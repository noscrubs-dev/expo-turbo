import { describe, expect, test } from "bun:test"

import { FrameMissingError, TargetError } from "./errors"
import { activeFrameAutofocusCandidates } from "./frame-response-application"
import { applyFrameResponse, resolveFormSubmissionDestination, resolveFrameTarget } from "./frames"
import { parseExpoTurboDocument } from "./parser"
import { DocumentSession } from "./session"
import { attributeValue, isElement } from "./tree"

function session(): DocumentSession {
  return new DocumentSession(
    parseExpoTurboDocument(
      '<Gallery><Notice id="notice"/><turbo-frame id="details" src="/old" target="_top"><Loading /></turbo-frame></Gallery>',
    ),
  )
}

describe("Turbo Frame responses", () => {
  test("extracts the exact frame, preserves its wrapper, and records the redirected src", () => {
    const document = session()
    const frame = document.tree.getElementById("details")
    if (!frame) throw new Error("fixture lost its active frame")
    const report = applyFrameResponse(
      document,
      "details",
      '<Page><Unrelated/><turbo-frame id="details" target="ignored"><Card id="card"/></turbo-frame></Page>',
      { finalUrl: "https://example.test/final" },
    )

    expect(document.tree.getElementById("details")).toBe(frame)
    expect(attributeValue(frame, "target")).toBe("_top")
    expect(attributeValue(frame, "src")).toBe("https://example.test/final")
    expect(frame.children.filter(isElement).map((child) => child.tagName)).toEqual(["Card"])
    expect(document.tree.getElementById("card")).toBeDefined()
    expect(report).toMatchObject({
      finalUrl: "https://example.test/final",
      frameId: "details",
    })
  })

  test("commits frame content before executing and consuming embedded Streams", () => {
    const document = session()
    const report = applyFrameResponse(
      document,
      "details",
      `<turbo-frame id="details">
         <Card id="new-card" />
         <turbo-stream action="remove" target="notice"></turbo-stream>
         <turbo-stream action="append" target="new-card"><template><Text id="stream-child" /></template></turbo-stream>
       </turbo-frame>`,
    )

    expect(report.streams.actions.map((action) => action.status)).toEqual(["applied", "applied"])
    expect(document.tree.getElementById("notice")).toBeUndefined()
    expect(document.tree.getElementById("stream-child")).toBeDefined()
    expect(
      document.tree.getElementById("details")?.children.some((child) => child.kind === "stream"),
    ).toBe(false)
  })

  test("reports ordered stable-id autofocus candidates that survive embedded Streams", () => {
    const document = session()
    applyFrameResponse(
      document,
      "details",
      `<turbo-frame id="details" autofocus="">
         <Field autofocus="" />
         <Field id="first" autofocus="" />
         <Group id="group">
           <Field id="removed" autofocus="false" />
           <Field id="second" autofocus="false" />
         </Group>
         <turbo-frame id="nested" autofocus="">
           <Field id="nested-field" autofocus="" />
         </turbo-frame>
         <template><Field id="deferred" autofocus="" /></template>
         <turbo-cable-stream-source id="source" autofocus="">
           <Field id="source-child" autofocus="" />
         </turbo-cable-stream-source>
         <turbo-stream action="remove" target="removed"></turbo-stream>
         <turbo-stream action="append" target="group">
           <template><Field id="inserted" autofocus="" /></template>
         </turbo-stream>
       </turbo-frame>`,
    )

    const frame = document.tree.getElementById("details")
    if (frame?.kind !== "frame") throw new Error("fixture lost its active Frame")
    const candidates = activeFrameAutofocusCandidates(document, frame)
    expect(candidates).toEqual(["id:first", "id:second", "id:inserted", "id:nested-field"])
    expect(Object.isFrozen(candidates)).toBe(true)
    expect(document.tree.getElementById("removed")).toBeUndefined()
    expect(document.tree.getElementById("deferred")).toBeDefined()
    expect(document.tree.getElementById("source-child")).toBeDefined()
  })

  test("fails without changing the active frame when the response omits it", () => {
    const document = session()
    const frame = document.tree.getElementById("details")
    const children = frame?.children

    expect(() =>
      applyFrameResponse(document, "details", '<Page><turbo-frame id="other"/></Page>'),
    ).toThrow(FrameMissingError)
    expect(frame?.children).toBe(children)
    expect(frame?.children.filter(isElement).map((child) => child.tagName)).toEqual(["Loading"])
  })

  test("fails loudly when the active frame itself is missing", () => {
    expect(() => applyFrameResponse(session(), "missing", '<turbo-frame id="missing"/>')).toThrow(
      FrameMissingError,
    )
  })
})

describe("Turbo Frame target resolution", () => {
  test("applies submitter, element, Frame default, and current-frame precedence", () => {
    const tree = parseExpoTurboDocument(
      `<Gallery>
        <turbo-frame id="named" />
        <turbo-frame id="outer">
          <turbo-frame id="current" target="named" />
        </turbo-frame>
      </Gallery>`,
    )

    expect(resolveFrameTarget(tree, "current")).toEqual({
      frameId: "named",
      kind: "frame",
      requestedTarget: "named",
    })
    expect(resolveFrameTarget(tree, "current", { elementTarget: "_self" })).toEqual({
      frameId: "current",
      kind: "frame",
      requestedTarget: "_self",
    })
    expect(
      resolveFrameTarget(tree, "current", {
        elementTarget: "named",
        submitterTarget: "_parent",
      }),
    ).toEqual({ frameId: "outer", kind: "frame", requestedTarget: "_parent" })
    expect(
      resolveFrameTarget(tree, "current", { elementTarget: "_parent", submitterTarget: "" }),
    ).toEqual({ frameId: "named", kind: "frame", requestedTarget: "named" })
  })

  test("promotes _top and unavailable or disabled parent targets", () => {
    const tree = parseExpoTurboDocument(
      `<Gallery>
        <turbo-frame id="disabled" disabled="" />
        <turbo-frame id="outer" disabled="">
          <turbo-frame id="current" />
        </turbo-frame>
        <turbo-frame id="top-level" />
      </Gallery>`,
    )

    expect(resolveFrameTarget(tree, "current", { elementTarget: "_top" })).toEqual({
      kind: "top",
      requestedTarget: "_top",
    })
    expect(resolveFrameTarget(tree, "current", { elementTarget: "_parent" })).toEqual({
      kind: "top",
      requestedTarget: "_parent",
    })
    expect(resolveFrameTarget(tree, "top-level", { elementTarget: "_parent" })).toEqual({
      kind: "top",
      requestedTarget: "_parent",
    })
    expect(resolveFrameTarget(tree, "current", { elementTarget: "disabled" })).toEqual({
      kind: "top",
      requestedTarget: "disabled",
    })
  })

  test("falls back to the current Frame for missing named targets", () => {
    const tree = parseExpoTurboDocument('<Gallery><turbo-frame id="current" /></Gallery>')

    expect(resolveFrameTarget(tree, "current", { elementTarget: "missing" })).toEqual({
      frameId: "current",
      kind: "frame",
      requestedTarget: "missing",
    })
    expect(() => resolveFrameTarget(tree, "missing")).toThrow(FrameMissingError)
  })
})

describe("native form submission destination resolution", () => {
  test("captures only an active enabled named Frame from document-level forms", () => {
    const tree = parseExpoTurboDocument(
      `<Gallery>
        <DemoForm id="form" />
        <turbo-frame id="named" />
        <turbo-frame id="alternate" />
        <turbo-frame id="disabled" disabled="" />
      </Gallery>`,
    )
    const form = tree.getElementById("form")
    if (!form) throw new Error("form fixture is missing")

    expect(resolveFormSubmissionDestination(tree, form)).toEqual({ kind: "document" })
    expect(
      resolveFormSubmissionDestination(tree, form, {
        formTarget: "named",
        submitterTarget: "",
      }),
    ).toEqual({ frameId: "named", kind: "frame", requestedTarget: "named" })
    expect(
      resolveFormSubmissionDestination(tree, form, {
        formTarget: "named",
        submitterTarget: "alternate",
      }),
    ).toEqual({ frameId: "alternate", kind: "frame", requestedTarget: "alternate" })
    for (const target of ["missing", "disabled", "_top", "_self", "_parent"]) {
      expect(resolveFormSubmissionDestination(tree, form, { formTarget: target })).toEqual({
        kind: "document",
        requestedTarget: target,
      })
    }
    expect(() => resolveFormSubmissionDestination(tree, form, null as never)).toThrow(TargetError)
    expect(() =>
      resolveFormSubmissionDestination(tree, form, { submitterTarget: 7 } as never),
    ).toThrow(TargetError)
    expect(() => resolveFormSubmissionDestination(tree, null as never)).toThrow(FrameMissingError)

    let targetReads = 0
    expect(() =>
      resolveFormSubmissionDestination(tree, form, {
        get formTarget() {
          targetReads += 1
          tree.removeNode(form)
          return "named"
        },
      }),
    ).toThrow(FrameMissingError)
    expect(targetReads).toBe(1)
  })

  test("uses Turbo's in-Frame blank-submitter and nearest-Frame semantics", () => {
    const tree = parseExpoTurboDocument(
      `<Gallery>
        <turbo-frame id="named" />
        <turbo-frame id="outer">
          <turbo-frame id="current" target="named">
            <DemoForm id="form" />
          </turbo-frame>
        </turbo-frame>
        <turbo-frame id="disabled-current" disabled="">
          <DemoForm id="disabled-form" />
        </turbo-frame>
      </Gallery>`,
    )
    const form = tree.getElementById("form")
    const disabledForm = tree.getElementById("disabled-form")
    if (!form || !disabledForm) throw new Error("form fixture is missing")

    expect(resolveFormSubmissionDestination(tree, form)).toEqual({
      frameId: "named",
      kind: "frame",
      requestedTarget: "named",
    })
    expect(
      resolveFormSubmissionDestination(tree, form, {
        formTarget: "_top",
        submitterTarget: "",
      }),
    ).toEqual({ frameId: "named", kind: "frame", requestedTarget: "named" })
    expect(
      resolveFormSubmissionDestination(tree, form, {
        formTarget: "named",
        submitterTarget: "_parent",
      }),
    ).toEqual({ frameId: "outer", kind: "frame", requestedTarget: "_parent" })
    expect(resolveFormSubmissionDestination(tree, form, { submitterTarget: "missing" })).toEqual({
      frameId: "current",
      kind: "frame",
      requestedTarget: "missing",
    })
    expect(resolveFormSubmissionDestination(tree, disabledForm, { formTarget: "named" })).toEqual({
      kind: "document",
      requestedTarget: "named",
    })
  })
})
