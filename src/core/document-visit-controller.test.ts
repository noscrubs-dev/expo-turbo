import { describe, expect, test } from "bun:test"

import type {
  ClockAdapter,
  FetchAdapter,
  NavigationAdapter,
  TurboRequest,
  TurboResponse,
} from "../adapters"
import {
  DocumentHistory,
  type DocumentHistoryEntry,
  type DocumentHistoryHostAdapter,
  type DocumentHistoryWriteMethod,
} from "./document-history"
import {
  DocumentCommitError,
  DocumentRequestLoader,
  DocumentSnapshotRestoreCommitError,
} from "./document-loader"
import { DocumentSnapshotCache } from "./document-snapshot-cache"
import {
  DOCUMENT_VISIT_PROGRESS_DELAY_MS,
  DocumentVisitController,
} from "./document-visit-controller"
import { ContentTypeError, ParseError, RequestError, StateError, TargetError } from "./errors"
import { EXPO_TURBO_MIME_TYPE } from "./frame-loader"
import { parseExpoTurboDocument } from "./parser"
import { DocumentSession } from "./session"
import { attributeValue, type DocumentTree } from "./tree"

interface PendingRequest {
  readonly request: TurboRequest
  readonly resolve: (response: TurboResponse) => void
}

interface TimerRecord {
  readonly callback: () => void
  cleared: boolean
  readonly delayMs: number
  readonly handle: object
}

class ManualClock implements ClockAdapter {
  onClear: (() => void) | undefined
  readonly timers: TimerRecord[] = []

  clearTimeout(handle: unknown): void {
    const timer = this.timers.find((candidate) => candidate.handle === handle)
    if (timer) timer.cleared = true
    const onClear = this.onClear
    this.onClear = undefined
    onClear?.()
  }

  now(): number {
    return 0
  }

  setTimeout(callback: () => void, delayMs: number): unknown {
    const handle = Object.freeze({})
    this.timers.push({ callback, cleared: false, delayMs, handle })
    return handle
  }

  fire(index: number): void {
    const timer = this.timers[index]
    if (!timer) throw new Error(`Missing timer ${index}`)
    timer.callback()
  }
}

class ReentrantSnapshotCache extends DocumentSnapshotCache {
  onGet: (() => void) | undefined
  onPut: (() => void) | undefined

  override get(url: string): DocumentTree | undefined {
    const snapshot = super.get(url)
    const onGet = this.onGet
    this.onGet = undefined
    onGet?.()
    return snapshot
  }

  override put(url: string, tree: DocumentTree): void {
    super.put(url, tree)
    const onPut = this.onPut
    this.onPut = undefined
    onPut?.()
  }
}

function historyFixture(
  write: (method: DocumentHistoryWriteMethod, entry: DocumentHistoryEntry) => undefined = () =>
    undefined,
  currentUrl = "https://example.test/current",
  restorationIndex = 0,
): Readonly<{
  history: DocumentHistory
  writes: ReadonlyArray<
    Readonly<{ readonly entry: DocumentHistoryEntry; readonly method: DocumentHistoryWriteMethod }>
  >
}> {
  const writes: Array<
    Readonly<{ readonly entry: DocumentHistoryEntry; readonly method: DocumentHistoryWriteMethod }>
  > = []
  let identifier = 0
  const host: DocumentHistoryHostAdapter = {
    write(method, entry) {
      writes.push(Object.freeze({ entry, method }))
      return write(method, entry)
    },
  }
  const history = new DocumentHistory({ next: () => `history-${++identifier}` }, host)
  history.initialize({
    entry: {
      restorationIdentifier: "history-current",
      restorationIndex,
      url: currentUrl,
    },
    kind: "managed",
  })
  return Object.freeze({ history, writes })
}

function response(xml: string, options: Partial<TurboResponse> = {}): TurboResponse {
  return {
    headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
    redirected: false,
    status: 200,
    text: async () => xml,
    url: "https://example.test/response",
    ...options,
  }
}

function harness(
  options: Readonly<{
    clock?: ManualClock
    documentUrl?: string
    documentXml?: string
    fetch?: FetchAdapter["fetch"]
    onObserverError?: (error: AggregateError) => void
    progressDelayMs?: number
    snapshotCache?: DocumentSnapshotCache
    history?: DocumentHistory
  }> = {},
) {
  const pending: PendingRequest[] = []
  const session = new DocumentSession(
    parseExpoTurboDocument(options.documentXml ?? '<Gallery><Old id="old" /></Gallery>', {
      url: options.documentUrl ?? "https://example.test/current",
    }),
  )
  let requestId = 0
  const loader = new DocumentRequestLoader(
    session,
    {
      fetch:
        options.fetch ??
        ((request) =>
          new Promise<TurboResponse>((resolve) => {
            pending.push({ request, resolve })
          })),
    },
    { next: () => `request-${++requestId}` },
  )
  const clock = options.clock ?? new ManualClock()
  const controller = new DocumentVisitController(loader, clock, {
    ...(options.history ? { history: options.history } : {}),
    ...(options.onObserverError ? { onObserverError: options.onObserverError } : {}),
    ...(options.progressDelayMs !== undefined ? { progressDelayMs: options.progressDelayMs } : {}),
    ...(options.snapshotCache ? { snapshotCache: options.snapshotCache } : {}),
  })
  return { clock, controller, loader, pending, session }
}

describe("Document visit controller", () => {
  test("publishes initialized, started, delayed-progress, and completed snapshots", async () => {
    const { clock, controller, pending, session } = harness()
    const revisions: number[] = []
    controller.subscribe(() => revisions.push(controller.state.revision))

    expect(controller.state).toEqual({
      busy: false,
      progressVisible: false,
      revision: 0,
      status: "initialized",
    })
    const initial = controller.state
    expect(controller.state).toBe(initial)

    const visit = controller.visit("/next")
    expect(pending).toHaveLength(1)
    expect(controller.state).toEqual({
      busy: true,
      progressVisible: false,
      revision: 1,
      status: "started",
    })
    expect(clock.timers[0]?.delayMs).toBe(DOCUMENT_VISIT_PROGRESS_DELAY_MS)

    clock.fire(0)
    expect(controller.state).toEqual({
      busy: true,
      progressVisible: true,
      revision: 2,
      status: "started",
    })

    pending[0]?.resolve(
      response('<Gallery><Next id="next" /></Gallery>', {
        url: "https://example.test/next",
      }),
    )
    expect(await visit).toMatchObject({ classification: "success", status: "committed" })
    expect(controller.state).toEqual({
      busy: false,
      progressVisible: false,
      revision: 3,
      status: "completed",
    })
    expect(revisions).toEqual([1, 2, 3])
    expect(session.tree.getElementById("next")?.tagName).toBe("Next")
  })

  test("restores a no-preview snapshot for a host back traversal without fetching or writing history", async () => {
    const snapshotCache = new DocumentSnapshotCache()
    snapshotCache.put(
      "https://example.test/back#stored",
      parseExpoTurboDocument(
        '<Gallery data-turbo-cache-control="no-preview"><Back id="back" /></Gallery>',
        { url: "https://example.test/back#stored" },
      ),
    )
    const { history, writes } = historyFixture(() => undefined, "https://example.test/current", 4)
    const { clock, controller, pending, session } = harness({ history, snapshotCache })
    const revisions: number[] = []
    controller.subscribe(() => revisions.push(controller.state.revision))
    session.setAttribute("id:old", "data-state", "latest")

    const result = await controller.restoreTraversal({
      restorationIdentifier: "history-back",
      restorationIndex: 2,
      url: "https://example.test/back",
    })

    expect(result).toEqual({
      direction: "back",
      entry: {
        restorationIdentifier: "history-back",
        restorationIndex: 2,
        url: "https://example.test/back",
      },
      restorationData: {},
      source: "snapshot",
      status: "restored",
    })
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.restorationData)).toBe(true)
    expect(pending).toHaveLength(0)
    expect(writes).toEqual([])
    expect(clock.timers).toHaveLength(0)
    expect(session.tree.getElementById("back")).toBeDefined()
    expect(session.tree.document.url).toBe("https://example.test/back")
    expect(snapshotCache.get("https://example.test/current")?.getElementById("old")).toMatchObject({
      attributes: expect.arrayContaining([
        expect.objectContaining({ name: "data-state", value: "latest" }),
      ]),
    })
    expect(controller.state.status).toBe("completed")
    expect(revisions).toEqual([1, 2])
  })

  test("falls back to one history-neutral GET for a forward traversal cache miss", async () => {
    const snapshotCache = new DocumentSnapshotCache()
    const { history, writes } = historyFixture(() => undefined, "https://example.test/current", 2)
    const { controller, pending, session } = harness({ history, snapshotCache })

    const restored = controller.restoreTraversal({
      restorationIdentifier: "history-forward",
      restorationIndex: 5,
      url: "https://example.test/forward",
    })

    expect(pending).toHaveLength(1)
    expect(pending[0]?.request.url).toBe("https://example.test/forward")
    expect(history.current).toEqual({
      restorationIdentifier: "history-forward",
      restorationIndex: 5,
      url: "https://example.test/forward",
    })
    session.setAttribute("id:old", "data-state", "latest")
    pending[0]?.resolve(
      response('<Gallery><Forward id="forward" /></Gallery>', {
        url: "https://example.test/forward",
      }),
    )

    expect(await restored).toMatchObject({
      direction: "forward",
      result: { classification: "success", status: "committed" },
      source: "network",
    })
    expect(writes).toEqual([])
    expect(session.tree.getElementById("forward")).toBeDefined()
    expect(snapshotCache.get("https://example.test/current")?.getElementById("old")).toMatchObject({
      attributes: expect.arrayContaining([
        expect.objectContaining({ name: "data-state", value: "latest" }),
      ]),
    })
    expect(controller.state.status).toBe("completed")
  })

  test("lets a newer host traversal supersede an in-flight restoration", async () => {
    const snapshotCache = new DocumentSnapshotCache()
    snapshotCache.put(
      "https://example.test/newest",
      parseExpoTurboDocument('<Gallery><Newest id="newest" /></Gallery>', {
        url: "https://example.test/newest",
      }),
    )
    const { history, writes } = historyFixture()
    const { controller, pending, session } = harness({ history, snapshotCache })

    const first = controller.restoreTraversal({
      restorationIdentifier: "history-first",
      restorationIndex: 1,
      url: "https://example.test/first",
    })
    expect(pending).toHaveLength(1)

    const second = await controller.restoreTraversal({
      restorationIdentifier: "history-second",
      restorationIndex: 2,
      url: "https://example.test/newest",
    })

    expect(second).toMatchObject({ source: "snapshot", status: "restored" })
    expect(pending[0]?.request.signal?.aborted).toBe(true)
    pending[0]?.resolve(
      response('<Gallery><Late id="late" /></Gallery>', {
        url: "https://example.test/first",
      }),
    )
    expect(await first).toMatchObject({ result: { status: "canceled" }, source: "network" })
    expect(history.current?.restorationIdentifier).toBe("history-second")
    expect(writes).toEqual([])
    expect(session.tree.getElementById("newest")).toBeDefined()
    expect(session.tree.getElementById("late")).toBeUndefined()
  })

  test("does not let stale cache lookup reclaim ownership from a newer traversal", async () => {
    const snapshotCache = new ReentrantSnapshotCache()
    snapshotCache.put(
      "https://example.test/older",
      parseExpoTurboDocument('<Gallery><Older id="older" /></Gallery>', {
        url: "https://example.test/older",
      }),
    )
    const { history } = historyFixture()
    const { controller, pending, session } = harness({ history, snapshotCache })
    let newest: Promise<unknown> | undefined
    snapshotCache.onGet = () => {
      newest = controller.restoreTraversal({
        restorationIdentifier: "history-newest",
        restorationIndex: 2,
        url: "https://example.test/newest",
      })
    }

    const older = controller.restoreTraversal({
      restorationIdentifier: "history-older",
      restorationIndex: 1,
      url: "https://example.test/older",
    })

    await expect(older).rejects.toThrow("superseded before ownership")
    if (!newest) throw new Error("newer traversal was not started")
    expect(pending).toHaveLength(1)
    expect(pending[0]?.request.signal?.aborted).toBe(false)
    pending[0]?.resolve(
      response('<Gallery><Newest id="newest" /></Gallery>', {
        url: "https://example.test/newest",
      }),
    )
    expect(await newest).toMatchObject({
      result: { classification: "success", status: "committed" },
      source: "network",
    })
    expect(history.current?.restorationIdentifier).toBe("history-newest")
    expect(session.tree.getElementById("newest")).toBeDefined()
    expect(session.tree.getElementById("older")).toBeUndefined()
  })

  test("rejects a stale pre-start traversal after claim reentrancy without fetching", async () => {
    const { history } = historyFixture()
    const pendingPeer: Array<(response: TurboResponse) => void> = []
    let invalid: Promise<unknown> | undefined
    let traversalFetches = 0
    const session = new DocumentSession(
      parseExpoTurboDocument('<Gallery><Old id="old" /></Gallery>', {
        url: "https://example.test/current",
      }),
    )
    const traversalLoader = new DocumentRequestLoader(
      session,
      {
        fetch: async () => {
          traversalFetches += 1
          return response('<Gallery><Unexpected id="unexpected" /></Gallery>')
        },
      },
      { next: () => "traversal-request" },
    )
    const controller = new DocumentVisitController(traversalLoader, new ManualClock(), { history })
    const peerLoader = new DocumentRequestLoader(
      session,
      {
        fetch: (request) =>
          new Promise<TurboResponse>((resolve) => {
            pendingPeer.push(resolve)
            request.signal?.addEventListener("abort", () => {
              invalid = controller.restoreTraversal({
                restorationIdentifier: "invalid",
                restorationIndex: 2,
                url: "https://outside.test/private",
              })
              void invalid.catch(() => undefined)
            })
          }),
      },
      { next: () => "peer-request" },
    )
    const peer = peerLoader.load("/peer")

    const traversal = controller.restoreTraversal({
      restorationIdentifier: "history-traversal",
      restorationIndex: 1,
      url: "https://example.test/traversal",
    })

    await expect(traversal).rejects.toThrow("superseded before starting")
    if (!invalid) throw new Error("invalid traversal was not emitted")
    await expect(invalid).rejects.toBeInstanceOf(TargetError)
    expect(traversalFetches).toBe(0)
    expect(controller.state.status).toBe("initialized")
    expect(session.tree.getElementById("old")).toBeDefined()
    expect(session.tree.getElementById("unexpected")).toBeUndefined()
    pendingPeer[0]?.(response('<Gallery><Peer id="peer" /></Gallery>'))
    expect(await peer).toMatchObject({ status: "canceled" })
  })

  test("copies traversal entry primitives before history adoption", async () => {
    const snapshotCache = new DocumentSnapshotCache()
    snapshotCache.put(
      "https://example.test/newest",
      parseExpoTurboDocument('<Gallery><Newest id="newest" /></Gallery>', {
        url: "https://example.test/newest",
      }),
    )
    const { history } = historyFixture()
    const { controller, session } = harness({ history, snapshotCache })
    let newest: Promise<unknown> | undefined
    let emitted = false
    const older = controller.restoreTraversal({
      get restorationIdentifier() {
        if (!emitted) {
          emitted = true
          newest = controller.restoreTraversal({
            restorationIdentifier: "history-newest",
            restorationIndex: 2,
            url: "https://example.test/newest",
          })
        }
        return "history-older"
      },
      restorationIndex: 1,
      url: "https://example.test/older",
    })

    await expect(older).rejects.toThrow("superseded before admission")
    if (!newest) throw new Error("newer traversal was not started")
    expect(await newest).toMatchObject({ source: "snapshot", status: "restored" })
    expect(history.current?.restorationIdentifier).toBe("history-newest")
    expect(session.tree.getElementById("newest")).toBeDefined()
    expect(session.tree.getElementById("older")).toBeUndefined()
  })

  test("lets a started subscriber cancel cached restoration before tree replacement", async () => {
    const snapshotCache = new DocumentSnapshotCache()
    snapshotCache.put(
      "https://example.test/cached",
      parseExpoTurboDocument('<Gallery><Cached id="cached" /></Gallery>', {
        url: "https://example.test/cached",
      }),
    )
    const { history } = historyFixture()
    const { controller, pending, session } = harness({ history, snapshotCache })
    controller.subscribe(() => {
      if (controller.state.status === "started") controller.cancel()
    })

    const result = await controller.restoreTraversal({
      restorationIdentifier: "history-cached",
      restorationIndex: 1,
      url: "https://example.test/cached",
    })

    expect(result).toMatchObject({ source: "snapshot", status: "canceled" })
    expect(controller.state.status).toBe("canceled")
    expect(pending).toHaveLength(0)
    expect(session.tree.getElementById("old")).toBeDefined()
    expect(session.tree.getElementById("cached")).toBeUndefined()
  })

  test("rejects foreign-origin cached traversal before adopting history", async () => {
    const snapshotCache = new DocumentSnapshotCache()
    snapshotCache.put(
      "https://other.test/private",
      parseExpoTurboDocument('<Gallery><Private id="private" /></Gallery>', {
        url: "https://other.test/private",
      }),
    )
    const { history } = historyFixture()
    const { controller, pending, session } = harness({ history, snapshotCache })

    await expect(
      controller.restoreTraversal({
        restorationIdentifier: "history-private",
        restorationIndex: 1,
        url: "https://other.test/private",
      }),
    ).rejects.toBeInstanceOf(TargetError)

    expect(history.current?.restorationIdentifier).toBe("history-current")
    expect(snapshotCache.has("https://other.test/private")).toBe(true)
    expect(pending).toHaveLength(0)
    expect(session.tree.getElementById("old")).toBeDefined()
    expect(session.tree.getElementById("private")).toBeUndefined()
  })

  test("rejects missing, misaligned, and malformed traversal state before request ownership", async () => {
    const historyless = harness()
    await expect(
      historyless.controller.restoreTraversal({
        restorationIdentifier: "missing",
        restorationIndex: 1,
        url: "https://example.test/missing",
      }),
    ).rejects.toBeInstanceOf(TargetError)
    expect(historyless.pending).toHaveLength(0)

    const { history } = historyFixture(() => undefined, "https://example.test/other")
    const misaligned = harness({ history })
    await expect(
      misaligned.controller.restoreTraversal({
        restorationIdentifier: "misaligned",
        restorationIndex: 1,
        url: "https://example.test/misaligned",
      }),
    ).rejects.toBeInstanceOf(StateError)
    expect(history.current?.restorationIdentifier).toBe("history-current")
    expect(misaligned.pending).toHaveLength(0)

    const alignedHistory = historyFixture().history
    const malformed = harness({ history: alignedHistory })
    await expect(
      malformed.controller.restoreTraversal({
        restorationIdentifier: "credentialed",
        restorationIndex: 1,
        url: "https://user:secret@example.test/private",
      }),
    ).rejects.toBeInstanceOf(TargetError)
    expect(alignedHistory.current?.restorationIdentifier).toBe("history-current")
    expect(malformed.pending).toHaveLength(0)

    await expect(
      malformed.controller.restoreTraversal({
        restorationIdentifier: "fragment",
        restorationIndex: 1,
        url: "https://example.test/fragment#target",
      }),
    ).rejects.toBeInstanceOf(TargetError)
    await expect(
      malformed.controller.restoreTraversal({
        extra: "secret",
        restorationIdentifier: "extra",
        restorationIndex: 1,
        url: "https://example.test/extra",
      } as never),
    ).rejects.toThrow("unsupported fields")
    await expect(malformed.controller.restoreTraversal(null as never)).rejects.toBeInstanceOf(
      StateError,
    )
    await expect(malformed.controller.restoreTraversal([] as never)).rejects.toBeInstanceOf(
      StateError,
    )
    expect(alignedHistory.current?.restorationIdentifier).toBe("history-current")
    expect(malformed.pending).toHaveLength(0)
  })

  test("fails closed on a redirected traversal response without rolling host history back", async () => {
    const snapshotCache = new DocumentSnapshotCache()
    const { history, writes } = historyFixture()
    const { controller, pending, session } = harness({ history, snapshotCache })
    const restored = controller.restoreTraversal({
      restorationIdentifier: "history-target",
      restorationIndex: 1,
      url: "https://example.test/target",
    })

    pending[0]?.resolve(
      response('<Gallery><Redirected id="redirected" /></Gallery>', {
        redirected: true,
        url: "https://example.test/final",
      }),
    )

    await expect(restored).rejects.toBeInstanceOf(StateError)
    expect(history.current).toEqual({
      restorationIdentifier: "history-target",
      restorationIndex: 1,
      url: "https://example.test/target",
    })
    expect(writes).toEqual([])
    expect(session.tree.getElementById("old")).toBeDefined()
    expect(session.tree.getElementById("redirected")).toBeUndefined()
    expect(snapshotCache.has("https://example.test/current")).toBe(false)
    expect(controller.state.status).toBe("failed")
  })

  test("rejects a traversal response after host history moves again outside the controller", async () => {
    const snapshotCache = new DocumentSnapshotCache()
    const { history } = historyFixture()
    const { controller, pending, session } = harness({ history, snapshotCache })
    const restored = controller.restoreTraversal({
      restorationIdentifier: "history-target",
      restorationIndex: 1,
      url: "https://example.test/target",
    })
    expect(
      history.adoptTraversal({
        restorationIdentifier: "history-other",
        restorationIndex: 2,
        url: "https://example.test/other",
      }),
    ).toBe("forward")

    pending[0]?.resolve(
      response('<Gallery><Target id="target" /></Gallery>', {
        url: "https://example.test/target",
      }),
    )

    await expect(restored).rejects.toBeInstanceOf(StateError)
    expect(history.current?.restorationIdentifier).toBe("history-other")
    expect(session.tree.getElementById("old")).toBeDefined()
    expect(session.tree.getElementById("target")).toBeUndefined()
    expect(snapshotCache.has("https://example.test/current")).toBe(false)

    const recovered = controller.restoreTraversal({
      restorationIdentifier: "history-recovered",
      restorationIndex: 3,
      url: "https://example.test/recovered",
    })
    pending[1]?.resolve(
      response('<Gallery><Recovered id="recovered" /></Gallery>', {
        url: "https://example.test/recovered",
      }),
    )
    expect(await recovered).toMatchObject({
      direction: "forward",
      result: { status: "committed" },
      source: "network",
    })
    expect(session.tree.getElementById("recovered")).toBeDefined()
  })

  test("rechecks host history after cached and network outgoing snapshot capture", async () => {
    const cached = new ReentrantSnapshotCache()
    cached.put(
      "https://example.test/cached-target",
      parseExpoTurboDocument('<Gallery><CachedTarget id="cached-target" /></Gallery>', {
        url: "https://example.test/cached-target",
      }),
    )
    const cachedHistory = historyFixture().history
    const cachedHarness = harness({ history: cachedHistory, snapshotCache: cached })
    cached.onPut = () => {
      cachedHistory.adoptTraversal({
        restorationIdentifier: "history-cached-other",
        restorationIndex: 2,
        url: "https://example.test/cached-other",
      })
    }

    await expect(
      cachedHarness.controller.restoreTraversal({
        restorationIdentifier: "history-cached-target",
        restorationIndex: 1,
        url: "https://example.test/cached-target",
      }),
    ).rejects.toBeInstanceOf(StateError)
    expect(cachedHistory.current?.restorationIdentifier).toBe("history-cached-other")
    expect(cachedHarness.session.tree.getElementById("old")).toBeDefined()
    expect(cachedHarness.session.tree.getElementById("cached-target")).toBeUndefined()

    const network = new ReentrantSnapshotCache()
    const networkHistory = historyFixture().history
    const networkHarness = harness({ history: networkHistory, snapshotCache: network })
    const restoring = networkHarness.controller.restoreTraversal({
      restorationIdentifier: "history-network-target",
      restorationIndex: 1,
      url: "https://example.test/network-target",
    })
    network.onPut = () => {
      networkHistory.adoptTraversal({
        restorationIdentifier: "history-network-other",
        restorationIndex: 2,
        url: "https://example.test/network-other",
      })
    }
    networkHarness.pending[0]?.resolve(
      response('<Gallery><NetworkTarget id="network-target" /></Gallery>', {
        url: "https://example.test/network-target",
      }),
    )

    await expect(restoring).rejects.toBeInstanceOf(StateError)
    expect(networkHistory.current?.restorationIdentifier).toBe("history-network-other")
    expect(networkHarness.session.tree.getElementById("old")).toBeDefined()
    expect(networkHarness.session.tree.getElementById("network-target")).toBeUndefined()
  })

  test("keeps adopted history with the old tree for an empty traversal response", async () => {
    const { history, writes } = historyFixture()
    const { controller, pending, session } = harness({ history })
    const restored = controller.restoreTraversal({
      restorationIdentifier: "history-empty",
      restorationIndex: 1,
      url: "https://example.test/empty",
    })
    pending[0]?.resolve(
      response("", {
        status: 204,
        url: "https://example.test/empty",
      }),
    )

    expect(await restored).toMatchObject({ result: { status: "empty" }, source: "network" })
    expect(history.current?.restorationIdentifier).toBe("history-empty")
    expect(writes).toEqual([])
    expect(session.tree.getElementById("old")).toBeDefined()
    expect(controller.state.status).toBe("completed")
  })

  test("reports cached restoration finalization errors after committing restored truth", async () => {
    const snapshotCache = new DocumentSnapshotCache()
    snapshotCache.put(
      "https://example.test/restored",
      parseExpoTurboDocument('<Gallery><Restored id="restored" /></Gallery>', {
        url: "https://example.test/restored",
      }),
    )
    const { history } = historyFixture()
    const { controller, session } = harness({ history, snapshotCache })
    const errors: Error[] = []
    controller.subscribeErrors((error) => errors.push(error))
    session.registerDisposal("id:old", () => {
      throw new Error("disposal failed")
    })

    await expect(
      controller.restoreTraversal({
        restorationIdentifier: "history-restored",
        restorationIndex: 1,
        url: "https://example.test/restored",
      }),
    ).rejects.toBeInstanceOf(DocumentSnapshotRestoreCommitError)

    expect(session.tree.getElementById("restored")).toBeDefined()
    expect(controller.state.status).toBe("completed")
    expect(errors).toHaveLength(1)
    expect(errors[0]).toBeInstanceOf(DocumentSnapshotRestoreCommitError)
  })

  test("captures the latest outgoing truth immediately before an advance commit", async () => {
    const snapshotCache = new DocumentSnapshotCache()
    const { controller, pending, session } = harness({
      documentXml:
        '<Gallery><Old id="old" data-state="initial" /><Temporary id="temporary" data-turbo-temporary="" /></Gallery>',
      snapshotCache,
    })
    const visit = controller.visit("/next")
    expect(snapshotCache.size).toBe(0)

    session.setAttribute("id:old", "data-state", "latest")
    pending[0]?.resolve(
      response('<Gallery><Next id="next" /></Gallery>', {
        url: "https://example.test/next",
      }),
    )

    expect(await visit).toMatchObject({ status: "committed" })
    const cached = snapshotCache.get("https://example.test/current")
    const old = cached?.getElementById("old")
    expect(old ? attributeValue(old, "data-state") : undefined).toBe("latest")
    expect(cached?.getElementById("temporary")).toBeUndefined()
    expect(session.tree.getElementById("next")?.tagName).toBe("Next")
    expect(session.tree.getElementById("old")).toBeUndefined()
  })

  test("commits an advance without caching a no-cache outgoing document", async () => {
    const snapshotCache = new DocumentSnapshotCache()
    const { controller, pending, session } = harness({
      documentXml: '<Gallery data-turbo-cache-control="no-cache"><Old id="old" /></Gallery>',
      snapshotCache,
    })
    const visit = controller.visit("/next")
    pending[0]?.resolve(
      response('<Gallery><Next id="next" /></Gallery>', {
        url: "https://example.test/next",
      }),
    )

    expect(await visit).toMatchObject({ status: "committed" })
    expect(snapshotCache.size).toBe(0)
    expect(session.tree.getElementById("next")?.tagName).toBe("Next")
  })

  test("captures outgoing truth before committing history and replacing the tree", async () => {
    const order: string[] = []
    const snapshotCache = new DocumentSnapshotCache()
    let history: DocumentHistory
    let session: DocumentSession
    const fixture = historyFixture((method, entry) => {
      expect(method).toBe("push")
      expect(entry.url).toBe("https://example.test/next")
      expect(snapshotCache.has("https://example.test/current")).toBe(true)
      expect(history.current?.restorationIdentifier).toBe("history-current")
      expect(session.tree.getElementById("old")).toBeDefined()
      expect(session.tree.getElementById("next")).toBeUndefined()
      order.push("history")
    })
    history = fixture.history
    const current = harness({ history, snapshotCache })
    session = current.session
    session.subscribe("id:old", () => {
      expect(history.current?.url).toBe("https://example.test/next")
      expect(session.tree.getElementById("old")).toBeUndefined()
      expect(session.tree.getElementById("next")).toBeDefined()
      order.push("tree")
    })

    const visit = current.controller.visit("/next")
    current.pending[0]?.resolve(
      response('<Gallery><Next id="next" /></Gallery>', {
        url: "https://example.test/next",
      }),
    )

    expect(await visit).toMatchObject({ status: "committed" })
    expect(order).toEqual(["history", "tree"])
    expect(fixture.writes).toEqual([
      {
        entry: {
          restorationIdentifier: "history-1",
          restorationIndex: 1,
          url: "https://example.test/next",
        },
        method: "push",
      },
    ])
    expect(history.current).toBe(fixture.writes[0]?.entry)
  })

  test("captures and replaces top-level history for an explicit replace visit", async () => {
    const order: string[] = []
    const snapshotCache = new DocumentSnapshotCache()
    let history: DocumentHistory
    let session: DocumentSession
    const fixture = historyFixture((method, entry) => {
      expect(method).toBe("replace")
      expect(entry).toMatchObject({
        restorationIndex: 0,
        url: "https://example.test/replacement",
      })
      expect(snapshotCache.has("https://example.test/current")).toBe(true)
      expect(history.current?.restorationIdentifier).toBe("history-current")
      expect(session.tree.getElementById("old")).toBeDefined()
      expect(session.tree.getElementById("replacement")).toBeUndefined()
      order.push("history")
    })
    history = fixture.history
    const current = harness({
      documentXml: '<Gallery><Old id="old" data-state="initial" /></Gallery>',
      history,
      snapshotCache,
    })
    const { controller, pending } = current
    session = current.session
    const visit = controller.visit("/replacement", { action: "replace" })
    session.setAttribute("id:old", "data-state", "latest")
    session.subscribe("id:old", () => {
      expect(history.current?.url).toBe("https://example.test/replacement")
      expect(session.tree.getElementById("old")).toBeUndefined()
      expect(session.tree.getElementById("replacement")).toBeDefined()
      order.push("tree")
    })
    pending[0]?.resolve(
      response('<Gallery><Replacement id="replacement" /></Gallery>', {
        url: "https://example.test/replacement",
      }),
    )

    expect(await visit).toMatchObject({ status: "committed" })
    const cached = snapshotCache.get("https://example.test/current")
    const old = cached?.getElementById("old")
    expect(old ? attributeValue(old, "data-state") : undefined).toBe("latest")
    expect(order).toEqual(["history", "tree"])
    expect(fixture.writes).toEqual([
      {
        entry: {
          restorationIdentifier: "history-1",
          restorationIndex: 0,
          url: "https://example.test/replacement",
        },
        method: "replace",
      },
    ])
    expect(fixture.history.current).toBe(fixture.writes[0]?.entry)
    expect(session.tree.getElementById("replacement")?.tagName).toBe("Replacement")
  })

  test("retargets an explicit replace redirect without changing its history method or index", async () => {
    const fixture = historyFixture()
    const { controller, pending, session } = harness({ history: fixture.history })

    const visit = controller.visit("/requested", { action: "replace" })
    pending[0]?.resolve(
      response('<Gallery><Final id="final" /></Gallery>', {
        redirected: true,
        url: "https://example.test/final",
      }),
    )

    expect(await visit).toMatchObject({ redirected: true, status: "committed" })
    expect(fixture.writes).toEqual([
      {
        entry: {
          restorationIdentifier: "history-1",
          restorationIndex: 0,
          url: "https://example.test/final",
        },
        method: "replace",
      },
    ])
    expect(session.tree.document.url).toBe("https://example.test/final")
  })

  test("aligns canonical-equivalent active and history URLs for an advance", async () => {
    const documentUrl = "https://example.test:443/current"
    const fixture = historyFixture(undefined, documentUrl)
    const { controller, pending, session } = harness({
      documentUrl,
      history: fixture.history,
    })

    const visit = controller.visit("/next")
    expect(pending[0]?.request.url).toBe("https://example.test/next")
    pending[0]?.resolve(
      response('<Gallery><Next id="next" /></Gallery>', {
        url: "https://example.test:443/next",
      }),
    )

    expect(await visit).toMatchObject({ status: "committed" })
    expect(fixture.writes).toHaveLength(1)
    expect(fixture.history.current?.url).toBe("https://example.test/next")
    expect(session.tree.document.url).toBe("https://example.test/next")
  })

  test("preserves requested-location history method while retargeting redirects", async () => {
    const fixture = historyFixture()
    const { controller, pending } = harness({ history: fixture.history })

    const sameLocation = controller.visit("/current")
    pending[0]?.resolve(
      response('<Gallery><Same id="same" /></Gallery>', {
        url: "https://example.test/current",
      }),
    )
    expect(await sameLocation).toMatchObject({ status: "committed" })

    const redirected = controller.visit("/requested")
    pending[1]?.resolve(
      response('<Gallery><Final id="final" /></Gallery>', {
        redirected: true,
        url: "https://example.test/final",
      }),
    )
    expect(await redirected).toMatchObject({ redirected: true, status: "committed" })

    expect(fixture.writes).toEqual([
      {
        entry: {
          restorationIdentifier: "history-1",
          restorationIndex: 0,
          url: "https://example.test/current",
        },
        method: "replace",
      },
      {
        entry: {
          restorationIdentifier: "history-2",
          restorationIndex: 1,
          url: "https://example.test/final",
        },
        method: "push",
      },
    ])
    expect(fixture.history.current).toBe(fixture.writes[1]?.entry)
  })

  test("keeps explicit no-tree responses out of document history", async () => {
    const fixture = historyFixture()
    const { controller, pending, session } = harness({ history: fixture.history })
    const tree = session.tree
    const historyEntry = fixture.history.current

    const empty = controller.visit("/empty")
    pending[0]?.resolve(
      response("unused", {
        headers: {},
        status: 204,
        url: "https://example.test/empty",
      }),
    )

    expect(await empty).toMatchObject({ status: "empty" })
    expect(fixture.writes).toEqual([])
    expect(fixture.history.current).toBe(historyEntry)
    expect(session.tree).toBe(tree)
  })

  test("keeps an explicit replace no-tree response out of cache and history", async () => {
    const snapshotCache = new DocumentSnapshotCache()
    const fixture = historyFixture()
    const { controller, pending, session } = harness({
      history: fixture.history,
      snapshotCache,
    })
    const tree = session.tree
    const historyEntry = fixture.history.current

    const visit = controller.visit("/empty-replacement", { action: "replace" })
    pending[0]?.resolve(
      response("unused", {
        headers: {},
        status: 204,
        url: "https://example.test/empty-replacement",
      }),
    )

    expect(await visit).toMatchObject({ status: "empty" })
    expect(snapshotCache.size).toBe(0)
    expect(fixture.writes).toEqual([])
    expect(fixture.history.current).toBe(historyEntry)
    expect(session.tree).toBe(tree)
  })

  test("rejects misaligned history before request ownership or lifecycle changes", async () => {
    const fixture = historyFixture(undefined, "https://example.test/other")
    const { controller, pending } = harness({ history: fixture.history })
    const initial = controller.state

    await expect(controller.visit("/next")).rejects.toBeInstanceOf(StateError)

    expect(controller.state).toBe(initial)
    expect(pending).toHaveLength(0)
    expect(fixture.writes).toEqual([])
    expect(fixture.history.current?.url).toBe("https://example.test/other")
  })

  test("rechecks active document alignment after injected history planning", async () => {
    let session: DocumentSession
    const writes: DocumentHistoryEntry[] = []
    const history = new DocumentHistory(
      {
        next() {
          session.replaceTree(
            parseExpoTurboDocument('<Gallery><Drifted id="drifted" /></Gallery>', {
              url: "https://example.test/drifted",
            }),
          )
          return "history-drifted"
        },
      },
      {
        write(_method, entry) {
          writes.push(entry)
        },
      },
    )
    history.initialize({
      entry: {
        restorationIdentifier: "history-current",
        restorationIndex: 0,
        url: "https://example.test/current",
      },
      kind: "managed",
    })
    const current = harness({ history })
    session = current.session
    const initial = current.controller.state

    await expect(current.controller.visit("/next")).rejects.toBeInstanceOf(StateError)

    expect(current.controller.state).toBe(initial)
    expect(current.pending).toHaveLength(0)
    expect(writes).toEqual([])
    expect(history.current?.url).toBe("https://example.test/current")
    expect(session.tree.document.url).toBe("https://example.test/drifted")
  })

  test("fails an atomic history-host rejection without replacing the tree and retries fresh", async () => {
    let attempts = 0
    const snapshotCache = new DocumentSnapshotCache()
    const fixture = historyFixture(() => {
      attempts += 1
      if (attempts === 1) throw new Error("history host failed with secret-token")
    })
    const { controller, pending, session } = harness({
      history: fixture.history,
      snapshotCache,
    })
    const tree = session.tree
    const historyEntry = fixture.history.current

    const failed = controller.visit("/failed")
    pending[0]?.resolve(
      response('<Gallery><Failed id="failed" /></Gallery>', {
        url: "https://example.test/failed",
      }),
    )
    try {
      await failed
      throw new Error("expected history host write to fail")
    } catch (error) {
      expect(error).toBeInstanceOf(StateError)
      expect(String(error)).not.toContain("secret-token")
    }
    expect(controller.state.status).toBe("failed")
    expect(session.tree).toBe(tree)
    expect(fixture.history.current).toBe(historyEntry)
    expect(snapshotCache.has("https://example.test/current")).toBe(true)

    const retry = controller.visit("/retry")
    pending[1]?.resolve(
      response('<Gallery><Retry id="retry" /></Gallery>', {
        url: "https://example.test/retry",
      }),
    )
    expect(await retry).toMatchObject({ status: "committed" })
    expect(fixture.history.current?.restorationIdentifier).toBe("history-2")
    expect(session.tree.getElementById("retry")).toBeDefined()
  })

  test("fails snapshot capture before any irreversible history write", async () => {
    class FailingSnapshotCache extends DocumentSnapshotCache {
      override put(): void {
        throw new Error("snapshot failed with secret-token")
      }
    }

    const fixture = historyFixture()
    const { controller, pending, session } = harness({
      history: fixture.history,
      snapshotCache: new FailingSnapshotCache(),
    })
    const tree = session.tree
    const historyEntry = fixture.history.current

    const visit = controller.visit("/next")
    pending[0]?.resolve(
      response('<Gallery><Next id="next" /></Gallery>', {
        url: "https://example.test/next",
      }),
    )
    try {
      await visit
      throw new Error("expected snapshot capture to fail")
    } catch (error) {
      expect(error).toBeInstanceOf(RequestError)
      expect(String(error)).not.toContain("secret-token")
    }

    expect(fixture.writes).toEqual([])
    expect(fixture.history.current).toBe(historyEntry)
    expect(session.tree).toBe(tree)
    expect(controller.state.status).toBe("failed")
  })

  test("keeps history-host reentrant visits and cancellation outside the commit", async () => {
    let controller: DocumentVisitController
    let peer: DocumentVisitController
    let sameControllerVisit: Promise<unknown> | undefined
    let peerVisit: Promise<unknown> | undefined
    const fixture = historyFixture(() => {
      sameControllerVisit = controller.visit("/same-controller")
      peerVisit = peer.visit("/peer")
      controller.cancel()
      expect(controller.state.status).toBe("started")
      expect(peer.state.status).toBe("initialized")
    })
    const current = harness({ history: fixture.history })
    controller = current.controller
    peer = new DocumentVisitController(current.loader, new ManualClock())

    const outer = controller.visit("/outer")
    current.pending[0]?.resolve(
      response('<Gallery><Outer id="outer" /></Gallery>', {
        url: "https://example.test/outer",
      }),
    )

    expect(await outer).toMatchObject({ status: "committed" })
    if (!sameControllerVisit || !peerVisit) throw new Error("reentrant visits were not captured")
    await expect(sameControllerVisit).rejects.toBeInstanceOf(StateError)
    await expect(peerVisit).rejects.toBeInstanceOf(StateError)
    expect(current.pending).toHaveLength(1)
    expect(controller.state.status).toBe("completed")
    expect(peer.state.status).toBe("initialized")
    expect(current.session.tree.getElementById("outer")).toBeDefined()
  })

  test("lets tree finalization start a newer visit from aligned history and tree state", async () => {
    const fixture = historyFixture()
    const { controller, pending, session } = harness({ history: fixture.history })
    let newer: Promise<unknown> | undefined
    const unsubscribe = session.subscribe("id:old", () => {
      unsubscribe()
      expect(fixture.history.current?.url).toBe("https://example.test/first")
      expect(session.tree.document.url).toBe("https://example.test/first")
      newer = controller.visit("/newer")
    })

    const first = controller.visit("/first")
    pending[0]?.resolve(
      response('<Gallery><First id="first" /></Gallery>', {
        url: "https://example.test/first",
      }),
    )
    expect(await first).toMatchObject({ status: "committed" })
    expect(controller.state.status).toBe("started")
    expect(pending[1]?.request.url).toBe("https://example.test/newer")

    pending[1]?.resolve(
      response('<Gallery><Newer id="newer" /></Gallery>', {
        url: "https://example.test/newer",
      }),
    )
    expect(await newer).toMatchObject({ status: "committed" })
    expect(controller.state.status).toBe("completed")
    expect(fixture.history.current?.url).toBe("https://example.test/newer")
    expect(session.tree.getElementById("newer")).toBeDefined()
  })

  test("ignores cancellation after final ownership release during tree finalization", async () => {
    const fixture = historyFixture()
    const { controller, pending, session } = harness({ history: fixture.history })
    let statusDuringFinalization: string | undefined
    const unsubscribe = session.subscribe("id:old", () => {
      unsubscribe()
      controller.cancel()
      statusDuringFinalization = controller.state.status
    })

    const visit = controller.visit("/committed")
    pending[0]?.resolve(
      response('<Gallery><Committed id="committed" /></Gallery>', {
        url: "https://example.test/committed",
      }),
    )

    expect(await visit).toMatchObject({ status: "committed" })
    expect(statusDuringFinalization).toBe("started")
    expect(controller.state.status).toBe("completed")
    expect(fixture.history.current?.url).toBe("https://example.test/committed")
    expect(session.tree.getElementById("committed")).toBeDefined()
  })

  test("clears fast-visit progress and ignores a manually fired stale timer", async () => {
    const snapshotCache = new DocumentSnapshotCache()
    const { clock, controller, pending, session } = harness({ snapshotCache })
    const visit = controller.visit("/empty")
    const timer = clock.timers[0]

    pending[0]?.resolve(
      response("unused", {
        headers: {},
        status: 204,
        url: "https://example.test/empty",
      }),
    )
    expect(await visit).toMatchObject({ status: "empty" })
    expect(timer?.cleared).toBe(true)
    const terminal = controller.state
    clock.fire(0)
    expect(controller.state).toBe(terminal)
    expect(controller.state.status).toBe("completed")
    expect(session.tree.getElementById("old")?.tagName).toBe("Old")
    expect(snapshotCache.size).toBe(0)
  })

  test("commits authoritative HTTP error documents before publishing failed", async () => {
    for (const fixture of [
      { classification: "client-error", status: 422 },
      { classification: "server-error", status: 500 },
    ] as const) {
      const snapshotCache = new DocumentSnapshotCache()
      const history = historyFixture()
      const { controller, pending, session } = harness({
        history: history.history,
        snapshotCache,
      })
      const errors: Error[] = []
      controller.subscribeErrors((error) => errors.push(error))
      const visit = controller.visit(`/error-${fixture.status}`)

      pending[0]?.resolve(
        response(`<Gallery><Error id="error-${fixture.status}" /></Gallery>`, {
          status: fixture.status,
          url: `https://example.test/error-${fixture.status}`,
        }),
      )

      expect(await visit).toMatchObject({
        classification: fixture.classification,
        status: "committed",
      })
      expect(controller.state.status).toBe("failed")
      expect(controller.state.busy).toBe(false)
      expect(errors).toHaveLength(0)
      expect(session.tree.getElementById(`error-${fixture.status}`)?.tagName).toBe("Error")
      expect(snapshotCache.has("https://example.test/current")).toBe(true)
      expect(history.writes).toHaveLength(1)
      expect(history.writes[0]).toMatchObject({
        entry: {
          restorationIndex: 1,
          url: `https://example.test/error-${fixture.status}`,
        },
        method: "push",
      })
    }
  })

  test("publishes typed transport failures while preserving the current document", async () => {
    const fixtures: ReadonlyArray<{
      error: typeof ContentTypeError | typeof ParseError | typeof RequestError
      fetch: FetchAdapter["fetch"]
    }> = [
      {
        error: RequestError,
        fetch: async () => Promise.reject(new Error("network unavailable")),
      },
      {
        error: ContentTypeError,
        fetch: async () => response("{}", { headers: { "Content-Type": "application/json" } }),
      },
      {
        error: ParseError,
        fetch: async () => response("<Gallery>"),
      },
    ]

    for (const fixture of fixtures) {
      const history = historyFixture()
      const snapshotCache = new DocumentSnapshotCache()
      const { clock, controller, session } = harness({
        fetch: fixture.fetch,
        history: history.history,
        snapshotCache,
      })
      const tree = session.tree
      const errors: Error[] = []
      controller.subscribeErrors((error) => errors.push(error))

      await expect(controller.visit("/failure")).rejects.toBeInstanceOf(fixture.error)
      expect(controller.state).toMatchObject({
        busy: false,
        progressVisible: false,
        status: "failed",
      })
      expect(errors).toHaveLength(1)
      expect(errors[0]).toBeInstanceOf(fixture.error)
      expect(clock.timers[0]?.cleared).toBe(true)
      expect(session.tree).toBe(tree)
      expect(snapshotCache.size).toBe(0)
      expect(history.writes).toEqual([])
    }
  })

  test("cancels immediately and ignores every later request and timer callback", async () => {
    const history = historyFixture()
    const snapshotCache = new DocumentSnapshotCache()
    const { clock, controller, pending, session } = harness({
      history: history.history,
      snapshotCache,
    })
    const visit = controller.visit("/pending")
    const loading = controller.state

    controller.cancel()
    expect(pending[0]?.request.signal?.aborted).toBe(true)
    expect(controller.state).toMatchObject({ busy: false, status: "canceled" })
    expect(controller.state.revision).toBe(loading.revision + 1)
    const canceled = controller.state
    controller.cancel()
    expect(controller.state).toBe(canceled)

    pending[0]?.resolve(
      response('<Gallery><Late id="late" /></Gallery>', {
        url: "https://example.test/pending",
      }),
    )
    expect(await visit).toMatchObject({ status: "canceled" })
    clock.fire(0)
    expect(controller.state).toBe(canceled)
    expect(session.tree.getElementById("late")).toBeUndefined()
    expect(snapshotCache.size).toBe(0)
    expect(history.writes).toEqual([])

    const retry = controller.visit("/retry")
    pending[1]?.resolve(
      response('<Gallery><Retry id="retry" /></Gallery>', {
        url: "https://example.test/retry",
      }),
    )
    expect(await retry).toMatchObject({ status: "committed" })
    expect(controller.state.status).toBe("completed")
    expect(history.writes).toHaveLength(1)
  })

  test("preserves newer work started by an abort listener during explicit cancellation", async () => {
    const pending: PendingRequest[] = []
    let controller: DocumentVisitController
    let newer: Promise<unknown> | undefined
    let requestCount = 0
    const current = harness({
      fetch: (request) =>
        new Promise<TurboResponse>((resolve) => {
          requestCount += 1
          pending.push({ request, resolve })
          if (requestCount === 1) {
            request.signal?.addEventListener("abort", () => {
              newer = controller.visit("/newer-from-abort")
            })
          }
        }),
    })
    controller = current.controller

    const older = controller.visit("/older")
    controller.cancel()

    expect(pending).toHaveLength(2)
    expect(pending[0]?.request.signal?.aborted).toBe(true)
    expect(pending[1]?.request.signal?.aborted).toBe(false)
    expect(controller.state.status).toBe("started")

    pending[0]?.resolve(
      response('<Gallery><Older id="older" /></Gallery>', {
        url: "https://example.test/older",
      }),
    )
    expect(await older).toMatchObject({ status: "canceled" })
    expect(controller.state.status).toBe("started")

    pending[1]?.resolve(
      response('<Gallery><Newer id="newer" /></Gallery>', {
        url: "https://example.test/newer-from-abort",
      }),
    )
    expect(await newer).toMatchObject({ status: "committed" })
    expect(controller.state.status).toBe("completed")
    expect(current.session.tree.getElementById("newer")).toBeDefined()
  })

  test("preserves a newer visit started reentrantly while clearing old progress", async () => {
    const clock = new ManualClock()
    const current = harness({ clock })
    let newer: Promise<unknown> | undefined

    const older = current.controller.visit("/older")
    clock.onClear = () => {
      newer = current.controller.visit("/newer-from-clear")
    }
    const displaced = current.controller.visit("/displaced")

    expect(current.pending).toHaveLength(3)
    expect(current.pending[0]?.request.signal?.aborted).toBe(true)
    expect(current.pending[1]?.request.signal?.aborted).toBe(true)
    expect(current.pending[2]?.request.signal?.aborted).toBe(false)
    expect(clock.timers).toHaveLength(2)
    expect(clock.timers[1]?.cleared).toBe(false)
    expect(current.controller.state.status).toBe("started")

    current.controller.cancel()
    expect(current.pending[2]?.request.signal?.aborted).toBe(true)
    expect(clock.timers[1]?.cleared).toBe(true)
    expect(current.controller.state.status).toBe("canceled")

    for (const [index, url] of ["older", "displaced", "newer-from-clear"].entries()) {
      current.pending[index]?.resolve(
        response(`<Gallery><Late id="late-${index}" /></Gallery>`, {
          url: `https://example.test/${url}`,
        }),
      )
    }
    expect(await older).toMatchObject({ status: "canceled" })
    expect(await displaced).toMatchObject({ status: "canceled" })
    expect(await newer).toMatchObject({ status: "canceled" })
  })

  test("installs request ownership before a started subscriber cancels", async () => {
    const { clock, controller, pending, session } = harness()
    let unsubscribe: () => void = () => undefined
    unsubscribe = controller.subscribe(() => {
      if (controller.state.status !== "started") return
      unsubscribe()
      controller.cancel()
    })

    const visit = controller.visit("/canceled-by-subscriber")

    expect(pending).toHaveLength(1)
    expect(pending[0]?.request.signal?.aborted).toBe(true)
    expect(clock.timers[0]?.cleared).toBe(true)
    expect(controller.state).toMatchObject({ busy: false, status: "canceled" })
    pending[0]?.resolve(
      response('<Gallery><Late id="late" /></Gallery>', {
        url: "https://example.test/canceled-by-subscriber",
      }),
    )
    expect(await visit).toMatchObject({ status: "canceled" })
    expect(session.tree.getElementById("late")).toBeUndefined()
  })

  test("keeps a reentrant newer visit authoritative", async () => {
    const { clock, controller, pending, session } = harness()
    let newer: Promise<unknown> | undefined
    let startedNewer = false
    controller.subscribe(() => {
      if (controller.state.status !== "started" || startedNewer) return
      startedNewer = true
      newer = controller.visit("/newer-from-subscriber")
    })

    const older = controller.visit("/older")

    expect(pending).toHaveLength(2)
    expect(pending[0]?.request.url).toBe("https://example.test/older")
    expect(pending[0]?.request.signal?.aborted).toBe(true)
    expect(pending[1]?.request.url).toBe("https://example.test/newer-from-subscriber")
    expect(pending[1]?.request.signal?.aborted).toBe(false)
    expect(clock.timers[0]?.cleared).toBe(true)
    pending[0]?.resolve(
      response('<Gallery><Older id="older" /></Gallery>', {
        url: "https://example.test/older",
      }),
    )
    expect(await older).toMatchObject({ status: "canceled" })
    pending[1]?.resolve(
      response('<Gallery><Newer id="newer" /></Gallery>', {
        url: "https://example.test/newer-from-subscriber",
      }),
    )
    expect(await newer).toMatchObject({ status: "committed" })
    expect(controller.state.status).toBe("completed")
    expect(session.tree.getElementById("older")).toBeUndefined()
    expect(session.tree.getElementById("newer")?.tagName).toBe("Newer")
  })

  test("keeps superseded request and timer settlements out of the newer visit", async () => {
    const { clock, controller, pending, session } = harness()
    const older = controller.visit("/older")
    const newer = controller.visit("/newer")
    expect(pending[0]?.request.signal?.aborted).toBe(true)
    expect(pending[1]?.request.signal?.aborted).toBe(false)
    expect(clock.timers[0]?.cleared).toBe(true)

    const newerStarted = controller.state
    clock.fire(0)
    expect(controller.state).toBe(newerStarted)
    pending[0]?.resolve(
      response('<Gallery><Older id="older" /></Gallery>', {
        url: "https://example.test/older",
      }),
    )
    expect(await older).toMatchObject({ status: "canceled" })
    expect(controller.state).toBe(newerStarted)

    clock.fire(1)
    expect(controller.state.progressVisible).toBe(true)
    pending[1]?.resolve(
      response('<Gallery><Newer id="newer" /></Gallery>', {
        url: "https://example.test/newer",
      }),
    )
    expect(await newer).toMatchObject({ status: "committed" })
    expect(controller.state.status).toBe("completed")
    expect(session.tree.getElementById("older")).toBeUndefined()
    expect(session.tree.getElementById("newer")?.tagName).toBe("Newer")
  })

  test("keeps a superseded response body and timer out of the newer visit", async () => {
    let releaseOlderBody: (_xml: string) => void = () => undefined
    let resolveNewer: (_response: TurboResponse) => void = () => undefined
    let signalOlderBodyStarted: () => void = () => undefined
    const olderBodyStarted = new Promise<void>((resolve) => {
      signalOlderBodyStarted = resolve
    })
    let fetchCount = 0
    const { clock, controller, session } = harness({
      fetch: () => {
        fetchCount += 1
        if (fetchCount === 1) {
          return Promise.resolve(
            response("unused", {
              text: () => {
                signalOlderBodyStarted()
                return new Promise<string>((resolve) => {
                  releaseOlderBody = resolve
                })
              },
              url: "https://example.test/older",
            }),
          )
        }
        return new Promise<TurboResponse>((resolve) => {
          resolveNewer = resolve
        })
      },
    })
    const errors: Error[] = []
    controller.subscribeErrors((error) => errors.push(error))
    const older = controller.visit("/older")
    await olderBodyStarted
    const newer = controller.visit("/newer")
    const newerStarted = controller.state

    expect(clock.timers[0]?.cleared).toBe(true)
    releaseOlderBody('<Gallery><Older id="older" /></Gallery>')
    expect(await older).toMatchObject({ status: "canceled" })
    expect(controller.state).toBe(newerStarted)
    clock.fire(0)
    expect(controller.state).toBe(newerStarted)
    clock.fire(1)
    expect(controller.state.progressVisible).toBe(true)
    resolveNewer(
      response('<Gallery><Newer id="newer" /></Gallery>', {
        url: "https://example.test/newer",
      }),
    )
    expect(await newer).toMatchObject({ status: "committed" })
    expect(controller.state.status).toBe("completed")
    expect(errors).toEqual([])
    expect(session.tree.getElementById("older")).toBeUndefined()
    expect(session.tree.getElementById("newer")?.tagName).toBe("Newer")
  })

  test("cancels after an external tree replacement while the response body is pending", async () => {
    let releaseBody: (_xml: string) => void = () => undefined
    let signalBodyStarted: () => void = () => undefined
    const bodyStarted = new Promise<void>((resolve) => {
      signalBodyStarted = resolve
    })
    const { clock, controller, session } = harness({
      fetch: async () =>
        response("unused", {
          text: () => {
            signalBodyStarted()
            return new Promise<string>((resolve) => {
              releaseBody = resolve
            })
          },
          url: "https://example.test/pending",
        }),
    })
    const errors: Error[] = []
    controller.subscribeErrors((error) => errors.push(error))
    const visit = controller.visit("/pending")
    await bodyStarted
    const replacement = parseExpoTurboDocument('<Gallery><External id="external" /></Gallery>', {
      url: "https://example.test/external",
    })
    session.replaceTree(replacement)
    releaseBody('<Gallery><Late id="late" /></Gallery>')

    expect(await visit).toMatchObject({ status: "canceled" })
    expect(clock.timers[0]?.cleared).toBe(true)
    expect(controller.state).toMatchObject({ busy: false, status: "canceled" })
    const canceled = controller.state
    clock.fire(0)
    expect(controller.state).toBe(canceled)
    expect(errors).toEqual([])
    expect(session.tree).toBe(replacement)
    expect(session.tree.getElementById("late")).toBeUndefined()
  })

  test("does not supersede an active visit when a newer source fails admission", async () => {
    const { controller, pending } = harness()
    const active = controller.visit("/valid")
    const started = controller.state

    await expect(controller.visit("https://outside.test/invalid")).rejects.toBeInstanceOf(
      TargetError,
    )
    expect(pending).toHaveLength(1)
    expect(pending[0]?.request.signal?.aborted).toBe(false)
    expect(controller.state).toBe(started)

    pending[0]?.resolve(
      response('<Gallery><Valid id="valid" /></Gallery>', {
        url: "https://example.test/valid",
      }),
    )
    expect(await active).toMatchObject({ status: "committed" })
    expect(controller.state.status).toBe("completed")
  })

  test("rejects a historyless replace, restore, and forged actions before ownership", async () => {
    const navigationCalls: string[] = []
    const navigation: NavigationAdapter = {
      back() {},
      openExternal() {},
      visit: (url) => navigationCalls.push(url),
    }
    const snapshotCache = new DocumentSnapshotCache()
    const { controller, pending } = harness({ snapshotCache })
    const active = controller.visit("/pending")
    const started = controller.state

    await expect(
      controller.visit("/other", { action: "replace", navigation }),
    ).rejects.toBeInstanceOf(TargetError)
    await expect(
      controller.visit("https://outside.test/restore", { action: "restore", navigation }),
    ).rejects.toBeInstanceOf(TargetError)
    await expect(
      controller.visit("/archive.pdf", { action: "bogus" as never, navigation }),
    ).rejects.toBeInstanceOf(TargetError)

    expect(navigationCalls).toEqual([])
    expect(pending).toHaveLength(1)
    expect(pending[0]?.request.signal?.aborted).toBe(false)
    expect(controller.state).toBe(started)
    expect(snapshotCache.size).toBe(0)
    pending[0]?.resolve(
      response('<Gallery><Done id="done" /></Gallery>', {
        url: "https://example.test/pending",
      }),
    )
    expect(await active).toMatchObject({ status: "committed" })
  })

  test("refreshes exact current truth without snapshot or history writes", async () => {
    const history = historyFixture()
    const snapshotCache = new DocumentSnapshotCache()
    const { controller, pending, session } = harness({
      documentXml: '<Gallery data-turbo-root="/app"><Old id="old" /></Gallery>',
      history: history.history,
      snapshotCache,
    })

    expect(await controller.refreshCurrent("https://example.test/stale")).toBeUndefined()
    expect(pending).toHaveLength(0)

    const refreshing = controller.refreshCurrent("https://example.test/current")
    expect(pending).toHaveLength(1)
    expect(pending[0]?.request.url).toBe("https://example.test/current")
    expect(await controller.refreshCurrent("https://example.test/current")).toBeUndefined()
    expect(pending).toHaveLength(1)

    pending[0]?.resolve(
      response('<Gallery data-turbo-root="/app"><Fresh id="fresh" /></Gallery>', {
        url: "https://example.test/current",
      }),
    )
    expect(await refreshing).toMatchObject({ status: "committed" })
    expect(session.tree.getElementById("fresh")).toBeDefined()
    expect(snapshotCache.size).toBe(0)
    expect(history.writes).toEqual([])
    expect(history.history.current?.url).toBe("https://example.test/current")
  })

  test("refreshes canonical-equivalent current history without a history write", async () => {
    const documentUrl = "https://example.test:443/current"
    const history = historyFixture(undefined, documentUrl)
    const { controller, pending, session } = harness({
      documentUrl,
      history: history.history,
    })

    const refreshing = controller.refreshCurrent("https://example.test/current")
    expect(pending[0]?.request.url).toBe("https://example.test/current")
    pending[0]?.resolve(
      response('<Gallery><Fresh id="fresh" /></Gallery>', {
        url: documentUrl,
      }),
    )

    expect(await refreshing).toMatchObject({ status: "committed" })
    expect(history.writes).toEqual([])
    expect(history.history.current?.url).toBe("https://example.test/current")
    expect(session.tree.document.url).toBe("https://example.test/current")
  })

  test("rejects a redirected refresh before it can drift from current history", async () => {
    const history = historyFixture()
    const { controller, pending, session } = harness({ history: history.history })
    const tree = session.tree
    const entry = history.history.current

    const refreshing = controller.refreshCurrent("https://example.test/current")
    pending[0]?.resolve(
      response('<Gallery data-turbo-root="/"><Redirected id="redirected" /></Gallery>', {
        redirected: true,
        url: "https://example.test/redirected",
      }),
    )

    await expect(refreshing).rejects.toBeInstanceOf(StateError)
    expect(controller.state.status).toBe("failed")
    expect(history.writes).toEqual([])
    expect(history.history.current).toBe(entry)
    expect(session.tree).toBe(tree)
  })

  test("rejects a refresh when history changes before the final tree commit", async () => {
    const history = historyFixture()
    const { controller, pending, session } = harness({ history: history.history })
    const tree = session.tree

    const refreshing = controller.refreshCurrent("https://example.test/current")
    history.history.commitProposal(history.history.proposeAdvance("https://example.test/manual"))
    pending[0]?.resolve(
      response('<Gallery><Fresh id="fresh" /></Gallery>', {
        url: "https://example.test/current",
      }),
    )

    await expect(refreshing).rejects.toBeInstanceOf(StateError)
    expect(controller.state.status).toBe("failed")
    expect(history.writes).toHaveLength(1)
    expect(history.history.current?.url).toBe("https://example.test/manual")
    expect(session.tree).toBe(tree)
  })

  test("delegates root-external, excluded-extension, and cross-origin proposals without disturbing the current visit", async () => {
    const navigationCalls: { action: string; url: string }[] = []
    const externalCalls: string[] = []
    const navigation: NavigationAdapter = {
      back() {},
      openExternal: (url) => externalCalls.push(url),
      visit: (url, action) => navigationCalls.push({ action, url }),
    }
    const { controller, pending } = harness({
      documentXml: '<Gallery data-turbo-root="/app"><Old id="old" /></Gallery>',
    })
    const active = controller.visit("/app/pending")
    const started = controller.state

    const outside = await controller.visit("/application", { navigation })
    const extension = await controller.visit("/app/archive.pdf", { navigation })
    const replacement = await controller.visit("/outside-replacement", {
      action: "replace",
      navigation,
    })
    const external = await controller.visit("https://outside.test/app", { navigation })

    expect(outside).toEqual({
      action: "advance",
      kind: "navigation",
      reason: "outside-root",
      status: "delegated",
      url: "https://example.test/application",
    })
    expect(extension).toEqual({
      action: "advance",
      kind: "navigation",
      reason: "unvisitable-extension",
      status: "delegated",
      url: "https://example.test/app/archive.pdf",
    })
    expect(replacement).toEqual({
      action: "replace",
      kind: "navigation",
      reason: "outside-root",
      status: "delegated",
      url: "https://example.test/outside-replacement",
    })
    expect(external).toEqual({
      kind: "external",
      reason: "external",
      status: "delegated",
      url: "https://outside.test/app",
    })
    expect(Object.isFrozen(outside)).toBe(true)
    expect(Object.isFrozen(extension)).toBe(true)
    expect(Object.isFrozen(external)).toBe(true)
    expect(navigationCalls).toEqual([
      { action: "advance", url: "https://example.test/application" },
      { action: "advance", url: "https://example.test/app/archive.pdf" },
      { action: "replace", url: "https://example.test/outside-replacement" },
    ])
    expect(externalCalls).toEqual(["https://outside.test/app"])
    expect(pending).toHaveLength(1)
    expect(pending[0]?.request.signal?.aborted).toBe(false)
    expect(controller.state).toBe(started)

    pending[0]?.resolve(
      response('<Gallery data-turbo-root="/app"><Done id="done" /></Gallery>', {
        url: "https://example.test/app/pending",
      }),
    )
    expect(await active).toMatchObject({ status: "committed" })
  })

  test("reproposes a successful redirect against the response document root before commit", async () => {
    const snapshotCache = new DocumentSnapshotCache()
    const history = historyFixture()
    const navigationCalls: { action: string; url: string }[] = []
    const navigation: NavigationAdapter = {
      back() {},
      openExternal() {},
      visit: (url, action) => navigationCalls.push({ action, url }),
    }
    const { controller, pending, session } = harness({
      documentXml: '<Gallery data-turbo-root="/app"><Old id="old" /></Gallery>',
      history: history.history,
      snapshotCache,
    })
    const previousTree = session.tree
    const visit = controller.visit("/app/start", { navigation })

    pending[0]?.resolve(
      response('<Gallery data-turbo-root="/other"><Discarded id="discarded" /></Gallery>', {
        redirected: true,
        url: "https://example.test/app/final",
      }),
    )

    expect(await visit).toEqual({
      action: "replace",
      kind: "navigation",
      reason: "outside-root",
      status: "delegated",
      url: "https://example.test/app/final",
    })
    expect(navigationCalls).toEqual([{ action: "replace", url: "https://example.test/app/final" }])
    expect(session.tree).toBe(previousTree)
    expect(session.tree.getElementById("discarded")).toBeUndefined()
    expect(snapshotCache.size).toBe(0)
    expect(history.writes).toEqual([])
    expect(history.history.current?.restorationIdentifier).toBe("history-current")
    expect(controller.state).toMatchObject({ busy: false, status: "completed" })
  })

  test("commits redirects admitted by the response root and nonredirect pages that redefine it", async () => {
    const navigationCalls: string[] = []
    const navigation: NavigationAdapter = {
      back() {},
      openExternal() {},
      visit: (url) => navigationCalls.push(url),
    }
    const { controller, pending, session } = harness({
      documentXml: '<Gallery data-turbo-root="/app"><Old id="old" /></Gallery>',
    })

    const redirected = controller.visit("/app/start", { navigation })
    pending[0]?.resolve(
      response('<Gallery data-turbo-root="/"><Wide id="wide" /></Gallery>', {
        redirected: true,
        url: "https://example.test/outside",
      }),
    )
    expect(await redirected).toMatchObject({ redirected: true, status: "committed" })
    expect(session.tree.getElementById("wide")?.tagName).toBe("Wide")

    const redefined = controller.visit("/next", { navigation })
    pending[1]?.resolve(
      response('<Gallery data-turbo-root="/other"><Narrow id="narrow" /></Gallery>', {
        url: "https://example.test/next",
      }),
    )
    expect(await redefined).toMatchObject({ redirected: false, status: "committed" })
    expect(session.tree.getElementById("narrow")?.tagName).toBe("Narrow")
    expect(navigationCalls).toEqual([])
  })

  test("commits redirected error documents even when their response root excludes the final URL", async () => {
    for (const fixture of [
      { classification: "client-error", status: 422 },
      { classification: "server-error", status: 500 },
    ] as const) {
      const navigationCalls: string[] = []
      const navigation: NavigationAdapter = {
        back() {},
        openExternal() {},
        visit: (url) => navigationCalls.push(url),
      }
      const { controller, pending, session } = harness({
        documentXml: '<Gallery data-turbo-root="/app"><Old id="old" /></Gallery>',
      })
      const visit = controller.visit("/app/start", { navigation })

      pending[0]?.resolve(
        response(
          `<Gallery data-turbo-root="/other"><Error id="error-${fixture.status}" /></Gallery>`,
          {
            redirected: true,
            status: fixture.status,
            url: `https://example.test/app/final-${fixture.status}`,
          },
        ),
      )

      expect(await visit).toMatchObject({
        classification: fixture.classification,
        redirected: true,
        status: "committed",
      })
      expect(controller.state.status).toBe("failed")
      expect(session.tree.getElementById(`error-${fixture.status}`)?.tagName).toBe("Error")
      expect(navigationCalls).toEqual([])
    }
  })

  test("reproposes redirected empty responses and excluded extensions against the active root", async () => {
    for (const fixture of [
      { headers: {}, status: 204, text: "unused", url: "https://example.test/outside-empty" },
      {
        headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
        status: 201,
        text: "  ",
        url: "https://example.test/outside-blank",
      },
      {
        headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
        status: 200,
        text: '<Gallery data-turbo-root="/app"><Discarded /></Gallery>',
        url: "https://example.test/app/archive.pdf",
      },
    ] as const) {
      const navigationCalls: { action: string; url: string }[] = []
      const navigation: NavigationAdapter = {
        back() {},
        openExternal() {},
        visit: (url, action) => navigationCalls.push({ action, url }),
      }
      const { controller, pending, session } = harness({
        documentXml: '<Gallery data-turbo-root="/app"><Old id="old" /></Gallery>',
      })
      const previousTree = session.tree
      const visit = controller.visit("/app/start", { navigation })

      pending[0]?.resolve(
        response(fixture.text, {
          headers: fixture.headers,
          redirected: true,
          status: fixture.status,
          url: fixture.url,
        }),
      )

      expect(await visit).toMatchObject({
        action: "replace",
        kind: "navigation",
        reason: fixture.url.endsWith(".pdf") ? "unvisitable-extension" : "outside-root",
        status: "delegated",
        url: fixture.url,
      })
      expect(navigationCalls).toEqual([{ action: "replace", url: fixture.url }])
      expect(session.tree).toBe(previousTree)
      expect(controller.state.status).toBe("completed")
    }
  })

  test("rejects invalid response roots and missing redirect navigation without retaining ownership", async () => {
    for (const fixture of [
      {
        error: TargetError,
        xml: '<Gallery data-turbo-root="https://user:secret@example.test/app"><Invalid /></Gallery>',
      },
      {
        error: TargetError,
        xml: '<Gallery data-turbo-root="/other"><NeedsNavigation /></Gallery>',
      },
    ] as const) {
      const { controller, pending, session } = harness({
        documentXml: '<Gallery data-turbo-root="/app"><Old id="old" /></Gallery>',
      })
      const previousTree = session.tree
      const first = controller.visit("/app/start")
      pending[0]?.resolve(
        response(fixture.xml, {
          redirected: true,
          url: "https://example.test/app/final",
        }),
      )

      await expect(first).rejects.toBeInstanceOf(fixture.error)
      expect(session.tree).toBe(previousTree)
      expect(controller.state.status).toBe("failed")

      const retry = controller.visit("/app/retry")
      expect(pending).toHaveLength(2)
      pending[1]?.resolve(
        response('<Gallery data-turbo-root="/app"><Retry id="retry" /></Gallery>', {
          url: "https://example.test/app/retry",
        }),
      )
      expect(await retry).toMatchObject({ status: "committed" })
      expect(session.tree.getElementById("retry")?.tagName).toBe("Retry")
    }
  })

  test("keeps a newer visit authoritative while stale redirect navigation settles", async () => {
    let rejectNavigation: (error: Error) => void = () => undefined
    let signalNavigationStarted: () => void = () => undefined
    const navigationStarted = new Promise<void>((resolve) => {
      signalNavigationStarted = resolve
    })
    const failure = new Error("stale router failure")
    const navigation: NavigationAdapter = {
      back() {},
      openExternal() {},
      visit: () => {
        signalNavigationStarted()
        return new Promise<void>((_resolve, reject) => {
          rejectNavigation = reject
        })
      },
    }
    const { controller, pending, session } = harness({
      documentXml: '<Gallery data-turbo-root="/app"><Old id="old" /></Gallery>',
    })
    const errors: Error[] = []
    controller.subscribeErrors((error) => errors.push(error))
    const stale = controller.visit("/app/start", { navigation })
    pending[0]?.resolve(
      response('<Gallery data-turbo-root="/other"><Stale /></Gallery>', {
        redirected: true,
        url: "https://example.test/app/final",
      }),
    )
    await navigationStarted

    const current = controller.visit("/app/current")
    const currentStarted = controller.state
    rejectNavigation(failure)
    await expect(stale).rejects.toBe(failure)
    expect(controller.state).toBe(currentStarted)
    expect(errors).toEqual([])

    pending[1]?.resolve(
      response('<Gallery data-turbo-root="/app"><Current id="current" /></Gallery>', {
        url: "https://example.test/app/current",
      }),
    )
    expect(await current).toMatchObject({ status: "committed" })
    expect(controller.state.status).toBe("completed")
    expect(session.tree.getElementById("current")?.tagName).toBe("Current")
  })

  test("rejects cross-origin final redirects without replacing the active document", async () => {
    const { controller, pending, session } = harness({
      documentXml: '<Gallery data-turbo-root="/app"><Old id="old" /></Gallery>',
    })
    const previousTree = session.tree
    const errors: Error[] = []
    controller.subscribeErrors((error) => errors.push(error))
    const visit = controller.visit("/app/start")
    pending[0]?.resolve(
      response('<Gallery data-turbo-root="/"><Outside /></Gallery>', {
        redirected: true,
        url: "https://outside.test/final",
      }),
    )

    await expect(visit).rejects.toBeInstanceOf(TargetError)
    expect(controller.state.status).toBe("failed")
    expect(errors).toHaveLength(1)
    expect(errors[0]).toBeInstanceOf(TargetError)
    expect(session.tree).toBe(previousTree)
  })

  test("fails a discarded redirect when owning-host navigation rejects", async () => {
    const failure = new Error("router unavailable")
    const navigation: NavigationAdapter = {
      back() {},
      openExternal() {},
      visit: () => {
        throw failure
      },
    }
    const { controller, pending, session } = harness({
      documentXml: '<Gallery data-turbo-root="/app"><Old id="old" /></Gallery>',
    })
    const previousTree = session.tree
    const errors: Error[] = []
    controller.subscribeErrors((error) => errors.push(error))
    const visit = controller.visit("/app/start", { navigation })
    pending[0]?.resolve(
      response('<Gallery data-turbo-root="/other"><Discarded /></Gallery>', {
        redirected: true,
        url: "https://example.test/app/final",
      }),
    )

    await expect(visit).rejects.toBe(failure)
    expect(controller.state).toMatchObject({ busy: false, status: "failed" })
    expect(errors).toEqual([failure])
    expect(session.tree).toBe(previousTree)
  })

  test("isolates owner-aware cancellation across controllers sharing one loader", async () => {
    const { loader, pending, session } = harness()
    const first = new DocumentVisitController(loader, new ManualClock())
    const second = new DocumentVisitController(loader, new ManualClock())
    const firstVisit = first.visit("/first")
    const secondVisit = second.visit("/second")

    expect(pending[0]?.request.signal?.aborted).toBe(true)
    first.cancel()
    expect(first.state.status).toBe("started")
    expect(pending[1]?.request.signal?.aborted).toBe(false)

    pending[0]?.resolve(
      response('<Gallery><First id="first" /></Gallery>', {
        url: "https://example.test/first",
      }),
    )
    expect(await firstVisit).toMatchObject({ status: "canceled" })
    expect(first.state.status).toBe("canceled")
    pending[1]?.resolve(
      response('<Gallery><Second id="second" /></Gallery>', {
        url: "https://example.test/second",
      }),
    )
    expect(await secondVisit).toMatchObject({ status: "committed" })
    expect(second.state.status).toBe("completed")
    expect(session.tree.getElementById("second")?.tagName).toBe("Second")
  })

  test("retains committed classification when session finalization reports an error", async () => {
    for (const fixture of [
      { expected: "completed", status: 200 },
      { expected: "failed", status: 422 },
    ] as const) {
      const history = historyFixture()
      const snapshotCache = new DocumentSnapshotCache()
      const { controller, pending, session } = harness({
        history: history.history,
        snapshotCache,
      })
      const errors: Error[] = []
      controller.subscribeErrors((error) => errors.push(error))
      session.registerDisposal("id:old", () => {
        throw new Error("fixture disposal failed")
      })
      const visit = controller.visit(`/committed-${fixture.status}`)
      pending[0]?.resolve(
        response(`<Gallery><Committed id="committed-${fixture.status}" /></Gallery>`, {
          status: fixture.status,
          url: `https://example.test/committed-${fixture.status}`,
        }),
      )

      await expect(visit).rejects.toBeInstanceOf(DocumentCommitError)
      expect(controller.state.status).toBe(fixture.expected)
      expect(controller.state.busy).toBe(false)
      expect(errors).toHaveLength(1)
      expect(errors[0]).toBeInstanceOf(DocumentCommitError)
      expect(session.tree.getElementById(`committed-${fixture.status}`)?.tagName).toBe("Committed")
      expect(snapshotCache.has("https://example.test/current")).toBe(true)
      expect(history.writes).toHaveLength(1)
      expect(history.writes[0]).toMatchObject({
        entry: { url: `https://example.test/committed-${fixture.status}` },
        method: "push",
      })
      expect(history.history.current).toBe(history.writes[0]?.entry)
    }
  })

  test("isolates state and error observer failures from request outcomes", async () => {
    const observerErrors: AggregateError[] = []
    const { controller, pending } = harness({
      onObserverError: (error) => observerErrors.push(error),
    })
    const stateEvents: string[] = []
    const reported: Error[] = []
    controller.subscribe(() => {
      stateEvents.push(`throwing:${controller.state.status}`)
      throw new Error("state observer failed")
    })
    controller.subscribe(() => stateEvents.push(`healthy:${controller.state.status}`))
    controller.subscribeErrors(() => {
      throw new Error("error observer failed")
    })
    controller.subscribeErrors((error) => reported.push(error))

    const visit = controller.visit("/observed")
    expect(pending).toHaveLength(1)
    expect(stateEvents).toEqual(["throwing:started", "healthy:started"])
    expect(reported).toEqual([])
    expect(observerErrors).toHaveLength(1)
    expect(observerErrors[0]?.errors[0]).toMatchObject({ message: "state observer failed" })

    pending[0]?.resolve(
      response('<Gallery><Observed id="observed" /></Gallery>', {
        url: "https://example.test/observed",
      }),
    )
    expect(await visit).toMatchObject({ status: "committed" })
    expect(controller.state.status).toBe("completed")
    expect(stateEvents).toEqual([
      "throwing:started",
      "healthy:started",
      "throwing:completed",
      "healthy:completed",
    ])
    expect(reported).toEqual([])
    expect(observerErrors).toHaveLength(2)

    const failed = controller.visit("/wrong-mime")
    pending[1]?.resolve(response("{}", { headers: { "Content-Type": "application/json" } }))
    await expect(failed).rejects.toBeInstanceOf(ContentTypeError)
    expect(reported.at(-1)).toBeInstanceOf(ContentTypeError)
    expect(observerErrors).toHaveLength(5)
    expect(observerErrors.at(-1)?.errors[0]).toMatchObject({ message: "error observer failed" })
  })

  test("validates the configurable progress delay", () => {
    const { loader } = harness()
    expect(
      () => new DocumentVisitController(loader, new ManualClock(), { progressDelayMs: -1 }),
    ).toThrow(RequestError)
    expect(
      () => new DocumentVisitController(loader, new ManualClock(), { progressDelayMs: Infinity }),
    ).toThrow(RequestError)
  })
})
