import { SubscriptionError } from "../core/errors"
import type {
  CableAdapter,
  CableCallbacks,
  CableSubscription,
  LifecycleAdapter,
  LifecycleState,
  Unsubscribe,
} from "./index"

export interface DisposableCableAdapter extends CableAdapter {
  dispose(): void
}

export interface LifecycleCableAdapterOptions {
  readonly createCable: () => DisposableCableAdapter
  readonly lifecycle: LifecycleAdapter
  readonly onError: (error: SubscriptionError) => void | PromiseLike<void>
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

function lifecycleError(message: string): SubscriptionError {
  return new SubscriptionError(message)
}

function isLifecycleState(value: unknown): value is LifecycleState {
  return value === "active" || value === "background" || value === "inactive"
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
 * recreates the credential-bearing transport. Credentials, AppState mapping,
 * network policy, and retry/backoff remain host-owned.
 */
export class LifecycleCableAdapter implements CableAdapter {
  private active = true
  private cable: DisposableCableAdapter | undefined
  private generation = 0
  private readonly records = new Set<LifecycleCableRecord>()
  private state: LifecycleState
  private readonly createCable: LifecycleCableAdapterOptions["createCable"]
  private readonly lifecycle: LifecycleAdapter
  private readonly onError: LifecycleCableAdapterOptions["onError"]
  private unsubscribeLifecycle: Unsubscribe = () => undefined

  constructor(options: LifecycleCableAdapterOptions) {
    if (!options || typeof options !== "object" || Array.isArray(options)) {
      throw lifecycleError("Action Cable lifecycle options are invalid")
    }
    let createCable: LifecycleCableAdapterOptions["createCable"]
    let lifecycle: LifecycleCableAdapterOptions["lifecycle"]
    let onError: LifecycleCableAdapterOptions["onError"]
    try {
      createCable = options.createCable
      lifecycle = options.lifecycle
      onError = options.onError
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
    this.lifecycle = lifecycle
    this.onError = onError
    this.state = state
    try {
      const unsubscribe = subscribe.call(lifecycle, (nextState) => {
        this.transition(nextState)
      })
      if (typeof unsubscribe !== "function") {
        throw lifecycleError("Action Cable lifecycle subscription is invalid")
      }
      this.unsubscribeLifecycle = unsubscribe
    } catch (error) {
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
    if (this.state === "active") {
      try {
        this.attach(record)
      } catch (error) {
        record.active = false
        this.records.delete(record)
        this.releaseIdleCable()
        if (error instanceof SubscriptionError) throw error
        throw lifecycleError("Action Cable lifecycle activation failed")
      }
    }

    let unsubscribed = false
    return Object.freeze({
      unsubscribe: () => {
        if (unsubscribed) return
        unsubscribed = true
        this.unsubscribeRecord(record)
      },
    })
  }

  dispose(): void {
    if (!this.active) return
    this.active = false
    try {
      this.unsubscribeLifecycle()
    } catch {
      this.report(lifecycleError("Action Cable lifecycle disposal failed"))
    }
    this.releaseCable(false)
    for (const record of this.records) record.active = false
    this.records.clear()
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
      this.releaseCable(true)
      return
    }
    try {
      for (const record of this.records) this.attach(record)
    } catch (error) {
      this.releaseCable(false)
      this.report(
        error instanceof SubscriptionError
          ? error
          : lifecycleError("Action Cable lifecycle activation failed"),
      )
    }
  }

  private attach(record: LifecycleCableRecord): void {
    if (!this.active || !record.active || record.attached || this.state !== "active") return
    const cable = this.ensureCable()
    const generation = this.generation
    record.attached = true
    try {
      record.subscription = cable.subscribe(record.identifier, {
        connected: (reconnected) => {
          if (!this.owns(record, generation)) return
          record.connected = true
          this.invoke(record, "connected", record.everConnected || reconnected)
          record.everConnected = true
        },
        disconnected: (willAttemptReconnect) => {
          if (!this.owns(record, generation)) return
          record.connected = false
          this.invoke(record, "disconnected", willAttemptReconnect)
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

  private ensureCable(): DisposableCableAdapter {
    if (this.cable) return this.cable
    let cable: DisposableCableAdapter
    try {
      cable = this.createCable()
    } catch {
      throw lifecycleError("Action Cable lifecycle adapter factory failed")
    }
    if (
      !cable ||
      (typeof cable !== "object" && typeof cable !== "function") ||
      Array.isArray(cable) ||
      typeof cable.subscribe !== "function" ||
      typeof cable.dispose !== "function"
    ) {
      throw lifecycleError("Action Cable lifecycle adapter factory returned an invalid adapter")
    }
    this.cable = cable
    return cable
  }

  private releaseCable(willAttemptReconnect: boolean): void {
    const cable = this.cable
    this.cable = undefined
    this.generation += 1
    for (const record of this.records) {
      if (!record.active || !record.attached) continue
      record.attached = false
      record.subscription = undefined
      record.connected = false
      this.invoke(record, "disconnected", willAttemptReconnect)
    }
    if (!cable) return
    try {
      cable.dispose()
    } catch {
      this.report(lifecycleError("Action Cable lifecycle transport disposal failed"))
    }
  }

  private releaseIdleCable(): void {
    if (this.records.size !== 0) return
    this.releaseCable(false)
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
