import { SubscriptionError } from "../core/errors"
import {
  ACTION_CABLE_V1_JSON_PROTOCOL,
  decodeActionCableV1Frame,
  encodeActionCableSubscribe,
  encodeActionCableUnsubscribe,
} from "./action-cable-wire"
import type { CableAdapter, CableCallbacks, CableSubscription, ClockAdapter } from "./index"

export type ActionCableWebSocketEventType = "close" | "error" | "message" | "open"

/** Minimal native WebSocket boundary; hosts may wrap their platform WebSocket here. */
export interface ActionCableWebSocket {
  readonly protocol: string
  addEventListener(
    type: ActionCableWebSocketEventType,
    listener: (event: Readonly<{ readonly data?: unknown }>) => void,
  ): void
  close(): void
  removeEventListener(
    type: ActionCableWebSocketEventType,
    listener: (event: Readonly<{ readonly data?: unknown }>) => void,
  ): void
  send(data: string): void
}

export interface ActionCableWebSocketAdapterOptions {
  /** Optional host clock used to retry subscriptions that have not been confirmed yet. */
  readonly clock?: Pick<ClockAdapter, "clearTimeout" | "setTimeout">
  readonly createSocket: (
    url: string,
    protocols: readonly [typeof ACTION_CABLE_V1_JSON_PROTOCOL],
  ) => ActionCableWebSocket
  /** Receives only redacted transport failures; callbacks still receive their terminal state. */
  readonly onError: (error: SubscriptionError) => void
  /** Absolute `ws:` or `wss:` endpoint without URL userinfo, query, or fragment. */
  readonly url: string
}

/** Action Cable's official client re-sends an unconfirmed subscription every half second. */
export const ACTION_CABLE_SUBSCRIPTION_RETRY_MS = 500

const nativeSubscriptionRetryClock: Pick<ClockAdapter, "clearTimeout" | "setTimeout"> = {
  clearTimeout(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>)
  },
  setTimeout(callback, delayMs) {
    return setTimeout(callback, delayMs)
  },
}

interface CallbackSnapshot {
  connected(reconnected: boolean): void
  disconnected(willAttemptReconnect?: boolean): void
  received(message: string): void
  rejected(): void
}

interface SubscriptionRecord {
  active: boolean
  readonly callbacks: CallbackSnapshot
  connected: boolean
  reconnectOnConfirm: boolean
}

interface SubscriptionGroup {
  confirmed: boolean
  readonly identifier: string
  readonly records: Set<SubscriptionRecord>
  subscribed: boolean
}

interface SocketConnection {
  readonly close: (event: Readonly<{ readonly data?: unknown }>) => void
  readonly error: (event: Readonly<{ readonly data?: unknown }>) => void
  readonly generation: number
  readonly message: (event: Readonly<{ readonly data?: unknown }>) => void
  readonly open: (event: Readonly<{ readonly data?: unknown }>) => void
  readonly socket: ActionCableWebSocket
}

function adapterError(message: string): SubscriptionError {
  return new SubscriptionError(message)
}

function consumeUnexpectedResult(result: unknown): void {
  if ((typeof result !== "object" || result === null) && typeof result !== "function") return
  try {
    void Promise.resolve(result).catch(() => undefined)
  } catch {
    // Only redacted synchronous errors cross the adapter boundary.
  }
}

function callbacksSnapshot(callbacks: CableCallbacks): CallbackSnapshot {
  if (!callbacks || (typeof callbacks !== "object" && typeof callbacks !== "function")) {
    throw adapterError("Action Cable subscription callbacks are invalid")
  }

  try {
    const { connected, disconnected, received, rejected } = callbacks
    if (
      typeof connected !== "function" ||
      typeof disconnected !== "function" ||
      typeof received !== "function" ||
      typeof rejected !== "function"
    ) {
      throw adapterError("Action Cable subscription callbacks are invalid")
    }
    return Object.freeze({
      connected: (reconnected: boolean) => {
        consumeUnexpectedResult(connected.call(callbacks, reconnected))
      },
      disconnected: (willAttemptReconnect: boolean | undefined) => {
        consumeUnexpectedResult(disconnected.call(callbacks, willAttemptReconnect))
      },
      received: (message: string) => {
        consumeUnexpectedResult(received.call(callbacks, message))
      },
      rejected: () => {
        consumeUnexpectedResult(rejected.call(callbacks))
      },
    })
  } catch (error) {
    if (error instanceof SubscriptionError) throw error
    throw adapterError("Action Cable subscription callbacks are invalid")
  }
}

function isWebSocketUrl(value: string): boolean {
  if (value.trim() !== value) return false
  try {
    const url = new URL(value)
    return (
      (url.protocol === "ws:" || url.protocol === "wss:") &&
      url.hostname !== "" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === ""
    )
  } catch {
    return false
  }
}

/**
 * A bounded Action Cable v1 JSON transport over one host-owned WebSocket at a time.
 *
 * This deliberately owns no credentials, URL derivation, lifecycle integration,
 * heartbeat monitoring, or connection-retry policy. It guarantees each active
 * subscription until confirmed at Action Cable's cadence, but only rotates the
 * socket after an explicit valid server `disconnect` frame requests reconnecting;
 * terminal socket failures otherwise require the host to construct a fresh adapter.
 */
export class ActionCableV1WebSocketAdapter implements CableAdapter {
  private active = true
  private connection: SocketConnection | undefined
  private creatingConnection = false
  private generation = 0
  private readonly groups = new Map<string, SubscriptionGroup>()
  private readonly pendingConnectionRecords = new Set<SubscriptionRecord>()
  private terminated = false
  private welcomed = false
  private readonly createSocket: ActionCableWebSocketAdapterOptions["createSocket"]
  private readonly onError: ActionCableWebSocketAdapterOptions["onError"]
  private readonly retryClock: Pick<ClockAdapter, "clearTimeout" | "setTimeout">
  private subscriptionRetryHandle: unknown
  private readonly url: string

  constructor(options: ActionCableWebSocketAdapterOptions) {
    if (!options || typeof options !== "object") {
      throw adapterError("Action Cable WebSocket adapter options are invalid")
    }

    let optionsAreArray: boolean
    try {
      optionsAreArray = Array.isArray(options)
    } catch {
      throw adapterError("Action Cable WebSocket adapter options could not be read")
    }
    if (optionsAreArray) throw adapterError("Action Cable WebSocket adapter options are invalid")

    let createSocket: ActionCableWebSocketAdapterOptions["createSocket"]
    let clock: ActionCableWebSocketAdapterOptions["clock"]
    let onError: ActionCableWebSocketAdapterOptions["onError"]
    let url: string
    try {
      clock = options.clock
      createSocket = options.createSocket
      onError = options.onError
      url = options.url
    } catch {
      throw adapterError("Action Cable WebSocket adapter options could not be read")
    }
    if (typeof createSocket !== "function") {
      throw adapterError("Action Cable WebSocket adapter requires a socket factory")
    }
    if (typeof onError !== "function") {
      throw adapterError("Action Cable WebSocket adapter requires an error observer")
    }
    if (typeof url !== "string" || !isWebSocketUrl(url)) {
      throw adapterError("Action Cable WebSocket URL must be an absolute ws or wss URL")
    }

    let retryClock: Pick<ClockAdapter, "clearTimeout" | "setTimeout"> = nativeSubscriptionRetryClock
    if (clock !== undefined) {
      if (
        !clock ||
        (typeof clock !== "object" && typeof clock !== "function") ||
        Array.isArray(clock)
      ) {
        throw adapterError("Action Cable subscription retry clock is invalid")
      }
      let clearTimeout: ClockAdapter["clearTimeout"]
      let setTimeout: ClockAdapter["setTimeout"]
      try {
        clearTimeout = clock.clearTimeout
        setTimeout = clock.setTimeout
      } catch {
        throw adapterError("Action Cable subscription retry clock is invalid")
      }
      if (typeof clearTimeout !== "function" || typeof setTimeout !== "function") {
        throw adapterError("Action Cable subscription retry clock is invalid")
      }
      retryClock = Object.freeze({
        clearTimeout: (handle) => clearTimeout.call(clock, handle),
        setTimeout: (callback, delayMs) => setTimeout.call(clock, callback, delayMs),
      })
    }

    this.createSocket = createSocket
    this.onError = onError
    this.retryClock = retryClock
    this.url = url
  }

  subscribe(identifier: string, callbacks: CableCallbacks): CableSubscription {
    this.assertUsable()
    if (typeof identifier !== "string" || identifier.trim() === "") {
      throw adapterError("Action Cable subscription identifier must be nonblank")
    }

    const record: SubscriptionRecord = {
      active: true,
      callbacks: callbacksSnapshot(callbacks),
      connected: false,
      reconnectOnConfirm: false,
    }
    let group = this.groups.get(identifier)
    const groupWasNew = group === undefined
    if (!group) {
      group = {
        confirmed: false,
        identifier,
        records: new Set(),
        subscribed: false,
      }
      this.groups.set(identifier, group)
    }
    group.records.add(record)
    if (this.creatingConnection) this.pendingConnectionRecords.add(record)

    try {
      this.ensureConnection()
    } catch (error) {
      group.records.delete(record)
      if (groupWasNew && group.records.size === 0) this.groups.delete(identifier)
      if (error instanceof SubscriptionError) throw error
      throw adapterError("Action Cable WebSocket connection failed")
    }

    if (this.welcomed && group.records.has(record) && !group.subscribed) {
      this.subscribeGroup(group)
    }
    if (group.confirmed && !record.connected && record.active && group.records.has(record)) {
      record.connected = true
      this.invoke(record, "connected", false)
    }

    let unsubscribed = false
    return Object.freeze({
      unsubscribe: () => {
        if (unsubscribed) return
        unsubscribed = true
        this.unsubscribeRecord(group, record)
      },
    })
  }

  dispose(): void {
    if (!this.active) return
    this.active = false
    this.stopSubscriptionGuarantee()
    const records = this.drainGroups()
    this.pendingConnectionRecords.clear()
    this.detachConnection(true)
    for (const record of records) this.invoke(record, "disconnected", false)
  }

  private ensureConnection(): void {
    if (this.connection || this.creatingConnection) return

    let socket: ActionCableWebSocket
    this.creatingConnection = true
    try {
      socket = this.createSocket(this.url, [ACTION_CABLE_V1_JSON_PROTOCOL])
    } catch {
      this.creatingConnection = false
      if (this.failPendingConnectionRecords()) {
        this.report(adapterError("Action Cable WebSocket connection failed"))
      }
      throw adapterError("Action Cable WebSocket connection failed")
    }
    try {
      if (!socket || (typeof socket !== "object" && typeof socket !== "function")) {
        this.creatingConnection = false
        if (this.failPendingConnectionRecords()) {
          this.report(adapterError("Action Cable WebSocket connection failed"))
        }
        throw adapterError("Action Cable WebSocket connection failed")
      }
      if (!this.active) {
        this.closeSocket(socket)
        throw adapterError("Action Cable WebSocket adapter is disposed")
      }
      if (this.terminated) {
        this.closeSocket(socket)
        throw adapterError("Action Cable WebSocket adapter is terminated")
      }

      const generation = ++this.generation
      const connection: SocketConnection = {
        close: () =>
          this.handleSocketTerminal(connection, "Action Cable WebSocket connection closed"),
        error: () =>
          this.handleSocketTerminal(connection, "Action Cable WebSocket connection failed"),
        generation,
        message: (event) => this.handleMessage(connection, event),
        open: () => this.handleOpen(connection),
        socket,
      }
      this.connection = connection
      this.welcomed = false

      try {
        socket.addEventListener("open", connection.open)
        if (!this.owns(connection)) {
          this.removeSocketListeners(connection)
          return
        }
        socket.addEventListener("close", connection.close)
        if (!this.owns(connection)) {
          this.removeSocketListeners(connection)
          return
        }
        socket.addEventListener("error", connection.error)
        if (!this.owns(connection)) {
          this.removeSocketListeners(connection)
          return
        }
        socket.addEventListener("message", connection.message)
        if (!this.owns(connection)) this.removeSocketListeners(connection)
        else this.pendingConnectionRecords.clear()
      } catch {
        this.detachConnection(true)
        this.creatingConnection = false
        if (this.failPendingConnectionRecords()) {
          this.report(adapterError("Action Cable WebSocket connection failed"))
        }
        throw adapterError("Action Cable WebSocket connection failed")
      }
    } finally {
      this.creatingConnection = false
    }
  }

  private handleOpen(connection: SocketConnection): void {
    if (!this.owns(connection) || !this.acceptedProtocol(connection)) return
  }

  private handleMessage(
    connection: SocketConnection,
    event: Readonly<{ readonly data?: unknown }>,
  ): void {
    if (!this.owns(connection) || !this.acceptedProtocol(connection)) return
    if (typeof event.data !== "string") {
      this.terminal("Action Cable WebSocket message is invalid")
      return
    }

    let frame: ReturnType<typeof decodeActionCableV1Frame>
    try {
      frame = decodeActionCableV1Frame(event.data)
    } catch {
      this.terminal("Action Cable WebSocket message is invalid")
      return
    }

    if (!("type" in frame)) {
      const group = this.groups.get(frame.identifier)
      if (!group) return
      for (const record of [...group.records]) {
        if (record.active && group.records.has(record))
          this.invoke(record, "received", frame.message)
      }
      return
    }
    if (frame.type === "welcome") {
      this.welcomed = true
      for (const group of [...this.groups.values()]) {
        if (!this.active || this.terminated) return
        if (!group.subscribed) this.subscribeGroup(group)
      }
      return
    }
    if (frame.type === "ping") return
    if (frame.type === "disconnect") {
      if (frame.reconnect) {
        this.reconnect(connection)
        return
      }
      this.terminal("Action Cable WebSocket connection disconnected")
      return
    }

    const group = this.groups.get(frame.identifier)
    if (!group) return
    if (frame.type === "confirm_subscription") {
      if (group.confirmed) return
      group.confirmed = true
      for (const record of [...group.records]) {
        if (!record.active || !group.records.has(record)) continue
        const reconnected = record.reconnectOnConfirm
        record.connected = true
        record.reconnectOnConfirm = false
        this.invoke(record, "connected", reconnected)
      }
      this.stopSubscriptionGuaranteeIfIdle()
      return
    }
    if (frame.type === "reject_subscription") {
      this.groups.delete(group.identifier)
      for (const record of [...group.records]) {
        record.active = false
        this.invoke(record, "rejected")
      }
      group.records.clear()
      this.stopSubscriptionGuaranteeIfIdle()
      this.closeIdleConnection()
      return
    }
  }

  private acceptedProtocol(connection: SocketConnection): boolean {
    try {
      if (connection.socket.protocol === ACTION_CABLE_V1_JSON_PROTOCOL) return true
    } catch {
      // The host socket is invalid; report only the redacted protocol failure below.
    }
    this.terminal("Action Cable WebSocket protocol is unsupported")
    return false
  }

  private subscribeGroup(group: SubscriptionGroup): void {
    if (
      !this.active ||
      this.terminated ||
      !this.welcomed ||
      group.subscribed ||
      group.records.size === 0
    ) {
      return
    }
    group.subscribed = true
    if (!this.send(encodeActionCableSubscribe(group.identifier))) {
      if (
        !this.terminated &&
        this.groups.get(group.identifier) === group &&
        group.records.size > 0
      ) {
        group.subscribed = false
      }
      return
    }
    if (!group.confirmed && this.groups.get(group.identifier) === group && group.records.size > 0) {
      this.startSubscriptionGuarantee()
    }
  }

  private startSubscriptionGuarantee(): void {
    if (!this.active || this.terminated || !this.welcomed || !this.hasUnconfirmedSubscriptions()) {
      this.stopSubscriptionGuarantee()
      return
    }
    if (this.subscriptionRetryHandle !== undefined) return
    try {
      this.subscriptionRetryHandle = this.retryClock.setTimeout(() => {
        this.subscriptionRetryHandle = undefined
        this.retryUnconfirmedSubscriptions()
      }, ACTION_CABLE_SUBSCRIPTION_RETRY_MS)
    } catch {
      this.terminal("Action Cable subscription guarantee failed")
    }
  }

  private retryUnconfirmedSubscriptions(): void {
    if (!this.active || this.terminated || !this.welcomed) return
    for (const group of [...this.groups.values()]) {
      if (
        group.confirmed ||
        group.records.size === 0 ||
        this.groups.get(group.identifier) !== group
      ) {
        continue
      }
      group.subscribed = false
      this.subscribeGroup(group)
      if (!this.active || this.terminated) return
    }
    this.stopSubscriptionGuaranteeIfIdle()
  }

  private hasUnconfirmedSubscriptions(): boolean {
    for (const group of this.groups.values()) {
      if (!group.confirmed && group.records.size > 0) return true
    }
    return false
  }

  private stopSubscriptionGuaranteeIfIdle(): void {
    if (!this.hasUnconfirmedSubscriptions()) this.stopSubscriptionGuarantee()
  }

  private stopSubscriptionGuarantee(): void {
    if (this.subscriptionRetryHandle === undefined) return
    const handle = this.subscriptionRetryHandle
    this.subscriptionRetryHandle = undefined
    try {
      this.retryClock.clearTimeout(handle)
    } catch {
      // The adapter has released the retry handle and cannot safely retry its host clock.
    }
  }

  private unsubscribeRecord(group: SubscriptionGroup, record: SubscriptionRecord): void {
    if (!record.active || !group.records.delete(record)) return
    record.active = false
    this.pendingConnectionRecords.delete(record)
    if (group.records.size > 0) return
    if (this.groups.get(group.identifier) === group) this.groups.delete(group.identifier)
    if (group.subscribed && this.welcomed) this.send(encodeActionCableUnsubscribe(group.identifier))
    this.stopSubscriptionGuaranteeIfIdle()
    this.closeIdleConnection()
  }

  private send(command: string): boolean {
    const connection = this.connection
    if (!connection || !this.owns(connection)) return false
    try {
      connection.socket.send(command)
      return true
    } catch {
      this.terminal("Action Cable WebSocket command failed")
      return false
    }
  }

  private handleSocketTerminal(connection: SocketConnection, message: string): void {
    if (!this.owns(connection)) return
    this.terminal(message)
  }

  private reconnect(connection: SocketConnection): void {
    if (!this.owns(connection)) return
    const records: Readonly<{ group: SubscriptionGroup; record: SubscriptionRecord }>[] = []
    for (const group of this.groups.values()) {
      group.confirmed = false
      group.subscribed = false
      for (const record of group.records) {
        if (!record.active) continue
        record.reconnectOnConfirm = record.connected
        record.connected = false
        this.pendingConnectionRecords.add(record)
        records.push({ group, record })
      }
    }

    this.detachConnection(true)
    for (const { group, record } of records) {
      if (
        record.active &&
        this.groups.get(group.identifier) === group &&
        group.records.has(record)
      ) {
        this.invoke(record, "disconnected", true)
      }
    }
    if (!this.active || this.terminated || this.groups.size === 0 || this.connection) return

    for (const group of this.groups.values()) {
      for (const record of group.records) {
        if (record.active) this.pendingConnectionRecords.add(record)
      }
    }
    try {
      this.ensureConnection()
    } catch {
      // Pending records settle and report the redacted replacement failure in ensureConnection().
    }
  }

  private terminal(message: string): void {
    if (!this.active || this.terminated) return
    this.terminated = true
    const records = this.drainGroups()
    this.pendingConnectionRecords.clear()
    this.detachConnection(true)
    for (const record of records) this.invoke(record, "disconnected", false)
    this.report(adapterError(message))
  }

  private closeIdleConnection(): void {
    if (this.groups.size !== 0 || !this.connection) return
    this.detachConnection(true)
  }

  private drainGroups(): SubscriptionRecord[] {
    const records: SubscriptionRecord[] = []
    for (const group of this.groups.values()) {
      for (const record of group.records) {
        if (!record.active) continue
        record.active = false
        records.push(record)
      }
      group.records.clear()
    }
    this.groups.clear()
    return records
  }

  private failPendingConnectionRecords(): boolean {
    let notified = false
    while (this.pendingConnectionRecords.size > 0) {
      const pending = [...this.pendingConnectionRecords]
      this.pendingConnectionRecords.clear()
      const active = pending.filter((record) => record.active)
      for (const record of active) record.active = false
      for (const group of [...this.groups.values()]) {
        for (const record of active) group.records.delete(record)
        if (group.records.size === 0 && this.groups.get(group.identifier) === group) {
          this.groups.delete(group.identifier)
        }
      }
      for (const record of active) {
        notified ||= true
        this.invoke(record, "disconnected", false)
      }
    }
    return notified
  }

  private detachConnection(close: boolean): void {
    this.stopSubscriptionGuarantee()
    const connection = this.connection
    this.connection = undefined
    this.welcomed = false
    if (!connection) return
    this.removeSocketListeners(connection)
    if (!close) return
    this.closeSocket(connection.socket)
  }

  private removeSocketListeners(connection: SocketConnection): void {
    try {
      connection.socket.removeEventListener("open", connection.open)
      connection.socket.removeEventListener("close", connection.close)
      connection.socket.removeEventListener("error", connection.error)
      connection.socket.removeEventListener("message", connection.message)
    } catch {
      // Cleanup must not let a host socket implementation escape package boundaries.
    }
  }

  private closeSocket(socket: ActionCableWebSocket): void {
    try {
      socket.close()
    } catch {
      // The adapter is already disconnected from the socket and cannot retry here.
    }
  }

  private invoke(
    record: SubscriptionRecord,
    method: keyof CallbackSnapshot,
    ...args: [boolean] | [string] | []
  ): void {
    try {
      switch (method) {
        case "connected":
          record.callbacks.connected(args[0] as boolean)
          return
        case "disconnected":
          record.callbacks.disconnected(args[0] as boolean | undefined)
          return
        case "received":
          record.callbacks.received(args[0] as string)
          return
        case "rejected":
          record.callbacks.rejected()
          return
      }
    } catch {
      this.report(adapterError("Action Cable WebSocket callback failed"))
    }
  }

  private owns(connection: SocketConnection): boolean {
    return (
      this.active &&
      !this.terminated &&
      this.connection === connection &&
      connection.generation === this.generation
    )
  }

  private report(error: SubscriptionError): void {
    try {
      const result: unknown = this.onError(error)
      if (result !== undefined) consumeUnexpectedResult(result)
    } catch {
      queueMicrotask(() => {
        throw new AggregateError(
          [error, adapterError("Action Cable WebSocket error observer failed")],
          "Action Cable WebSocket error observer failed",
        )
      })
    }
  }

  private assertUsable(): void {
    if (!this.active) throw adapterError("Action Cable WebSocket adapter is disposed")
    if (this.terminated) throw adapterError("Action Cable WebSocket adapter is terminated")
  }
}
