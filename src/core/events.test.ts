import { describe, expect, test } from "bun:test"

import { CancellableEvent, NotificationEvent, PausableEvent, TypedEventBus } from "./events"

interface TestEvents {
  beforeVisit: { url: string }
  loaded: { documentId: string }
}

describe("typed event bus", () => {
  test("dispatches typed events in subscription order and preserves cancellation", async () => {
    const bus = new TypedEventBus<TestEvents>()
    const calls: string[] = []
    bus.subscribe("beforeVisit", (event) => {
      calls.push(`first:${event.detail.url}`)
      if (event instanceof CancellableEvent) event.preventDefault()
    })
    bus.subscribe("beforeVisit", (event) => {
      calls.push(
        `second:${event instanceof CancellableEvent ? event.defaultPrevented : "not-cancellable"}`,
      )
    })

    const event = await bus.dispatch(
      new CancellableEvent("beforeVisit", { url: "https://example.test/next" }),
    )

    expect(calls).toEqual(["first:https://example.test/next", "second:true"])
    expect(event.defaultPrevented).toBe(true)
  })

  test("waits for nested pauses and serializes later dispatches", async () => {
    const bus = new TypedEventBus<TestEvents>()
    const calls: string[] = []
    let resumeFirst: (() => void) | undefined
    let resumeSecond: (() => void) | undefined

    bus.subscribe("beforeVisit", (event) => {
      calls.push("before:start")
      if (!(event instanceof PausableEvent)) throw new Error("expected a pausable event")
      event.pause()
      event.pause()
      resumeFirst = () => event.resume()
      resumeSecond = () => event.resume()
    })
    bus.subscribe("beforeVisit", () => {
      calls.push("before:end")
    })
    bus.subscribe("loaded", (event) => {
      calls.push(`loaded:${event.detail.documentId}`)
    })

    const before = bus.dispatch(
      new PausableEvent("beforeVisit", { url: "https://example.test/paused" }),
    )
    const loaded = bus.dispatch(new NotificationEvent("loaded", { documentId: "document" }))
    await Promise.resolve()

    expect(calls).toEqual(["before:start"])
    resumeFirst?.()
    await Promise.resolve()
    expect(calls).toEqual(["before:start"])
    resumeSecond?.()
    await Promise.all([before, loaded])
    expect(calls).toEqual(["before:start", "before:end", "loaded:document"])
  })

  test("uses a stable listener snapshot for each dispatch", async () => {
    const bus = new TypedEventBus<TestEvents>()
    const calls: string[] = []
    const late = () => calls.push("late")
    let unsubscribeSecond: () => void = () => undefined

    bus.subscribe("loaded", () => {
      calls.push("first")
      unsubscribeSecond()
      bus.subscribe("loaded", late)
    })
    unsubscribeSecond = bus.subscribe("loaded", () => calls.push("second"))

    await bus.dispatch(new NotificationEvent("loaded", { documentId: "one" }))
    expect(calls).toEqual(["first", "second"])

    calls.length = 0
    await bus.dispatch(new NotificationEvent("loaded", { documentId: "two" }))
    expect(calls).toEqual(["first", "late"])
  })

  test("recovers the serial queue after a listener failure", async () => {
    const bus = new TypedEventBus<TestEvents>()
    const calls: string[] = []
    const unsubscribe = bus.subscribe("loaded", () => {
      throw new Error("listener failed")
    })

    await expect(
      bus.dispatch(new NotificationEvent("loaded", { documentId: "failed" })),
    ).rejects.toThrow("listener failed")

    unsubscribe()
    bus.subscribe("loaded", () => calls.push("recovered"))
    await bus.dispatch(new NotificationEvent("loaded", { documentId: "next" }))
    expect(calls).toEqual(["recovered"])
  })

  test("rejects blank event types and unbalanced resume calls", () => {
    expect(() => new NotificationEvent(" ", undefined)).toThrow(
      "Logical event types must not be blank",
    )
    expect(() => new PausableEvent("loaded", { documentId: "document" }).resume()).toThrow(
      "Logical event is not paused",
    )
  })
})
