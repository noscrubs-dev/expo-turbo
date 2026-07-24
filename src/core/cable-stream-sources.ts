import type { CableAdapter, CableCallbacks, CableSubscription } from "../adapters/index.js"
import {
  markCableStreamSourceErrorReported,
  wasCableStreamSourceErrorReported,
} from "./cable-stream-source-errors-internal.js"
import { ExpoTurboError, StateError, SubscriptionError } from "./errors.js"
import type { DocumentSession } from "./session.js"
import {
  dispatchGuardedTurboStreamFragment,
  type StreamDispatchOptions,
  type StreamDispatchReport,
} from "./streams.js"
import { attributeValue, type ProtocolElement } from "./tree.js"

const MAX_PENDING_CABLE_MESSAGES = 100
const STANDARD_STREAM_CHANNEL = "Turbo::StreamsChannel"
const DATA_ATTRIBUTE_NAME = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/
const RESERVED_PARAMETERS = new Set(["channel", "signed_stream_name"])

export type CableStreamSourceRelease = () => void

export type CableSubscriptionState =
  | "connected"
  | "connecting"
  | "disconnected"
  | "reconnecting"
  | "rejected"

export interface CableStreamSourceConnection {
  readonly nodeKey: string
  readonly state: CableSubscriptionState
}

export interface CableStreamSourceConnectionSnapshot {
  readonly revision: number
  readonly sources: readonly CableStreamSourceConnection[]
}

export type CableStreamSourceConnectionListener = () => void

/**
 * One redacted recovery handoff after an Action Cable server-directed
 * reconnect. `sourceKeys` identify only logical source nodes that were active
 * in that reconnect cycle; they never contain the Cable identifier or message.
 */
export interface CableReconnectRequest {
  readonly baseUrl: string
  readonly scroll: "preserve"
  readonly sourceKeys: readonly string[]
}

export interface CableReconnectRequester {
  request(request: CableReconnectRequest): void
}

export interface CableStreamSourceCollection {
  retain(source: ProtocolElement): CableStreamSourceRelease
}

export interface ObservableCableStreamSourceCollection extends CableStreamSourceCollection {
  readonly connectionSnapshot: CableStreamSourceConnectionSnapshot
  subscribeConnection(listener: CableStreamSourceConnectionListener): () => void
}

export interface CableStreamSourceRegistryOptions {
  readonly onError: (error: ExpoTurboError) => void
  readonly onMessage?: (report: StreamDispatchReport) => PromiseLike<void> | void
  /**
   * Optional source-aware reconciliation after an adapter has re-confirmed a
   * server-directed reconnect. This remains separate from Stream `refresh`
   * handling so hosts can keep that protocol feature disabled.
   */
  readonly reconnectRefresh?: CableReconnectRequester
  readonly streamOptions?: StreamDispatchOptions
}

interface SourceRecord {
  active: boolean
  connectionState: CableSubscriptionState
  descriptorError: SubscriptionError | undefined
  descriptorRevision: number
  identifier: string
  owners: number
  readonly node: ProtocolElement
  releaseEpoch: number
  transport: TransportRecord | undefined
  unregisterChanges: () => void
  unregisterDisposal: () => void
}

interface TransportRecord {
  active: boolean
  readonly identifier: string
  state: CableSubscriptionState
  readonly sources: Set<SourceRecord>
  subscription: CableSubscription | undefined
}

interface QueuedMessage {
  readonly message: string
  readonly transport: TransportRecord
}

function consumeUnexpectedResult(result: unknown): void {
  if ((typeof result !== "object" || result === null) && typeof result !== "function") return
  try {
    void Promise.resolve(result).catch(() => undefined)
  } catch {
    // Only the redacted SubscriptionError crosses the package boundary.
  }
}

function strictToken(value: string | undefined, label: string, target: string): string {
  if (value === undefined || value === "" || value.trim() !== value) {
    throw new SubscriptionError(`Cable stream source ${label} must be a nonblank token`, {
      target,
    })
  }
  return value
}

function sourceIdentifier(node: ProtocolElement): string {
  const channel = strictToken(attributeValue(node, "channel"), "channel", node.key)
  const signedValue = attributeValue(node, "signed-stream-name")
  const signedStreamName =
    signedValue === undefined ? null : strictToken(signedValue, "signed stream name", node.key)
  if (channel === STANDARD_STREAM_CHANNEL && signedStreamName === null) {
    throw new SubscriptionError("Turbo Streams Cable sources require a signed stream name", {
      target: node.key,
    })
  }

  const data: [string, string][] = []
  const names = new Set<string>()
  for (const attribute of node.attributes) {
    if (!attribute.name.startsWith("data-")) continue
    const sourceName = attribute.name.slice(5)
    if (!DATA_ATTRIBUTE_NAME.test(sourceName)) {
      throw new SubscriptionError("Cable stream source data parameter is invalid", {
        target: node.key,
      })
    }
    const name = sourceName.replaceAll("-", "_")
    if (RESERVED_PARAMETERS.has(name)) {
      throw new SubscriptionError("Cable stream source data parameter is reserved", {
        target: node.key,
      })
    }
    if (names.has(name)) {
      throw new SubscriptionError("Cable stream source data parameters collide", {
        target: node.key,
      })
    }
    names.add(name)
    data.push([name, attribute.value])
  }
  data.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))

  const identifier: Record<string, string | null> = {
    channel,
    signed_stream_name: signedStreamName,
  }
  for (const [name, value] of data) identifier[name] = value
  return JSON.stringify(identifier)
}

function redactedSubscriptionError(message: string, target?: string): SubscriptionError {
  return new SubscriptionError(message, target ? { target } : {})
}

export class CableStreamSourceRegistry implements ObservableCableStreamSourceCollection {
  private active = true
  private connectionStateSnapshot: CableStreamSourceConnectionSnapshot = Object.freeze({
    revision: 0,
    sources: Object.freeze([]),
  })
  private readonly connectionListeners = new Set<CableStreamSourceConnectionListener>()
  private dispatching = false
  private drainPromise: Promise<void> | undefined
  private readonly messages: QueuedMessage[] = []
  private readonly onError: (error: ExpoTurboError) => void
  private readonly onMessage:
    | ((report: StreamDispatchReport) => PromiseLike<void> | void)
    | undefined
  private readonly reconnectRefresh: CableReconnectRequester | undefined
  private reconnectCycle = 0
  private reconciledReconnectCycle = 0
  private readonly reconnectingTransports = new Set<TransportRecord>()
  private readonly sources = new Map<ProtocolElement, SourceRecord>()
  private readonly streamOptions: StreamDispatchOptions
  private readonly transports = new Map<string, TransportRecord>()

  constructor(
    private readonly session: DocumentSession,
    private readonly cable: CableAdapter,
    options: CableStreamSourceRegistryOptions,
  ) {
    if (!options || typeof options !== "object" || Array.isArray(options)) {
      throw new StateError("Cable stream source registry options must be an object")
    }
    if (typeof options.onError !== "function") {
      throw new StateError("Cable stream source registry requires an error observer")
    }
    if (options.onMessage !== undefined && typeof options.onMessage !== "function") {
      throw new StateError("Cable stream source message observer must be a function")
    }
    if (
      options.reconnectRefresh !== undefined &&
      (typeof options.reconnectRefresh !== "object" ||
        options.reconnectRefresh === null ||
        typeof options.reconnectRefresh.request !== "function")
    ) {
      throw new StateError("Cable stream source reconnect refresh must provide a request method")
    }
    this.onError = options.onError
    this.onMessage = options.onMessage
    this.reconnectRefresh = options.reconnectRefresh
    this.streamOptions = Object.freeze({ ...(options.streamOptions ?? {}) })
  }

  get connectionSnapshot(): CableStreamSourceConnectionSnapshot {
    return this.connectionStateSnapshot
  }

  subscribeConnection(listener: CableStreamSourceConnectionListener): () => void {
    this.assertActive()
    if (typeof listener !== "function") {
      throw new StateError("Cable stream source connection listener must be a function")
    }
    this.connectionListeners.add(listener)
    let subscribed = true
    return () => {
      if (!subscribed) return
      subscribed = false
      this.connectionListeners.delete(listener)
    }
  }

  retain(node: ProtocolElement): CableStreamSourceRelease {
    this.assertActive()
    if (node?.kind !== "stream-source" || this.session.tree.getNodeByKey(node.key) !== node) {
      throw new SubscriptionError("Active Cable stream source is missing", {
        ...(typeof node === "object" &&
        node !== null &&
        "key" in node &&
        typeof node.key === "string"
          ? { target: node.key }
          : {}),
      })
    }
    const current = this.sources.get(node)
    if (current?.active) {
      if (current.descriptorError) {
        if (!wasCableStreamSourceErrorReported(current.descriptorError)) {
          this.report(current.descriptorError)
        }
        throw current.descriptorError
      }
      current.owners += 1
      current.releaseEpoch += 1
      if (!current.transport) {
        try {
          this.acquireTransport(current)
        } catch (error) {
          current.owners -= 1
          if (current.owners === 0) this.releaseSource(current, true)
          else if (!current.transport) this.reacquireTransport(current)
          const reported =
            error instanceof ExpoTurboError
              ? error
              : redactedSubscriptionError("Cable stream source subscription failed", node.key)
          this.report(reported)
          throw reported
        }
      }
      return this.releaseToken(current)
    }

    let identifier: string
    try {
      identifier = sourceIdentifier(node)
    } catch (error) {
      const reported =
        error instanceof ExpoTurboError
          ? error
          : redactedSubscriptionError("Cable stream source descriptor is invalid", node.key)
      this.report(reported)
      throw reported
    }
    const record: SourceRecord = {
      active: true,
      connectionState: "connecting",
      descriptorError: undefined,
      descriptorRevision: 0,
      identifier,
      node,
      owners: 1,
      releaseEpoch: 0,
      transport: undefined,
      unregisterChanges: () => undefined,
      unregisterDisposal: () => undefined,
    }
    record.unregisterDisposal = this.session.registerDisposal(node.key, () => {
      this.releaseSource(record, false)
    })
    record.unregisterChanges = this.session.subscribe(node.key, () => {
      this.rebindSource(record)
    })
    this.sources.set(node, record)
    try {
      this.acquireTransport(record)
    } catch (error) {
      record.owners -= 1
      if (record.owners === 0) this.releaseSource(record, true)
      else if (!record.transport) this.reacquireTransport(record)
      const reported =
        error instanceof ExpoTurboError
          ? error
          : redactedSubscriptionError("Cable stream source subscription failed", node.key)
      this.report(reported)
      throw reported
    }
    this.publishConnectionSnapshot()
    return this.releaseToken(record)
  }

  dispose(): void {
    if (!this.active) return
    this.active = false
    this.messages.length = 0
    for (const record of [...this.sources.values()]) this.releaseSource(record, true)
    this.connectionListeners.clear()
  }

  private acquireTransport(source: SourceRecord): void {
    const current = this.transports.get(source.identifier)
    if (current?.active) {
      current.sources.add(source)
      source.transport = current
      this.setSourceConnectionState(source, current.state)
      return
    }

    const descriptorRevision = source.descriptorRevision
    const transport: TransportRecord = {
      active: true,
      identifier: source.identifier,
      state: "connecting",
      sources: new Set([source]),
      subscription: undefined,
    }
    source.transport = transport
    this.transports.set(transport.identifier, transport)
    this.setTransportConnectionState(transport, "connecting")
    const callbacks: CableCallbacks = {
      connected: (reconnected) =>
        this.setTransportConnectionState(transport, "connected", reconnected),
      disconnected: (willAttemptReconnect) =>
        this.setTransportConnectionState(
          transport,
          willAttemptReconnect === true ? "reconnecting" : "disconnected",
        ),
      received: (message) => this.receive(transport, message),
      rejected: () => this.setTransportConnectionState(transport, "rejected"),
    }

    let subscription: unknown
    try {
      subscription = this.cable.subscribe(transport.identifier, callbacks)
      if (
        !subscription ||
        (typeof subscription !== "object" && typeof subscription !== "function") ||
        typeof (subscription as Partial<CableSubscription>).unsubscribe !== "function"
      ) {
        consumeUnexpectedResult(subscription)
        throw redactedSubscriptionError(
          "Cable adapter returned an invalid subscription",
          source.node.key,
        )
      }
    } catch (error) {
      const strandedSources = [...transport.sources].filter((candidate) => candidate !== source)
      this.deactivateTransport(transport)
      for (const stranded of strandedSources) {
        if (
          stranded.active &&
          stranded.owners > 0 &&
          !stranded.transport &&
          stranded.identifier === transport.identifier
        ) {
          this.reacquireTransport(stranded)
        }
      }
      if (
        !source.active ||
        source.descriptorRevision !== descriptorRevision ||
        source.identifier !== transport.identifier ||
        source.transport !== undefined
      ) {
        return
      }
      if (error instanceof ExpoTurboError) throw error
      throw redactedSubscriptionError("Cable stream source subscription failed", source.node.key)
    }

    transport.subscription = subscription as CableSubscription
    if (!transport.active) this.unsubscribe(transport, source.node.key)
  }

  private rebindSource(source: SourceRecord): void {
    if (!this.active || !source.active) return
    let identifier: string
    try {
      identifier = sourceIdentifier(source.node)
    } catch (error) {
      const descriptorRevision = ++source.descriptorRevision
      const reported =
        error instanceof SubscriptionError
          ? error
          : redactedSubscriptionError("Cable stream source descriptor changed", source.node.key)
      source.descriptorError = reported
      this.detachTransport(source)
      this.setSourceConnectionState(source, "disconnected")
      if (
        !source.active ||
        source.descriptorRevision !== descriptorRevision ||
        source.descriptorError !== reported
      ) {
        return
      }
      if (source.owners > 0) this.report(reported)
      return
    }

    if (source.descriptorError === undefined && identifier === source.identifier) {
      if (source.owners > 0 && !source.transport) this.reacquireTransport(source)
      return
    }

    const descriptorRevision = ++source.descriptorRevision
    source.descriptorError = undefined
    source.identifier = identifier
    this.detachTransport(source)
    if (!source.active || source.descriptorRevision !== descriptorRevision) return
    if (source.owners > 0) this.reacquireTransport(source)
  }

  private reacquireTransport(source: SourceRecord): void {
    try {
      this.acquireTransport(source)
    } catch (error) {
      this.report(
        error instanceof ExpoTurboError
          ? error
          : redactedSubscriptionError("Cable stream source subscription failed", source.node.key),
      )
    }
  }

  private receive(transport: TransportRecord, message: unknown): Promise<void> {
    if (!this.active || !transport.active || !this.hasOwners(transport)) return Promise.resolve()
    const target = this.sourceTarget(transport)
    if (typeof message !== "string") {
      this.report(redactedSubscriptionError("Cable stream messages must be strings", target))
      return Promise.resolve()
    }
    if (this.messages.length >= MAX_PENDING_CABLE_MESSAGES) {
      this.report(redactedSubscriptionError("Cable stream message queue limit exceeded", target))
      return Promise.resolve()
    }
    this.messages.push({ message, transport })
    if (this.dispatching) return this.drainPromise ?? Promise.resolve()

    const draining = this.drainMessages()
    this.drainPromise = draining
    return draining
  }

  private async drainMessages(): Promise<void> {
    if (this.dispatching) return
    this.dispatching = true
    try {
      while (this.messages.length > 0) {
        const queued = this.messages.shift()
        if (
          !queued ||
          !this.active ||
          !queued.transport.active ||
          !this.hasOwners(queued.transport)
        ) {
          continue
        }
        const messageTarget = this.sourceTarget(queued.transport)
        try {
          const report = await dispatchGuardedTurboStreamFragment(
            this.session,
            queued.message,
            this.streamOptions,
            {
              shouldContinue: () =>
                this.active && queued.transport.active && this.hasOwners(queued.transport),
            },
          )
          if (this.onMessage) {
            try {
              const result = this.onMessage(report)
              if (result !== undefined) await result
            } catch {
              this.report(
                redactedSubscriptionError(
                  "Cable stream source message observer failed",
                  messageTarget,
                ),
              )
            }
          }
        } catch {
          this.report(
            redactedSubscriptionError("Cable stream message dispatch failed", messageTarget),
          )
        }
      }
    } finally {
      this.dispatching = false
      this.drainPromise = undefined
    }
  }

  private releaseToken(record: SourceRecord): CableStreamSourceRelease {
    let released = false
    return () => {
      if (released) return undefined
      released = true
      if (!record.active || record.owners === 0) return undefined
      record.owners -= 1
      if (record.owners !== 0) return undefined
      const releaseEpoch = ++record.releaseEpoch
      queueMicrotask(() => {
        if (!record.active || record.owners !== 0 || record.releaseEpoch !== releaseEpoch) {
          return
        }
        this.releaseSource(record, true)
      })
      return undefined
    }
  }

  private releaseSource(record: SourceRecord, unregisterDisposal: boolean): void {
    if (!record.active) return
    record.active = false
    record.descriptorRevision += 1
    record.owners = 0
    record.releaseEpoch += 1
    if (this.sources.get(record.node) === record) this.sources.delete(record.node)
    record.unregisterChanges()
    if (unregisterDisposal) record.unregisterDisposal()

    this.detachTransport(record)
    this.publishConnectionSnapshot()
  }

  private detachTransport(source: SourceRecord): void {
    const transport = source.transport
    source.transport = undefined
    if (!transport) return
    transport.sources.delete(source)
    if (transport.sources.size > 0) return
    this.deactivateTransport(transport)
    this.unsubscribe(transport, source.node.key)
  }

  private deactivateTransport(transport: TransportRecord): void {
    if (!transport.active) return
    this.forgetReconnect(transport)
    transport.active = false
    if (this.transports.get(transport.identifier) === transport) {
      this.transports.delete(transport.identifier)
    }
    for (const source of transport.sources) {
      if (source.transport === transport) source.transport = undefined
    }
    transport.sources.clear()
  }

  private setSourceConnectionState(source: SourceRecord, state: CableSubscriptionState): void {
    if (!source.active || source.connectionState === state) return
    source.connectionState = state
    this.publishConnectionSnapshot()
  }

  private setTransportConnectionState(
    transport: TransportRecord,
    state: CableSubscriptionState,
    reconnected = false,
  ): void {
    if (!this.active || !transport.active || !this.hasOwners(transport)) return
    const wasReconnecting = this.reconnectingTransports.has(transport)
    if (state === "reconnecting" && transport.state !== "reconnecting") {
      this.beginReconnect(transport)
    }
    const reconnectCycle = this.reconnectCycle
    const shouldRefresh =
      state === "connected" &&
      reconnected &&
      wasReconnecting &&
      this.reconciledReconnectCycle !== reconnectCycle
    transport.state = state
    let changed = false
    for (const source of transport.sources) {
      if (!source.active || source.transport !== transport || source.connectionState === state) {
        continue
      }
      source.connectionState = state
      changed = true
    }
    if (changed) this.publishConnectionSnapshot()
    if (
      shouldRefresh &&
      this.active &&
      transport.active &&
      this.hasOwners(transport) &&
      transport.state === "connected" &&
      this.reconnectingTransports.has(transport) &&
      this.reconnectCycle === reconnectCycle &&
      this.reconciledReconnectCycle !== reconnectCycle
    ) {
      this.reconciledReconnectCycle = reconnectCycle
      this.refreshAfterReconnect(transport)
    }
    if (transport.state !== "reconnecting") this.forgetReconnect(transport)
  }

  private refreshAfterReconnect(transport: TransportRecord): void {
    const refresh = this.reconnectRefresh
    if (!refresh) return
    const target = this.sourceTarget(transport)
    const baseUrl = this.session.tree.document.url
    if (!baseUrl) {
      this.report(
        redactedSubscriptionError(
          "Cable stream source reconnect reconciliation requires an active document URL",
          target,
        ),
      )
      return
    }
    try {
      refresh.request(
        Object.freeze({
          baseUrl,
          scroll: "preserve" as const,
          sourceKeys: this.reconnectSourceKeys(),
        }),
      )
    } catch {
      this.report(
        redactedSubscriptionError("Cable stream source reconnect reconciliation failed", target),
      )
    }
  }

  private beginReconnect(transport: TransportRecord): void {
    if (this.reconnectingTransports.size === 0) this.reconnectCycle += 1
    this.reconnectingTransports.add(transport)
  }

  private reconnectSourceKeys(): readonly string[] {
    const keys = new Set<string>()
    for (const transport of this.reconnectingTransports) {
      if (!transport.active || !this.hasOwners(transport)) continue
      for (const source of transport.sources) {
        if (!source.active || source.transport !== transport) continue
        keys.add(source.node.key)
      }
    }
    return Object.freeze([...keys].sort())
  }

  private forgetReconnect(transport: TransportRecord): void {
    this.reconnectingTransports.delete(transport)
  }

  private publishConnectionSnapshot(): void {
    const sources = [...this.sources.values()]
      .filter((source) => source.active)
      .map((source) => Object.freeze({ nodeKey: source.node.key, state: source.connectionState }))
      .sort((left, right) =>
        left.nodeKey < right.nodeKey ? -1 : left.nodeKey > right.nodeKey ? 1 : 0,
      )
    const current = this.connectionStateSnapshot.sources
    if (
      current.length === sources.length &&
      current.every(
        (source, index) =>
          source.nodeKey === sources[index]?.nodeKey && source.state === sources[index]?.state,
      )
    ) {
      return
    }
    this.connectionStateSnapshot = Object.freeze({
      revision: this.connectionStateSnapshot.revision + 1,
      sources: Object.freeze(sources),
    })
    const published = this.connectionStateSnapshot
    const observerFailures: unknown[] = []
    for (const listener of [...this.connectionListeners]) {
      try {
        const result: unknown = listener()
        if (result !== undefined) consumeUnexpectedResult(result)
      } catch (error) {
        observerFailures.push(error)
      }
      if (this.connectionStateSnapshot !== published) break
    }
    if (observerFailures.length > 0) {
      this.report(redactedSubscriptionError("Cable stream source connection observer failed"))
    }
  }

  private unsubscribe(transport: TransportRecord, target: string): void {
    const subscription = transport.subscription
    transport.subscription = undefined
    if (!subscription) return
    let result: unknown
    try {
      result = subscription.unsubscribe()
    } catch {
      this.report(redactedSubscriptionError("Cable stream source unsubscribe failed", target))
      return
    }
    if (result !== undefined) {
      consumeUnexpectedResult(result)
      this.report(redactedSubscriptionError("Cable stream source unsubscribe failed", target))
    }
  }

  private sourceTarget(transport: TransportRecord): string | undefined {
    for (const source of transport.sources) {
      if (source.active && source.owners > 0 && source.transport === transport) {
        return source.node.key
      }
    }
    return undefined
  }

  private hasOwners(transport: TransportRecord): boolean {
    for (const source of transport.sources) {
      if (source.active && source.owners > 0 && source.transport === transport) return true
    }
    return false
  }

  private report(error: ExpoTurboError): void {
    markCableStreamSourceErrorReported(error)
    try {
      const result = this.onError(error)
      if (result !== undefined) consumeUnexpectedResult(result)
    } catch {
      queueMicrotask(() => {
        throw new AggregateError(
          [error, new SubscriptionError("Cable stream source error observer failed")],
          "Cable stream source error observer failed",
        )
      })
    }
  }

  private assertActive(): void {
    if (!this.active) throw new StateError("Cable stream source registry is disposed")
  }
}
