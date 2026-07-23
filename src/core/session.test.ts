import { describe, expect, test } from "bun:test"

import type { TurboResponse } from "../adapters"
import { consumeDocumentAutofocus } from "./document-autofocus-internal"
import { DocumentRequestLoader } from "./document-loader"
import {
  notifyDocumentMorphFrameReloads,
  registerDocumentMorphFrameReloader,
} from "./document-morph-frame-reload-internal"
import { morphCurrentDocument } from "./document-session-morph-internal"
import { DocumentSnapshotCache } from "./document-snapshot-cache"
import { type DisposalError, TargetError } from "./errors"
import { parseExpoTurboDocument } from "./parser"
import { EXPO_TURBO_MIME_TYPE } from "./protocol-request"
import { DocumentSession, SessionCommitError } from "./session"
import { dispatchTurboStreamFragment } from "./streams"
import {
  attributeValue,
  DocumentTree,
  type ProtocolDocument,
  type ProtocolElement,
  type ProtocolNode,
} from "./tree"

function session(xml: string): DocumentSession {
  return new DocumentSession(parseExpoTurboDocument(xml))
}

function response(xml: string, url: string): TurboResponse {
  return {
    headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
    redirected: false,
    status: 200,
    text: async () => xml,
    url,
  }
}

describe("document session snapshots", () => {
  test("publishes frozen preview provenance only for whole-document replacements", async () => {
    const document = session('<Gallery><Panel id="panel" /></Gallery>')
    const states: Array<Readonly<{ generation: number; preview: boolean }>> = []
    const initial = document.treeState
    const unsubscribe = document.subscribeTreeState(() => states.push(document.treeState))

    expect(initial).toEqual({ generation: 0, preview: false })
    expect(Object.isFrozen(initial)).toBe(true)
    document.setAttribute("id:panel", "data-state", "mutated")
    expect(document.treeState).toBe(initial)
    expect(states).toEqual([])

    document.replaceTreePreview(
      parseExpoTurboDocument('<Gallery><Preview id="preview" /></Gallery>'),
    )
    document.replaceTree(parseExpoTurboDocument('<Gallery><Canonical id="canonical" /></Gallery>'))
    unsubscribe()
    document.replaceTree(parseExpoTurboDocument('<Gallery><Later id="later" /></Gallery>'))

    expect(states).toEqual([
      { generation: 1, preview: true },
      { generation: 2, preview: false },
    ])
    expect(states.every(Object.isFrozen)).toBe(true)
    expect(document.treeState).toEqual({ generation: 3, preview: false })
  })

  test("publishes one session revision notification for each logical commit", async () => {
    const document = session('<Gallery><Panel id="panel" /></Gallery>')
    const revisions: number[] = []
    const unsubscribe = document.subscribeRevision(() => revisions.push(document.revision))

    document.setAttribute("id:panel", "data-state", "changed")
    document.mutate((tree) => {
      const panel = tree.getElementById("panel")
      if (!panel) throw new TargetError("Expected panel fixture")
      tree.setAttribute(panel, "data-extra", "present")
      return ["id:panel", "id:panel"]
    })
    document.replaceTreePreview(
      parseExpoTurboDocument('<Gallery><Preview id="preview" /></Gallery>'),
    )
    document.replaceTree(parseExpoTurboDocument('<Gallery><Canonical id="canonical" /></Gallery>'))
    unsubscribe()
    document.setAttribute("id:canonical", "data-state", "ignored")

    expect(revisions).toEqual([1, 2, 3, 4])
  })

  test("retains compatible document morph identity while publishing a fresh nonpreview generation", async () => {
    const document = new DocumentSession(
      parseExpoTurboDocument(
        '<Gallery id="gallery" tone="before"><Panel id="retained" tone="before"/><Panel id="permanent" data-turbo-permanent="" tone="kept"><Locked id="locked" value="current"/></Panel><Removed id="removed"/></Gallery>',
        { url: "https://example.test/current" },
      ),
    )
    const tree = document.tree
    const root = document.tree.getElementById("gallery")
    const retained = document.tree.getElementById("retained")
    const permanent = document.tree.getElementById("permanent")
    const retainedIdentity = document.getNodeSnapshot("id:retained")?.identity
    const revisions: number[] = []
    const states: Array<Readonly<{ generation: number; preview: boolean }>> = []
    const changed: string[] = []
    const disposed: string[] = []
    document.subscribeRevision(() => revisions.push(document.revision))
    document.subscribeTreeState(() => states.push(document.treeState))
    document.subscribe(document.tree.document.key, () => changed.push("document"))
    document.subscribe("id:retained", () => changed.push("retained"))
    document.registerDisposal("id:removed", () => disposed.push("removed"))

    morphCurrentDocument(
      document,
      parseExpoTurboDocument(
        '<Gallery id="gallery" tone="after"><Panel id="permanent" data-turbo-permanent="" tone="incoming"><Locked id="locked" value="incoming"/></Panel><Panel id="retained" autofocus="" tone="after"/><Added id="added"/></Gallery>',
        { url: "https://example.test/next" },
      ),
    )

    expect(document.tree).toBe(tree)
    expect(document.tree.getElementById("gallery")).toBe(root)
    expect(document.tree.getElementById("retained")).toBe(retained)
    expect(document.tree.getElementById("permanent")).toBe(permanent)
    expect(document.getNodeSnapshot("id:retained")?.identity).toBe(retainedIdentity)
    const currentGallery = document.tree.getElementById("gallery")
    const currentRetained = document.tree.getElementById("retained")
    const currentPermanent = document.tree.getElementById("permanent")
    if (!currentGallery || !currentRetained || !currentPermanent) {
      throw new Error("Expected retained document morph fixtures")
    }
    expect(attributeValue(currentGallery, "tone")).toBe("after")
    expect(attributeValue(currentRetained, "tone")).toBe("after")
    expect(attributeValue(currentPermanent, "tone")).toBe("kept")
    expect(document.tree.getElementById("removed")).toBeUndefined()
    expect(document.tree.getElementById("added")).toBeDefined()
    expect(document.tree.document.url).toBe("https://example.test/next")
    expect(document.treeGeneration).toBe(1)
    expect(document.treeState).toEqual({ generation: 1, preview: false })
    expect(document.revision).toBe(1)
    expect(consumeDocumentAutofocus(document, document.tree.document, 1)).toBeUndefined()
    expect(revisions).toEqual([1])
    expect(states).toEqual([{ generation: 1, preview: false }])
    expect(changed).toEqual(["retained", "document"])
    expect(disposed).toEqual(["removed"])
  })

  test("retains the application root while its id is added, changed, or removed", () => {
    for (const candidate of [
      { currentId: undefined, incomingId: "gallery" },
      { currentId: "gallery", incomingId: "next-gallery" },
      { currentId: "gallery", incomingId: undefined },
    ] as const) {
      const currentAttribute = candidate.currentId ? ` id="${candidate.currentId}"` : ""
      const incomingAttribute = candidate.incomingId ? ` id="${candidate.incomingId}"` : ""
      const document = session(
        `<Gallery${currentAttribute} tone="before"><Panel id="retained" tone="before"/></Gallery>`,
      )
      const root = document.tree.document.children[0]
      const retained = document.tree.getElementById("retained")
      if (root?.kind !== "element" || !retained) {
        throw new Error("Expected document root id transition fixtures")
      }

      morphCurrentDocument(
        document,
        parseExpoTurboDocument(
          `<Gallery${incomingAttribute} tone="after"><Panel id="retained" tone="after"/></Gallery>`,
        ),
      )

      expect(document.tree.document.children[0]).toBe(root)
      expect(document.tree.getElementById("retained")).toBe(retained)
      expect(attributeValue(root, "id")).toBe(candidate.incomingId)
      expect(attributeValue(root, "tone")).toBe("after")
      if (candidate.currentId) {
        expect(document.tree.getElementById(candidate.currentId)).toBeUndefined()
      }
      if (candidate.incomingId) {
        expect(document.tree.getElementById(candidate.incomingId)).toBe(root)
      }
    }
  })

  test("replaces an incompatible application root while retaining compatible descendants", () => {
    const document = new DocumentSession(
      parseExpoTurboDocument(
        '<Gallery id="gallery"><Group id="left"><Panel id="retained" tone="before"/></Group><turbo-frame id="refreshable" src="/refreshable" refresh="morph"><FrameBefore id="frame-before"/></turbo-frame><Removed id="removed"/></Gallery>',
        { url: "https://example.test/current" },
      ),
    )
    const tree = document.tree
    const root = document.tree.getElementById("gallery")
    const retained = document.tree.getElementById("retained")
    const refreshable = document.tree.getElementById("refreshable")
    if (refreshable?.kind !== "frame") throw new Error("Expected refreshable Frame fixture")
    const retainedIdentity = document.getNodeSnapshot("id:retained")?.identity
    const disposed: string[] = []
    const reloads: (readonly ProtocolElement[])[] = []
    document.registerDisposal("id:gallery", () => disposed.push("root"))
    document.registerDisposal("id:retained", () => disposed.push("retained"))
    document.registerDisposal("id:removed", () => disposed.push("removed"))
    registerDocumentMorphFrameReloader(document, (frames) => reloads.push(frames))

    morphCurrentDocument(
      document,
      parseExpoTurboDocument(
        '<Screen id="screen"><Group id="right"><Panel id="retained" tone="after"/></Group><turbo-frame id="refreshable" src="/refreshable" refresh="morph"><FrameAfter id="frame-after"/></turbo-frame><Added id="added"/></Screen>',
        { url: "https://example.test/next" },
      ),
    )

    const screen = document.tree.getElementById("screen")
    const right = document.tree.getElementById("right")
    if (!screen || !right || !retained) throw new Error("Expected replaced document root fixtures")
    expect(document.tree).toBe(tree)
    expect(screen).not.toBe(root)
    expect(screen.parent).toBe(document.tree.document)
    expect(document.tree.getElementById("gallery")).toBeUndefined()
    expect(document.tree.getElementById("retained")).toBe(retained)
    expect(document.tree.getElementById("refreshable")).toBe(refreshable)
    expect(document.tree.getElementById("frame-before")).toBeDefined()
    expect(document.tree.getElementById("frame-after")).toBeUndefined()
    expect(retained.parent).toBe(right)
    expect(document.getNodeSnapshot("id:retained")?.identity).toBe(retainedIdentity)
    expect(attributeValue(retained, "tone")).toBe("after")
    expect(document.tree.getElementById("removed")).toBeUndefined()
    expect(document.tree.getElementById("added")).toBeDefined()
    expect(document.tree.document.url).toBe("https://example.test/next")
    expect(document.treeGeneration).toBe(1)
    expect(document.revision).toBe(1)
    expect(disposed).toEqual(["removed", "root"])
    notifyDocumentMorphFrameReloads(document, document.tree.document, document.treeGeneration)
    expect(reloads).toEqual([[refreshable]])
  })

  test("rejects a document root id that collides with an active descendant", () => {
    const document = session(
      '<Gallery id="gallery" tone="before"><Panel id="next-gallery" tone="before"/></Gallery>',
    )
    const tree = document.tree
    const root = document.tree.getElementById("gallery")
    const descendant = document.tree.getElementById("next-gallery")

    expect(() =>
      morphCurrentDocument(
        document,
        parseExpoTurboDocument(
          '<Gallery id="next-gallery" tone="after"><Panel id="replacement" /></Gallery>',
        ),
      ),
    ).toThrow(TargetError)

    expect(document.tree).toBe(tree)
    expect(document.tree.getElementById("gallery")).toBe(root)
    expect(document.tree.getElementById("next-gallery")).toBe(descendant)
    expect(document.tree.getElementById("replacement")).toBeUndefined()
    expect(document.treeGeneration).toBe(0)
    expect(document.revision).toBe(0)
  })

  test("retains only outermost compatible refresh-morph Frames for post-render reload", () => {
    const document = new DocumentSession(
      parseExpoTurboDocument(
        '<Gallery id="gallery"><turbo-frame id="outer" src="/outer" refresh="morph"><turbo-frame id="nested" src="/nested" refresh="morph"><Panel id="nested-old"/></turbo-frame><Panel id="outer-old"/></turbo-frame><turbo-frame id="omitted" src="/omitted" refresh="morph"><Panel id="omitted-old"/></turbo-frame><turbo-frame id="changed" src="/old" refresh="morph"><Panel id="changed-old"/></turbo-frame><turbo-frame id="plain" src="/plain"><Panel id="plain-old"/></turbo-frame><turbo-cable-stream-source id="source" channel="Before"/></Gallery>',
        { url: "https://example.test/current" },
      ),
    )
    const outer = document.tree.getElementById("outer")
    const nested = document.tree.getElementById("nested")
    const omitted = document.tree.getElementById("omitted")
    const changed = document.tree.getElementById("changed")
    const plain = document.tree.getElementById("plain")
    const source = document.tree.getElementById("source")
    if (
      outer?.kind !== "frame" ||
      nested?.kind !== "frame" ||
      omitted?.kind !== "frame" ||
      changed?.kind !== "frame" ||
      plain?.kind !== "frame" ||
      source?.kind !== "stream-source"
    ) {
      throw new Error("Expected document morph Frame fixtures")
    }
    const reloads: (readonly ProtocolElement[])[] = []
    registerDocumentMorphFrameReloader(document, (frames) => reloads.push(frames))

    morphCurrentDocument(
      document,
      parseExpoTurboDocument(
        '<Gallery id="gallery"><turbo-frame id="outer" src="/outer" refresh="morph"><Panel id="incoming-ignored"/></turbo-frame><turbo-frame id="changed" src="/new" refresh="morph"><Panel id="changed-new"/></turbo-frame><turbo-frame id="plain" src="/plain"><Panel id="plain-new"/></turbo-frame><turbo-cable-stream-source id="source" channel="After"/></Gallery>',
        { url: "https://example.test/current" },
      ),
    )

    expect(document.tree.getElementById("outer")).toBe(outer)
    expect(document.tree.getElementById("nested")).toBe(nested)
    expect(document.tree.getElementById("omitted")).toBe(omitted)
    expect(document.tree.getElementById("outer-old")).toBeDefined()
    expect(document.tree.getElementById("omitted-old")).toBeDefined()
    expect(document.tree.getElementById("incoming-ignored")).toBeUndefined()
    expect(document.tree.getElementById("changed")).not.toBe(changed)
    expect(document.tree.getElementById("changed-old")).toBeUndefined()
    expect(document.tree.getElementById("changed-new")).toBeDefined()
    expect(document.tree.getElementById("plain")).not.toBe(plain)
    expect(document.tree.getElementById("plain-old")).toBeUndefined()
    expect(document.tree.getElementById("plain-new")).toBeDefined()
    const currentSource = document.tree.getElementById("source")
    expect(currentSource).not.toBe(source)
    expect(currentSource && attributeValue(currentSource, "channel")).toBe("After")
    expect(reloads).toEqual([])

    notifyDocumentMorphFrameReloads(document, document.tree.document, document.treeGeneration)
    expect(reloads).toEqual([[outer, omitted]])
    notifyDocumentMorphFrameReloads(document, document.tree.document, document.treeGeneration)
    expect(reloads).toEqual([[outer, omitted]])
  })

  test("reparents a stable application identity during a current-document morph", () => {
    const document = new DocumentSession(
      parseExpoTurboDocument(
        '<Gallery id="gallery"><Group id="right"/><Group id="left"><Field id="field" tone="before"/></Group></Gallery>',
        { url: "https://example.test/current" },
      ),
    )
    const field = document.tree.getElementById("field")
    if (!field) throw new Error("Expected document reparent fixture")
    const identity = document.getNodeSnapshot(field.key)?.identity

    morphCurrentDocument(
      document,
      parseExpoTurboDocument(
        '<Gallery id="gallery"><Group id="right"><Field id="field" tone="after"/></Group><Group id="left"/></Gallery>',
        { url: "https://example.test/current" },
      ),
    )

    const right = document.tree.getElementById("right")
    if (!right) throw new Error("Expected reparent destination")
    expect(document.tree.getElementById("field")).toBe(field)
    expect(field.parent).toBe(right)
    expect(document.getNodeSnapshot(field.key)?.identity).toBe(identity)
    expect(document.getNodeSnapshot(field.key)?.morphRevision).toBe(1)
    expect(attributeValue(field, "tone")).toBe("after")
  })

  test("moves and preserves an opaque permanent identity during a current-document morph", () => {
    const document = new DocumentSession(
      parseExpoTurboDocument(
        '<Gallery id="gallery"><Group id="left"><Panel id="permanent" data-turbo-permanent="" tone="client"><Field id="locked" value="client"/></Panel></Group><Group id="right"/><Panel id="unmatched" data-turbo-permanent="" tone="kept"/></Gallery>',
        { url: "https://example.test/current" },
      ),
    )
    const permanent = document.tree.getElementById("permanent")
    const locked = document.tree.getElementById("locked")
    const unmatched = document.tree.getElementById("unmatched")
    if (!permanent || !locked || !unmatched) throw new Error("Expected permanent fixtures")

    morphCurrentDocument(
      document,
      parseExpoTurboDocument(
        '<Gallery id="gallery"><Group id="left"/><Group id="right"><Panel id="permanent" tone="server"><Field id="locked" value="server"/></Panel></Group></Gallery>',
        { url: "https://example.test/next" },
      ),
    )

    const right = document.tree.getElementById("right")
    const gallery = document.tree.getElementById("gallery")
    if (!right || !gallery) throw new Error("Expected permanent destinations")
    expect(document.tree.getElementById("permanent")).toBe(permanent)
    expect(document.tree.getElementById("locked")).toBe(locked)
    expect(document.tree.getElementById("unmatched")).toBe(unmatched)
    expect(permanent.parent).toBe(right)
    expect(unmatched.parent).toBe(gallery)
    expect(attributeValue(permanent, "tone")).toBe("client")
    expect(attributeValue(locked, "value")).toBe("client")
    expect(document.getNodeSnapshot(permanent.key)?.morphRevision).toBe(0)
  })

  test("moves and preserves an opaque permanent Frame during a current-document morph", () => {
    const document = new DocumentSession(
      parseExpoTurboDocument(
        '<Gallery id="gallery"><Group id="left"><turbo-frame id="permanent-frame" src="/client" refresh="morph" data-turbo-permanent=""><ClientOwned id="locked"/></turbo-frame></Group><Group id="right"/></Gallery>',
        { url: "https://example.test/current" },
      ),
    )
    const frame = document.tree.getElementById("permanent-frame")
    const locked = document.tree.getElementById("locked")
    if (frame?.kind !== "frame" || !locked) throw new Error("Expected permanent Frame fixtures")
    const reloads: (readonly ProtocolElement[])[] = []
    registerDocumentMorphFrameReloader(document, (frames) => reloads.push(frames))

    morphCurrentDocument(
      document,
      parseExpoTurboDocument(
        '<Gallery id="gallery"><Group id="left"/><Group id="right"><turbo-frame id="permanent-frame" src="/server" refresh="morph"><ServerOwned id="ignored"/></turbo-frame></Group></Gallery>',
        { url: "https://example.test/next" },
      ),
    )

    const right = document.tree.getElementById("right")
    if (!right) throw new Error("Expected permanent Frame destination")
    expect(document.tree.getElementById("permanent-frame")).toBe(frame)
    expect(document.tree.getElementById("locked")).toBe(locked)
    expect(document.tree.getElementById("ignored")).toBeUndefined()
    expect(frame.parent).toBe(right)
    expect(attributeValue(frame, "src")).toBe("/client")
    expect(document.getNodeSnapshot(frame.key)?.morphRevision).toBe(0)
    notifyDocumentMorphFrameReloads(document, document.tree.document, document.treeGeneration)
    expect(reloads).toEqual([])
  })

  test("matches anonymous document wrappers through stable descendant ID sets", () => {
    const document = new DocumentSession(
      parseExpoTurboDocument(
        '<Gallery id="gallery"><Row tone="one"><Field id="one"/></Row><Row tone="two"><Field id="two"/></Row></Gallery>',
        { url: "https://example.test/current" },
      ),
    )
    const gallery = document.tree.getElementById("gallery")
    const first = gallery?.children[0]
    const second = gallery?.children[1]
    if (first?.kind !== "element" || second?.kind !== "element") {
      throw new Error("Expected anonymous document wrappers")
    }

    morphCurrentDocument(
      document,
      parseExpoTurboDocument(
        '<Gallery id="gallery"><Row tone="two-after"><Field id="two"/></Row><Row tone="one-after"><Field id="one"/></Row></Gallery>',
        { url: "https://example.test/next" },
      ),
    )

    expect(document.tree.getElementById("gallery")?.children).toEqual([second, first])
    expect(attributeValue(first, "tone")).toBe("one-after")
    expect(attributeValue(second, "tone")).toBe("two-after")
  })

  test("ignores document-level formatting around a compatible document morph root", async () => {
    const document = new DocumentSession(
      parseExpoTurboDocument(
        '\n<!-- current formatting -->\n<Gallery><Panel id="panel" tone="before"/></Gallery>',
      ),
    )

    morphCurrentDocument(
      document,
      parseExpoTurboDocument(
        '\n<Gallery><Panel id="panel" tone="after"/></Gallery>\n<!-- next formatting -->',
      ),
    )

    const panel = document.tree.getElementById("panel")
    if (!panel) throw new Error("Expected document morph panel")
    expect(attributeValue(panel, "tone")).toBe("after")
  })

  test("rejects a blank incoming document URL before a current-document morph changes state", async () => {
    const document = new DocumentSession(
      parseExpoTurboDocument('<Gallery id="gallery"><Panel id="panel" tone="before"/></Gallery>', {
        url: "https://example.test/current",
      }),
    )
    const tree = document.tree
    const panel = document.tree.getElementById("panel")
    const disposed: string[] = []
    document.registerDisposal("id:panel", () => disposed.push("panel"))
    const sourceChildren: ProtocolNode[] = []
    const sourceDocument: ProtocolDocument = {
      children: sourceChildren,
      key: "source-document",
      kind: "document",
      parent: null,
      url: "",
    }
    const sourceRoot: ProtocolElement = {
      attributes: [
        { localName: "id", name: "id", namespaceUri: null, prefix: null, value: "gallery" },
        { localName: "tone", name: "tone", namespaceUri: null, prefix: null, value: "after" },
      ],
      children: [],
      key: "source-gallery",
      kind: "element",
      localName: "Gallery",
      namespaceUri: null,
      parent: sourceDocument,
      prefix: null,
      tagName: "Gallery",
    }
    sourceChildren.push(sourceRoot)
    const source = new DocumentTree(sourceDocument)

    expect(() => morphCurrentDocument(document, source)).toThrow(TargetError)
    expect(document.tree).toBe(tree)
    expect(document.tree.getElementById("panel")).toBe(panel)
    const currentPanel = document.tree.getElementById("panel")
    if (!currentPanel) throw new Error("Expected unchanged document morph panel")
    expect(attributeValue(currentPanel, "tone")).toBe("before")
    expect(document.tree.document.url).toBe("https://example.test/current")
    expect(document.treeGeneration).toBe(0)
    expect(document.revision).toBe(0)
    expect(disposed).toEqual([])
  })

  test("keeps a revision committed when its session-wide listener fails", async () => {
    const document = session('<Gallery><Panel id="panel" /></Gallery>')
    document.subscribeRevision(() => {
      throw new Error("revision listener failed")
    })

    expect(() => document.setAttribute("id:panel", "data-state", "committed")).toThrow(
      SessionCommitError,
    )

    expect(document.revision).toBe(1)
    expect(document.tree.getElementById("panel")?.attributes).toContainEqual(
      expect.objectContaining({ name: "data-state", value: "committed" }),
    )
  })

  test("captures an independent tree and restores fresh clones repeatedly", async () => {
    const document = new DocumentSession(
      parseExpoTurboDocument('<Gallery><Panel id="panel" data-state="original" /></Gallery>', {
        url: "https://example.test/current",
      }),
    )
    const cache = new DocumentSnapshotCache()
    document.captureSnapshot(cache)

    document.setAttribute("id:panel", "data-state", "live-mutated")
    const first = document.restoreSnapshot(cache, "https://example.test/current#first")
    expect(first).toEqual({ status: "restored" })
    expect(Object.isFrozen(first)).toBe(true)
    expect(document.tree.getElementById("panel")?.attributes).toContainEqual(
      expect.objectContaining({ name: "data-state", value: "original" }),
    )

    document.setAttribute("id:panel", "data-state", "restored-mutated")
    const firstTree = document.tree
    expect(document.restoreSnapshot(cache, "https://example.test/current#second")).toEqual({
      status: "restored",
    })
    expect(document.tree).not.toBe(firstTree)
    expect(document.tree.getElementById("panel")?.attributes).toContainEqual(
      expect.objectContaining({ name: "data-state", value: "original" }),
    )
  })

  test("fails capture without an active URL and leaves misses as true no-ops", async () => {
    const cache = new DocumentSnapshotCache()
    cache.put(
      "https://example.test/existing",
      parseExpoTurboDocument("<Gallery><Existing /></Gallery>", {
        url: "https://example.test/existing",
      }),
    )
    const document = session('<Gallery><Panel id="panel" /></Gallery>')
    const tree = document.tree
    const snapshot = document.getNodeSnapshot("id:panel")
    const disposed: string[] = []
    document.registerDisposal("id:panel", () => disposed.push("panel"))

    expect(() => document.captureSnapshot(cache)).toThrow(TargetError)
    expect(cache.size).toBe(1)
    expect(() => document.restoreSnapshot(cache, "/relative")).toThrow(TargetError)
    const missed = document.restoreSnapshot(cache, "https://example.test/missing")
    expect(missed).toEqual({ status: "miss" })
    expect(Object.isFrozen(missed)).toBe(true)
    expect(document.tree).toBe(tree)
    expect(document.treeGeneration).toBe(0)
    expect(document.revision).toBe(0)
    expect(document.getNodeSnapshot("id:panel")).toBe(snapshot)
    expect(disposed).toEqual([])
  })

  test("restores through one tree replacement with disposal and fresh identities", async () => {
    const document = new DocumentSession(
      parseExpoTurboDocument('<Gallery><Cached id="cached" /></Gallery>', {
        url: "https://example.test/cached",
      }),
    )
    const cache = new DocumentSnapshotCache()
    const initialIdentity = document.getNodeSnapshot("id:cached")?.identity
    document.captureSnapshot(cache)
    document.replaceTree(
      parseExpoTurboDocument(
        '<Gallery><Outgoing id="outgoing"><Child id="child" /></Outgoing></Gallery>',
        {
          url: "https://example.test/outgoing",
        },
      ),
    )
    const disposed: string[] = []
    document.registerDisposal("id:outgoing", () => disposed.push("outgoing"))
    document.registerDisposal("id:child", () => disposed.push("child"))
    const generation = document.treeGeneration
    const revision = document.revision

    expect(document.restoreSnapshot(cache, "https://example.test/cached")).toEqual({
      status: "restored",
    })
    expect(document.treeGeneration).toBe(generation + 1)
    expect(document.revision).toBe(revision + 1)
    expect(disposed).toEqual(["child", "outgoing"])
    expect(document.tree.getElementById("cached")?.tagName).toBe("Cached")
    expect(document.getNodeSnapshot("id:cached")?.identity).not.toBe(initialIdentity)
  })

  test("keeps the restored tree committed when replacement finalization fails", async () => {
    const document = new DocumentSession(
      parseExpoTurboDocument('<Gallery><Cached id="cached" /></Gallery>', {
        url: "https://example.test/cached",
      }),
    )
    const cache = new DocumentSnapshotCache()
    document.captureSnapshot(cache)
    document.replaceTree(
      parseExpoTurboDocument('<Gallery><Outgoing id="outgoing" /></Gallery>', {
        url: "https://example.test/outgoing",
      }),
    )
    document.registerDisposal("id:outgoing", () => {
      throw new Error("cleanup failed")
    })
    const generation = document.treeGeneration
    const revision = document.revision

    expect(() => document.restoreSnapshot(cache, "https://example.test/cached")).toThrow(
      SessionCommitError,
    )
    expect(document.treeGeneration).toBe(generation + 1)
    expect(document.revision).toBe(revision + 1)
    expect(document.tree.getElementById("cached")?.tagName).toBe("Cached")
    expect(document.tree.getElementById("outgoing")).toBeUndefined()
  })

  test("prevents an older in-flight document response from replacing a restored snapshot", async () => {
    let resolveResponse: (response: TurboResponse) => void = () => undefined
    const document = new DocumentSession(
      parseExpoTurboDocument('<Gallery><Cached id="cached" /></Gallery>', {
        url: "https://example.test/cached",
      }),
    )
    const cache = new DocumentSnapshotCache()
    document.captureSnapshot(cache)
    document.replaceTree(
      parseExpoTurboDocument('<Gallery><Live id="live" /></Gallery>', {
        url: "https://example.test/live",
      }),
    )
    const loader = new DocumentRequestLoader(
      document,
      {
        fetch: () =>
          new Promise<TurboResponse>((resolve) => {
            resolveResponse = resolve
          }),
      },
      { next: () => "request-1" },
    )

    const loading = loader.load("/late")
    expect(document.restoreSnapshot(cache, "https://example.test/cached")).toEqual({
      status: "restored",
    })
    resolveResponse(response('<Gallery><Late id="late" /></Gallery>', "https://example.test/late"))

    expect(await loading).toMatchObject({ status: "canceled" })
    expect(document.tree.getElementById("cached")?.tagName).toBe("Cached")
    expect(document.tree.getElementById("late")).toBeUndefined()
  })
})

describe("document subtree disposal", () => {
  test("runs descendant hooks before parent hooks exactly once", async () => {
    const document = session('<Gallery><Panel id="panel"><Child id="child"/></Panel></Gallery>')
    const events: string[] = []
    document.registerDisposal("id:panel", () => events.push("panel"))
    document.registerDisposal("id:child", () => events.push("child"))

    await dispatchTurboStreamFragment(document, '<turbo-stream action="remove" target="panel"/>')
    await dispatchTurboStreamFragment(document, '<turbo-stream action="remove" target="panel"/>')

    expect(events).toEqual(["child", "panel"])
  })

  test("disposes replaced identity even when the stable key is reused", async () => {
    const document = session('<Gallery><Panel id="panel"><Old/></Panel></Gallery>')
    const disposed: string[] = []
    document.registerDisposal("id:panel", () => disposed.push("old"))

    await dispatchTurboStreamFragment(
      document,
      '<turbo-stream action="replace" target="panel"><template><Panel id="panel"><New/></Panel></template></turbo-stream>',
    )
    document.registerDisposal("id:panel", () => disposed.push("new"))
    await dispatchTurboStreamFragment(document, '<turbo-stream action="remove" target="panel"/>')

    expect(disposed).toEqual(["old", "new"])
  })

  test("supports explicit unregister and reports hook errors after all cleanup runs", async () => {
    const errors: DisposalError[] = []
    const document = new DocumentSession(
      parseExpoTurboDocument('<Gallery><Panel id="panel"><Child id="child"/></Panel></Gallery>'),
      { onDisposalError: (error) => errors.push(error) },
    )
    const events: string[] = []
    const unregister = document.registerDisposal("id:child", () => events.push("unregistered"))
    unregister()
    document.registerDisposal("id:child", () => {
      events.push("broken")
      throw new Error("cleanup failed")
    })
    document.registerDisposal("id:panel", () => events.push("parent"))

    await dispatchTurboStreamFragment(document, '<turbo-stream action="remove" target="panel"/>')

    expect(events).toEqual(["broken", "parent"])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ code: "disposal", context: { target: "id:child" } })
    expect(document.tree.getElementById("panel")).toBeUndefined()
    expect(() => document.registerDisposal("id:panel", () => undefined)).toThrow(TargetError)
  })

  test("commits before reporting every disposal and stable-snapshot listener failure", async () => {
    const document = session('<Gallery><Panel id="panel" /></Gallery>')
    const events: string[] = []
    document.registerDisposal("id:panel", () => {
      events.push("dispose")
      throw new Error("disposal failed")
    })
    let unsubscribeSecond: () => void = () => undefined
    document.subscribe("id:panel", () => {
      events.push("first")
      unsubscribeSecond()
      document.subscribe("id:panel", () => events.push("late"))
      throw new Error("listener failed")
    })
    unsubscribeSecond = document.subscribe("id:panel", () => events.push("second"))
    const replacement = parseExpoTurboDocument('<Gallery><Next id="next" /></Gallery>')

    let reported: unknown
    try {
      document.replaceTree(replacement)
    } catch (error) {
      reported = error
    }

    expect(reported).toBeInstanceOf(AggregateError)
    expect((reported as AggregateError).errors).toHaveLength(2)
    expect(events).toEqual(["dispose", "first", "second"])
    expect(document.tree).toBe(replacement)
    expect(document.revision).toBe(1)
    expect(document.treeGeneration).toBe(1)
  })

  test("uses one callback snapshot across every key in a tree replacement", async () => {
    const document = session('<Gallery><First id="first" /><Second id="second" /></Gallery>')
    const events: string[] = []
    let unsubscribeSecond: () => void = () => undefined
    document.subscribe("id:first", () => {
      events.push("first")
      unsubscribeSecond()
      document.subscribe("id:second", () => events.push("late-second"))
      document.subscribe("id:third", () => events.push("third"))
    })
    unsubscribeSecond = document.subscribe("id:second", () => events.push("second"))

    document.replaceTree(parseExpoTurboDocument('<Gallery><Next id="next" /></Gallery>'))

    expect(events).toEqual(["first", "second"])
  })

  test("reports every disposal, reporter, and listener failure after commit", async () => {
    const events: string[] = []
    const document = new DocumentSession(
      parseExpoTurboDocument('<Gallery><Panel id="panel"><Child id="child" /></Panel></Gallery>'),
      {
        onDisposalError(error) {
          events.push(`report:${error.context.target}`)
          throw new Error(`reporter failed for ${error.context.target}`)
        },
      },
    )
    document.registerDisposal("id:child", () => {
      events.push("dispose:child")
      throw new Error("child failed")
    })
    document.registerDisposal("id:panel", () => {
      events.push("dispose:panel")
      throw new Error("panel failed")
    })
    document.subscribe("id:panel", () => {
      events.push("listener:panel")
      throw new Error("listener failed")
    })
    document.subscribe("id:child", () => events.push("listener:child"))

    let reported: unknown
    try {
      document.replaceTree(parseExpoTurboDocument('<Gallery><Next id="next" /></Gallery>'))
    } catch (error) {
      reported = error
    }

    expect(reported).toBeInstanceOf(AggregateError)
    expect((reported as AggregateError).errors).toHaveLength(5)
    expect(
      (reported as AggregateError).errors.filter((error) => error instanceof TargetError),
    ).toHaveLength(0)
    expect(
      (reported as AggregateError).errors.filter(
        (error) => error instanceof Error && error.name === "DisposalError",
      ),
    ).toHaveLength(2)
    expect(events).toEqual([
      "dispose:child",
      "dispose:panel",
      "listener:panel",
      "listener:child",
      "report:id:child",
      "report:id:panel",
    ])
    expect(document.tree.getElementById("next")?.tagName).toBe("Next")
  })
})
