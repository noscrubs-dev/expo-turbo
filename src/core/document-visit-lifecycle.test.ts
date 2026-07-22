import { describe, expect, test } from "bun:test"
import {
  admitDocumentVisitLifecycle,
  BeforeCacheEvent,
  BeforePrefetchEvent,
  BeforeVisitEvent,
  DOCUMENT_VISIT_LIFECYCLE_BEFORE_CACHE_DISPATCH,
  DOCUMENT_VISIT_LIFECYCLE_BEFORE_DISPATCH,
  DOCUMENT_VISIT_LIFECYCLE_BEFORE_PREFETCH_DISPATCH,
  DOCUMENT_VISIT_LIFECYCLE_CLICK_DISPATCH,
  DOCUMENT_VISIT_LIFECYCLE_LOAD_DISPATCH,
  DOCUMENT_VISIT_LIFECYCLE_RELOAD_DISPATCH,
  DOCUMENT_VISIT_LIFECYCLE_RENDER_DISPATCH,
  DOCUMENT_VISIT_LIFECYCLE_VISIT_DISPATCH,
  DocumentLoadEvent,
  DocumentReloadEvent,
  DocumentRenderEvent,
  DocumentVisitLifecycle,
  documentVisitLifecycleOption,
  LinkClickEvent,
  VisitEvent,
} from "./document-visit-lifecycle"
import { PropsError, StateError } from "./errors"

function capturedError(operation: () => unknown): Error {
  try {
    operation()
  } catch (error) {
    if (error instanceof Error) return error
  }
  throw new Error("Expected operation to throw an Error")
}

function surfacedErrors(operation: () => unknown): Error[] {
  const scheduled: (() => void)[] = []
  const original = globalThis.queueMicrotask
  globalThis.queueMicrotask = (callback) => {
    scheduled.push(callback)
  }
  try {
    operation()
  } finally {
    globalThis.queueMicrotask = original
  }
  return scheduled.map((callback) => capturedError(callback))
}

describe("document visit lifecycle", () => {
  test("freezes native click detail and makes cancellation irreversible", () => {
    const lifecycle = new DocumentVisitLifecycle()
    const event = new LinkClickEvent("link-key", "https://example.test/next")
    lifecycle.subscribe("click", (received) => {
      expect(received).toBe(event)
      expect(received.detail).toEqual({
        nodeKey: "link-key",
        url: "https://example.test/next",
      })
      expect(Object.isFrozen(received)).toBe(true)
      expect(Object.isFrozen(received.detail)).toBe(true)
      received.preventDefault()
      expect(() => Object.defineProperty(received, "defaultPrevented", { value: false })).toThrow()
    })

    expect(lifecycle[DOCUMENT_VISIT_LIFECYCLE_CLICK_DISPATCH](event)).toBe(event)
    expect(event.defaultPrevented).toBe(true)
  })

  test("keeps click cancellation when a hostile listener poisons WeakSet intrinsics", () => {
    const lifecycle = new DocumentVisitLifecycle()
    const add = Object.getOwnPropertyDescriptor(WeakSet.prototype, "add")
    const has = Object.getOwnPropertyDescriptor(WeakSet.prototype, "has")
    if (!add || !has) throw new Error("WeakSet intrinsic descriptors are unavailable")

    lifecycle.subscribe("click", (event) => {
      Object.defineProperties(WeakSet.prototype, {
        add: {
          ...add,
          value: function poisonedAdd() {
            return this
          },
        },
        has: { ...has, value: () => false },
      })
      try {
        event.preventDefault()
      } finally {
        Object.defineProperties(WeakSet.prototype, { add, has })
      }
    })

    const event = lifecycle[DOCUMENT_VISIT_LIFECYCLE_CLICK_DISPATCH](
      new LinkClickEvent("link-key", "https://example.test/next"),
    )
    expect(event.defaultPrevented).toBe(true)
  })

  test("freezes native before-prefetch detail and makes cancellation irreversible", () => {
    const lifecycle = new DocumentVisitLifecycle()
    const event = new BeforePrefetchEvent("link-key", "https://example.test/next")
    lifecycle.subscribe("before-prefetch", (received) => {
      expect(received).toBe(event)
      expect(received.detail).toEqual({
        nodeKey: "link-key",
        url: "https://example.test/next",
      })
      expect(Object.isFrozen(received)).toBe(true)
      expect(Object.isFrozen(received.detail)).toBe(true)
      received.preventDefault()
      expect(() => Object.defineProperty(received, "defaultPrevented", { value: false })).toThrow()
    })

    expect(lifecycle[DOCUMENT_VISIT_LIFECYCLE_BEFORE_PREFETCH_DISPATCH](event)).toBe(event)
    expect(event.defaultPrevented).toBe(true)
  })

  test("uses stable click listener snapshots and rejects asynchronous or failing listeners", () => {
    const lifecycle = new DocumentVisitLifecycle()
    const calls: string[] = []
    const late = () => {
      calls.push("late")
      return undefined
    }
    let removeSecond: () => void = () => undefined
    lifecycle.subscribe("click", () => {
      calls.push("first")
      removeSecond()
      lifecycle.subscribe("click", late)
    })
    removeSecond = lifecycle.subscribe("click", () => {
      calls.push("second")
    })
    lifecycle[DOCUMENT_VISIT_LIFECYCLE_CLICK_DISPATCH](
      new LinkClickEvent("one", "https://example.test/one"),
    )
    expect(calls).toEqual(["first", "second"])

    calls.length = 0
    lifecycle[DOCUMENT_VISIT_LIFECYCLE_CLICK_DISPATCH](
      new LinkClickEvent("two", "https://example.test/two"),
    )
    expect(calls).toEqual(["first", "late"])

    const privateUrl = "https://example.test/private?token=secret"
    const thrown = new DocumentVisitLifecycle()
    thrown.subscribe("click", () => {
      throw new Error(privateUrl)
    })
    const thrownError = capturedError(() =>
      thrown[DOCUMENT_VISIT_LIFECYCLE_CLICK_DISPATCH](
        new LinkClickEvent("private-link", privateUrl),
      ),
    )
    expect(thrownError).toBeInstanceOf(StateError)
    expect(thrownError.message).toBe("Click listener failed")
    expect(String(thrownError)).not.toContain("secret")

    for (const value of [false, null, 0, "", Promise.resolve(undefined)]) {
      const invalid = new DocumentVisitLifecycle()
      invalid.subscribe("click", (() => value) as never)
      const invalidError = capturedError(() =>
        invalid[DOCUMENT_VISIT_LIFECYCLE_CLICK_DISPATCH](
          new LinkClickEvent("private-link", privateUrl),
        ),
      )
      expect(invalidError).toBeInstanceOf(StateError)
      expect(invalidError.message).toBe("Click listener must return undefined")
      expect(String(invalidError)).not.toContain("secret")
    }
  })

  test("redacts hostile click thenables that poison WeakSet intrinsics", () => {
    const lifecycle = new DocumentVisitLifecycle()
    const has = Object.getOwnPropertyDescriptor(WeakSet.prototype, "has")
    if (!has) throw new Error("WeakSet has descriptor is unavailable")
    lifecycle.subscribe("click", (() => ({
      // biome-ignore lint/suspicious/noThenProperty: This deliberately exercises a hostile thenable.
      get then() {
        Object.defineProperty(WeakSet.prototype, "has", {
          ...has,
          value: () => {
            throw new Error("private click-thenable secret")
          },
        })
        return () => undefined
      },
    })) as never)

    try {
      const error = capturedError(() =>
        lifecycle[DOCUMENT_VISIT_LIFECYCLE_CLICK_DISPATCH](
          new LinkClickEvent("private-link", "https://example.test/private?token=secret"),
        ),
      )
      expect(error).toBeInstanceOf(StateError)
      expect(error.message).toBe("Click listener failed")
      expect(String(error)).not.toContain("secret")
    } finally {
      Object.defineProperty(WeakSet.prototype, "has", has)
    }
  })

  test("uses stable before-prefetch listener snapshots and redacts invalid listeners", () => {
    const lifecycle = new DocumentVisitLifecycle()
    const calls: string[] = []
    const late = () => {
      calls.push("late")
      return undefined
    }
    let removeSecond: () => void = () => undefined
    lifecycle.subscribe("before-prefetch", () => {
      calls.push("first")
      removeSecond()
      lifecycle.subscribe("before-prefetch", late)
    })
    removeSecond = lifecycle.subscribe("before-prefetch", () => {
      calls.push("second")
    })
    lifecycle[DOCUMENT_VISIT_LIFECYCLE_BEFORE_PREFETCH_DISPATCH](
      new BeforePrefetchEvent("one", "https://example.test/one"),
    )
    expect(calls).toEqual(["first", "second"])

    calls.length = 0
    lifecycle[DOCUMENT_VISIT_LIFECYCLE_BEFORE_PREFETCH_DISPATCH](
      new BeforePrefetchEvent("two", "https://example.test/two"),
    )
    expect(calls).toEqual(["first", "late"])

    const url = "https://example.test/private?token=secret"
    const thrown = new DocumentVisitLifecycle()
    thrown.subscribe("before-prefetch", () => {
      throw new Error(url)
    })
    const listenerError = capturedError(() =>
      thrown[DOCUMENT_VISIT_LIFECYCLE_BEFORE_PREFETCH_DISPATCH](
        new BeforePrefetchEvent("private-link", url),
      ),
    )
    expect(listenerError).toBeInstanceOf(StateError)
    expect(listenerError.message).toBe("Before-prefetch listener failed")
    expect(String(listenerError)).not.toContain("secret")

    for (const value of [false, null, 0, "", Promise.resolve(undefined)]) {
      const invalid = new DocumentVisitLifecycle()
      invalid.subscribe("before-prefetch", (() => value) as never)
      const invalidError = capturedError(() =>
        invalid[DOCUMENT_VISIT_LIFECYCLE_BEFORE_PREFETCH_DISPATCH](
          new BeforePrefetchEvent("private-link", url),
        ),
      )
      expect(invalidError).toBeInstanceOf(StateError)
      expect(invalidError.message).toBe("Before-prefetch listener must return undefined")
      expect(String(invalidError)).not.toContain("secret")
    }
  })

  test("freezes event details and exposes before-visit cancellation", () => {
    const lifecycle = new DocumentVisitLifecycle()
    const beforeVisit = new BeforeVisitEvent("https://example.test/next")
    const visit = new VisitEvent("https://example.test/next", "advance")
    lifecycle.subscribe("before-visit", (event) => {
      expect(event.detail).toEqual({ url: "https://example.test/next" })
      expect(Object.isFrozen(event.detail)).toBe(true)
      event.preventDefault()
    })

    expect(lifecycle[DOCUMENT_VISIT_LIFECYCLE_BEFORE_DISPATCH](beforeVisit)).toBe(beforeVisit)
    expect(beforeVisit.defaultPrevented).toBe(true)
    expect(visit.detail).toEqual({
      action: "advance",
      direction: "forward",
      url: "https://example.test/next",
    })
    expect(Object.isFrozen(visit.detail)).toBe(true)
  })

  test("exposes frozen native document render, load, and reload notifications", () => {
    const lifecycle = new DocumentVisitLifecycle()
    const events: string[] = []
    lifecycle.subscribe("render", (event) => {
      events.push(event.type)
      expect(event.detail).toEqual({
        generation: 4,
        preview: false,
        renderMethod: "replace",
        url: "https://example.test/next",
      })
      expect(Object.isFrozen(event)).toBe(true)
      expect(Object.isFrozen(event.detail)).toBe(true)
      return undefined
    })
    lifecycle.subscribe("load", (event) => {
      events.push(event.type)
      expect(event.detail).toEqual({ generation: 4, url: "https://example.test/next" })
      expect(Object.isFrozen(event)).toBe(true)
      expect(Object.isFrozen(event.detail)).toBe(true)
      return undefined
    })
    lifecycle.subscribe("reload", (event) => {
      events.push(event.type)
      expect(event.detail).toEqual({ cause: "transport", reason: "request-failed" })
      expect(Object.isFrozen(event)).toBe(true)
      expect(Object.isFrozen(event.detail)).toBe(true)
      return undefined
    })

    lifecycle[DOCUMENT_VISIT_LIFECYCLE_RENDER_DISPATCH](
      new DocumentRenderEvent({
        generation: 4,
        preview: false,
        renderMethod: "replace",
        url: "https://example.test/next",
      }),
    )
    lifecycle[DOCUMENT_VISIT_LIFECYCLE_LOAD_DISPATCH](
      new DocumentLoadEvent({ generation: 4, url: "https://example.test/next" }),
    )
    lifecycle[DOCUMENT_VISIT_LIFECYCLE_RELOAD_DISPATCH](
      new DocumentReloadEvent({ cause: "transport", reason: "request-failed" }),
    )

    expect(events).toEqual(["render", "load", "reload"])
  })

  test("emits frozen before-cache notifications through stable listener snapshots", async () => {
    const reported: AggregateError[] = []
    const lifecycle = new DocumentVisitLifecycle({
      onObserverError(error) {
        reported.push(error)
        return undefined
      },
    })
    const calls: string[] = []
    const late = () => {
      calls.push("late")
      return undefined
    }
    let removeSecond: () => void = () => undefined
    lifecycle.subscribe("before-cache", (event) => {
      calls.push("first")
      expect(event.type).toBe("before-cache")
      expect(event.detail).toBeUndefined()
      expect(Object.isFrozen(event)).toBe(true)
      removeSecond()
      lifecycle.subscribe("before-cache", late)
    })
    removeSecond = lifecycle.subscribe("before-cache", () => {
      calls.push("second")
      throw new Error("private cache observer failure")
    })

    expect(
      lifecycle[DOCUMENT_VISIT_LIFECYCLE_BEFORE_CACHE_DISPATCH](new BeforeCacheEvent()),
    ).toBeUndefined()
    expect(calls).toEqual(["first", "second"])
    expect(reported).toHaveLength(1)
    expect(reported[0]?.errors).toHaveLength(1)
    expect(reported[0]?.errors[0]).toBeInstanceOf(StateError)
    expect(reported[0]?.errors[0]?.message).toBe("Before-cache listener failed")
    expect(String(reported[0]?.errors[0])).not.toContain("private")

    calls.length = 0
    lifecycle[DOCUMENT_VISIT_LIFECYCLE_BEFORE_CACHE_DISPATCH](new BeforeCacheEvent())
    expect(calls).toEqual(["first", "late"])
    await Promise.resolve()
  })

  test("uses stable listener snapshots across synchronous dispatches", () => {
    const lifecycle = new DocumentVisitLifecycle()
    const calls: string[] = []
    const late = () => {
      calls.push("late")
      return undefined
    }
    let removeSecond: () => void = () => undefined
    lifecycle.subscribe("before-visit", () => {
      calls.push("first")
      removeSecond()
      lifecycle.subscribe("before-visit", late)
    })
    removeSecond = lifecycle.subscribe("before-visit", () => {
      calls.push("second")
    })

    lifecycle[DOCUMENT_VISIT_LIFECYCLE_BEFORE_DISPATCH](
      new BeforeVisitEvent("https://example.test/one"),
    )
    expect(calls).toEqual(["first", "second"])

    calls.length = 0
    lifecycle[DOCUMENT_VISIT_LIFECYCLE_BEFORE_DISPATCH](
      new BeforeVisitEvent("https://example.test/two"),
    )
    expect(calls).toEqual(["first", "late"])

    calls.length = 0
    let removeVisit: () => void = () => undefined
    lifecycle.subscribe("visit", () => {
      calls.push("visit-first")
      removeVisit()
      lifecycle.subscribe("visit", () => {
        calls.push("visit-late")
      })
    })
    removeVisit = lifecycle.subscribe("visit", () => {
      calls.push("visit-second")
    })
    lifecycle[DOCUMENT_VISIT_LIFECYCLE_VISIT_DISPATCH](
      new VisitEvent("https://example.test/two", "advance"),
    )
    expect(calls).toEqual(["visit-first", "visit-second"])
  })

  test("redacts before-visit listener failures and rejects every non-undefined return", () => {
    const url = "https://example.test/private?token=secret"
    const thrown = new DocumentVisitLifecycle()
    thrown.subscribe("before-visit", () => {
      throw new Error(`leaked ${url}`)
    })

    const listenerError = capturedError(() =>
      thrown[DOCUMENT_VISIT_LIFECYCLE_BEFORE_DISPATCH](new BeforeVisitEvent(url)),
    )
    expect(listenerError).toBeInstanceOf(StateError)
    expect(listenerError.message).toBe("Before-visit listener failed")
    expect(listenerError.cause).toBeUndefined()
    expect(String(listenerError)).not.toContain(url)
    expect(String(listenerError)).not.toContain("secret")

    for (const value of [false, null, 0, "", Promise.resolve(undefined)]) {
      const invalid = new DocumentVisitLifecycle()
      invalid.subscribe("before-visit", (() => value) as never)
      const invalidError = capturedError(() =>
        invalid[DOCUMENT_VISIT_LIFECYCLE_BEFORE_DISPATCH](new BeforeVisitEvent(url)),
      )
      expect(invalidError).toBeInstanceOf(StateError)
      expect(invalidError.message).toBe("Before-visit listener must return undefined")
      expect(invalidError.cause).toBeUndefined()
    }

    const rejection = {
      // biome-ignore lint/suspicious/noThenProperty: This deliberately exercises a rejected thenable.
      then(_resolve: (value: never) => void, reject: (error: unknown) => void) {
        reject(new Error(`rejected ${url}`))
      },
    }
    const rejected = new DocumentVisitLifecycle()
    rejected.subscribe("before-visit", (() => rejection) as never)
    expect(() =>
      rejected[DOCUMENT_VISIT_LIFECYCLE_BEFORE_DISPATCH](new BeforeVisitEvent(url)),
    ).toThrow("Before-visit listener must return undefined")
  })

  test("reports redacted visit observer faults without interrupting notification", async () => {
    const url = "https://example.test/private?token=secret"
    const reported: AggregateError[] = []
    const calls: string[] = []
    const lifecycle = new DocumentVisitLifecycle({
      onObserverError(error) {
        reported.push(error)
        return undefined
      },
    })
    lifecycle.subscribe("visit", () => {
      calls.push("first")
      throw new Error(`leaked ${url}`)
    })
    lifecycle.subscribe("visit", (() => {
      calls.push("second")
      return Promise.reject(new Error(`rejected ${url}`))
    }) as never)
    lifecycle.subscribe("visit", () => {
      calls.push("third")
    })

    expect(
      lifecycle[DOCUMENT_VISIT_LIFECYCLE_VISIT_DISPATCH](new VisitEvent(url, "replace")),
    ).toBeUndefined()
    expect(calls).toEqual(["first", "second", "third"])
    expect(reported).toHaveLength(1)
    expect(reported[0]?.message).toBe("Document visit notification observers failed")
    expect(reported[0]?.errors).toHaveLength(2)
    for (const error of reported[0]?.errors ?? []) {
      expect(error).toBeInstanceOf(StateError)
      expect(error.message).toBe("Visit listener failed")
      expect(error.cause).toBeUndefined()
      expect(String(error)).not.toContain(url)
      expect(String(error)).not.toContain("secret")
    }
    await Promise.resolve()
  })

  test("surfaces unhandled and reporter failures asynchronously through redacted errors", async () => {
    const unreported = new DocumentVisitLifecycle()
    unreported.subscribe("visit", () => {
      throw new Error("secret unreported listener failure")
    })
    const unreportedErrors = surfacedErrors(() =>
      unreported[DOCUMENT_VISIT_LIFECYCLE_VISIT_DISPATCH](
        new VisitEvent("https://example.test/unreported", "advance"),
      ),
    )
    expect(unreportedErrors).toHaveLength(1)
    expect(unreportedErrors[0]).toBeInstanceOf(AggregateError)
    expect(unreportedErrors[0]?.message).toBe("Document visit notification observers failed")

    const thrown = new DocumentVisitLifecycle({
      onObserverError() {
        throw new Error("secret reporter failure")
      },
    })
    thrown.subscribe("visit", () => {
      throw new Error("secret listener failure")
    })
    const thrownErrors = surfacedErrors(() =>
      thrown[DOCUMENT_VISIT_LIFECYCLE_VISIT_DISPATCH](
        new VisitEvent("https://example.test/one", "advance"),
      ),
    )
    expect(thrownErrors).toHaveLength(1)
    expect(thrownErrors[0]).toBeInstanceOf(AggregateError)
    expect(thrownErrors[0]?.message).toBe("Document visit notification observer reporting failed")
    expect(String(thrownErrors[0])).not.toContain("secret")

    const rejected = new DocumentVisitLifecycle({
      onObserverError() {
        return Promise.reject(new Error("secret reporter rejection")) as never
      },
    })
    rejected.subscribe("visit", (() => false) as never)
    const rejectedErrors = surfacedErrors(() =>
      rejected[DOCUMENT_VISIT_LIFECYCLE_VISIT_DISPATCH](
        new VisitEvent("https://example.test/two", "replace"),
      ),
    )
    expect(rejectedErrors).toHaveLength(1)
    expect(rejectedErrors[0]?.message).toBe("Document visit notification observer reporting failed")
    expect(String(rejectedErrors[0])).not.toContain("secret")
    await Promise.resolve()
  })

  test("rejects invalid subscriptions and lifecycle options without leaking values", () => {
    const lifecycle = new DocumentVisitLifecycle()
    const typeError = capturedError(() =>
      lifecycle.subscribe("secret-event" as "visit", () => undefined),
    )
    expect(typeError).toBeInstanceOf(StateError)
    expect(typeError.message).toBe("Document visit lifecycle event type is invalid")
    expect(typeError.cause).toBeUndefined()

    const listenerError = capturedError(() => lifecycle.subscribe("visit", null as never))
    expect(listenerError).toBeInstanceOf(StateError)
    expect(listenerError.message).toBe("Document visit lifecycle listener must be a function")
    expect(listenerError.cause).toBeUndefined()
    expect(() => new DocumentVisitLifecycle({ onObserverError: "secret" as never })).toThrow(
      PropsError,
    )
    const revokedConstructorOptions = Proxy.revocable({}, {})
    revokedConstructorOptions.revoke()
    expect(() => new DocumentVisitLifecycle(revokedConstructorOptions.proxy)).toThrow(
      "Document visit lifecycle options could not be read",
    )

    expect(admitDocumentVisitLifecycle(undefined, "invalid lifecycle")).toBeUndefined()
    expect(documentVisitLifecycleOption({ visitLifecycle: lifecycle }, "Test host")).toBe(lifecycle)
    expect(() => documentVisitLifecycleOption({ visitLifecycle: "secret" }, "Test host")).toThrow(
      "Test host visit lifecycle is invalid",
    )

    const revokedLifecycle = Proxy.revocable(lifecycle, {})
    revokedLifecycle.revoke()
    expect(() =>
      admitDocumentVisitLifecycle(revokedLifecycle.proxy, "Lifecycle is invalid"),
    ).toThrow("Lifecycle is invalid")

    const revokedOptions = Proxy.revocable({ visitLifecycle: lifecycle }, {})
    revokedOptions.revoke()
    expect(() => documentVisitLifecycleOption(revokedOptions.proxy, "Test host")).toThrow(
      "Test host options could not be read",
    )
  })
})
