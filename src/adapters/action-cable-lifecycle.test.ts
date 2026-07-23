import { describe, expect, test } from "bun:test"

import { SubscriptionError } from "../core/errors"
import {
  type DisposableCableAdapter,
  LifecycleCableAdapter,
  type NetworkReachabilityAdapter,
  type NetworkReachabilityState,
} from "./action-cable-lifecycle"
import type {
  CableCallbacks,
  CableSubscription,
  ClockAdapter,
  LifecycleAdapter,
  LifecycleState,
} from "./index"

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

class FakeNetwork implements NetworkReachabilityAdapter {
  readonly listeners = new Set<(state: NetworkReachabilityState) => void>()

  constructor(private state: NetworkReachabilityState) {}

  getState(): NetworkReachabilityState {
    return this.state
  }

  subscribe(listener: (state: NetworkReachabilityState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit(state: NetworkReachabilityState): void {
    this.state = state
    for (const listener of [...this.listeners]) listener(state)
  }
}

class FakeClock implements ClockAdapter {
  nowMs = 0
  readonly timers = new Map<number, Readonly<{ callback: () => void; dueAt: number }>>()
  private nextHandle = 1

  clearTimeout(handle: unknown): void {
    this.timers.delete(Number(handle))
  }

  now(): number {
    return this.nowMs
  }

  setTimeout(callback: () => void, delayMs: number): unknown {
    const handle = this.nextHandle++
    this.timers.set(handle, { callback, dueAt: this.nowMs + delayMs })
    return handle
  }

  advance(ms: number): void {
    this.nowMs += ms
    while (true) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.dueAt <= this.nowMs)
        .sort((left, right) => left[1].dueAt - right[1].dueAt)[0]
      if (!due) return
      this.timers.delete(due[0])
      due[1].callback()
    }
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
  test("attaches every logical subscription after one asynchronous credential factory", async () => {
    const lifecycle = new FakeLifecycle("active")
    const cable = new FakeCable()
    let resolveCable: ((cable: DisposableCableAdapter) => void) | undefined
    let attempts = 0
    const adapter = new LifecycleCableAdapter({
      createCable: () => {
        attempts += 1
        return new Promise<DisposableCableAdapter>((resolve) => {
          resolveCable = resolve
        })
      },
      lifecycle,
      onError: () => undefined,
    })

    adapter.subscribe("one", callbacks([]))
    adapter.subscribe("two", callbacks([]))
    expect(attempts).toBe(1)
    expect(cable.records).toEqual([])

    resolveCable?.(cable)
    await Promise.resolve()
    await Promise.resolve()
    expect(cable.records.map((record) => record.identifier)).toEqual(["one", "two"])
  })

  test("disposes a stale asynchronous credential transport and creates a fresh one", async () => {
    const lifecycle = new FakeLifecycle("active")
    const resolvers: ((cable: DisposableCableAdapter) => void)[] = []
    const adapter = new LifecycleCableAdapter({
      createCable: () =>
        new Promise<DisposableCableAdapter>((resolve) => {
          resolvers.push(resolve)
        }),
      lifecycle,
      onError: () => undefined,
    })
    const staleCable = new FakeCable()
    const freshCable = new FakeCable()

    adapter.subscribe("protected", callbacks([]))
    lifecycle.emit("background")
    resolvers[0]?.(staleCable)
    await Promise.resolve()
    await Promise.resolve()
    expect(staleCable.disposeCalls).toBe(1)
    expect(staleCable.records).toEqual([])

    lifecycle.emit("active")
    expect(resolvers).toHaveLength(2)
    resolvers[1]?.(freshCable)
    await Promise.resolve()
    await Promise.resolve()
    expect(freshCable.records.map((record) => record.identifier)).toEqual(["protected"])
  })

  test("retries a rejected asynchronous credential factory within the same bounds", async () => {
    const clock = new FakeClock()
    const errors: SubscriptionError[] = []
    let attempts = 0
    const cable = new FakeCable()
    const adapter = new LifecycleCableAdapter({
      clock,
      createCable: async () => {
        attempts += 1
        if (attempts === 1) throw new Error("credential-secret")
        return cable
      },
      lifecycle: new FakeLifecycle("active"),
      onError: (error) => {
        errors.push(error)
      },
      retry: { initialDelayMs: 10, maxAttempts: 2, maxDelayMs: 20, multiplier: 2 },
    })

    adapter.subscribe("protected", callbacks([]))
    await Promise.resolve()
    await Promise.resolve()
    expect(errors).toEqual([new SubscriptionError("Action Cable lifecycle adapter factory failed")])
    expect(clock.timers.size).toBe(1)

    clock.advance(10)
    await Promise.resolve()
    await Promise.resolve()
    expect(attempts).toBe(2)
    expect(cable.records.map((record) => record.identifier)).toEqual(["protected"])
  })

  test("settles an asynchronous credential failure terminally without retry policy", async () => {
    const errors: SubscriptionError[] = []
    const events: string[] = []
    const adapter = new LifecycleCableAdapter({
      createCable: async () => {
        throw new Error("credential-secret")
      },
      lifecycle: new FakeLifecycle("active"),
      onError: (error) => {
        errors.push(error)
      },
    })

    adapter.subscribe("protected", callbacks(events))
    await Promise.resolve()
    await Promise.resolve()

    expect(errors).toEqual([new SubscriptionError("Action Cable lifecycle adapter factory failed")])
    expect(events).toEqual(["disconnected:false"])
  })

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

  test("suspends while offline and recreates one fresh transport immediately when online", () => {
    const lifecycle = new FakeLifecycle("active")
    const network = new FakeNetwork("online")
    const cables: FakeCable[] = []
    const events: string[] = []
    const adapter = new LifecycleCableAdapter({
      createCable: () => {
        const cable = new FakeCable()
        cables.push(cable)
        return cable
      },
      lifecycle,
      network,
      onError: () => undefined,
    })

    adapter.subscribe("protected", callbacks(events))
    cables[0]?.records[0]?.callbacks.connected(false)
    network.emit("offline")
    network.emit("offline")

    expect(cables[0]?.disposeCalls).toBe(1)
    expect(events).toEqual(["connected:false", "disconnected:true"])

    network.emit("online")
    expect(cables).toHaveLength(2)
    cables[1]?.records[0]?.callbacks.connected(false)
    expect(events).toEqual(["connected:false", "disconnected:true", "connected:true"])
  })

  test("retries terminal transport loss with bounded exponential backoff", () => {
    const clock = new FakeClock()
    const lifecycle = new FakeLifecycle("active")
    const cables: FakeCable[] = []
    const errors: SubscriptionError[] = []
    const events: string[] = []
    const adapter = new LifecycleCableAdapter({
      clock,
      createCable: () => {
        const cable = new FakeCable()
        cables.push(cable)
        return cable
      },
      lifecycle,
      onError: (error) => {
        errors.push(error)
      },
      retry: { initialDelayMs: 100, maxAttempts: 3, maxDelayMs: 250, multiplier: 2 },
    })

    adapter.subscribe("protected", callbacks(events))
    cables[0]?.records[0]?.callbacks.connected(false)
    cables[0]?.records[0]?.callbacks.disconnected(false)
    expect(events).toEqual(["connected:false", "disconnected:true"])
    expect([...clock.timers.values()].map((timer) => timer.dueAt)).toEqual([100])

    clock.advance(99)
    expect(cables).toHaveLength(1)
    clock.advance(1)
    expect(cables).toHaveLength(2)
    cables[1]?.records[0]?.callbacks.disconnected(false)
    expect([...clock.timers.values()].map((timer) => timer.dueAt)).toEqual([300])

    clock.advance(200)
    expect(cables).toHaveLength(3)
    cables[2]?.records[0]?.callbacks.connected(false)
    expect(events).toEqual([
      "connected:false",
      "disconnected:true",
      "disconnected:true",
      "connected:true",
    ])
    expect(clock.timers.size).toBe(0)
    expect(errors).toEqual([])
  })

  test("pauses a pending retry offline and resets the cycle on reachability", () => {
    const clock = new FakeClock()
    const lifecycle = new FakeLifecycle("active")
    const network = new FakeNetwork("online")
    const cables: FakeCable[] = []
    const adapter = new LifecycleCableAdapter({
      clock,
      createCable: () => {
        const cable = new FakeCable()
        cables.push(cable)
        return cable
      },
      lifecycle,
      network,
      onError: () => undefined,
      retry: { initialDelayMs: 100, maxAttempts: 2, maxDelayMs: 200, multiplier: 2 },
    })

    adapter.subscribe("protected", callbacks([]))
    cables[0]?.records[0]?.callbacks.disconnected(false)
    network.emit("offline")
    clock.advance(1_000)
    expect(cables).toHaveLength(1)

    network.emit("online")
    expect(cables).toHaveLength(2)
  })

  test("bounds repeated factory failures and reports terminal exhaustion", () => {
    const clock = new FakeClock()
    const errors: SubscriptionError[] = []
    const events: string[] = []
    let attempts = 0
    const adapter = new LifecycleCableAdapter({
      clock,
      createCable: () => {
        attempts += 1
        throw new Error("secret")
      },
      lifecycle: new FakeLifecycle("active"),
      onError: (error) => {
        errors.push(error)
      },
      retry: { initialDelayMs: 10, maxAttempts: 2, maxDelayMs: 20, multiplier: 2 },
    })

    adapter.subscribe("protected", callbacks(events))
    expect(attempts).toBe(1)
    clock.advance(10)
    expect(attempts).toBe(2)
    clock.advance(20)
    expect(attempts).toBe(3)

    expect(clock.timers.size).toBe(0)
    expect(errors.map((error) => error.message)).toEqual([
      "Action Cable lifecycle adapter factory failed",
      "Action Cable lifecycle adapter factory failed",
      "Action Cable lifecycle adapter factory failed",
      "Action Cable retry attempts exhausted",
    ])
    expect(events).toEqual(["disconnected:false"])
  })

  test("does not retry an explicit subscription rejection", () => {
    const clock = new FakeClock()
    const { lifecycle } = createManagedCable()
    const cables: FakeCable[] = []
    const events: string[] = []
    const adapter = new LifecycleCableAdapter({
      clock,
      createCable: () => {
        const cable = new FakeCable()
        cables.push(cable)
        return cable
      },
      lifecycle,
      onError: () => undefined,
      retry: { initialDelayMs: 10, maxAttempts: 2, maxDelayMs: 20, multiplier: 2 },
    })

    adapter.subscribe("protected", callbacks(events))
    cables[0]?.records[0]?.callbacks.rejected()
    clock.advance(100)

    expect(cables).toHaveLength(1)
    expect(events).toEqual(["rejected"])
  })

  test("requires a valid bounded retry policy and clock", () => {
    const lifecycle = new FakeLifecycle("active")
    const createCable = () => new FakeCable()
    const onError = () => undefined

    expect(
      () =>
        new LifecycleCableAdapter({
          createCable,
          lifecycle,
          onError,
          retry: { initialDelayMs: 10, maxAttempts: 1, maxDelayMs: 10, multiplier: 1 },
        }),
    ).toThrow(new SubscriptionError("Action Cable retry policy requires a clock"))
    expect(
      () =>
        new LifecycleCableAdapter({
          clock: new FakeClock(),
          createCable,
          lifecycle,
          onError,
          retry: { initialDelayMs: -1, maxAttempts: 0, maxDelayMs: 0, multiplier: 0 },
        }),
    ).toThrow(new SubscriptionError("Action Cable retry policy is invalid"))
  })
})
