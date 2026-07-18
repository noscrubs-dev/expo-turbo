import { describe, expect, test } from "bun:test"

import type { ClockAdapter, TurboRequest, TurboResponse } from "../adapters"
import {
  DocumentHistory,
  type DocumentHistoryEntry,
  type DocumentHistoryHostAdapter,
} from "./document-history"
import {
  type DocumentHistoryTraversalSource,
  subscribeDocumentHistoryTraversal,
} from "./document-history-traversal"
import { DocumentRequestLoader } from "./document-loader"
import { DocumentSnapshotCache } from "./document-snapshot-cache"
import {
  type DocumentTraversalRestoreResult,
  DocumentVisitController,
} from "./document-visit-controller"
import { StateError, TargetError } from "./errors"
import { parseExpoTurboDocument } from "./parser"
import { EXPO_TURBO_MIME_TYPE } from "./protocol-request"
import { DocumentSession } from "./session"

interface PendingRequest {
  readonly request: TurboRequest
  readonly resolve: (response: TurboResponse) => void
}

class ManualClock implements ClockAdapter {
  clearTimeout(): void {}
  now(): number {
    return 0
  }
  setTimeout(): object {
    return Object.freeze({})
  }
}

class TraversalSource implements DocumentHistoryTraversalSource {
  listener: ((entry: DocumentHistoryEntry) => void) | undefined
  readonly listeners: Array<(entry: DocumentHistoryEntry) => void> = []
  subscribeCalls = 0
  unsubscribeCalls = 0

  subscribe(listener: (entry: DocumentHistoryEntry) => void): () => undefined {
    this.subscribeCalls += 1
    this.listener = listener
    this.listeners.push(listener)
    return () => {
      this.unsubscribeCalls += 1
      if (this.listener === listener) this.listener = undefined
      return undefined
    }
  }

  emit(entry: DocumentHistoryEntry): void {
    const listener = this.listener
    if (!listener) throw new Error("Traversal source is not subscribed")
    listener(entry)
  }
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

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function harness(snapshotCache = new DocumentSnapshotCache()) {
  const pending: PendingRequest[] = []
  const writes: DocumentHistoryEntry[] = []
  const host: DocumentHistoryHostAdapter = {
    write(_method, entry) {
      writes.push(entry)
    },
  }
  const history = new DocumentHistory({ next: () => "unused" }, host)
  history.initialize({
    entry: {
      restorationIdentifier: "current",
      restorationIndex: 4,
      url: "https://example.test/current",
    },
    kind: "managed",
  })
  const session = new DocumentSession(
    parseExpoTurboDocument('<Gallery><Current id="current" /></Gallery>', {
      url: "https://example.test/current",
    }),
  )
  let requestId = 0
  const loader = new DocumentRequestLoader(
    session,
    {
      fetch: (request) =>
        new Promise<TurboResponse>((resolve) => pending.push({ request, resolve })),
    },
    { next: () => `request-${++requestId}` },
  )
  const controller = new DocumentVisitController(loader, new ManualClock(), {
    history,
    snapshotCache,
  })
  const errors: Error[] = []
  const results: DocumentTraversalRestoreResult[] = []
  const source = new TraversalSource()
  const unsubscribe = subscribeDocumentHistoryTraversal(source, controller, {
    onError: (error) => errors.push(error),
    onResult: (result) => results.push(result),
  })
  return { controller, errors, history, pending, results, session, source, unsubscribe, writes }
}

describe("document history traversal subscription", () => {
  test("restores a managed cached entry without another host write", async () => {
    const cache = new DocumentSnapshotCache()
    cache.put(
      "https://example.test/back",
      parseExpoTurboDocument('<Gallery><Back id="back" /></Gallery>', {
        url: "https://example.test/back",
      }),
    )
    const fixture = harness(cache)

    fixture.source.emit({
      restorationIdentifier: "back",
      restorationIndex: 2,
      url: "https://example.test/back",
    })
    await tick()

    expect(fixture.source.subscribeCalls).toBe(1)
    expect(fixture.results).toEqual([
      {
        direction: "back",
        entry: {
          restorationIdentifier: "back",
          restorationIndex: 2,
          url: "https://example.test/back",
        },
        restorationData: {},
        source: "snapshot",
        status: "restored",
      },
    ])
    expect(fixture.errors).toEqual([])
    expect(fixture.pending).toHaveLength(0)
    expect(fixture.writes).toEqual([])
    expect(fixture.session.tree.getElementById("back")).toBeDefined()
    fixture.unsubscribe()
  })

  test("reports one network restoration result for a cache miss", async () => {
    const fixture = harness()

    fixture.source.emit({
      restorationIdentifier: "forward",
      restorationIndex: 5,
      url: "https://example.test/forward",
    })
    expect(fixture.pending).toHaveLength(1)
    expect(fixture.history.current?.restorationIdentifier).toBe("forward")
    fixture.pending[0]?.resolve(
      response('<Gallery><Forward id="forward" /></Gallery>', "https://example.test/forward"),
    )
    await tick()

    expect(fixture.results).toHaveLength(1)
    expect(fixture.results[0]).toMatchObject({
      direction: "forward",
      result: { classification: "success", status: "committed" },
      source: "network",
    })
    expect(fixture.errors).toEqual([])
    expect(fixture.writes).toEqual([])
    expect(fixture.session.tree.getElementById("forward")).toBeDefined()
    fixture.unsubscribe()
  })

  test("adopts rapid traversal events immediately and reports only the newest settlement", async () => {
    const cache = new DocumentSnapshotCache()
    cache.put(
      "https://example.test/newest",
      parseExpoTurboDocument('<Gallery><Newest id="newest" /></Gallery>', {
        url: "https://example.test/newest",
      }),
    )
    const fixture = harness(cache)

    fixture.source.emit({
      restorationIdentifier: "first",
      restorationIndex: 3,
      url: "https://example.test/first",
    })
    expect(fixture.pending).toHaveLength(1)
    fixture.source.emit({
      restorationIdentifier: "newest",
      restorationIndex: 6,
      url: "https://example.test/newest",
    })

    expect(fixture.history.current?.restorationIdentifier).toBe("newest")
    expect(fixture.pending[0]?.request.signal?.aborted).toBe(true)
    fixture.pending[0]?.resolve(
      response('<Gallery><Late id="late" /></Gallery>', "https://example.test/first"),
    )
    await tick()

    expect(fixture.results).toHaveLength(1)
    expect(fixture.results[0]).toMatchObject({
      entry: { restorationIdentifier: "newest" },
      source: "snapshot",
      status: "restored",
    })
    expect(fixture.errors).toEqual([])
    expect(fixture.session.tree.getElementById("newest")).toBeDefined()
    expect(fixture.session.tree.getElementById("late")).toBeUndefined()
    fixture.unsubscribe()
  })

  test("a newer invalid host entry supersedes an older pending restoration", async () => {
    const fixture = harness()

    fixture.source.emit({
      restorationIdentifier: "pending",
      restorationIndex: 3,
      url: "https://example.test/pending",
    })
    expect(fixture.pending).toHaveLength(1)

    fixture.source.emit({
      restorationIdentifier: "invalid",
      restorationIndex: 4,
      url: "https://outside.test/private",
    })
    expect(fixture.pending[0]?.request.signal?.aborted).toBe(true)
    fixture.pending[0]?.resolve(
      response('<Gallery><Stale id="stale" /></Gallery>', "https://example.test/pending"),
    )
    await tick()

    expect(fixture.results).toEqual([])
    expect(fixture.errors).toHaveLength(1)
    expect(fixture.errors[0]).toBeInstanceOf(TargetError)
    expect(fixture.session.tree.getElementById("current")).toBeDefined()
    expect(fixture.session.tree.getElementById("stale")).toBeUndefined()
    fixture.unsubscribe()
  })

  test("reports invalid entries and remains usable for a later valid traversal", async () => {
    const cache = new DocumentSnapshotCache()
    cache.put(
      "https://example.test/recovered",
      parseExpoTurboDocument('<Gallery><Recovered id="recovered" /></Gallery>', {
        url: "https://example.test/recovered",
      }),
    )
    const fixture = harness(cache)

    const invalidEntries = [
      {
        restorationIdentifier: "foreign",
        restorationIndex: 3,
        url: "https://outside.test/private",
      },
      {
        restorationIdentifier: "fragment",
        restorationIndex: 3,
        url: "https://example.test/current#private",
      },
      {
        restorationIdentifier: "malformed",
        restorationIndex: -1,
        url: "https://example.test/malformed",
      },
    ]
    for (const entry of invalidEntries) {
      fixture.source.emit(entry)
      await tick()
    }

    expect(fixture.errors).toHaveLength(3)
    expect(fixture.errors[0]).toBeInstanceOf(TargetError)
    expect(fixture.errors[1]).toBeInstanceOf(TargetError)
    expect(fixture.errors[2]).toBeInstanceOf(StateError)
    expect(fixture.results).toEqual([])
    expect(fixture.pending).toHaveLength(0)
    expect(fixture.writes).toEqual([])
    expect(fixture.history.current?.restorationIdentifier).toBe("current")

    fixture.source.emit({
      restorationIdentifier: "recovered",
      restorationIndex: 2,
      url: "https://example.test/recovered",
    })
    await tick()

    expect(fixture.results).toHaveLength(1)
    expect(fixture.results[0]).toMatchObject({
      entry: { restorationIdentifier: "recovered" },
      source: "snapshot",
      status: "restored",
    })
    expect(fixture.errors).toHaveLength(3)
    fixture.unsubscribe()
  })

  test("unsubscribe suppresses late events and settlements without canceling controller work", async () => {
    const fixture = harness()
    fixture.source.emit({
      restorationIdentifier: "forward",
      restorationIndex: 5,
      url: "https://example.test/forward",
    })
    expect(fixture.pending).toHaveLength(1)
    const lateListener = fixture.source.listeners[0]

    fixture.unsubscribe()
    fixture.unsubscribe()
    expect(fixture.source.unsubscribeCalls).toBe(1)
    lateListener?.({
      restorationIdentifier: "late",
      restorationIndex: 6,
      url: "https://example.test/late",
    })
    expect(fixture.pending).toHaveLength(1)
    fixture.pending[0]?.resolve(
      response('<Gallery><Forward id="forward" /></Gallery>', "https://example.test/forward"),
    )
    await tick()

    expect(fixture.results).toEqual([])
    expect(fixture.errors).toEqual([])
    expect(fixture.session.tree.getElementById("forward")).toBeDefined()
  })

  test("fails subscription lifecycle errors synchronously and invalidates before unsubscribe", async () => {
    const controller = {
      restoreTraversal: () => Promise.reject(new Error("must not run")),
    }
    const onError = () => undefined

    expect(() =>
      subscribeDocumentHistoryTraversal(
        {
          subscribe() {
            throw new Error("secret subscription failure")
          },
        },
        controller,
        { onError },
      ),
    ).toThrow(new StateError("Document history traversal subscription failed"))

    expect(() =>
      subscribeDocumentHistoryTraversal({ subscribe: (() => "invalid") as never }, controller, {
        onError,
      }),
    ).toThrow(
      new StateError("Document history traversal source must return an unsubscribe function"),
    )

    expect(() =>
      subscribeDocumentHistoryTraversal(
        {
          subscribe: (async () => {
            throw new Error("secret asynchronous subscription failure")
          }) as never,
        },
        controller,
        { onError },
      ),
    ).toThrow(
      new StateError("Document history traversal source must return an unsubscribe function"),
    )
    await tick()

    let listener: ((entry: DocumentHistoryEntry) => void) | undefined
    let restoreCalls = 0
    const unsubscribe = subscribeDocumentHistoryTraversal(
      {
        subscribe(next) {
          listener = next
          return () => {
            throw new Error("secret unsubscribe failure")
          }
        },
      },
      {
        restoreTraversal: () => {
          restoreCalls += 1
          return Promise.reject(new Error("must not settle"))
        },
      },
      { onError },
    )

    expect(() => unsubscribe()).toThrow(
      new StateError("Document history traversal unsubscribe failed"),
    )
    listener?.({
      restorationIdentifier: "late",
      restorationIndex: 1,
      url: "https://example.test/late",
    })
    expect(restoreCalls).toBe(0)
  })

  test("rejects asynchronous unsubscribe cleanup contracts synchronously", async () => {
    let listener: ((entry: DocumentHistoryEntry) => void) | undefined
    let restoreCalls = 0
    const unsubscribe = subscribeDocumentHistoryTraversal(
      {
        subscribe(next) {
          listener = next
          return (async () => {
            throw new Error("secret asynchronous unsubscribe failure")
          }) as never
        },
      },
      {
        restoreTraversal: () => {
          restoreCalls += 1
          return Promise.reject(new Error("must not settle"))
        },
      },
      { onError: () => undefined },
    )

    expect(() => unsubscribe()).toThrow(
      new StateError("Document history traversal unsubscribe failed"),
    )
    listener?.({
      restorationIdentifier: "late",
      restorationIndex: 1,
      url: "https://example.test/late",
    })
    await tick()
    expect(restoreCalls).toBe(0)
  })
})
