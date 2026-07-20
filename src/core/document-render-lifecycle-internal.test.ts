import { describe, expect, test } from "bun:test"
import {
  acknowledgeDocumentRender,
  prepareDocumentRender,
  retainDocumentRenderer,
  subscribeDocumentRenderLifecycle,
} from "./document-render-lifecycle-internal"
import { DocumentVisitLifecycle } from "./document-visit-lifecycle"
import { StateError } from "./errors"
import { parseExpoTurboDocument } from "./parser"
import { DocumentSession } from "./session"

function tree(id: string) {
  return parseExpoTurboDocument(`<Screen id="${id}" />`, {
    url: `https://example.test/${id}`,
  })
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

describe("document render lifecycle coordination", () => {
  test("acknowledges one exact generation before settling its renderer", async () => {
    const session = new DocumentSession(tree("initial"))
    const lifecycle = new DocumentVisitLifecycle()
    const events: string[] = []
    lifecycle.subscribe("render", (event) => {
      events.push(`${event.type}:${event.detail.generation}:${event.detail.url}`)
    })
    const release = retainDocumentRenderer(session)
    const prepared = prepareDocumentRender(session, lifecycle, {
      preview: false,
      url: "https://example.test/next",
    })

    session.replaceTree(tree("next"))
    prepared.seal()
    expect(
      acknowledgeDocumentRender(session, session.tree.document, 0, session.revision),
    ).toBeUndefined()
    const acknowledgement = acknowledgeDocumentRender(
      session,
      session.tree.document,
      prepared.commit.generation,
      session.revision,
    )
    expect(events).toEqual(["render:1:https://example.test/next"])
    expect(prepared.outcome).toBeUndefined()

    acknowledgement?.finish()
    expect(await prepared.rendered).toBe("rendered")
    expect(
      acknowledgeDocumentRender(
        session,
        session.tree.document,
        prepared.commit.generation,
        session.revision,
      ),
    ).toBeUndefined()
    expect(events).toHaveLength(1)
    release()
  })

  test("releases history scroll once only after the exact rendered acknowledgement", async () => {
    const session = new DocumentSession(tree("initial"))
    const lifecycle = new DocumentVisitLifecycle()
    const release = retainDocumentRenderer(session)
    const position = Object.freeze({ x: 12, y: 34 })
    const prepared = prepareDocumentRender(session, lifecycle, {
      historyScroll: position,
      preview: false,
      url: "https://example.test/next",
    })

    session.replaceTree(tree("next"))
    prepared.seal()
    const acknowledgement = acknowledgeDocumentRender(
      session,
      session.tree.document,
      prepared.commit.generation,
      session.revision,
    )
    expect(acknowledgement?.consumeHistoryScroll()).toBeUndefined()
    expect(acknowledgement?.finish()).toBe(true)
    expect(acknowledgement?.consumeHistoryScroll()).toBe(position)
    expect(acknowledgement?.consumeHistoryScroll()).toBeUndefined()
    expect(await prepared.rendered).toBe("rendered")
    release()
  })

  test("supersedes an unseen generation and releases pending work on final renderer disposal", async () => {
    const session = new DocumentSession(tree("initial"))
    const lifecycle = new DocumentVisitLifecycle()
    const events: number[] = []
    lifecycle.subscribe("render", (event) => {
      events.push(event.detail.generation)
    })
    const release = retainDocumentRenderer(session)
    const first = prepareDocumentRender(session, lifecycle, {
      historyScroll: Object.freeze({ x: 1, y: 2 }),
      preview: false,
      url: "https://example.test/first",
    })
    session.replaceTree(tree("first"))
    const second = prepareDocumentRender(session, lifecycle, {
      preview: false,
      url: "https://example.test/second",
    })
    session.replaceTree(tree("second"))

    expect(await first.rendered).toBe("superseded")
    expect(
      acknowledgeDocumentRender(
        session,
        session.tree.document,
        first.commit.generation,
        session.revision,
      ),
    ).toBeUndefined()
    expect(events).toEqual([])

    release()
    await Promise.resolve()
    expect(await second.rendered).toBe("unavailable")
    expect(events).toEqual([])
  })

  test("keeps headless document work synchronous and reacquires after deferred disposal", async () => {
    const session = new DocumentSession(tree("initial"))
    const lifecycle = new DocumentVisitLifecycle()
    const headless = prepareDocumentRender(session, lifecycle, {
      preview: false,
      url: "https://example.test/headless",
    })
    expect(headless.outcome).toBe("unavailable")
    expect(await headless.rendered).toBe("unavailable")

    const release = retainDocumentRenderer(session)
    release()
    const keep = retainDocumentRenderer(session)
    await Promise.resolve()
    const prepared = prepareDocumentRender(session, lifecycle, {
      preview: false,
      url: "https://example.test/next",
    })
    session.replaceTree(tree("next"))
    prepared.seal()
    const acknowledgement = acknowledgeDocumentRender(
      session,
      session.tree.document,
      prepared.commit.generation,
      session.revision,
    )
    acknowledgement?.finish()
    expect(await prepared.rendered).toBe("rendered")
    keep()
  })

  test("waits for the response-owned revision seal before acknowledging", async () => {
    const session = new DocumentSession(tree("initial"))
    const lifecycle = new DocumentVisitLifecycle()
    const events: number[] = []
    lifecycle.subscribe("render", (event) => {
      events.push(event.detail.generation)
    })
    const release = retainDocumentRenderer(session)
    const prepared = prepareDocumentRender(session, lifecycle, {
      preview: false,
      url: "https://example.test/next",
    })

    session.replaceTree(tree("next"))
    const replacementRevision = session.revision
    expect(
      acknowledgeDocumentRender(
        session,
        session.tree.document,
        prepared.commit.generation,
        replacementRevision,
      ),
    ).toBeUndefined()

    const root = session.tree.getElementById("next")
    expect(root).toBeDefined()
    session.setAttribute(root?.key ?? "missing", "data-final", "true")
    prepared.seal()
    expect(
      acknowledgeDocumentRender(
        session,
        session.tree.document,
        prepared.commit.generation,
        replacementRevision,
      ),
    ).toBeUndefined()

    const acknowledgement = acknowledgeDocumentRender(
      session,
      session.tree.document,
      prepared.commit.generation,
      session.revision,
    )
    acknowledgement?.finish()

    expect(events).toEqual([prepared.commit.generation])
    expect(await prepared.rendered).toBe("rendered")
    release()
  })

  test("requires the exact current session revision before rendering", async () => {
    const session = new DocumentSession(tree("initial"))
    const lifecycle = new DocumentVisitLifecycle()
    const events: number[] = []
    lifecycle.subscribe("render", (event) => {
      events.push(event.detail.generation)
    })
    const release = retainDocumentRenderer(session)
    const prepared = prepareDocumentRender(session, lifecycle, {
      preview: false,
      url: "https://example.test/next",
    })

    session.replaceTree(tree("next"))
    prepared.seal()
    const sealedRevision = session.revision
    const next = session.tree.getElementById("next")
    expect(next).toBeDefined()
    session.setAttribute(next?.key ?? "missing", "data-after-seal", "true")

    expect(
      acknowledgeDocumentRender(
        session,
        session.tree.document,
        prepared.commit.generation,
        sealedRevision,
      ),
    ).toBeUndefined()
    expect(events).toEqual([])

    const acknowledgement = acknowledgeDocumentRender(
      session,
      session.tree.document,
      prepared.commit.generation,
      session.revision,
    )
    acknowledgement?.finish()

    expect(events).toEqual([prepared.commit.generation])
    expect(await prepared.rendered).toBe("rendered")
    release()
  })

  test("retries after a render observer advances the revision without duplicating render", async () => {
    const session = new DocumentSession(tree("initial"))
    const lifecycle = new DocumentVisitLifecycle()
    const events: number[] = []
    lifecycle.subscribe("render", (event) => {
      events.push(event.detail.generation)
      const next = session.tree.getElementById("next")
      session.setAttribute(next?.key ?? "missing", "data-observer", "true")
    })
    const release = retainDocumentRenderer(session)
    const prepared = prepareDocumentRender(session, lifecycle, {
      preview: false,
      url: "https://example.test/next",
    })

    session.replaceTree(tree("next"))
    prepared.seal()
    expect(
      acknowledgeDocumentRender(
        session,
        session.tree.document,
        prepared.commit.generation,
        session.revision,
      ),
    ).toBeUndefined()
    expect(events).toEqual([prepared.commit.generation])

    const acknowledgement = acknowledgeDocumentRender(
      session,
      session.tree.document,
      prepared.commit.generation,
      session.revision,
    )
    acknowledgement?.finish()

    expect(events).toEqual([prepared.commit.generation])
    expect(await prepared.rendered).toBe("rendered")
    release()
  })

  test("retries a stale acknowledgement finish without duplicating render", async () => {
    const session = new DocumentSession(tree("initial"))
    const lifecycle = new DocumentVisitLifecycle()
    const events: number[] = []
    lifecycle.subscribe("render", (event) => {
      events.push(event.detail.generation)
    })
    const release = retainDocumentRenderer(session)
    const prepared = prepareDocumentRender(session, lifecycle, {
      preview: false,
      url: "https://example.test/next",
    })

    session.replaceTree(tree("next"))
    prepared.seal()
    const acknowledgement = acknowledgeDocumentRender(
      session,
      session.tree.document,
      prepared.commit.generation,
      session.revision,
    )
    const next = session.tree.getElementById("next")
    session.setAttribute(next?.key ?? "missing", "data-after-render", "true")
    acknowledgement?.finish()

    const retry = acknowledgeDocumentRender(
      session,
      session.tree.document,
      prepared.commit.generation,
      session.revision,
    )
    retry?.finish()

    expect(events).toEqual([prepared.commit.generation])
    expect(await prepared.rendered).toBe("rendered")
    release()
  })

  test("isolates and redacts render seal subscriber faults", async () => {
    const session = new DocumentSession(tree("initial"))
    const lifecycle = new DocumentVisitLifecycle()
    const release = retainDocumentRenderer(session)
    const prepared = prepareDocumentRender(session, lifecycle, {
      preview: false,
      url: "https://example.test/next",
    })
    const notified: string[] = []
    subscribeDocumentRenderLifecycle(session, () => {
      throw new Error("secret render subscriber failure")
    })
    subscribeDocumentRenderLifecycle(session, () => {
      notified.push("healthy")
    })

    session.replaceTree(tree("next"))
    const errors = surfacedErrors(() => prepared.seal())
    expect(notified).toEqual(["healthy"])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toBeInstanceOf(AggregateError)
    expect(errors[0]?.message).toBe("Document render lifecycle subscribers failed")
    expect((errors[0] as AggregateError).errors[0]).toBeInstanceOf(StateError)
    expect(String(errors[0])).not.toContain("secret")

    const acknowledgement = acknowledgeDocumentRender(
      session,
      session.tree.document,
      prepared.commit.generation,
      session.revision,
    )
    acknowledgement?.finish()
    expect(await prepared.rendered).toBe("rendered")
    release()
  })
})
