import { describe, expect, test } from "bun:test"

import type { TurboResponse } from "../adapters"
import { DocumentRequestLoader } from "./document-loader"
import { DocumentSnapshotCache } from "./document-snapshot-cache"
import { type DisposalError, TargetError } from "./errors"
import { parseExpoTurboDocument } from "./parser"
import { EXPO_TURBO_MIME_TYPE } from "./protocol-request"
import { DocumentSession, SessionCommitError } from "./session"
import { dispatchTurboStreamFragment } from "./streams"

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
  test("captures an independent tree and restores fresh clones repeatedly", () => {
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

  test("fails capture without an active URL and leaves misses as true no-ops", () => {
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

  test("restores through one tree replacement with disposal and fresh identities", () => {
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

  test("keeps the restored tree committed when replacement finalization fails", () => {
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
  test("runs descendant hooks before parent hooks exactly once", () => {
    const document = session('<Gallery><Panel id="panel"><Child id="child"/></Panel></Gallery>')
    const events: string[] = []
    document.registerDisposal("id:panel", () => events.push("panel"))
    document.registerDisposal("id:child", () => events.push("child"))

    dispatchTurboStreamFragment(document, '<turbo-stream action="remove" target="panel"/>')
    dispatchTurboStreamFragment(document, '<turbo-stream action="remove" target="panel"/>')

    expect(events).toEqual(["child", "panel"])
  })

  test("disposes replaced identity even when the stable key is reused", () => {
    const document = session('<Gallery><Panel id="panel"><Old/></Panel></Gallery>')
    const disposed: string[] = []
    document.registerDisposal("id:panel", () => disposed.push("old"))

    dispatchTurboStreamFragment(
      document,
      '<turbo-stream action="replace" target="panel"><template><Panel id="panel"><New/></Panel></template></turbo-stream>',
    )
    document.registerDisposal("id:panel", () => disposed.push("new"))
    dispatchTurboStreamFragment(document, '<turbo-stream action="remove" target="panel"/>')

    expect(disposed).toEqual(["old", "new"])
  })

  test("supports explicit unregister and reports hook errors after all cleanup runs", () => {
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

    dispatchTurboStreamFragment(document, '<turbo-stream action="remove" target="panel"/>')

    expect(events).toEqual(["broken", "parent"])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ code: "disposal", context: { target: "id:child" } })
    expect(document.tree.getElementById("panel")).toBeUndefined()
    expect(() => document.registerDisposal("id:panel", () => undefined)).toThrow(TargetError)
  })

  test("commits before reporting every disposal and stable-snapshot listener failure", () => {
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

  test("uses one callback snapshot across every key in a tree replacement", () => {
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

  test("reports every disposal, reporter, and listener failure after commit", () => {
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
