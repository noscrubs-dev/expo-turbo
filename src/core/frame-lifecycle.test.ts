import { describe, expect, test } from "bun:test"
import { FrameMissingError, PropsError, RequestError, StateError } from "./errors"
import {
  createFrameMissingEvent,
  discardFrameMissingResponseBody,
  executeFrameMissingVisit,
  executeFrameVisitControlReload,
  FRAME_LIFECYCLE_MISSING_DISPATCH,
  FrameLifecycle,
  FrameMissingEvent,
  frameLifecycleOption,
  hasFrameMissingVisitIntent,
} from "./frame-lifecycle"

function capturedError(operation: () => unknown): Error {
  try {
    operation()
  } catch (error) {
    if (error instanceof Error) return error
  }
  throw new Error("Expected operation to throw an Error")
}

async function capturedRejection(operation: () => Promise<unknown>): Promise<Error> {
  try {
    await operation()
  } catch (error) {
    if (error instanceof Error) return error
  }
  throw new Error("Expected operation to reject with an Error")
}

function missingEvent(body = '<PrivateCard token="secret" />'): FrameMissingEvent {
  return createFrameMissingEvent({
    body,
    frameId: "details",
    response: {
      redirected: true,
      status: 404,
      url: "https://example.test/private?token=secret",
    },
  })
}

describe("Frame lifecycle", () => {
  test("freezes the cancellable public event without exposing its response body", () => {
    const event = missingEvent()

    expect(event.type).toBe("frame-missing")
    expect(event.detail.frameId).toBe("details")
    expect(event.detail.response).toEqual({
      redirected: true,
      status: 404,
      url: "https://example.test/private?token=secret",
    })
    expect(Object.keys(event.detail).sort()).toEqual(["frameId", "response", "visit"])
    expect(JSON.stringify(event)).not.toContain("PrivateCard")
    expect(Object.isFrozen(event)).toBe(true)
    expect(Object.isFrozen(event.detail)).toBe(true)
    expect(Object.isFrozen(event.detail.response)).toBe(true)

    event.preventDefault()
    expect(event.defaultPrevented).toBe(true)
    expect(() => Object.defineProperty(event, "defaultPrevented", { value: false })).toThrow()
    event.preventDefault()
    expect(event.defaultPrevented).toBe(true)
  })

  test("uses stable listener snapshots", () => {
    const lifecycle = new FrameLifecycle()
    const calls: string[] = []
    const late = () => {
      calls.push("late")
      return undefined
    }
    let removeSecond: () => void = () => undefined
    lifecycle.subscribe("frame-missing", () => {
      calls.push("first")
      removeSecond()
      lifecycle.subscribe("frame-missing", late)
    })
    removeSecond = lifecycle.subscribe("frame-missing", () => {
      calls.push("second")
    })

    expect(lifecycle[FRAME_LIFECYCLE_MISSING_DISPATCH](missingEvent())).toBeInstanceOf(
      FrameMissingEvent,
    )
    expect(calls).toEqual(["first", "second"])

    calls.length = 0
    lifecycle[FRAME_LIFECYCLE_MISSING_DISPATCH](missingEvent())
    expect(calls).toEqual(["first", "late"])
  })

  test("requires synchronous undefined listeners and redacts failures", async () => {
    const privateValue = "private-listener-secret"
    const thrown = new FrameLifecycle()
    thrown.subscribe("frame-missing", () => {
      throw new Error(privateValue)
    })

    const thrownError = capturedError(() =>
      thrown[FRAME_LIFECYCLE_MISSING_DISPATCH](missingEvent()),
    )
    expect(thrownError).toBeInstanceOf(FrameMissingError)
    expect(thrownError.message).toBe("Frame-missing listener failed")
    expect(thrownError.cause).toBeUndefined()
    expect(String(thrownError)).not.toContain(privateValue)
    expect(String(thrownError)).not.toContain("token=secret")

    for (const result of [false, null, 0, "", Promise.reject(new Error(privateValue))]) {
      const invalid = new FrameLifecycle()
      invalid.subscribe("frame-missing", (() => result) as never)
      const error = capturedError(() => invalid[FRAME_LIFECYCLE_MISSING_DISPATCH](missingEvent()))
      expect(error).toBeInstanceOf(FrameMissingError)
      expect(error.message).toBe("Frame-missing listener must return undefined")
      expect(error.cause).toBeUndefined()
      expect(String(error)).not.toContain(privateValue)
      expect(String(error)).not.toContain("token=secret")
    }
    await Promise.resolve()
  })

  test("records the first visit intent and executes it only after prevented dispatch", async () => {
    const requests: unknown[] = []
    const lifecycle = new FrameLifecycle({
      visitResponse(request) {
        requests.push(request)
      },
    })
    lifecycle.subscribe("frame-missing", (event) => {
      event.detail.visit({ action: "replace" })
      event.detail.visit({ action: "advance" })
      expect(hasFrameMissingVisitIntent(event)).toBe(true)
      expect(requests).toHaveLength(0)
      event.preventDefault()
    })

    const event = missingEvent("<PrivateCard>trusted XML</PrivateCard>")
    lifecycle[FRAME_LIFECYCLE_MISSING_DISPATCH](event)
    expect(requests).toHaveLength(0)

    const firstExecution = executeFrameMissingVisit(lifecycle, event)
    const secondExecution = executeFrameMissingVisit(lifecycle, event)
    await Promise.all([firstExecution, secondExecution])

    expect(requests).toHaveLength(1)
    expect(requests[0]).toEqual({
      action: "replace",
      body: "<PrivateCard>trusted XML</PrivateCard>",
      frameId: "details",
      reason: "frame-missing",
      response: {
        redirected: true,
        status: 404,
        url: "https://example.test/private?token=secret",
      },
    })
    expect(Object.isFrozen(requests[0])).toBe(true)
    expect(Object.isFrozen((requests[0] as { response: object }).response)).toBe(true)
  })

  test("defaults visit intent to advance and does not execute an unprevented intent", async () => {
    const actions: string[] = []
    const lifecycle = new FrameLifecycle({
      visitResponse(request) {
        actions.push(request.action)
      },
    })
    const event = missingEvent()
    lifecycle.subscribe("frame-missing", (received) => {
      received.detail.visit()
    })

    lifecycle[FRAME_LIFECYCLE_MISSING_DISPATCH](event)
    expect(hasFrameMissingVisitIntent(event)).toBe(true)
    await executeFrameMissingVisit(lifecycle, event)
    expect(actions).toEqual([])

    event.preventDefault()
    await executeFrameMissingVisit(lifecycle, event)
    expect(actions).toEqual([])

    const prevented = missingEvent()
    prevented.detail.visit()
    prevented.preventDefault()
    await executeFrameMissingVisit(lifecycle, prevented)
    expect(actions).toEqual(["advance"])
  })

  test("discards hidden response bytes when terminal handling has no visitor", async () => {
    const calls: string[] = []
    const lifecycle = new FrameLifecycle({
      visitResponse(request) {
        calls.push(request.body)
      },
    })
    const discarded = missingEvent("discarded response body")
    discardFrameMissingResponseBody(discarded)
    discarded.preventDefault()
    discarded.detail.visit()
    expect(hasFrameMissingVisitIntent(discarded)).toBe(false)
    await executeFrameMissingVisit(lifecycle, discarded)

    const preventedWithoutVisit = missingEvent("unvisited response body")
    preventedWithoutVisit.preventDefault()
    await executeFrameMissingVisit(lifecycle, preventedWithoutVisit)
    preventedWithoutVisit.detail.visit()
    expect(hasFrameMissingVisitIntent(preventedWithoutVisit)).toBe(false)
    await executeFrameMissingVisit(lifecycle, preventedWithoutVisit)
    expect(calls).toEqual([])
  })

  test("redacts visitor failures and never retries an executed intent", async () => {
    let calls = 0
    const lifecycle = new FrameLifecycle({
      async visitResponse() {
        calls += 1
        throw new Error("private response body secret")
      },
    })
    const event = missingEvent()
    event.detail.visit()
    event.preventDefault()

    const first = await capturedRejection(() => executeFrameMissingVisit(lifecycle, event))
    const second = await capturedRejection(() => executeFrameMissingVisit(lifecycle, event))
    expect(calls).toBe(1)
    for (const error of [first, second]) {
      expect(error).toBeInstanceOf(RequestError)
      expect(error.message).toBe("Frame-missing response visit failed")
      expect(error.cause).toBeUndefined()
      expect(String(error)).not.toContain("secret")
    }
  })

  test("rejects unavailable response visitors and direct events without leaking metadata", async () => {
    const lifecycle = new FrameLifecycle()
    const event = new FrameMissingEvent("details", {
      redirected: false,
      status: 200,
      url: "https://example.test/private?token=secret",
    })
    event.detail.visit()
    event.preventDefault()

    const error = await capturedRejection(() => executeFrameMissingVisit(lifecycle, event))
    expect(error).toBeInstanceOf(RequestError)
    expect(error.message).toBe("Frame-missing response visit failed")
    expect(error.cause).toBeUndefined()
    expect(String(error)).not.toContain("secret")
  })

  test("executes automatic visit-control reload promotion through the trusted visitor", async () => {
    const requests: unknown[] = []
    const lifecycle = new FrameLifecycle({
      visitResponse(request) {
        requests.push(request)
      },
    })

    await executeFrameVisitControlReload(lifecycle, {
      body: '<Gallery data-turbo-visit-control="reload" />',
      frameId: "details",
      response: {
        redirected: true,
        status: 422,
        url: "https://example.test/final",
      },
    })

    expect(requests).toEqual([
      {
        action: "advance",
        body: '<Gallery data-turbo-visit-control="reload" />',
        frameId: "details",
        reason: "visit-control-reload",
        response: {
          redirected: true,
          status: 422,
          url: "https://example.test/final",
        },
      },
    ])
    expect(Object.isFrozen(requests[0])).toBe(true)
    expect(Object.isFrozen((requests[0] as { response: object }).response)).toBe(true)
  })

  test("redacts unavailable and failing visit-control reload visitors", async () => {
    for (const lifecycle of [
      new FrameLifecycle(),
      new FrameLifecycle({
        visitResponse() {
          throw new Error("private promotion secret")
        },
      }),
    ]) {
      const error = await capturedRejection(() =>
        executeFrameVisitControlReload(lifecycle, {
          body: "private response body",
          frameId: "details",
          response: {
            redirected: false,
            status: 500,
            url: "https://example.test/private?token=secret",
          },
        }),
      )
      expect(error).toBeInstanceOf(RequestError)
      expect(error.message).toBe("Frame visit-control response visit failed")
      expect(error.cause).toBeUndefined()
      expect(String(error)).not.toContain("private")
      expect(String(error)).not.toContain("secret")
    }
  })

  test("validates visit options before retaining an intent", () => {
    const event = missingEvent()
    expect(() => event.detail.visit({ action: "restore" as "advance" })).toThrow(
      "Frame-missing visit action is invalid",
    )
    expect(hasFrameMissingVisitIntent(event)).toBe(false)

    const revoked = Proxy.revocable({}, {})
    revoked.revoke()
    const error = capturedError(() => event.detail.visit(revoked.proxy))
    expect(error).toBeInstanceOf(FrameMissingError)
    expect(error.message).toBe("Frame-missing visit options could not be read")
  })

  test("admits only nominal Frame lifecycle options", () => {
    const lifecycle = new FrameLifecycle()
    expect(frameLifecycleOption({ frameLifecycle: lifecycle }, "Test host")).toBe(lifecycle)
    expect(frameLifecycleOption({}, "Test host")).toBeUndefined()
    expect(() => frameLifecycleOption({ frameLifecycle: {} }, "Test host")).toThrow(
      "Test host Frame lifecycle is invalid",
    )
    expect(() => frameLifecycleOption({ frameLifecycle: "private" }, "Test host")).toThrow(
      PropsError,
    )

    const revoked = Proxy.revocable({ frameLifecycle: lifecycle }, {})
    revoked.revoke()
    expect(() => frameLifecycleOption(revoked.proxy, "Test host")).toThrow(
      "Test host options could not be read",
    )
  })

  test("rejects invalid lifecycle construction and subscriptions", () => {
    expect(() => new FrameLifecycle({ visitResponse: "private" as never })).toThrow(
      "Frame lifecycle response visitor must be a function",
    )
    const revoked = Proxy.revocable({}, {})
    revoked.revoke()
    expect(() => new FrameLifecycle(revoked.proxy)).toThrow(
      "Frame lifecycle options could not be read",
    )

    const lifecycle = new FrameLifecycle()
    expect(() => lifecycle.subscribe("private" as "frame-missing", () => undefined)).toThrow(
      "Frame lifecycle event type is invalid",
    )
    expect(() => lifecycle.subscribe("frame-missing", null as never)).toThrow(
      "Frame lifecycle listener must be a function",
    )
    expect(capturedError(() => lifecycle.subscribe("frame-missing", null as never))).toBeInstanceOf(
      StateError,
    )
  })
})
