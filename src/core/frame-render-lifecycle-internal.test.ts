import { describe, expect, test } from "bun:test"
import { StateError } from "./errors"
import { FrameLifecycle } from "./frame-lifecycle"
import {
  acknowledgeFrameRender,
  dispatchFrameLoad,
  dispatchFrameRender,
  frameRenderLifecycleRevision,
  hasFrameRenderTicket,
  prepareFrameRender,
  retainFrameRenderer,
  subscribeFrameRenderLifecycle,
} from "./frame-render-lifecycle-internal"
import { parseExpoTurboDocument } from "./parser"
import { DocumentSession } from "./session"
import type { ProtocolElement } from "./tree"

function tree(child = "Loading") {
  return parseExpoTurboDocument(
    `<Gallery><turbo-frame id="details"><${child} /></turbo-frame></Gallery>`,
    { url: "https://example.test/page" },
  )
}

function frame(session: DocumentSession): ProtocolElement {
  const target = session.tree.getElementById("details")
  if (target?.kind !== "frame") throw new Error("Expected details Frame")
  return target
}

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

describe("Frame render lifecycle coordination", () => {
  test("acknowledges one exact active Frame before settling render and load", async () => {
    const session = new DocumentSession(tree())
    const lifecycle = new FrameLifecycle()
    const events: string[] = []
    lifecycle.subscribe("frame-render", (event) => {
      events.push(`${event.type}:${event.detail.frameId}:${event.detail.url}`)
    })
    lifecycle.subscribe("frame-load", (event) => {
      events.push(`${event.type}:${event.detail.frameId}:${event.detail.url}`)
    })
    const target = frame(session)
    const release = retainFrameRenderer(session, target)
    const prepared = prepareFrameRender(session, {
      frame: target,
      frameId: "details",
      url: "https://example.test/frame",
    })

    session.setAttribute(target.key, "data-committed", "true")
    expect(frameRenderLifecycleRevision(session)).toBe(0)
    prepared.seal()
    expect(frameRenderLifecycleRevision(session)).toBe(1)
    expect(acknowledgeFrameRender(session, target, "other", session.revision)).toBeUndefined()
    const acknowledgement = acknowledgeFrameRender(session, target, "details", session.revision)

    expect(events).toEqual([])
    expect(prepared.outcome).toBeUndefined()
    acknowledgement?.finish()
    expect(await prepared.rendered).toBe("rendered")

    expect(dispatchFrameRender(lifecycle, prepared)).toBe(true)
    expect(dispatchFrameLoad(lifecycle, prepared)).toBe(true)
    expect(events).toEqual([
      "frame-render:details:https://example.test/frame",
      "frame-load:details:https://example.test/frame",
    ])
    release()
  })

  test("does not render a same-ID replacement from another tree generation", async () => {
    const session = new DocumentSession(tree())
    const lifecycle = new FrameLifecycle()
    const events: string[] = []
    lifecycle.subscribe("frame-render", (event) => {
      events.push(event.type)
    })
    const target = frame(session)
    const release = retainFrameRenderer(session, target)
    const prepared = prepareFrameRender(session, {
      frame: target,
      frameId: "details",
      url: "https://example.test/frame",
    })

    session.replaceTree(tree("Replacement"))
    prepared.seal()

    expect(await prepared.rendered).toBe("superseded")
    expect(hasFrameRenderTicket(session, frame(session), "details")).toBe(false)
    expect(events).toEqual([])
    release()
  })

  test("settles headless work immediately and tolerates deferred renderer disposal", async () => {
    const session = new DocumentSession(tree())
    const target = frame(session)
    const headless = prepareFrameRender(session, {
      frame: target,
      frameId: "details",
      url: "https://example.test/headless",
    })
    expect(headless.outcome).toBe("unavailable")
    expect(await headless.rendered).toBe("unavailable")

    const release = retainFrameRenderer(session, target)
    release()
    const keep = retainFrameRenderer(session, target)
    await Promise.resolve()
    const prepared = prepareFrameRender(session, {
      frame: target,
      frameId: "details",
      url: "https://example.test/frame",
    })
    session.setAttribute(target.key, "data-committed", "true")
    prepared.seal()
    acknowledgeFrameRender(session, target, "details", session.revision)?.finish()

    expect(await prepared.rendered).toBe("rendered")
    keep()
  })

  test("coordinates a mounted Frame without lifecycle observers", async () => {
    const session = new DocumentSession(tree())
    const target = frame(session)
    const release = retainFrameRenderer(session, target)
    const prepared = prepareFrameRender(session, {
      frame: target,
      frameId: "details",
      url: "https://example.test/frame",
    })

    session.setAttribute(target.key, "data-committed", "true")
    prepared.seal()
    expect(frameRenderLifecycleRevision(session)).toBe(1)

    acknowledgeFrameRender(session, target, "details", session.revision)?.finish()

    expect(await prepared.rendered).toBe("rendered")
    release()
  })

  test("settles a mounted ticket as unavailable after its final renderer releases", async () => {
    const session = new DocumentSession(tree())
    const target = frame(session)
    const release = retainFrameRenderer(session, target)
    const prepared = prepareFrameRender(session, {
      frame: target,
      frameId: "details",
      url: "https://example.test/frame",
    })

    release()
    await Promise.resolve()

    expect(await prepared.rendered).toBe("unavailable")
  })

  test("suppresses stale load after a render observer replaces the same-ID Frame", async () => {
    const session = new DocumentSession(tree())
    const lifecycle = new FrameLifecycle()
    const target = frame(session)
    const events: string[] = []
    lifecycle.subscribe("frame-render", (event) => {
      events.push(event.type)
      session.replaceTree(tree("Replacement"))
      return undefined
    })
    lifecycle.subscribe("frame-load", (event) => {
      events.push(event.type)
      return undefined
    })
    const release = retainFrameRenderer(session, target)
    const prepared = prepareFrameRender(session, {
      frame: target,
      frameId: "details",
      url: "https://example.test/frame",
    })

    session.setAttribute(target.key, "data-committed", "true")
    prepared.seal()
    acknowledgeFrameRender(session, target, "details", session.revision)?.finish()

    expect(await prepared.rendered).toBe("rendered")
    expect(dispatchFrameRender(lifecycle, prepared)).toBe(true)
    expect(dispatchFrameLoad(lifecycle, prepared)).toBe(false)
    expect(events).toEqual(["frame-render"])
    release()
  })

  test("suppresses stale load after a render observer releases the final renderer", async () => {
    const session = new DocumentSession(tree())
    const lifecycle = new FrameLifecycle()
    const target = frame(session)
    const events: string[] = []
    const release = retainFrameRenderer(session, target)
    lifecycle.subscribe("frame-render", (event) => {
      events.push(event.type)
      release()
      return undefined
    })
    lifecycle.subscribe("frame-load", (event) => {
      events.push(event.type)
      return undefined
    })
    const prepared = prepareFrameRender(session, {
      frame: target,
      frameId: "details",
      url: "https://example.test/frame",
    })

    session.setAttribute(target.key, "data-committed", "true")
    prepared.seal()
    acknowledgeFrameRender(session, target, "details", session.revision)?.finish()

    expect(await prepared.rendered).toBe("rendered")
    expect(dispatchFrameRender(lifecycle, prepared)).toBe(true)
    expect(dispatchFrameLoad(lifecycle, prepared)).toBe(false)
    expect(events).toEqual(["frame-render"])
  })

  test("suppresses autofocus for a canceled current Frame ticket", async () => {
    const session = new DocumentSession(tree())
    const target = frame(session)
    const release = retainFrameRenderer(session, target)
    const prepared = prepareFrameRender(session, {
      frame: target,
      frameId: "details",
      url: "https://example.test/frame",
    })

    session.setAttribute(target.key, "data-committed", "true")
    prepared.seal()
    prepared.cancel()

    expect(hasFrameRenderTicket(session, target, "details")).toBe(true)
    expect(await prepared.rendered).toBe("superseded")
    release()
  })

  test("marks a failed acknowledgement as non-focusable", async () => {
    const session = new DocumentSession(tree())
    const target = frame(session)
    const release = retainFrameRenderer(session, target)
    const prepared = prepareFrameRender(session, {
      frame: target,
      frameId: "details",
      url: "https://example.test/frame",
    })

    session.setAttribute(target.key, "data-committed", "true")
    prepared.seal()
    acknowledgeFrameRender(session, target, "details", session.revision)?.fail()

    expect(hasFrameRenderTicket(session, target, "details")).toBe(true)
    expect(await prepared.rendered).toBe("failed")
    release()
  })

  test("isolates and redacts render seal subscriber faults", async () => {
    const session = new DocumentSession(tree())
    const target = frame(session)
    const release = retainFrameRenderer(session, target)
    const prepared = prepareFrameRender(session, {
      frame: target,
      frameId: "details",
      url: "https://example.test/frame",
    })
    const notified: string[] = []
    subscribeFrameRenderLifecycle(session, () => {
      throw new Error("secret Frame subscriber failure")
    })
    subscribeFrameRenderLifecycle(session, () => {
      notified.push("healthy")
    })

    session.setAttribute(target.key, "data-committed", "true")
    const errors = surfacedErrors(() => prepared.seal())
    expect(notified).toEqual(["healthy"])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toBeInstanceOf(AggregateError)
    expect(errors[0]?.message).toBe("Frame render lifecycle subscribers failed")
    expect((errors[0] as AggregateError).errors[0]).toBeInstanceOf(StateError)
    expect(String(errors[0])).not.toContain("secret")

    acknowledgeFrameRender(session, target, "details", session.revision)?.finish()
    expect(await prepared.rendered).toBe("rendered")
    release()
  })
})
