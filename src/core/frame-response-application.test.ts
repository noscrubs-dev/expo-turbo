import { describe, expect, test } from "bun:test"

import { ParseError, StateError } from "./errors"
import {
  commitPreparedFrameMutation,
  prepareFrameMutation,
  prepareFrameResponse,
} from "./frame-response-application"
import { parseExpoTurboDocument } from "./parser"
import { DocumentSession } from "./session"
import { attributeValue, isElement } from "./tree"

function sessionFixture(): DocumentSession {
  return new DocumentSession(
    parseExpoTurboDocument(
      '<Gallery><Outside id="outside" /><turbo-frame id="details" src="/old"><Old id="old" /></turbo-frame><turbo-frame id="peer"><Peer id="peer-child" /></turbo-frame></Gallery>',
      { url: "https://example.test/current" },
    ),
  )
}

describe("prepared Frame mutations", () => {
  test("preserves the tree, Frame wrapper, and unrelated identities while retargeting URLs", () => {
    const session = sessionFixture()
    const tree = session.tree
    const frame = tree.getElementById("details")
    const outside = tree.getElementById("outside")
    const peer = tree.getElementById("peer")
    if (frame?.kind !== "frame" || !outside || !peer) throw new Error("invalid fixture")
    const revision = session.revision
    let documentNotifications = 0
    session.subscribe(tree.document.key, () => {
      documentNotifications += 1
    })

    const prepared = prepareFrameResponse(
      "details",
      '<turbo-frame id="details"><Loaded id="loaded" /></turbo-frame>',
    )
    const mutation = prepareFrameMutation(session, frame, prepared, {
      documentUrl: "https://example.test/final",
      finalUrl: "https://example.test/final/frame",
    })
    const preparedChild = prepared.responseFrame.children.find(isElement)
    if (!preparedChild) throw new Error("invalid prepared fixture")
    ;(preparedChild as unknown as { tagName: string }).tagName = "Tampered"

    expect(Object.isFrozen(mutation)).toBe(true)
    expect(session.tree).toBe(tree)
    expect(session.tree.document.url).toBe("https://example.test/current")
    expect(attributeValue(frame, "src")).toBe("/old")
    expect(frame.children.filter(isElement)[0]?.tagName).toBe("Old")

    commitPreparedFrameMutation(session, mutation)

    expect(session.tree).toBe(tree)
    expect(session.tree.getElementById("details")).toBe(frame)
    expect(session.tree.getElementById("outside")).toBe(outside)
    expect(session.tree.getElementById("peer")).toBe(peer)
    expect(session.tree.document.url).toBe("https://example.test/final")
    expect(attributeValue(frame, "src")).toBe("https://example.test/final/frame")
    expect(frame.children.filter(isElement)[0]?.tagName).toBe("Loaded")
    expect(session.revision).toBe(revision + 1)
    expect(documentNotifications).toBe(1)
    expect(() => commitPreparedFrameMutation(session, mutation)).toThrow(StateError)
  })

  test("rejects active-document ID collisions during preflight without mutating the session", () => {
    const session = sessionFixture()
    const frame = session.tree.getElementById("details")
    if (frame?.kind !== "frame") throw new Error("invalid fixture")
    const children = frame.children
    const revision = session.revision
    const prepared = prepareFrameResponse(
      "details",
      '<turbo-frame id="details"><Collision id="outside" /></turbo-frame>',
    )

    expect(() => prepareFrameMutation(session, frame, prepared)).toThrow(ParseError)
    expect(session.revision).toBe(revision)
    expect(frame.children).toBe(children)
    expect(attributeValue(frame, "src")).toBe("/old")
    expect(session.tree.document.url).toBe("https://example.test/current")
  })

  test("rejects a prepared mutation after any intervening session change", () => {
    const session = sessionFixture()
    const frame = session.tree.getElementById("details")
    if (frame?.kind !== "frame") throw new Error("invalid fixture")
    const children = frame.children
    const prepared = prepareFrameResponse(
      "details",
      '<turbo-frame id="details"><Loaded id="loaded" /></turbo-frame>',
    )
    const mutation = prepareFrameMutation(session, frame, prepared)

    session.setAttribute("id:outside", "tone", "changed")

    expect(() => commitPreparedFrameMutation(session, mutation)).toThrow(StateError)
    expect(() => commitPreparedFrameMutation(session, mutation)).toThrow(StateError)
    expect(frame.children).toBe(children)
    expect(session.tree.getElementById("loaded")).toBeUndefined()
  })
})
