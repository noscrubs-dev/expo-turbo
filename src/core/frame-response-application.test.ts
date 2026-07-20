import { describe, expect, test } from "bun:test"

import { ParseError, StateError } from "./errors"
import { FrameLifecycle } from "./frame-lifecycle"
import {
  commitPreparedFrameMutation,
  frameAutoscrollIntent,
  prepareFrameBeforeRender,
  prepareFrameMutation,
  prepareFrameResponse,
  renderPreparedFrameMutation,
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
  test("captures Frame autoscroll from either wrapper while retaining mounted settings", () => {
    const session = new DocumentSession(
      parseExpoTurboDocument(
        '<Gallery><turbo-frame id="details" data-autoscroll-behavior="smooth" data-autoscroll-block="center"><Old /></turbo-frame></Gallery>',
        { url: "https://example.test/current" },
      ),
    )
    const frame = session.tree.getElementById("details")
    if (frame?.kind !== "frame") throw new Error("invalid fixture")
    const prepared = prepareFrameResponse(
      "details",
      '<turbo-frame id="details" autoscroll="" data-autoscroll-behavior="auto" data-autoscroll-block="start"><Loaded /></turbo-frame>',
    )

    commitPreparedFrameMutation(session, prepareFrameMutation(session, frame, prepared))

    expect(frameAutoscrollIntent(session, frame, prepared)).toEqual({
      alignment: "center",
      behavior: "smooth",
      frameId: "details",
    })
  })

  test("defaults malformed mounted Frame autoscroll settings and treats presence as enabled", () => {
    const session = new DocumentSession(
      parseExpoTurboDocument(
        '<Gallery><turbo-frame id="details" autoscroll="false" data-autoscroll-behavior="instant" data-autoscroll-block="top"><Old /></turbo-frame></Gallery>',
        { url: "https://example.test/current" },
      ),
    )
    const frame = session.tree.getElementById("details")
    if (frame?.kind !== "frame") throw new Error("invalid fixture")
    const prepared = prepareFrameResponse(
      "details",
      '<turbo-frame id="details"><Loaded /></turbo-frame>',
    )

    commitPreparedFrameMutation(session, prepareFrameMutation(session, frame, prepared))

    expect(frameAutoscrollIntent(session, frame, prepared)).toEqual({
      alignment: "end",
      behavior: "auto",
      frameId: "details",
    })
  })

  test("does not create an autoscroll intent for Frames that did not request it", () => {
    const session = sessionFixture()
    const frame = session.tree.getElementById("details")
    if (frame?.kind !== "frame") throw new Error("invalid fixture")
    const prepared = prepareFrameResponse(
      "details",
      '<turbo-frame id="details"><Loaded /></turbo-frame>',
    )

    commitPreparedFrameMutation(session, prepareFrameMutation(session, frame, prepared))

    expect(frameAutoscrollIntent(session, frame, prepared)).toBeUndefined()
  })

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
    expect(() => {
      ;(preparedChild as unknown as { tagName: string }).tagName = "Tampered"
    }).toThrow(TypeError)

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

  test("requires a before-frame-render wrapper to delegate exactly once", () => {
    const session = sessionFixture()
    const frame = session.tree.getElementById("details")
    if (frame?.kind !== "frame") throw new Error("invalid fixture")
    const prepared = prepareFrameResponse(
      "details",
      '<turbo-frame id="details"><Loaded id="loaded" /></turbo-frame>',
    )
    const lifecycle = new FrameLifecycle()
    lifecycle.subscribe("before-frame-render", (event) => {
      event.detail.render = (context) => context.renderDefault()
      return undefined
    })

    const renderer = prepareFrameBeforeRender(lifecycle, prepared, "https://example.test/details")
    const mutation = prepareFrameMutation(session, frame, prepared)
    renderPreparedFrameMutation(prepared, renderer)
    commitPreparedFrameMutation(session, mutation)
    expect(session.tree.getElementById("loaded")).toBeDefined()

    const secondSession = sessionFixture()
    const secondFrame = secondSession.tree.getElementById("details")
    if (secondFrame?.kind !== "frame") throw new Error("invalid fixture")
    const secondPrepared = prepareFrameResponse(
      "details",
      '<turbo-frame id="details"><Loaded id="loaded" /></turbo-frame>',
    )
    const doubleLifecycle = new FrameLifecycle()
    doubleLifecycle.subscribe("before-frame-render", (event) => {
      event.detail.render = (context) => {
        context.renderDefault()
        return context.renderDefault()
      }
      return undefined
    })

    const secondMutation = prepareFrameMutation(secondSession, secondFrame, secondPrepared)
    expect(() =>
      renderPreparedFrameMutation(
        secondPrepared,
        prepareFrameBeforeRender(doubleLifecycle, secondPrepared, "https://example.test/details"),
      ),
    ).toThrow("Before-frame-render renderer failed")
    expect(secondSession.tree.getElementById("loaded")).toBeUndefined()
    expect(secondFrame.children.filter(isElement)[0]?.tagName).toBe("Old")
    expect(() => commitPreparedFrameMutation(secondSession, secondMutation)).not.toThrow()
  })
})
