import { describe, expect, test } from "bun:test"
import { FrameMissingError, PropsError, RequestError, StateError } from "./errors"
import {
  BeforeFrameMorphEvent,
  createBeforeFrameRenderEvent,
  createFrameMissingEvent,
  discardFrameMissingResponseBody,
  executeFrameMissingVisit,
  executeFrameVisitControlReload,
  FRAME_LIFECYCLE_BEFORE_MORPH_DISPATCH,
  FRAME_LIFECYCLE_BEFORE_RENDER_DISPATCH,
  FRAME_LIFECYCLE_LOAD_DISPATCH,
  FRAME_LIFECYCLE_MISSING_DISPATCH,
  FRAME_LIFECYCLE_RENDER_DISPATCH,
  FrameLifecycle,
  FrameLoadEvent,
  FrameMissingEvent,
  type FrameRenderContext,
  FrameRenderEvent,
  frameLifecycleOption,
  hasFrameMissingVisitIntent,
  waitUntilBeforeFrameRenderResumed,
} from "./frame-lifecycle"
import { parseExpoTurboDocument } from "./parser"

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

  test("emits frozen Frame render and load notifications", () => {
    const lifecycle = new FrameLifecycle()
    const events: string[] = []
    lifecycle.subscribe("frame-render", (event) => {
      events.push(event.type)
      expect(event.detail).toEqual({
        frameId: "details",
        renderMethod: "replace",
        url: "https://example.test/details",
      })
      expect(Object.isFrozen(event)).toBe(true)
      expect(Object.isFrozen(event.detail)).toBe(true)
      return undefined
    })
    lifecycle.subscribe("frame-load", (event) => {
      events.push(event.type)
      expect(event.detail).toEqual({
        frameId: "details",
        url: "https://example.test/details",
      })
      expect(Object.isFrozen(event)).toBe(true)
      expect(Object.isFrozen(event.detail)).toBe(true)
      return undefined
    })

    expect(
      lifecycle[FRAME_LIFECYCLE_RENDER_DISPATCH](
        new FrameRenderEvent({
          frameId: "details",
          renderMethod: "replace",
          url: "https://example.test/details",
        }),
      ),
    ).toBeUndefined()
    expect(
      lifecycle[FRAME_LIFECYCLE_LOAD_DISPATCH](
        new FrameLoadEvent({ frameId: "details", url: "https://example.test/details" }),
      ),
    ).toBeUndefined()

    expect(events).toEqual(["frame-render", "frame-load"])
  })

  test("emits frozen before-frame-morph handles through notification semantics", () => {
    const current = parseExpoTurboDocument(
      '<Gallery><turbo-frame id="details"><Current /></turbo-frame></Gallery>',
    ).getElementById("details")
    const incoming = parseExpoTurboDocument(
      '<Gallery><turbo-frame id="details"><Incoming /></turbo-frame></Gallery>',
    ).getElementById("details")
    if (current?.kind !== "frame" || incoming?.kind !== "frame") {
      throw new Error("Frame fixture is missing")
    }
    const lifecycle = new FrameLifecycle()
    const event = new BeforeFrameMorphEvent({
      currentFrame: current,
      frameId: "details",
      newFrame: incoming,
      url: "https://example.test/details",
    })
    let received: unknown
    lifecycle.subscribe("before-frame-morph", (value) => {
      received = value
      return undefined
    })

    expect(lifecycle[FRAME_LIFECYCLE_BEFORE_MORPH_DISPATCH](event)).toBeUndefined()
    expect(received).toBe(event)
    expect(event.type).toBe("before-frame-morph")
    expect(event.detail).toEqual({
      currentFrame: current,
      frameId: "details",
      newFrame: incoming,
      url: "https://example.test/details",
    })
    expect(Object.isFrozen(event)).toBe(true)
    expect(Object.isFrozen(event.detail)).toBe(true)
    expect(Object.isFrozen(event.detail.currentFrame)).toBe(true)
    expect(Object.isFrozen(event.detail.newFrame)).toBe(true)
  })

  test("selects a synchronous before-frame-render wrapper over frozen response metadata", () => {
    const response = parseExpoTurboDocument(
      '<Gallery><turbo-frame id="details"><Incoming /></turbo-frame></Gallery>',
    )
    const newFrame = response.getElementById("details")
    if (newFrame?.kind !== "frame") throw new Error("Frame fixture is missing")
    const lifecycle = new FrameLifecycle()
    const calls: string[] = []
    const first = (context: FrameRenderContext) => {
      calls.push("first")
      return context.renderDefault()
    }
    const second = (context: FrameRenderContext) => {
      calls.push("second")
      return context.renderDefault()
    }
    const event = createBeforeFrameRenderEvent(
      "details",
      newFrame,
      "https://example.test/details",
      (context) => context.renderDefault(),
      "morph",
    )

    lifecycle.subscribe("before-frame-render", (received) => {
      expect(received).toBe(event)
      expect(received.type).toBe("before-frame-render")
      expect(received.detail).toMatchObject({
        frameId: "details",
        newFrame,
        renderMethod: "morph",
        url: "https://example.test/details",
      })
      expect(Object.keys(received.detail).sort()).toEqual([
        "frameId",
        "newFrame",
        "renderMethod",
        "url",
      ])
      expect(Object.isFrozen(received)).toBe(true)
      expect(Object.isFrozen(received.detail)).toBe(true)
      expect(Object.isFrozen(received.detail.newFrame)).toBe(true)
      expect(typeof received.detail.render).toBe("function")
      received.detail.render = first
      received.detail.render = second
      return undefined
    })

    const renderer = lifecycle[FRAME_LIFECYCLE_BEFORE_RENDER_DISPATCH](event)
    expect(renderer).toBe(second)
    expect(
      renderer(
        Object.freeze({
          frameId: "details",
          newFrame,
          renderDefault() {
            calls.push("default")
            return undefined
          },
          renderMorph() {
            calls.push("morph")
            return undefined
          },
        }),
      ),
    ).toBeUndefined()
    expect(calls).toEqual(["second", "default"])
  })

  test("admits synchronous before-frame-render pauses that resume after dispatch", async () => {
    const response = parseExpoTurboDocument(
      '<Gallery><turbo-frame id="details"><Incoming /></turbo-frame></Gallery>',
    )
    const newFrame = response.getElementById("details")
    if (newFrame?.kind !== "frame") throw new Error("Frame fixture is missing")
    const lifecycle = new FrameLifecycle()
    const event = createBeforeFrameRenderEvent(
      "details",
      newFrame,
      "https://example.test/details",
      (context) => context.renderDefault(),
    )

    lifecycle.subscribe("before-frame-render", (received) => {
      received.pause()
      expect(received.paused).toBe(true)
      return undefined
    })

    lifecycle[FRAME_LIFECYCLE_BEFORE_RENDER_DISPATCH](event)
    let resumed = false
    void waitUntilBeforeFrameRenderResumed(event).then(() => {
      resumed = true
    })
    await Promise.resolve()
    expect(resumed).toBe(false)
    expect(() => event.pause()).toThrow("can no longer be paused")

    event.resume()
    await waitUntilBeforeFrameRenderResumed(event)
    await Promise.resolve()
    expect(event.paused).toBe(false)
    expect(resumed).toBe(true)
    expect(() => event.resume()).toThrow("is not paused")
  })

  test("requires synchronous undefined before-frame-render listeners and a function renderer", async () => {
    const response = parseExpoTurboDocument(
      '<Gallery><turbo-frame id="details"><Incoming /></turbo-frame></Gallery>',
    )
    const newFrame = response.getElementById("details")
    if (newFrame?.kind !== "frame") throw new Error("Frame fixture is missing")
    const create = () =>
      createBeforeFrameRenderEvent("details", newFrame, "https://example.test/details", (context) =>
        context.renderDefault(),
      )

    const invalidRenderer = new FrameLifecycle()
    invalidRenderer.subscribe("before-frame-render", (event) => {
      event.detail.render = null as never
      return undefined
    })
    expect(
      capturedError(() => invalidRenderer[FRAME_LIFECYCLE_BEFORE_RENDER_DISPATCH](create())),
    ).toMatchObject({
      code: "state",
      message: "Before-frame-render listener failed",
    })

    for (const result of [false, Promise.reject(new Error("private before-render result"))]) {
      const lifecycle = new FrameLifecycle()
      lifecycle.subscribe("before-frame-render", (() => result) as never)
      const error = capturedError(() => lifecycle[FRAME_LIFECYCLE_BEFORE_RENDER_DISPATCH](create()))
      expect(error).toMatchObject({
        code: "state",
        message: "Before-frame-render listener must return undefined",
      })
      expect(String(error)).not.toContain("private")
    }
    await Promise.resolve()
  })

  test("reports redacted render observer faults without interrupting notifications", async () => {
    const reported: AggregateError[] = []
    const lifecycle = new FrameLifecycle({
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
    lifecycle.subscribe("frame-render", () => {
      calls.push("first")
      removeSecond()
      lifecycle.subscribe("frame-render", late)
    })
    removeSecond = lifecycle.subscribe("frame-render", () => {
      calls.push("second")
      throw new Error("private Frame observer secret")
    })
    lifecycle.subscribe("frame-render", (() => {
      calls.push("third")
      return Promise.reject(new Error("private rejected Frame observer secret"))
    }) as never)

    lifecycle[FRAME_LIFECYCLE_RENDER_DISPATCH](
      new FrameRenderEvent({
        frameId: "details",
        renderMethod: "replace",
        url: "https://example.test/private?token=secret",
      }),
    )

    expect(calls).toEqual(["first", "second", "third"])
    expect(reported).toHaveLength(1)
    expect(reported[0]?.message).toBe("Frame lifecycle notification observers failed")
    expect(reported[0]?.errors).toHaveLength(2)
    for (const error of reported[0]?.errors ?? []) {
      expect(error).toBeInstanceOf(StateError)
      expect(error.message).toBe("Frame-render listener failed")
      expect(error.cause).toBeUndefined()
      expect(String(error)).not.toContain("secret")
    }

    calls.length = 0
    lifecycle[FRAME_LIFECYCLE_RENDER_DISPATCH](
      new FrameRenderEvent({
        frameId: "details",
        renderMethod: "replace",
        url: "https://example.test/details",
      }),
    )
    expect(calls).toEqual(["first", "third", "late"])
    await Promise.resolve()
  })

  test("surfaces unhandled and reporter failures asynchronously through redacted errors", async () => {
    const unreported = new FrameLifecycle()
    unreported.subscribe("frame-load", () => {
      throw new Error("secret unreported Frame observer failure")
    })
    const unreportedErrors = surfacedErrors(() =>
      unreported[FRAME_LIFECYCLE_LOAD_DISPATCH](
        new FrameLoadEvent({ frameId: "details", url: "https://example.test/details" }),
      ),
    )
    expect(unreportedErrors).toHaveLength(1)
    expect(unreportedErrors[0]).toBeInstanceOf(AggregateError)
    expect(unreportedErrors[0]?.message).toBe("Frame lifecycle notification observers failed")
    expect(String(unreportedErrors[0])).not.toContain("secret")

    const rejected = new FrameLifecycle({
      onObserverError() {
        return Promise.reject(new Error("secret Frame observer reporter rejection")) as never
      },
    })
    rejected.subscribe("frame-load", (() => false) as never)
    const rejectedErrors = surfacedErrors(() =>
      rejected[FRAME_LIFECYCLE_LOAD_DISPATCH](
        new FrameLoadEvent({ frameId: "details", url: "https://example.test/details" }),
      ),
    )
    expect(rejectedErrors).toHaveLength(1)
    expect(rejectedErrors[0]).toBeInstanceOf(AggregateError)
    expect(rejectedErrors[0]?.message).toBe(
      "Frame lifecycle notification observer reporting failed",
    )
    expect(String(rejectedErrors[0])).not.toContain("secret")
    await Promise.resolve()
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
    expect(() => new FrameLifecycle({ onObserverError: "private" as never })).toThrow(
      "Frame lifecycle error observer must be a function",
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
