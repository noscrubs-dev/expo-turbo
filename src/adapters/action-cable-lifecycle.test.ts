import { describe, expect, test } from "bun:test"

import { SubscriptionError } from "../core/errors"
import { type DisposableCableAdapter, LifecycleCableAdapter } from "./action-cable-lifecycle"
import type { CableCallbacks, CableSubscription, LifecycleAdapter, LifecycleState } from "./index"

class FakeLifecycle implements LifecycleAdapter {
  readonly listeners = new Set<(state: LifecycleState) => void>()

  constructor(private state: LifecycleState) {}

  getState(): LifecycleState {
    return this.state
  }

  subscribe(listener: (state: LifecycleState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit(state: LifecycleState): void {
    this.state = state
    for (const listener of [...this.listeners]) listener(state)
  }
}

interface FakeCableRecord {
  readonly callbacks: CableCallbacks
  readonly identifier: string
  unsubscribed: boolean
}

class FakeCable implements DisposableCableAdapter {
  disposeCalls = 0
  readonly records: FakeCableRecord[] = []

  subscribe(identifier: string, callbacks: CableCallbacks): CableSubscription {
    const record = { callbacks, identifier, unsubscribed: false }
    this.records.push(record)
    return Object.freeze({
      unsubscribe: () => {
        record.unsubscribed = true
      },
    })
  }

  dispose(): void {
    this.disposeCalls += 1
    for (const record of this.records) {
      if (!record.unsubscribed) record.callbacks.disconnected(false)
    }
  }
}

function callbacks(events: string[]): CableCallbacks {
  return {
    connected: (reconnected) => {
      events.push(`connected:${reconnected}`)
    },
    disconnected: (willAttemptReconnect) => {
      events.push(`disconnected:${willAttemptReconnect}`)
    },
    received: (message) => {
      events.push(`received:${message}`)
    },
    rejected: () => events.push("rejected"),
  }
}

function createManagedCable(initialState: LifecycleState = "active") {
  const cables: FakeCable[] = []
  const errors: SubscriptionError[] = []
  const lifecycle = new FakeLifecycle(initialState)
  const adapter = new LifecycleCableAdapter({
    createCable: () => {
      const cable = new FakeCable()
      cables.push(cable)
      return cable
    },
    lifecycle,
    onError: (error) => {
      errors.push(error)
    },
  })
  return { adapter, cables, errors, lifecycle }
}

describe("Action Cable lifecycle adapter", () => {
  test("recreates one credential-bearing transport while preserving logical subscriptions", () => {
    const { adapter, cables, errors, lifecycle } = createManagedCable()
    const events: string[] = []
    const identifier = '{"channel":"Turbo::StreamsChannel","signed_stream_name":"opaque"}'

    adapter.subscribe(identifier, callbacks(events))
    expect(cables).toHaveLength(1)
    expect(cables[0]?.records.map((record) => record.identifier)).toEqual([identifier])

    cables[0]?.records[0]?.callbacks.connected(false)
    cables[0]?.records[0]?.callbacks.received("first")
    lifecycle.emit("background")

    expect(cables[0]?.disposeCalls).toBe(1)
    expect(events).toEqual(["connected:false", "received:first", "disconnected:true"])

    cables[0]?.records[0]?.callbacks.received("stale")
    cables[0]?.records[0]?.callbacks.connected(false)
    lifecycle.emit("active")

    expect(cables).toHaveLength(2)
    expect(cables[1]?.records.map((record) => record.identifier)).toEqual([identifier])
    cables[1]?.records[0]?.callbacks.connected(false)
    cables[1]?.records[0]?.callbacks.received("second")

    expect(events).toEqual([
      "connected:false",
      "received:first",
      "disconnected:true",
      "connected:true",
      "received:second",
    ])
    expect(errors).toEqual([])
  })

  test("defers transport creation while inactive and treats inactive as suspended", () => {
    const { adapter, cables, lifecycle } = createManagedCable("inactive")
    const events: string[] = []

    adapter.subscribe("one", callbacks(events))
    adapter.subscribe("two", callbacks(events))
    expect(cables).toEqual([])

    lifecycle.emit("active")
    expect(cables).toHaveLength(1)
    expect(cables[0]?.records.map((record) => record.identifier)).toEqual(["one", "two"])

    lifecycle.emit("inactive")
    lifecycle.emit("inactive")
    expect(cables[0]?.disposeCalls).toBe(1)
    expect(events).toEqual(["disconnected:true", "disconnected:true"])
  })

  test("does not restore a logical subscription removed while suspended", () => {
    const { adapter, cables, lifecycle } = createManagedCable()
    const subscription = adapter.subscribe("removed", callbacks([]))

    lifecycle.emit("background")
    subscription.unsubscribe()
    lifecycle.emit("active")

    expect(cables).toHaveLength(1)
    expect(cables[0]?.disposeCalls).toBe(1)
  })

  test("closes an idle transport and lazily creates a fresh credential snapshot", () => {
    const { adapter, cables } = createManagedCable()
    const first = adapter.subscribe("first", callbacks([]))

    first.unsubscribe()
    expect(cables[0]?.records[0]?.unsubscribed).toBe(true)
    expect(cables[0]?.disposeCalls).toBe(1)

    adapter.subscribe("second", callbacks([]))
    expect(cables).toHaveLength(2)
  })

  test("reports a reactivation factory failure and retries only after another lifecycle edge", () => {
    const lifecycle = new FakeLifecycle("background")
    const errors: SubscriptionError[] = []
    let attempts = 0
    const cable = new FakeCable()
    const adapter = new LifecycleCableAdapter({
      createCable: () => {
        attempts += 1
        if (attempts === 1) throw new Error("credential-secret")
        return cable
      },
      lifecycle,
      onError: (error) => {
        errors.push(error)
      },
    })
    adapter.subscribe("protected", callbacks([]))

    lifecycle.emit("active")
    expect(errors).toEqual([new SubscriptionError("Action Cable lifecycle adapter factory failed")])
    expect(cable.records).toEqual([])

    lifecycle.emit("background")
    lifecycle.emit("active")
    expect(cable.records.map((record) => record.identifier)).toEqual(["protected"])
  })

  test("disposes lifecycle ownership and rejects future subscriptions", () => {
    const { adapter, cables, lifecycle } = createManagedCable()
    const events: string[] = []
    adapter.subscribe("one", callbacks(events))

    adapter.dispose()
    lifecycle.emit("background")
    lifecycle.emit("active")

    expect(cables).toHaveLength(1)
    expect(cables[0]?.disposeCalls).toBe(1)
    expect(events).toEqual(["disconnected:false"])
    expect(() => adapter.subscribe("again", callbacks([]))).toThrow(
      new SubscriptionError("Action Cable lifecycle adapter is disposed"),
    )
  })
})
