import { describe, expect, test } from "bun:test"

import { ParseError, StateError, TargetError } from "./errors"
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

  test("preserves paired permanent Frame descendants during ordinary replacement", () => {
    const session = new DocumentSession(
      parseExpoTurboDocument(
        '<Gallery><turbo-frame id="details"><DemoForm id="form" tone="client"><DemoInput id="editable" value="client" /><DemoPanel id="permanent" data-turbo-permanent="" tone="client"><DemoInput id="locked" value="client" /></DemoPanel></DemoForm><Old id="same" /></turbo-frame></Gallery>',
        { url: "https://example.test/current" },
      ),
    )
    const frame = session.tree.getElementById("details")
    const form = session.tree.getElementById("form")
    const editable = session.tree.getElementById("editable")
    const permanent = session.tree.getElementById("permanent")
    const locked = session.tree.getElementById("locked")
    const same = session.tree.getElementById("same")
    if (frame?.kind !== "frame" || !form || !editable || !permanent || !locked || !same) {
      throw new Error("invalid fixture")
    }

    const permanentSnapshot = session.getNodeSnapshot(permanent.key)
    let permanentDisposals = 0
    let replacedDisposals = 0
    session.registerDisposal(permanent.key, () => {
      permanentDisposals += 1
    })
    session.registerDisposal(locked.key, () => {
      permanentDisposals += 1
    })
    for (const node of [form, editable, same]) {
      session.registerDisposal(node.key, () => {
        replacedDisposals += 1
      })
    }

    const prepared = prepareFrameResponse(
      "details",
      '<turbo-frame id="details"><DemoForm id="form" tone="server"><DemoGroup id="new-parent"><DemoInput id="editable" value="server" /><DemoPanel id="permanent" data-turbo-permanent="" tone="server"><DemoInput id="locked" value="server" /></DemoPanel></DemoGroup></DemoForm><New id="same" /></turbo-frame>',
    )
    const mutation = prepareFrameMutation(session, frame, prepared)
    commitPreparedFrameMutation(session, mutation)

    const nextForm = session.tree.getElementById("form")
    const nextParent = session.tree.getElementById("new-parent")
    const nextEditable = session.tree.getElementById("editable")
    const nextPermanent = session.tree.getElementById("permanent")
    const nextLocked = session.tree.getElementById("locked")
    const nextSame = session.tree.getElementById("same")
    if (!nextForm || !nextParent || !nextEditable || !nextPermanent || !nextLocked || !nextSame) {
      throw new Error("missing replacement result")
    }

    expect(nextForm).not.toBe(form)
    expect(nextEditable).not.toBe(editable)
    expect(nextSame).not.toBe(same)
    expect(nextPermanent).toBe(permanent)
    expect(nextLocked).toBe(locked)
    expect(nextPermanent.parent).toBe(nextParent)
    expect(session.getNodeSnapshot(permanent.key)?.identity).toBe(permanentSnapshot?.identity)
    expect(attributeValue(nextForm, "tone")).toBe("server")
    expect(attributeValue(nextEditable, "value")).toBe("server")
    expect(attributeValue(nextPermanent, "tone")).toBe("client")
    expect(attributeValue(nextLocked, "value")).toBe("client")
    expect(permanentDisposals).toBe(0)
    expect(replacedDisposals).toBe(3)

    const responseForm = prepared.responseFrame.children.find(isElement)
    const responseGroup = responseForm?.children.find(isElement)
    const responsePermanent = responseGroup?.children.find(
      (child) => isElement(child) && attributeValue(child, "id") === "permanent",
    )
    if (!responsePermanent || !isElement(responsePermanent)) {
      throw new Error("invalid prepared response")
    }
    expect(responsePermanent).not.toBe(permanent)
    expect(attributeValue(responsePermanent, "tone")).toBe("server")
  })

  test("replaces one-sided permanent Frame descendants normally", () => {
    const session = new DocumentSession(
      parseExpoTurboDocument(
        '<Gallery><turbo-frame id="details"><DemoPanel id="permanent" data-turbo-permanent="" tone="client" /></turbo-frame></Gallery>',
        { url: "https://example.test/current" },
      ),
    )
    const frame = session.tree.getElementById("details")
    const permanent = session.tree.getElementById("permanent")
    if (frame?.kind !== "frame" || !permanent) throw new Error("invalid fixture")
    let disposals = 0
    session.registerDisposal(permanent.key, () => {
      disposals += 1
    })

    const prepared = prepareFrameResponse(
      "details",
      '<turbo-frame id="details"><DemoPanel id="permanent" tone="server" /></turbo-frame>',
    )
    commitPreparedFrameMutation(session, prepareFrameMutation(session, frame, prepared))

    const replacement = session.tree.getElementById("permanent")
    if (!replacement) throw new Error("missing replacement")
    expect(replacement).not.toBe(permanent)
    expect(attributeValue(replacement, "tone")).toBe("server")
    expect(disposals).toBe(1)
  })

  test("rejects paired permanent Frame replacements that would duplicate a retained descendant ID", () => {
    const session = new DocumentSession(
      parseExpoTurboDocument(
        '<Gallery><turbo-frame id="details"><DemoPanel id="permanent" data-turbo-permanent=""><Current id="duplicate" /></DemoPanel></turbo-frame></Gallery>',
        { url: "https://example.test/current" },
      ),
    )
    const frame = session.tree.getElementById("details")
    const permanent = session.tree.getElementById("permanent")
    const duplicate = session.tree.getElementById("duplicate")
    if (frame?.kind !== "frame" || !permanent || !duplicate) throw new Error("invalid fixture")
    const children = frame.children
    const revision = session.revision
    const permanentSnapshot = session.getNodeSnapshot(permanent.key)
    let disposals = 0
    session.registerDisposal(permanent.key, () => {
      disposals += 1
    })

    const prepared = prepareFrameResponse(
      "details",
      '<turbo-frame id="details"><DemoPanel id="permanent" data-turbo-permanent=""><Incoming /></DemoPanel><Other id="duplicate" /></turbo-frame>',
    )

    expect(() => prepareFrameMutation(session, frame, prepared)).toThrow(ParseError)
    expect(session.revision).toBe(revision)
    expect(frame.children).toBe(children)
    expect(session.tree.getElementById("permanent")).toBe(permanent)
    expect(session.tree.getElementById("duplicate")).toBe(duplicate)
    expect(session.getNodeSnapshot(permanent.key)).toBe(permanentSnapshot)
    expect(disposals).toBe(0)
  })

  test("does not treat permanent Frame wrappers as replacement candidates", () => {
    const session = new DocumentSession(
      parseExpoTurboDocument(
        '<Gallery><turbo-frame id="details" data-turbo-permanent=""><Old id="old" /></turbo-frame></Gallery>',
        { url: "https://example.test/current" },
      ),
    )
    const frame = session.tree.getElementById("details")
    if (frame?.kind !== "frame") throw new Error("invalid fixture")

    const prepared = prepareFrameResponse(
      "details",
      '<turbo-frame id="details" data-turbo-permanent=""><Loaded id="loaded" /></turbo-frame>',
    )
    commitPreparedFrameMutation(session, prepareFrameMutation(session, frame, prepared))

    expect(session.tree.getElementById("details")).toBe(frame)
    expect(session.tree.getElementById("old")).toBeUndefined()
    expect(session.tree.getElementById("loaded")).toBeDefined()
  })

  test("morphs Frame reload children without replacing the mounted wrapper or eligible app identity", () => {
    const session = new DocumentSession(
      parseExpoTurboDocument(
        '<Gallery><turbo-frame id="details" src="/old" refresh="morph" target="mounted"><DemoForm id="form" legacy="remove" tone="old"><DemoInput id="email" value="before" /><DemoPanel id="permanent" data-turbo-permanent="" tone="kept"><DemoInput id="locked" value="current" /></DemoPanel><DemoText id="removed">Before</DemoText></DemoForm><Old id="changed" /></turbo-frame></Gallery>',
        { url: "https://example.test/current" },
      ),
    )
    const frame = session.tree.getElementById("details")
    const form = session.tree.getElementById("form")
    const email = session.tree.getElementById("email")
    const permanent = session.tree.getElementById("permanent")
    const locked = session.tree.getElementById("locked")
    const changed = session.tree.getElementById("changed")
    if (frame?.kind !== "frame" || !form || !email || !permanent || !locked || !changed) {
      throw new Error("invalid fixture")
    }
    const formSnapshot = session.getNodeSnapshot(form.key)
    const emailSnapshot = session.getNodeSnapshot(email.key)
    const permanentSnapshot = session.getNodeSnapshot(permanent.key)
    let retainedDisposals = 0
    let permanentDisposals = 0
    let replacedDisposals = 0
    session.registerDisposal(form.key, () => {
      retainedDisposals += 1
    })
    session.registerDisposal(permanent.key, () => {
      permanentDisposals += 1
    })
    session.registerDisposal(locked.key, () => {
      permanentDisposals += 1
    })
    session.registerDisposal(changed.key, () => {
      replacedDisposals += 1
    })

    const prepared = prepareFrameResponse(
      "details",
      '<turbo-frame id="details" src="/incoming" refresh="replace" target="incoming"><DemoForm id="form" tone="new"><DemoInput id="email" value="after" /><DemoPanel id="permanent" data-turbo-permanent="" tone="incoming"><DemoInput id="locked" value="incoming" /></DemoPanel><DemoText id="added">After</DemoText></DemoForm><Changed id="changed" /></turbo-frame>',
    )
    const mutation = prepareFrameMutation(session, frame, prepared, {
      finalUrl: "https://example.test/final",
      renderMethod: "morph",
    })

    commitPreparedFrameMutation(session, mutation)

    const nextForm = session.tree.getElementById("form")
    const nextEmail = session.tree.getElementById("email")
    const nextPermanent = session.tree.getElementById("permanent")
    const nextLocked = session.tree.getElementById("locked")
    const nextChanged = session.tree.getElementById("changed")
    if (!nextForm || !nextEmail || !nextPermanent || !nextLocked || !nextChanged) {
      throw new Error("missing morph result")
    }
    expect(session.tree.getElementById("details")).toBe(frame)
    expect(nextForm).toBe(form)
    expect(nextEmail).toBe(email)
    expect(nextPermanent).toBe(permanent)
    expect(nextLocked).toBe(locked)
    expect(nextChanged).not.toBe(changed)
    expect(session.getNodeSnapshot(form.key)?.identity).toBe(formSnapshot?.identity)
    expect(session.getNodeSnapshot(email.key)?.identity).toBe(emailSnapshot?.identity)
    expect(session.getNodeSnapshot(permanent.key)?.identity).toBe(permanentSnapshot?.identity)
    expect(attributeValue(frame, "src")).toBe("https://example.test/final")
    expect(attributeValue(frame, "refresh")).toBe("morph")
    expect(attributeValue(frame, "target")).toBe("mounted")
    expect(attributeValue(nextForm, "legacy")).toBeUndefined()
    expect(attributeValue(nextForm, "tone")).toBe("new")
    expect(attributeValue(nextEmail, "value")).toBe("after")
    expect(attributeValue(nextPermanent, "tone")).toBe("kept")
    expect(attributeValue(nextLocked, "value")).toBe("current")
    expect(session.tree.getElementById("removed")).toBeUndefined()
    expect(session.tree.getElementById("added")).toBeDefined()
    expect(retainedDisposals).toBe(0)
    expect(permanentDisposals).toBe(0)
    expect(replacedDisposals).toBe(1)
  })

  test("retains eligible nested morph Frames untouched for their own post-render reload", () => {
    const session = new DocumentSession(
      parseExpoTurboDocument(
        '<Gallery><turbo-frame id="outer" src="/outer" refresh="morph"><DemoPanel id="shell" tone="before"><turbo-frame id="inner" src="/inner" refresh="morph"><Before id="inner-content" /></turbo-frame></DemoPanel></turbo-frame></Gallery>',
        { url: "https://example.test/current" },
      ),
    )
    const outer = session.tree.getElementById("outer")
    const shell = session.tree.getElementById("shell")
    const inner = session.tree.getElementById("inner")
    const content = session.tree.getElementById("inner-content")
    if (outer?.kind !== "frame" || !shell || inner?.kind !== "frame" || !content) {
      throw new Error("invalid fixture")
    }

    const prepared = prepareFrameResponse(
      "outer",
      '<turbo-frame id="outer"><DemoPanel id="shell" tone="incoming"><turbo-frame id="inner" src="https://example.test/inner" refresh="morph"><Incoming id="inner-content" /></turbo-frame></DemoPanel></turbo-frame>',
    )
    const retained = commitPreparedFrameMutation(
      session,
      prepareFrameMutation(session, outer, prepared, { renderMethod: "morph" }),
    )

    expect(retained).toEqual([inner])
    expect(session.tree.getElementById("outer")).toBe(outer)
    expect(session.tree.getElementById("shell")).toBe(shell)
    expect(session.tree.getElementById("inner")).toBe(inner)
    expect(session.tree.getElementById("inner-content")).toBe(content)
    expect(attributeValue(shell, "tone")).toBe("incoming")
    expect(attributeValue(inner, "src")).toBe("/inner")
    expect(attributeValue(inner, "refresh")).toBe("morph")
    expect(content.tagName).toBe("Before")
  })

  test("retains an omitted eligible nested morph Frame but not a source mismatch", () => {
    const session = new DocumentSession(
      parseExpoTurboDocument(
        '<Gallery><turbo-frame id="outer" src="/outer" refresh="morph"><DemoPanel id="shell"><turbo-frame id="inner" src="/inner" refresh="morph"><Before id="inner-content" /></turbo-frame><After id="after" /></DemoPanel></turbo-frame></Gallery>',
        { url: "https://example.test/current" },
      ),
    )
    const outer = session.tree.getElementById("outer")
    const inner = session.tree.getElementById("inner")
    if (outer?.kind !== "frame" || inner?.kind !== "frame") throw new Error("invalid fixture")

    const omitted = prepareFrameResponse(
      "outer",
      '<turbo-frame id="outer"><DemoPanel id="shell"><After id="after" tone="incoming" /></DemoPanel></turbo-frame>',
    )
    const retained = commitPreparedFrameMutation(
      session,
      prepareFrameMutation(session, outer, omitted, { renderMethod: "morph" }),
    )

    expect(retained).toEqual([inner])
    expect(session.tree.getElementById("inner")).toBe(inner)
    expect(session.tree.getElementById("inner-content")?.kind).toBe("element")

    const mismatch = prepareFrameResponse(
      "outer",
      '<turbo-frame id="outer"><DemoPanel id="shell"><turbo-frame id="inner" src="/other" refresh="morph"><Incoming id="inner-content" /></turbo-frame><After id="after" tone="second" /></DemoPanel></turbo-frame>',
    )
    const replaced = commitPreparedFrameMutation(
      session,
      prepareFrameMutation(session, outer, mismatch, { renderMethod: "morph" }),
    )
    const nextInner = session.tree.getElementById("inner")

    expect(replaced).toEqual([])
    expect(nextInner).not.toBe(inner)
    expect(nextInner?.kind).toBe("frame")
    expect(attributeValue(nextInner as Exclude<typeof nextInner, undefined>, "src")).toBe("/other")
    expect(session.tree.getElementById("inner-content")?.tagName).toBe("Incoming")
  })

  test("rejects a permanent Frame morph response wrapper without structural replacement", () => {
    const session = new DocumentSession(
      parseExpoTurboDocument(
        '<Gallery><turbo-frame id="details" src="/old" refresh="morph"><DemoForm id="form"><DemoInput id="email" /></DemoForm></turbo-frame></Gallery>',
        { url: "https://example.test/current" },
      ),
    )
    const frame = session.tree.getElementById("details")
    const form = session.tree.getElementById("form")
    const email = session.tree.getElementById("email")
    if (frame?.kind !== "frame" || !form || !email) throw new Error("invalid fixture")
    const revision = session.revision
    const formSnapshot = session.getNodeSnapshot(form.key)
    let disposals = 0
    session.registerDisposal(form.key, () => {
      disposals += 1
    })
    const prepared = prepareFrameResponse(
      "details",
      '<turbo-frame id="details" data-turbo-permanent=""><DemoForm id="form"><DemoInput id="email" /></DemoForm></turbo-frame>',
    )

    expect(() => prepareFrameMutation(session, frame, prepared, { renderMethod: "morph" })).toThrow(
      TargetError,
    )
    expect(session.revision).toBe(revision)
    expect(session.tree.getElementById("details")).toBe(frame)
    expect(session.tree.getElementById("form")).toBe(form)
    expect(session.tree.getElementById("email")).toBe(email)
    expect(session.getNodeSnapshot(form.key)).toBe(formSnapshot)
    expect(attributeValue(frame, "src")).toBe("/old")
    expect(disposals).toBe(0)
  })

  test("rejects a Frame morph below an active permanent ancestor without structural replacement", () => {
    const session = new DocumentSession(
      parseExpoTurboDocument(
        '<Gallery><DemoPanel id="boundary" data-turbo-permanent=""><turbo-frame id="details" src="/old" refresh="morph"><DemoForm id="form"><DemoInput id="email" /></DemoForm></turbo-frame></DemoPanel></Gallery>',
        { url: "https://example.test/current" },
      ),
    )
    const frame = session.tree.getElementById("details")
    const form = session.tree.getElementById("form")
    if (frame?.kind !== "frame" || !form) throw new Error("invalid fixture")
    const revision = session.revision
    const prepared = prepareFrameResponse(
      "details",
      '<turbo-frame id="details"><DemoForm id="form"><DemoInput id="email" /></DemoForm></turbo-frame>',
    )

    expect(() => prepareFrameMutation(session, frame, prepared, { renderMethod: "morph" })).toThrow(
      TargetError,
    )
    expect(session.revision).toBe(revision)
    expect(session.tree.getElementById("details")).toBe(frame)
    expect(session.tree.getElementById("form")).toBe(form)
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
