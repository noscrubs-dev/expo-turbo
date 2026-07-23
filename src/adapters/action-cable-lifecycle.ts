import { SubscriptionError } from "../core/errors"
import type {
  CableAdapter,
  CableCallbacks,
  CableSubscription,
  ClockAdapter,
  LifecycleAdapter,
  LifecycleState,
  Unsubscribe,
} from "./index"

export interface DisposableCableAdapter extends CableAdapter {
  dispose(): void
}

export interface LifecycleCableAdapterOptions {
  readonly clock?: Pick<ClockAdapter, "clearTimeout" | "setTimeout">
  readonly createCable: () => DisposableCableAdapter | PromiseLike<DisposableCableAdapter>
  readonly lifecycle: LifecycleAdapter
  readonly network?: NetworkReachabilityAdapter
  readonly onError: (error: SubscriptionError) => void | PromiseLike<void>
  readonly retry?: CableRetryPolicy
}

export type NetworkReachabilityState = "offline" | "online"

export interface NetworkReachabilityAdapter {
  getState(): NetworkReachabilityState
  subscribe(listener: (state: NetworkReachabilityState) => void): Unsubscribe
}

export interface CableRetryPolicy {
  /** Delay before the first retry. */
  readonly initialDelayMs: number
  /** Maximum number of transport recreation attempts in one failure cycle. */
  readonly maxAttempts: number
  /** Upper bound for one retry delay. */
  readonly maxDelayMs: number
  /** Exponential delay multiplier. */
  readonly multiplier: number
}

interface LifecycleCableRecord {
  active: boolean
  attached: boolean
  readonly callbacks: CableCallbacks
  connected: boolean
  everConnected: boolean
  readonly identifier: string
  subscription: CableSubscription | undefined
}

interface PendingCableFactory {
  readonly generation: number
}

function lifecycleError(message: string): SubscriptionError {
  return new SubscriptionError(message)
}

function isLifecycleState(value: unknown): value is LifecycleState {
  return value === "active" || value === "background" || value === "inactive"
}

function isNetworkState(value: unknown): value is NetworkReachabilityState {
  return value === "offline" || value === "online"
}

function validateRetryPolicy(value: CableRetryPolicy | undefined): CableRetryPolicy | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw lifecycleError("Action Cable retry policy is invalid")
  }
  let initialDelayMs: number
  let maxAttempts: number
  let maxDelayMs: number
  let multiplier: number
  try {
    ;({ initialDelayMs, maxAttempts, maxDelayMs, multiplier } = value)
  } catch {
    throw lifecycleError("Action Cable retry policy could not be read")
  }
  if (
    !Number.isFinite(initialDelayMs) ||
    initialDelayMs < 0 ||
    !Number.isSafeInteger(maxAttempts) ||
    maxAttempts < 1 ||
    !Number.isFinite(maxDelayMs) ||
    maxDelayMs < initialDelayMs ||
    !Number.isFinite(multiplier) ||
    multiplier < 1
  ) {
    throw lifecycleError("Action Cable retry policy is invalid")
  }
  return Object.freeze({ initialDelayMs, maxAttempts, maxDelayMs, multiplier })
}

function snapshotCallbacks(callbacks: CableCallbacks): CableCallbacks {
  if (!callbacks || typeof callbacks !== "object" || Array.isArray(callbacks)) {
    throw lifecycleError("Action Cable lifecycle callbacks are invalid")
  }
  let connected: CableCallbacks["connected"]
  let disconnected: CableCallbacks["disconnected"]
  let received: CableCallbacks["received"]
  let rejected: CableCallbacks["rejected"]
  try {
    connected = callbacks.connected
    disconnected = callbacks.disconnected
    received = callbacks.received
    rejected = callbacks.rejected
  } catch {
    throw lifecycleError("Action Cable lifecycle callbacks are invalid")
  }
  if (
    typeof connected !== "function" ||
    typeof disconnected !== "function" ||
    typeof received !== "function" ||
    typeof rejected !== "function"
  ) {
    throw lifecycleError("Action Cable lifecycle callbacks are invalid")
  }
  return Object.freeze({
    connected: (reconnected: boolean) => connected.call(callbacks, reconnected),
    disconnected: (willAttemptReconnect?: boolean) =>
      disconnected.call(callbacks, willAttemptReconnect),
    received: (message: string) => received.call(callbacks, message),
    rejected: () => rejected.call(callbacks),
  })
}

/**
 * Keeps logical Cable subscriptions stable while a host lifecycle suspends and
 * recreates the credential-bearing transport. Credentials and platform state
 * mapping remain host-owned. Hosts may inject reachability and a bounded retry
 * policy without exposing credentials to the package.
 */
export class LifecycleCableAdapter implements CableAdapter {
  private active = true
  private cable: DisposableCableAdapter | undefined
  private generation = 0
  private readonly records = new Set<LifecycleCableRecord>()
  private state: LifecycleState
  private readonly createCable: LifecycleCableAdapterOptions["createCable"]
  private readonly clock: LifecycleCableAdapterOptions["clock"]
  private readonly lifecycle: LifecycleAdapter
  private readonly network: NetworkReachabilityAdapter | undefined
  private networkState: NetworkReachabilityState = "online"
  private readonly onError: LifecycleCableAdapterOptions["onError"]
  private pendingCable: PendingCableFactory | undefined
  private readonly retry: CableRetryPolicy | undefined
  private retryAttempts = 0
  private retryHandle: unknown
  private unsubscribeLifecycle: Unsubscribe = () => undefined
  private unsubscribeNetwork: Unsubscribe = () => undefined

  constructor(options: LifecycleCableAdapterOptions) {
    if (!options || typeof options !== "object" || Array.isArray(options)) {
      throw lifecycleError("Action Cable lifecycle options are invalid")
    }
    let createCable: LifecycleCableAdapterOptions["createCable"]
    let clock: LifecycleCableAdapterOptions["clock"]
    let lifecycle: LifecycleCableAdapterOptions["lifecycle"]
    let network: LifecycleCableAdapterOptions["network"]
    let onError: LifecycleCableAdapterOptions["onError"]
    let retry: LifecycleCableAdapterOptions["retry"]
    try {
      clock = options.clock
      createCable = options.createCable
      lifecycle = options.lifecycle
      network = options.network
      onError = options.onError
      retry = options.retry
    } catch {
      throw lifecycleError("Action Cable lifecycle options could not be read")
    }
    if (typeof createCable !== "function") {
      throw lifecycleError("Action Cable lifecycle requires an adapter factory")
    }
    if (!lifecycle || typeof lifecycle !== "object" || Array.isArray(lifecycle)) {
      throw lifecycleError("Action Cable lifecycle adapter is invalid")
    }
    if (typeof onError !== "function") {
      throw lifecycleError("Action Cable lifecycle requires an error observer")
    }
    const retryPolicy = validateRetryPolicy(retry)
    if (
      retryPolicy &&
      (!clock ||
        typeof clock !== "object" ||
        Array.isArray(clock) ||
        typeof clock.clearTimeout !== "function" ||
        typeof clock.setTimeout !== "function")
    ) {
      throw lifecycleError("Action Cable retry policy requires a clock")
    }
    let getState: LifecycleAdapter["getState"]
    let subscribe: LifecycleAdapter["subscribe"]
    try {
      getState = lifecycle.getState
      subscribe = lifecycle.subscribe
    } catch {
      throw lifecycleError("Action Cable lifecycle adapter is invalid")
    }
    if (typeof getState !== "function" || typeof subscribe !== "function") {
      throw lifecycleError("Action Cable lifecycle adapter is invalid")
    }
    let state: unknown
    try {
      state = getState.call(lifecycle)
    } catch {
      throw lifecycleError("Action Cable lifecycle state could not be read")
    }
    if (!isLifecycleState(state)) {
      throw lifecycleError("Action Cable lifecycle state is invalid")
    }

    this.createCable = createCable
    this.clock = clock
    this.lifecycle = lifecycle
    this.network = network
    this.onError = onError
    this.retry = retryPolicy
    this.state = state
    if (network !== undefined) {
      if (!network || typeof network !== "object" || Array.isArray(network)) {
        throw lifecycleError("Action Cable network adapter is invalid")
      }
      let getNetworkState: NetworkReachabilityAdapter["getState"]
      let subscribeNetwork: NetworkReachabilityAdapter["subscribe"]
      try {
        getNetworkState = network.getState
        subscribeNetwork = network.subscribe
      } catch {
        throw lifecycleError("Action Cable network adapter is invalid")
      }
      if (typeof getNetworkState !== "function" || typeof subscribeNetwork !== "function") {
        throw lifecycleError("Action Cable network adapter is invalid")
      }
      let networkState: unknown
      try {
        networkState = getNetworkState.call(network)
      } catch {
        throw lifecycleError("Action Cable network state could not be read")
      }
      if (!isNetworkState(networkState)) {
        throw lifecycleError("Action Cable network state is invalid")
      }
      this.networkState = networkState
      try {
        const unsubscribe = subscribeNetwork.call(network, (nextState) => {
          this.transitionNetwork(nextState)
        })
        if (typeof unsubscribe !== "function") {
          throw lifecycleError("Action Cable network subscription is invalid")
        }
        this.unsubscribeNetwork = unsubscribe
      } catch (error) {
        if (error instanceof SubscriptionError) throw error
        throw lifecycleError("Action Cable network subscription failed")
      }
    }
    try {
      const unsubscribe = subscribe.call(lifecycle, (nextState) => {
        this.transition(nextState)
      })
      if (typeof unsubscribe !== "function") {
        throw lifecycleError("Action Cable lifecycle subscription is invalid")
      }
      this.unsubscribeLifecycle = unsubscribe
    } catch (error) {
      try {
        this.unsubscribeNetwork()
      } catch {
        // Constructor failure still releases every valid subscription it owns.
      }
      if (error instanceof SubscriptionError) throw error
      throw lifecycleError("Action Cable lifecycle subscription failed")
    }
  }

  subscribe(identifier: string, callbacks: CableCallbacks): CableSubscription {
    if (!this.active) throw lifecycleError("Action Cable lifecycle adapter is disposed")
    if (typeof identifier !== "string" || identifier.trim() === "") {
      throw lifecycleError("Action Cable lifecycle identifier must be nonblank")
    }
    const record: LifecycleCableRecord = {
      active: true,
      attached: false,
      callbacks: snapshotCallbacks(callbacks),
      connected: false,
      everConnected: false,
      identifier,
      subscription: undefined,
    }
    this.records.add(record)
    if (this.canConnect()) {
      try {
        this.attach(record)
      } catch (error) {
        if (this.retry) {
          this.reportTransportFailure(error)
          this.scheduleRetry()
          return this.subscriptionFor(record)
        }
        record.active = false
        this.records.delete(record)
        this.releaseIdleCable()
        if (error instanceof SubscriptionError) throw error
        throw lifecycleError("Action Cable lifecycle activation failed")
      }
    }

    return this.subscriptionFor(record)
  }

  dispose(): void {
    if (!this.active) return
    this.active = false
    try {
      this.unsubscribeLifecycle()
    } catch {
      this.report(lifecycleError("Action Cable lifecycle disposal failed"))
    }
    try {
      this.unsubscribeNetwork()
    } catch {
      this.report(lifecycleError("Action Cable network disposal failed"))
    }
    this.cancelRetry()
    this.releaseCable(false)
    for (const record of this.records) record.active = false
    this.records.clear()
  }

  /**
   * Disposes the current credential-bearing generation and asks the host
   * factory for a fresh snapshot while preserving logical subscriptions.
   * Hosts should update their identity or credential source before calling
   * this method.
   */
  rotateCredentials(): void {
    if (!this.active) throw lifecycleError("Action Cable lifecycle adapter is disposed")
    this.cancelRetry()
    this.retryAttempts = 0
    const reconnecting = this.canConnect() && this.records.size > 0
    this.releaseCable(reconnecting)
    if (reconnecting) this.activate()
  }

  private transition(nextState: unknown): void {
    if (!this.active) return
    if (!isLifecycleState(nextState)) {
      this.report(lifecycleError("Action Cable lifecycle state is invalid"))
      return
    }
    if (nextState === this.state) return
    this.state = nextState
    if (nextState !== "active") {
      this.cancelRetry()
      this.releaseCable(true)
      return
    }
    this.retryAttempts = 0
    this.activate()
  }

  private transitionNetwork(nextState: unknown): void {
    if (!this.active) return
    if (!isNetworkState(nextState)) {
      this.report(lifecycleError("Action Cable network state is invalid"))
      return
    }
    if (nextState === this.networkState) return
    this.networkState = nextState
    if (nextState === "offline") {
      this.cancelRetry()
      this.releaseCable(true)
      return
    }
    this.retryAttempts = 0
    this.activate()
  }

  private activate(): void {
    if (!this.canConnect() || this.records.size === 0 || this.retryHandle !== undefined) return
    try {
      for (const record of this.records) this.attach(record)
    } catch (error) {
      this.releaseCable(this.retry !== undefined)
      this.reportTransportFailure(error)
      if (this.retry) this.scheduleRetry()
    }
  }

  private attach(record: LifecycleCableRecord): void {
    if (!this.active || !record.active || record.attached || !this.canConnect()) return
    const cable = this.ensureCable()
    if (!cable) return
    const generation = this.generation
    record.attached = true
    try {
      record.subscription = cable.subscribe(record.identifier, {
        connected: (reconnected) => {
          if (!this.owns(record, generation)) return
          record.connected = true
          this.retryAttempts = 0
          this.cancelRetry()
          this.invoke(record, "connected", record.everConnected || reconnected)
          record.everConnected = true
        },
        disconnected: (willAttemptReconnect) => {
          if (!this.owns(record, generation)) return
          if (willAttemptReconnect || !this.retry) {
            record.connected = false
            this.invoke(record, "disconnected", willAttemptReconnect)
            return
          }
          this.releaseCable(true)
          this.scheduleRetry()
        },
        received: (message) => {
          if (!this.owns(record, generation)) return
          this.invoke(record, "received", message)
        },
        rejected: () => {
          if (!this.owns(record, generation)) return
          record.connected = false
          this.invoke(record, "rejected")
        },
      })
    } catch (error) {
      record.attached = false
      record.subscription = undefined
      throw error
    }
  }

  private ensureCable(): DisposableCableAdapter | undefined {
    if (this.cable) return this.cable
    if (this.pendingCable) return undefined
    let candidate: DisposableCableAdapter | PromiseLike<DisposableCableAdapter>
    try {
      candidate = this.createCable()
    } catch {
      throw lifecycleError("Action Cable lifecycle adapter factory failed")
    }
    if (this.isCable(candidate)) {
      this.cable = candidate
      return candidate
    }
    let then: unknown
    try {
      then = (candidate as PromiseLike<DisposableCableAdapter> | undefined)?.then
    } catch {
      throw lifecycleError("Action Cable lifecycle adapter factory failed")
    }
    if (typeof then !== "function") {
      throw lifecycleError("Action Cable lifecycle adapter factory returned an invalid adapter")
    }
    const pending = Object.freeze({ generation: this.generation })
    this.pendingCable = pending
    void Promise.resolve(candidate).then(
      (cable) => this.resolvePendingCable(pending, cable),
      () => this.rejectPendingCable(pending),
    )
    return undefined
  }

  private releaseCable(willAttemptReconnect: boolean): void {
    const cable = this.cable
    this.cable = undefined
    this.pendingCable = undefined
    this.generation += 1
    for (const record of this.records) {
      if (!record.active || !record.attached) continue
      record.attached = false
      record.subscription = undefined
      record.connected = false
      this.invoke(record, "disconnected", willAttemptReconnect)
    }
    if (cable) this.disposeCable(cable)
  }

  private releaseIdleCable(): void {
    if (this.records.size !== 0) return
    this.cancelRetry()
    this.retryAttempts = 0
    this.releaseCable(false)
  }

  private canConnect(): boolean {
    return this.active && this.state === "active" && this.networkState === "online"
  }

  private resolvePendingCable(pending: PendingCableFactory, cable: unknown): void {
    if (this.pendingCable !== pending) {
      if (this.isCable(cable)) this.disposeCable(cable)
      return
    }
    this.pendingCable = undefined
    if (!this.isCable(cable)) {
      this.settlePendingFactoryFailure(
        lifecycleError("Action Cable lifecycle adapter factory returned an invalid adapter"),
      )
      return
    }
    if (
      !this.active ||
      pending.generation !== this.generation ||
      !this.canConnect() ||
      this.records.size === 0
    ) {
      this.disposeCable(cable)
      return
    }
    this.cable = cable
    this.activate()
  }

  private rejectPendingCable(pending: PendingCableFactory): void {
    if (this.pendingCable !== pending) return
    this.pendingCable = undefined
    if (!this.active || pending.generation !== this.generation || !this.canConnect()) return
    this.settlePendingFactoryFailure(
      lifecycleError("Action Cable lifecycle adapter factory failed"),
    )
  }

  private settlePendingFactoryFailure(error: SubscriptionError): void {
    this.report(error)
    if (this.retry) {
      this.scheduleRetry()
      return
    }
    for (const record of this.records) {
      if (record.active) this.invoke(record, "disconnected", false)
    }
  }

  private isCable(value: unknown): value is DisposableCableAdapter {
    try {
      return (
        value !== null &&
        (typeof value === "object" || typeof value === "function") &&
        !Array.isArray(value) &&
        typeof (value as Partial<DisposableCableAdapter>).subscribe === "function" &&
        typeof (value as Partial<DisposableCableAdapter>).dispose === "function"
      )
    } catch {
      return false
    }
  }

  private disposeCable(cable: DisposableCableAdapter): void {
    try {
      cable.dispose()
    } catch {
      this.report(lifecycleError("Action Cable lifecycle transport disposal failed"))
    }
  }

  private scheduleRetry(): void {
    if (!this.retry || !this.clock || !this.canConnect() || this.records.size === 0) return
    if (this.retryHandle !== undefined) return
    if (this.retryAttempts >= this.retry.maxAttempts) {
      this.releaseCable(false)
      for (const record of this.records) {
        if (record.active) this.invoke(record, "disconnected", false)
      }
      this.report(lifecycleError("Action Cable retry attempts exhausted"))
      return
    }
    const delayMs = Math.min(
      this.retry.maxDelayMs,
      this.retry.initialDelayMs * this.retry.multiplier ** this.retryAttempts,
    )
    this.retryHandle = this.clock.setTimeout(() => {
      this.retryHandle = undefined
      this.retryAttempts += 1
      this.activate()
    }, delayMs)
  }

  private cancelRetry(): void {
    if (this.retryHandle === undefined || !this.clock) return
    const handle = this.retryHandle
    this.retryHandle = undefined
    try {
      this.clock.clearTimeout(handle)
    } catch {
      this.report(lifecycleError("Action Cable retry cancellation failed"))
    }
  }

  private reportTransportFailure(error: unknown): void {
    this.report(
      error instanceof SubscriptionError
        ? error
        : lifecycleError("Action Cable lifecycle activation failed"),
    )
  }

  private subscriptionFor(record: LifecycleCableRecord): CableSubscription {
    let unsubscribed = false
    return Object.freeze({
      unsubscribe: () => {
        if (unsubscribed) return
        unsubscribed = true
        this.unsubscribeRecord(record)
      },
    })
  }

  private unsubscribeRecord(record: LifecycleCableRecord): void {
    if (!record.active) return
    record.active = false
    this.records.delete(record)
    const subscription = record.subscription
    record.subscription = undefined
    record.attached = false
    try {
      subscription?.unsubscribe()
    } catch {
      this.report(lifecycleError("Action Cable lifecycle unsubscribe failed"))
    }
    this.releaseIdleCable()
  }

  private owns(record: LifecycleCableRecord, generation: number): boolean {
    return (
      this.active &&
      record.active &&
      record.attached &&
      this.records.has(record) &&
      this.generation === generation
    )
  }

  private invoke(
    record: LifecycleCableRecord,
    callback: keyof CableCallbacks,
    argument?: boolean | string,
  ): void {
    try {
      let result: void | PromiseLike<void>
      if (callback === "connected") result = record.callbacks.connected(argument === true)
      else if (callback === "disconnected") {
        result = record.callbacks.disconnected(argument === true)
      } else if (callback === "received") result = record.callbacks.received(String(argument))
      else result = record.callbacks.rejected()
      void Promise.resolve(result).catch(() => undefined)
    } catch {
      // Host callbacks cannot destabilize lifecycle ownership.
    }
  }

  private report(error: SubscriptionError): void {
    try {
      void Promise.resolve(this.onError(error)).catch(() => undefined)
    } catch {
      // Error observers cannot destabilize lifecycle ownership.
    }
  }
}
