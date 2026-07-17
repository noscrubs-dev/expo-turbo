import { describe, expect, test } from "bun:test"

import { FrameMissingError } from "./errors"
import { applyFrameResponse, resolveFrameTarget } from "./frames"
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
