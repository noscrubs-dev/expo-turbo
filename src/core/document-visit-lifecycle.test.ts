import { describe, expect, test } from "bun:test"
import {
  admitDocumentVisitLifecycle,
  BeforeVisitEvent,
  DOCUMENT_VISIT_LIFECYCLE_BEFORE_DISPATCH,
  DOCUMENT_VISIT_LIFECYCLE_VISIT_DISPATCH,
  DocumentVisitLifecycle,
  documentVisitLifecycleOption,
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
      url: "https://example.test/next",
    })
    expect(Object.isFrozen(visit.detail)).toBe(true)
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
