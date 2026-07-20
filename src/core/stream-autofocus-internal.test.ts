import { describe, expect, test } from "bun:test"

import { parseExpoTurboDocument, parseTurboStreamFragment } from "./parser"
import { DocumentSession } from "./session"
import {
  consumeStandaloneStreamAutofocus,
  stageStandaloneStreamAutofocus,
  streamAutofocusLifecycleRevision,
  subscribeStreamAutofocusLifecycle,
} from "./stream-autofocus-internal"
import { StreamLifecycle } from "./stream-lifecycle"
import {
  dispatchEmbeddedTurboStreamElements,
  dispatchGuardedTurboStreamElements,
  dispatchTurboStreamFragment,
} from "./streams"
import { isElement, type ProtocolElement } from "./tree"

function sessionFor(xml: string): DocumentSession {
  return new DocumentSession(parseExpoTurboDocument(xml, { url: "https://example.test/document" }))
}

function streamElements(xml: string): readonly ProtocolElement[] {
  return parseTurboStreamFragment(xml).document.children.filter(
    (node): node is ProtocolElement => isElement(node) && node.kind === "stream",
  )
}

describe("standalone Stream autofocus", () => {
  test("claims the first eligible structural candidate in message order and consumes it once", () => {
    const session = sessionFor('<Gallery id="gallery" />')
    const revision = streamAutofocusLifecycleRevision(session)
    let notifications = 0
    const unsubscribe = subscribeStreamAutofocusLifecycle(session, () => {
      notifications += 1
    })

    const report = dispatchTurboStreamFragment(
      session,
      `<turbo-stream action="append" target="gallery"><template>
        <Field id="first" autofocus="" />
        <Field autofocus="" />
        <Field id="second" autofocus="false" />
      </template></turbo-stream>
      <turbo-stream action="after" target="first"><template>
        <Field id="third" autofocus="" />
      </template></turbo-stream>`,
    )
    unsubscribe()

    expect(report.actions.map((action) => action.status)).toEqual(["applied", "applied"])
    expect(streamAutofocusLifecycleRevision(session)).toBe(revision + 1)
    expect(notifications).toBe(1)
    expect(consumeStandaloneStreamAutofocus(session, session.revision)).toEqual(["id:first"])
    expect(consumeStandaloneStreamAutofocus(session, session.revision)).toBeUndefined()
  })

  test("retains the first live candidate across later standalone Stream messages", () => {
    const session = sessionFor('<Gallery id="gallery" />')

    dispatchTurboStreamFragment(
      session,
      '<turbo-stream action="append" target="gallery"><template><Field id="first" autofocus="" /></template></turbo-stream>',
    )
    const firstRevision = session.revision
    dispatchTurboStreamFragment(
      session,
      '<turbo-stream action="append" target="gallery"><template><Field id="unrelated" /></template></turbo-stream>',
    )
    dispatchTurboStreamFragment(
      session,
      '<turbo-stream action="append" target="gallery"><template><Field id="later" autofocus="" /></template></turbo-stream>',
    )

    expect(session.revision).toBeGreaterThan(firstRevision)
    expect(consumeStandaloneStreamAutofocus(session, firstRevision)).toBeUndefined()
    expect(consumeStandaloneStreamAutofocus(session, session.revision)).toEqual(["id:first"])
  })

  test("does not stage Stream autofocus for document or Frame-embedded stream elements", () => {
    const session = sessionFor('<Gallery id="gallery" />')
    const revision = streamAutofocusLifecycleRevision(session)

    const report = dispatchEmbeddedTurboStreamElements(
      session,
      streamElements(
        '<turbo-stream action="append" target="gallery"><template><Field id="embedded" autofocus="" /></template></turbo-stream>',
      ),
    )

    expect(report.actions).toMatchObject([{ status: "applied" }])
    expect(session.tree.getElementById("embedded")).toBeDefined()
    expect(streamAutofocusLifecycleRevision(session)).toBe(revision)
    expect(consumeStandaloneStreamAutofocus(session, session.revision)).toBeUndefined()
  })

  test("rejects stale render revisions and same-id replacement candidates", () => {
    const staleRevisionSession = sessionFor('<Gallery id="gallery" />')
    dispatchTurboStreamFragment(
      staleRevisionSession,
      '<turbo-stream action="append" target="gallery"><template><Field id="candidate" autofocus="" /></template></turbo-stream>',
    )
    const currentRevision = staleRevisionSession.revision

    expect(
      consumeStandaloneStreamAutofocus(staleRevisionSession, currentRevision - 1),
    ).toBeUndefined()
    expect(consumeStandaloneStreamAutofocus(staleRevisionSession, currentRevision)).toEqual([
      "id:candidate",
    ])

    const replacementSession = sessionFor(
      '<Gallery><Field id="candidate" autofocus="" /></Gallery>',
    )
    const candidate = replacementSession.tree.getElementById("candidate")
    if (!candidate) throw new Error("candidate fixture is missing")
    stageStandaloneStreamAutofocus(replacementSession, [candidate])
    const stagedRevision = replacementSession.revision
    const autofocusRevision = streamAutofocusLifecycleRevision(replacementSession)

    replacementSession.replaceTree(
      parseExpoTurboDocument('<Gallery><Field id="candidate" autofocus="" /></Gallery>', {
        url: "https://example.test/replacement",
      }),
    )

    expect(streamAutofocusLifecycleRevision(replacementSession)).toBe(autofocusRevision + 1)
    expect(consumeStandaloneStreamAutofocus(replacementSession, stagedRevision)).toBeUndefined()
    expect(
      consumeStandaloneStreamAutofocus(replacementSession, replacementSession.revision),
    ).toBeUndefined()
  })

  test("replaces an invalidated candidate with the next standalone Stream candidate", () => {
    const session = sessionFor('<Gallery id="gallery" />')
    dispatchTurboStreamFragment(
      session,
      '<turbo-stream action="append" target="gallery"><template><Field id="first" autofocus="" /></template></turbo-stream>',
    )
    dispatchTurboStreamFragment(session, '<turbo-stream action="remove" target="first" />')
    dispatchTurboStreamFragment(
      session,
      '<turbo-stream action="append" target="gallery"><template><Field id="second" autofocus="" /></template></turbo-stream>',
    )

    expect(consumeStandaloneStreamAutofocus(session, session.revision)).toEqual(["id:second"])
  })

  test("excludes morph, canceled, and no-op stream actions", () => {
    const morphSession = sessionFor('<Gallery><Panel id="panel" /></Gallery>')
    const morphReport = dispatchTurboStreamFragment(
      morphSession,
      '<turbo-stream action="replace" target="panel" method="morph"><template><Panel id="panel"><Field id="morph" autofocus="" /></Panel></template></turbo-stream>',
    )
    expect(morphReport.actions).toMatchObject([{ status: "applied" }])
    expect(morphSession.tree.getElementById("morph")).toBeDefined()
    expect(consumeStandaloneStreamAutofocus(morphSession, morphSession.revision)).toBeUndefined()

    const canceledSession = sessionFor('<Gallery id="gallery" />')
    const lifecycle = new StreamLifecycle()
    lifecycle.subscribe("before-stream-render", (event) => {
      event.preventDefault()
      return undefined
    })
    const canceledReport = dispatchTurboStreamFragment(
      canceledSession,
      '<turbo-stream action="append" target="gallery"><template><Field id="canceled" autofocus="" /></template></turbo-stream>',
      { streamLifecycle: lifecycle },
    )
    expect(canceledReport.actions).toMatchObject([{ status: "canceled" }])
    expect(canceledSession.tree.getElementById("canceled")).toBeUndefined()
    expect(
      consumeStandaloneStreamAutofocus(canceledSession, canceledSession.revision),
    ).toBeUndefined()

    const noopSession = sessionFor('<Gallery id="gallery" />')
    const noopReport = dispatchTurboStreamFragment(
      noopSession,
      '<turbo-stream action="append" target="missing"><template><Field id="missing-target" autofocus="" /></template></turbo-stream>',
    )
    expect(noopReport.actions).toMatchObject([{ status: "noop" }])
    expect(consumeStandaloneStreamAutofocus(noopSession, noopSession.revision)).toBeUndefined()

    const noFallbackSession = sessionFor('<Gallery id="gallery" />')
    const noFallbackReport = dispatchTurboStreamFragment(
      noFallbackSession,
      `<turbo-stream action="append" target="missing"><template><Field id="first" autofocus="" /></template></turbo-stream>
       <turbo-stream action="append" target="gallery"><template><Field id="later" autofocus="" /></template></turbo-stream>`,
    )
    expect(noFallbackReport.actions.map((action) => action.status)).toEqual(["noop", "applied"])
    expect(
      consumeStandaloneStreamAutofocus(noFallbackSession, noFallbackSession.revision),
    ).toBeUndefined()
  })

  test("does not stage autofocus after a guarded Stream message loses ownership", () => {
    const session = sessionFor('<Gallery id="gallery" />')
    const lifecycle = new StreamLifecycle()
    let active = true
    lifecycle.subscribe("stream-action", () => {
      active = false
      return undefined
    })

    const report = dispatchGuardedTurboStreamElements(
      session,
      streamElements(
        `<turbo-stream action="append" target="gallery"><template>
          <Field id="candidate" autofocus="" />
        </template></turbo-stream>
        <turbo-stream action="append" target="gallery"><template>
          <Field id="later" autofocus="" />
        </template></turbo-stream>`,
      ),
      { streamLifecycle: lifecycle },
      { shouldContinue: () => active },
    )

    expect(report).toMatchObject({ interrupted: true })
    expect(report.actions.map((action) => action.status)).toEqual(["applied"])
    expect(session.tree.getElementById("candidate")).toBeDefined()
    expect(session.tree.getElementById("later")).toBeUndefined()
    expect(consumeStandaloneStreamAutofocus(session, session.revision)).toBeUndefined()
  })
})
