import { describe, expect, test } from "bun:test"

import { FrameMissingError } from "./errors"
import { applyFrameResponse } from "./frames"
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
