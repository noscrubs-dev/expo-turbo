import { describe, expect, test } from "bun:test"

import type {
  ClockAdapter,
  FetchAdapter,
  NavigationAdapter,
  TurboRequest,
  TurboResponse,
  VisitAction,
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
  DocumentSnapshotPreviewCommitError,
  DocumentSnapshotRestoreCommitError,
} from "./document-loader"
import { DocumentPrefetchCache } from "./document-prefetch-cache"
import { consumeDocumentRefreshScroll } from "./document-refresh-scroll-internal"
import {
  acknowledgeDocumentRender,
  documentRenderLifecycleRevision,
  retainDocumentRenderer,
  subscribeDocumentRenderLifecycle,
} from "./document-render-lifecycle-internal"
import { DocumentSnapshotCache } from "./document-snapshot-cache"
import {
  DOCUMENT_VISIT_PROGRESS_DELAY_MS,
  DocumentVisitController,
  type DocumentVisitResult,
} from "./document-visit-controller"
import { DocumentVisitLifecycle } from "./document-visit-lifecycle"
import {
  ContentTypeError,
  ParseError,
  PropsError,
  RequestError,
  StateError,
  TargetError,
} from "./errors"
import { EXPO_TURBO_MIME_TYPE } from "./frame-loader"
import { parseExpoTurboDocument } from "./parser"
import { RequestLifecycle } from "./request-lifecycle"
import { DocumentSession } from "./session"
import { attributeValue, type DocumentTree, isElement } from "./tree"

interface PendingRequest {
  readonly request: TurboRequest
  readonly resolve: (response: TurboResponse) => void
}

function waitForDocumentRenderSeal(session: DocumentSession, revision: number): Promise<void> {
  if (documentRenderLifecycleRevision(session) > revision) return Promise.resolve()
  return new Promise((resolve) => {
    const unsubscribe = subscribeDocumentRenderLifecycle(session, () => {
      if (documentRenderLifecycleRevision(session) <= revision) return
      unsubscribe()
      resolve()
    })
  })
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

class ThrowingProgressSetupClock extends ManualClock {
  override setTimeout(): unknown {
    throw new Error("sensitive setup failure")
  }
}

class ThrowingProgressCleanupClock extends ManualClock {
  override clearTimeout(handle: unknown): void {
    super.clearTimeout(handle)
    throw new Error("sensitive cleanup failure")
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
  restorationIdCount: () => number
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
  return Object.freeze({ history, restorationIdCount: () => identifier, writes })
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
    onRequestId?: () => void
    onObserverError?: (error: AggregateError) => void
    prefetchCache?: DocumentPrefetchCache
    progressDelayMs?: number
    requestLifecycle?: RequestLifecycle
    snapshotCache?: DocumentSnapshotCache
    history?: DocumentHistory
    visitLifecycle?: DocumentVisitLifecycle
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
    {
      next: () => {
        const nextRequestId = ++requestId
        options.onRequestId?.()
        return `request-${nextRequestId}`
      },
    },
    options.requestLifecycle ? { requestLifecycle: options.requestLifecycle } : {},
  )
  const clock = options.clock ?? new ManualClock()
  const controller = new DocumentVisitController(loader, clock, {
    ...(options.history ? { history: options.history } : {}),
    ...(options.onObserverError ? { onObserverError: options.onObserverError } : {}),
    ...(options.prefetchCache ? { prefetchCache: options.prefetchCache } : {}),
    ...(options.progressDelayMs !== undefined ? { progressDelayMs: options.progressDelayMs } : {}),
    ...(options.snapshotCache ? { snapshotCache: options.snapshotCache } : {}),
    ...(options.visitLifecycle ? { visitLifecycle: options.visitLifecycle } : {}),
  })
  return { clock, controller, loader, pending, requestIdCount: () => requestId, session }
}

describe("Document visit controller", () => {
  test("waits for and commits one prefetched response without a second request", async () => {
    let resolvePrefetch: ((tree: DocumentTree) => void) | undefined
    const prefetchCache = new DocumentPrefetchCache()
    prefetchCache.putPending(
      "https://example.test/next",
      new Promise((resolve) => {
        resolvePrefetch = resolve
      }),
    )
    const current = harness({ prefetchCache })

    const visiting = current.controller.visit("/next")
    expect(current.pending).toHaveLength(0)
    resolvePrefetch?.(
      parseExpoTurboDocument('<Gallery><Next id="next" /></Gallery>', {
        url: "https://example.test/next",
      }),
    )

    expect(await visiting).toEqual({
      source: "prefetch",
      status: "committed",
      url: "https://example.test/next",
    })
    expect(current.pending).toHaveLength(0)
    expect(current.requestIdCount()).toBe(0)
    expect(current.session.tree.getElementById("next")).toBeDefined()

    const second = current.controller.visit("/next")
    expect(current.pending).toHaveLength(1)
    current.pending[0]?.resolve(
      response('<Gallery><Canonical id="canonical" /></Gallery>', {
        url: "https://example.test/next",
      }),
    )
    await second
  })

  test("lets before-visit prevent work before history, cache, request, or state ownership", async () => {
    const lifecycle = new DocumentVisitLifecycle()
    const snapshotCache = new ReentrantSnapshotCache()
    snapshotCache.put(
      "https://example.test/next",
      parseExpoTurboDocument('<Gallery><Preview id="preview" /></Gallery>', {
        url: "https://example.test/next",
      }),
    )
    let cacheReads = 0
    snapshotCache.onGet = () => {
      cacheReads += 1
    }
    const history = historyFixture()
    lifecycle.subscribe("before-visit", (event) => {
      expect(event.detail).toEqual({ url: "https://example.test/next" })
      event.preventDefault()
    })
    const { clock, controller, pending, requestIdCount } = harness({
      history: history.history,
      snapshotCache,
      visitLifecycle: lifecycle,
    })
    const initial = controller.state

    expect(await controller.visit("/next")).toEqual({
      source: "visit-lifecycle",
      status: "canceled",
      url: "https://example.test/next",
    })
    expect(controller.state).toBe(initial)
    expect(history.restorationIdCount()).toBe(0)
    expect(history.writes).toEqual([])
    expect({ cacheReads, requests: requestIdCount() }).toEqual({ cacheReads: 0, requests: 0 })
    expect(pending).toHaveLength(0)
    expect(clock.timers).toHaveLength(0)
  })

  test("keeps a reentrant newer proposal authoritative across before-visit", async () => {
    const lifecycle = new DocumentVisitLifecycle()
    let controller: DocumentVisitController
    let newer: Promise<unknown> | undefined
    lifecycle.subscribe("before-visit", (event) => {
      if (!event.detail.url.endsWith("/older")) return
      newer = controller.visit("/newer")
    })
    const current = harness({ visitLifecycle: lifecycle })
    controller = current.controller

    const older = controller.visit("/older")

    expect(await older).toEqual({
      source: "visit-lifecycle",
      status: "canceled",
      url: "https://example.test/older",
    })
    expect(current.pending).toHaveLength(1)
    expect(current.pending[0]?.request.url).toBe("https://example.test/newer")
    current.pending[0]?.resolve(
      response('<Gallery><Newer id="newer" /></Gallery>', {
        url: "https://example.test/newer",
      }),
    )
    if (!newer) throw new Error("newer lifecycle visit did not start")
    expect(await newer).toMatchObject({ status: "committed" })
    expect(current.session.tree.getElementById("newer")).toBeDefined()
  })

  test("gates delegated proposals without publishing a visit start", async () => {
    const lifecycle = new DocumentVisitLifecycle()
    const events: string[] = []
    lifecycle.subscribe("before-visit", (event) => {
      events.push(`before:${event.detail.url}`)
    })
    lifecycle.subscribe("visit", () => {
      events.push("visit")
    })
    const delegated: string[] = []
    const navigation: NavigationAdapter = {
      back() {},
      openExternal(url) {
        delegated.push(url)
      },
      visit(url, action) {
        delegated.push(`${action}:${url}`)
      },
    }
    const current = harness({ visitLifecycle: lifecycle })

    expect(await current.controller.visit("https://other.test/path", { navigation })).toMatchObject(
      {
        kind: "external",
        status: "delegated",
      },
    )
    expect(events).toEqual(["before:https://other.test/path"])
    expect(delegated).toEqual(["https://other.test/path"])
    expect(current.requestIdCount()).toBe(0)
  })

  test("orders visit notification after request listeners and before physical fetch", async () => {
    const order: string[] = []
    const visitLifecycle = new DocumentVisitLifecycle()
    const requestLifecycle = new RequestLifecycle()
    visitLifecycle.subscribe("before-visit", () => {
      order.push("before-visit")
    })
    visitLifecycle.subscribe("visit", (event) => {
      order.push(`visit:${event.detail.action}:${event.detail.url}`)
    })
    requestLifecycle.subscribe("before-fetch-request", (event) => {
      order.push("before-fetch-request")
      event.detail.request.setUrl("https://example.test/admitted")
    })
    const { controller } = harness({
      fetch: async (request) => {
        order.push("fetch")
        expect(request.url).toBe("https://example.test/admitted")
        return response('<Gallery><Next id="next" /></Gallery>', { url: request.url })
      },
      requestLifecycle,
      visitLifecycle,
    })

    expect(await controller.visit("/next")).toMatchObject({ status: "committed" })
    expect(order).toEqual([
      "before-visit",
      "before-fetch-request",
      "visit:advance:https://example.test/next",
      "fetch",
    ])
  })

  test("settles committed document visits and load only after the exact native render", async () => {
    for (const candidate of [
      { classification: "success", status: 200, terminal: "completed" },
      { classification: "client-error", status: 422, terminal: "failed" },
      { classification: "server-error", status: 500, terminal: "failed" },
    ] as const) {
      const lifecycle = new DocumentVisitLifecycle()
      const current = harness({ visitLifecycle: lifecycle })
      const releaseRenderer = retainDocumentRenderer(current.session)
      const events: string[] = []
      lifecycle.subscribe("render", (event) => {
        expect(current.controller.state).toMatchObject({ busy: true, status: "started" })
        expect(event.detail).toMatchObject({ preview: false, renderMethod: "replace" })
        events.push(`render:${event.detail.generation}`)
      })
      lifecycle.subscribe("load", (event) => {
        expect(current.controller.state).toMatchObject({
          busy: false,
          status: candidate.terminal,
        })
        events.push(`load:${event.detail.generation}`)
      })
      const committed = new Promise<void>((resolve) => {
        const unsubscribe = current.session.subscribeTreeState(() => {
          if (current.session.treeGeneration !== 1) return
          unsubscribe()
          resolve()
        })
      })
      let settled = false
      const visit = current.controller.visit(`/render-${candidate.status}`)
      const renderRevision = documentRenderLifecycleRevision(current.session)
      void visit.then(() => {
        settled = true
      })
      current.pending[0]?.resolve(
        response(`<Gallery><Rendered id="render-${candidate.status}" /></Gallery>`, {
          status: candidate.status,
          url: `https://example.test/render-${candidate.status}`,
        }),
      )

      await committed
      await waitForDocumentRenderSeal(current.session, renderRevision)
      expect(current.session.tree.getElementById(`render-${candidate.status}`)).toBeDefined()
      expect(current.controller.state).toMatchObject({ busy: true, status: "started" })
      expect({ events, settled }).toEqual({ events: [], settled: false })

      const generation = current.session.treeGeneration
      const acknowledgement = acknowledgeDocumentRender(
        current.session,
        current.session.tree.document,
        generation,
        current.session.revision,
      )
      expect(events).toEqual([`render:${generation}`])
      expect(settled).toBe(false)
      acknowledgement?.finish()

      expect(await visit).toMatchObject({
        classification: candidate.classification,
        status: "committed",
      })
      expect(events).toEqual([`render:${generation}`, `load:${generation}`])
      expect(current.controller.state).toMatchObject({
        busy: false,
        status: candidate.terminal,
      })
      releaseRenderer()
    }
  })

  test("releases only the post-commit visual wait when cancellation follows tree installation", async () => {
    for (const candidate of [
      { classification: "success", status: 200, terminal: "completed" },
      { classification: "client-error", status: 422, terminal: "failed" },
    ] as const) {
      const lifecycle = new DocumentVisitLifecycle()
      const current = harness({ visitLifecycle: lifecycle })
      const releaseRenderer = retainDocumentRenderer(current.session)
      const events: string[] = []
      lifecycle.subscribe("render", () => {
        events.push("render")
      })
      lifecycle.subscribe("load", () => {
        events.push("load")
      })
      let canceled = false
      current.session.subscribeTreeState(() => {
        if (canceled || current.session.treeGeneration !== 1) return
        canceled = true
        current.controller.cancel()
      })

      const visit = current.controller.visit(`/cancel-after-commit-${candidate.status}`)
      current.pending[0]?.resolve(
        response(`<Gallery><Rendered id="cancel-${candidate.status}" /></Gallery>`, {
          status: candidate.status,
          url: `https://example.test/cancel-after-commit-${candidate.status}`,
        }),
      )

      expect(await visit).toMatchObject({
        classification: candidate.classification,
        status: "committed",
      })
      expect(current.session.tree.getElementById(`cancel-${candidate.status}`)).toBeDefined()
      expect(current.controller.state).toMatchObject({ busy: false, status: candidate.terminal })
      expect(events).toEqual([])
      expect(
        acknowledgeDocumentRender(
          current.session,
          current.session.tree.document,
          current.session.treeGeneration,
          current.session.revision,
        ),
      ).toBeUndefined()
      releaseRenderer()
    }
  })

  test("notifies visit when request admission cancels before physical fetch", async () => {
    const events: string[] = []
    const visitLifecycle = new DocumentVisitLifecycle()
    const requestLifecycle = new RequestLifecycle()
    visitLifecycle.subscribe("before-visit", () => {
      events.push("before-visit")
    })
    visitLifecycle.subscribe("visit", () => {
      events.push("visit")
    })
    requestLifecycle.subscribe("before-fetch-request", (event) => {
      events.push("before-fetch-request")
      event.preventDefault()
    })
    const current = harness({ requestLifecycle, visitLifecycle })

    expect(await current.controller.visit("/canceled")).toMatchObject({ status: "canceled" })
    expect(events).toEqual(["before-visit", "before-fetch-request", "visit"])
    expect(current.pending).toHaveLength(0)
    expect(current.controller.state.status).toBe("canceled")
  })

  test("emits one visit across cached preview and canonical revalidation", async () => {
    const lifecycle = new DocumentVisitLifecycle()
    const events: string[] = []
    lifecycle.subscribe("before-visit", (event) => {
      events.push(`before:${event.detail.url}`)
    })
    lifecycle.subscribe("visit", (event) => {
      events.push(`visit:${event.detail.action}`)
    })
    lifecycle.subscribe("before-cache", () => {
      events.push("before-cache")
    })
    const snapshotCache = new DocumentSnapshotCache()
    snapshotCache.put(
      "https://example.test/next",
      parseExpoTurboDocument('<Gallery><Preview id="preview" /></Gallery>', {
        url: "https://example.test/next",
      }),
    )
    const { controller, pending } = harness({ snapshotCache, visitLifecycle: lifecycle })

    const visiting = controller.visit("/next")

    expect(events).toEqual(["before:https://example.test/next", "visit:advance", "before-cache"])
    expect(pending).toHaveLength(1)
    pending[0]?.resolve(
      response('<Gallery><Canonical id="canonical" /></Gallery>', {
        url: "https://example.test/next",
      }),
    )
    expect(await visiting).toMatchObject({ status: "committed" })
    expect(events).toEqual(["before:https://example.test/next", "visit:advance", "before-cache"])
  })

  test("emits a final replace visit after a successful redirected document commits", async () => {
    const lifecycle = new DocumentVisitLifecycle()
    const events: string[] = []
    const history = historyFixture()
    let current: ReturnType<typeof harness>
    lifecycle.subscribe("before-visit", (event) => {
      events.push(`before:${event.detail.url}`)
    })
    lifecycle.subscribe("visit", (event) => {
      events.push(`visit:${event.detail.action}:${event.detail.url}`)
      if (event.detail.url === "https://example.test/final") {
        expect(current.session.tree.getElementById("final")).toBeDefined()
        expect(history.history.current?.url).toBe("https://example.test/final")
        expect(current.controller.state.status).toBe("started")
      }
    })
    current = harness({ history: history.history, visitLifecycle: lifecycle })

    const visiting = current.controller.visit("/requested")

    expect(events).toEqual([
      "before:https://example.test/requested",
      "visit:advance:https://example.test/requested",
    ])
    current.pending[0]?.resolve(
      response('<Gallery><Final id="final" /></Gallery>', {
        redirected: true,
        url: "https://example.test/final",
      }),
    )

    expect(await visiting).toMatchObject({ redirected: true, status: "committed" })
    expect(events).toEqual([
      "before:https://example.test/requested",
      "visit:advance:https://example.test/requested",
      "visit:replace:https://example.test/final",
    ])
    expect(current.controller.state.status).toBe("completed")
  })

  test("emits one original visit and one final replace across a redirected preview revalidation", async () => {
    const lifecycle = new DocumentVisitLifecycle()
    const events: string[] = []
    lifecycle.subscribe("before-visit", (event) => {
      events.push(`before:${event.detail.url}`)
    })
    lifecycle.subscribe("visit", (event) => {
      events.push(`visit:${event.detail.action}:${event.detail.url}`)
    })
    const snapshotCache = new DocumentSnapshotCache()
    snapshotCache.put(
      "https://example.test/requested",
      parseExpoTurboDocument('<Gallery><Preview id="preview" /></Gallery>', {
        url: "https://example.test/requested",
      }),
    )
    const current = harness({ snapshotCache, visitLifecycle: lifecycle })

    const visiting = current.controller.visit("/requested")

    expect(events).toEqual([
      "before:https://example.test/requested",
      "visit:advance:https://example.test/requested",
    ])
    current.pending[0]?.resolve(
      response('<Gallery><Final id="final" /></Gallery>', {
        redirected: true,
        url: "https://example.test/final",
      }),
    )

    expect(await visiting).toMatchObject({ redirected: true, status: "committed" })
    expect(events).toEqual([
      "before:https://example.test/requested",
      "visit:advance:https://example.test/requested",
      "visit:replace:https://example.test/final",
    ])
    expect(current.session.tree.getElementById("final")).toBeDefined()
    expect(current.session.treeState.preview).toBe(false)
  })

  test("emits redirected refresh follow-up but excludes errors and discarded redirects", async () => {
    {
      const lifecycle = new DocumentVisitLifecycle()
      const events: string[] = []
      lifecycle.subscribe("before-visit", (event) => {
        events.push(`before:${event.detail.url}`)
      })
      lifecycle.subscribe("visit", (event) => {
        events.push(`visit:${event.detail.action}:${event.detail.url}`)
      })
      const current = harness({
        history: historyFixture().history,
        visitLifecycle: lifecycle,
      })

      const refreshing = current.controller.refreshCurrent("https://example.test/current")
      current.pending[0]?.resolve(
        response('<Gallery><Fresh id="fresh" /></Gallery>', {
          redirected: true,
          url: "https://example.test/final",
        }),
      )

      expect(await refreshing).toMatchObject({ redirected: true, status: "committed" })
      expect(events).toEqual([
        "before:https://example.test/current",
        "visit:replace:https://example.test/current",
        "visit:replace:https://example.test/final",
      ])
    }

    {
      const lifecycle = new DocumentVisitLifecycle()
      const visits: string[] = []
      lifecycle.subscribe("visit", (event) => {
        visits.push(event.detail.url)
      })
      const current = harness({ visitLifecycle: lifecycle })
      const visiting = current.controller.visit("/error")
      current.pending[0]?.resolve(
        response('<Gallery><Invalid id="invalid" /></Gallery>', {
          redirected: true,
          status: 422,
          url: "https://example.test/error-final",
        }),
      )

      expect(await visiting).toMatchObject({
        classification: "client-error",
        status: "committed",
      })
      expect(visits).toEqual(["https://example.test/error"])
    }

    {
      const lifecycle = new DocumentVisitLifecycle()
      const visits: string[] = []
      lifecycle.subscribe("visit", (event) => {
        visits.push(event.detail.url)
      })
      const delegated: string[] = []
      const navigation: NavigationAdapter = {
        back() {},
        openExternal() {},
        visit(url, action) {
          delegated.push(`${action}:${url}`)
        },
      }
      const current = harness({ visitLifecycle: lifecycle })
      const visiting = current.controller.visit("/requested", { navigation })
      current.pending[0]?.resolve(
        response('<Gallery data-turbo-root="/inside"><Discarded /></Gallery>', {
          redirected: true,
          url: "https://example.test/outside",
        }),
      )

      expect(await visiting).toMatchObject({ kind: "navigation", status: "delegated" })
      expect(visits).toEqual(["https://example.test/requested"])
      expect(delegated).toEqual(["replace:https://example.test/outside"])
    }
  })

  test("keeps a reentrant newer visit authoritative after redirect follow-up notification", async () => {
    const lifecycle = new DocumentVisitLifecycle()
    let current: ReturnType<typeof harness>
    let newer: Promise<DocumentVisitResult> | undefined
    lifecycle.subscribe("visit", (event) => {
      if (event.detail.url === "https://example.test/final") {
        newer = current.controller.visit("/newer")
      }
    })
    current = harness({
      history: historyFixture().history,
      visitLifecycle: lifecycle,
    })

    const older = current.controller.visit("/older")
    current.pending[0]?.resolve(
      response('<Gallery><Final id="final" /></Gallery>', {
        redirected: true,
        url: "https://example.test/final",
      }),
    )

    expect(await older).toMatchObject({ redirected: true, status: "committed" })
    expect(current.controller.state.status).toBe("started")
    expect(current.pending).toHaveLength(2)
    expect(current.pending[1]?.request.url).toBe("https://example.test/newer")
    current.pending[1]?.resolve(
      response('<Gallery><Newer id="newer" /></Gallery>', {
        url: "https://example.test/newer",
      }),
    )
    if (!newer) throw new Error("redirect observer did not start a newer visit")
    expect(await newer).toMatchObject({ status: "committed" })
    expect(current.controller.state.status).toBe("completed")
    expect(current.session.tree.getElementById("newer")).toBeDefined()
  })

  test("emits redirect follow-up from a committed error without settling newer reentrant work", async () => {
    const lifecycle = new DocumentVisitLifecycle()
    const history = historyFixture()
    const events: string[] = []
    let current: ReturnType<typeof harness>
    let newer: Promise<DocumentVisitResult> | undefined
    lifecycle.subscribe("before-visit", (event) => {
      events.push(`before:${event.detail.url}`)
    })
    lifecycle.subscribe("visit", (event) => {
      events.push(`visit:${event.detail.action}:${event.detail.url}`)
      if (event.detail.url !== "https://example.test/final-error") return
      expect(current.session.tree.getElementById("final-error")).toBeDefined()
      expect(history.history.current?.url).toBe("https://example.test/final-error")
      expect(current.controller.state.status).toBe("started")
      newer = current.controller.visit("/newer-after-error")
    })
    current = harness({
      history: history.history,
      visitLifecycle: lifecycle,
    })
    current.session.registerDisposal("id:old", () => {
      throw new Error("fixture finalization failure")
    })

    const older = current.controller.visit("/older-error")
    current.pending[0]?.resolve(
      response('<Gallery><FinalError id="final-error" /></Gallery>', {
        redirected: true,
        url: "https://example.test/final-error",
      }),
    )

    await expect(older).rejects.toBeInstanceOf(DocumentCommitError)
    expect(events).toEqual([
      "before:https://example.test/older-error",
      "visit:advance:https://example.test/older-error",
      "visit:replace:https://example.test/final-error",
      "before:https://example.test/newer-after-error",
      "visit:advance:https://example.test/newer-after-error",
    ])
    expect(current.controller.state.status).toBe("started")
    expect(current.pending).toHaveLength(2)
    current.pending[1]?.resolve(
      response('<Gallery><Newer id="newer-after-error-result" /></Gallery>', {
        url: "https://example.test/newer-after-error",
      }),
    )
    if (!newer) throw new Error("committed-error observer did not start a newer visit")
    expect(await newer).toMatchObject({ status: "committed" })
    expect(current.controller.state.status).toBe("completed")
    expect(current.session.tree.getElementById("newer-after-error-result")).toBeDefined()
  })

  test("reports traversal as restore without a cancellable before-visit", async () => {
    const lifecycle = new DocumentVisitLifecycle()
    const events: string[] = []
    lifecycle.subscribe("before-visit", () => {
      events.push("before")
    })
    lifecycle.subscribe("visit", (event) => {
      events.push(`visit:${event.detail.action}`)
    })
    lifecycle.subscribe("before-cache", () => {
      events.push("before-cache")
    })
    const history = historyFixture(() => undefined, "https://example.test/current", 2)
    const { controller, pending } = harness({
      history: history.history,
      snapshotCache: new DocumentSnapshotCache(),
      visitLifecycle: lifecycle,
    })

    const restoring = controller.restoreTraversal({
      restorationIdentifier: "history-forward",
      restorationIndex: 3,
      url: "https://example.test/forward",
    })

    expect(events).toEqual(["visit:restore"])
    expect(pending).toHaveLength(1)
    pending[0]?.resolve(
      response('<Gallery><Forward id="forward" /></Gallery>', {
        url: "https://example.test/forward",
      }),
    )
    expect(await restoring).toMatchObject({ source: "network" })
    expect(events).toEqual(["visit:restore", "before-cache"])
  })

  test("emits restore for cached explicit visits and cached host traversal", async () => {
    const explicitLifecycle = new DocumentVisitLifecycle()
    const explicitEvents: string[] = []
    explicitLifecycle.subscribe("before-visit", () => {
      explicitEvents.push("before")
    })
    explicitLifecycle.subscribe("visit", (event) => {
      explicitEvents.push(`visit:${event.detail.action}`)
    })
    explicitLifecycle.subscribe("before-cache", () => {
      explicitEvents.push("before-cache")
    })
    const explicitCache = new DocumentSnapshotCache()
    explicitCache.put(
      "https://example.test/older",
      parseExpoTurboDocument('<Gallery><Older id="older" /></Gallery>', {
        url: "https://example.test/older",
      }),
    )
    const explicit = harness({
      history: historyFixture().history,
      snapshotCache: explicitCache,
      visitLifecycle: explicitLifecycle,
    })

    expect(await explicit.controller.visit("/older", { action: "restore" })).toMatchObject({
      source: "snapshot",
      status: "restored",
    })
    expect(explicitEvents).toEqual(["before", "visit:restore", "before-cache"])
    expect(explicit.pending).toHaveLength(0)

    const traversalLifecycle = new DocumentVisitLifecycle()
    const traversalEvents: string[] = []
    traversalLifecycle.subscribe("before-visit", () => {
      traversalEvents.push("before")
    })
    traversalLifecycle.subscribe("visit", (event) => {
      traversalEvents.push(`visit:${event.detail.action}`)
    })
    traversalLifecycle.subscribe("before-cache", () => {
      traversalEvents.push("before-cache")
    })
    const traversalCache = new DocumentSnapshotCache()
    traversalCache.put(
      "https://example.test/back",
      parseExpoTurboDocument('<Gallery><Back id="back" /></Gallery>', {
        url: "https://example.test/back",
      }),
    )
    const traversal = harness({
      history: historyFixture(() => undefined, "https://example.test/current", 2).history,
      snapshotCache: traversalCache,
      visitLifecycle: traversalLifecycle,
    })

    expect(
      await traversal.controller.restoreTraversal({
        restorationIdentifier: "history-back",
        restorationIndex: 1,
        url: "https://example.test/back",
      }),
    ).toMatchObject({ source: "snapshot", status: "restored" })
    expect(traversalEvents).toEqual(["visit:restore", "before-cache"])
    expect(traversal.pending).toHaveLength(0)
  })

  test("emits replace lifecycle for an accepted current-document refresh", async () => {
    const lifecycle = new DocumentVisitLifecycle()
    const events: string[] = []
    lifecycle.subscribe("before-visit", () => {
      events.push("before")
    })
    lifecycle.subscribe("visit", (event) => {
      events.push(`visit:${event.detail.action}`)
    })
    lifecycle.subscribe("before-cache", () => {
      events.push("before-cache")
    })
    const current = harness({
      history: historyFixture().history,
      visitLifecycle: lifecycle,
    })

    const refreshing = current.controller.refreshCurrent("https://example.test/current")

    expect(events).toEqual(["before", "visit:replace"])
    expect(current.pending).toHaveLength(1)
    current.pending[0]?.resolve(
      response('<Gallery><Fresh id="fresh" /></Gallery>', {
        url: "https://example.test/current",
      }),
    )
    expect(await refreshing).toMatchObject({ status: "committed" })
    expect(events).toEqual(["before", "visit:replace"])
  })

  test("lets a visit observer cancel exact ownership before fetch", async () => {
    const lifecycle = new DocumentVisitLifecycle()
    let controller: DocumentVisitController
    lifecycle.subscribe("visit", () => {
      controller.cancel()
    })
    const current = harness({ visitLifecycle: lifecycle })
    controller = current.controller

    expect(await controller.visit("/canceled")).toMatchObject({ status: "canceled" })
    expect(current.pending).toHaveLength(0)
    expect(current.requestIdCount()).toBe(1)
    expect(controller.state.status).toBe("canceled")
  })

  test("publishes canceled visit state when response handling is prevented", async () => {
    const lifecycle = new RequestLifecycle()
    lifecycle.subscribe("before-fetch-response", (event) => event.preventDefault())
    const { controller, session } = harness({
      fetch: async (request) =>
        response('<Gallery><Ignored id="ignored" /></Gallery>', { url: request.url }),
      requestLifecycle: lifecycle,
    })
    const previousTree = session.tree

    expect(await controller.visit("/prevented")).toMatchObject({ status: "prevented" })
    expect(controller.state).toMatchObject({
      busy: false,
      progressVisible: false,
      status: "canceled",
    })
    expect(session.tree).toBe(previousTree)
  })

  test("keeps a prevented fetch error rejected while suppressing default error delegation", async () => {
    const lifecycle = new RequestLifecycle()
    const visitLifecycle = new DocumentVisitLifecycle()
    const reloads: unknown[] = []
    lifecycle.subscribe("fetch-request-error", (event) => event.preventDefault())
    visitLifecycle.subscribe("reload", (event) => {
      reloads.push(event.detail)
    })
    const { controller } = harness({
      fetch: async () => {
        throw new Error("secret transport failure")
      },
      requestLifecycle: lifecycle,
      visitLifecycle,
    })
    const errors: Error[] = []
    controller.subscribeErrors((error) => errors.push(error))

    await expect(controller.visit("/failed")).rejects.toThrow("Document request failed")
    expect(controller.state).toMatchObject({ busy: false, status: "failed" })
    expect(errors).toEqual([])
    expect(reloads).toEqual([])
  })

  test("notifies visit before a paused before-fetch-request resumes", async () => {
    const requestLifecycle = new RequestLifecycle()
    const visitLifecycle = new DocumentVisitLifecycle()
    let resume: () => void = () => {
      throw new Error("before-fetch-request did not pause")
    }
    const { clock, controller, pending } = harness({ requestLifecycle, visitLifecycle })
    const order: string[] = []
    controller.subscribe(() => order.push(`state:${controller.state.status}`))
    visitLifecycle.subscribe("visit", () => {
      order.push("visit")
    })
    requestLifecycle.subscribe("before-fetch-request", (event) => {
      order.push(`before-fetch-request:${controller.state.status}`)
      event.pause()
      resume = () => event.resume()
    })

    const visit = controller.visit("/paused")

    expect(order).toEqual(["state:started", "before-fetch-request:started", "visit"])
    controller.cancel()
    expect(order).toEqual([
      "state:started",
      "before-fetch-request:started",
      "visit",
      "state:canceled",
    ])
    expect(controller.state).toEqual({
      busy: false,
      previewVisible: false,
      progressVisible: false,
      revision: 2,
      status: "canceled",
    })
    expect(clock.timers).toHaveLength(1)
    expect(clock.timers[0]?.cleared).toBe(true)
    expect(pending).toHaveLength(0)
    expect(await visit).toMatchObject({ status: "canceled" })
    expect(pending).toHaveLength(0)
    resume()
  })

  test("publishes initialized, started, delayed-progress, and completed snapshots", async () => {
    const { clock, controller, pending, session } = harness()
    const revisions: number[] = []
    controller.subscribe(() => revisions.push(controller.state.revision))

    expect(controller.state).toEqual({
      busy: false,
      previewVisible: false,
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
      previewVisible: false,
      progressVisible: false,
      revision: 1,
      status: "started",
    })
    expect(clock.timers[0]?.delayMs).toBe(DOCUMENT_VISIT_PROGRESS_DELAY_MS)

    clock.fire(0)
    expect(controller.state).toEqual({
      busy: true,
      previewVisible: false,
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
      previewVisible: false,
      progressVisible: false,
      revision: 3,
      status: "completed",
    })
    expect(revisions).toEqual([1, 2, 3])
    expect(session.tree.getElementById("next")?.tagName).toBe("Next")
  })

  test("renders one cached preview before always issuing the canonical GET", async () => {
    const order: string[] = []
    const snapshotCache = new DocumentSnapshotCache()
    snapshotCache.put(
      "https://example.test/next",
      parseExpoTurboDocument('<Gallery><Preview id="preview" /></Gallery>', {
        url: "https://example.test/next",
      }),
    )
    let history: DocumentHistory
    let session: DocumentSession
    const fixture = historyFixture((_method, entry) => {
      expect(entry.url).toBe("https://example.test/next")
      expect(session.tree.getElementById("old")).toBeDefined()
      expect(session.tree.getElementById("preview")).toBeUndefined()
      order.push("history")
    })
    history = fixture.history
    const current = harness({
      documentXml: '<Gallery><Old id="old" data-state="initial" /></Gallery>',
      history,
      snapshotCache,
    })
    session = current.session
    const states: string[] = []
    current.controller.subscribe(() => {
      states.push(
        `${current.controller.state.status}:${current.controller.state.previewVisible ? "preview" : "canonical"}`,
      )
    })
    session.setAttribute("id:old", "data-state", "latest")
    const unsubscribe = session.subscribe("id:old", () => {
      unsubscribe()
      expect(history.current?.url).toBe("https://example.test/next")
      expect(session.tree.getElementById("preview")).toBeDefined()
      expect(session.treeState.preview).toBe(true)
      order.push("tree")
    })

    const visit = current.controller.visit("/next")

    expect(order).toEqual(["history", "tree"])
    expect(current.pending).toHaveLength(1)
    expect(current.pending[0]?.request.url).toBe("https://example.test/next")
    expect(current.requestIdCount()).toBe(1)
    expect(current.clock.timers).toHaveLength(1)
    expect(current.controller.state).toMatchObject({
      busy: true,
      previewVisible: true,
      status: "started",
    })
    expect(session.tree.getElementById("preview")).toBeDefined()
    const outgoing = snapshotCache.get("https://example.test/current")
    const old = outgoing?.getElementById("old")
    expect(old ? attributeValue(old, "data-state") : undefined).toBe("latest")

    current.pending[0]?.resolve(
      response('<Gallery><Canonical id="canonical" /></Gallery>', {
        url: "https://example.test/next",
      }),
    )

    expect(await visit).toMatchObject({ classification: "success", status: "committed" })
    expect(session.tree.getElementById("canonical")).toBeDefined()
    expect(session.tree.getElementById("preview")).toBeUndefined()
    expect(current.controller.state).toMatchObject({
      busy: false,
      previewVisible: false,
      status: "completed",
    })
    expect(states).toEqual([
      "started:canonical",
      "started:preview",
      "started:canonical",
      "completed:canonical",
    ])
    expect(fixture.writes).toHaveLength(1)
  })

  test("shows a cached preview before starting canonical fetch and loads only the final render", async () => {
    const url = "https://example.test/next"
    const snapshotCache = new DocumentSnapshotCache()
    snapshotCache.put(
      url,
      parseExpoTurboDocument('<Gallery><Preview id="preview" /></Gallery>', { url }),
    )
    const lifecycle = new DocumentVisitLifecycle()
    let canonicalRequest: PendingRequest | undefined
    let notifyCanonicalRequest!: () => void
    const canonicalRequestStarted = new Promise<void>((resolve) => {
      notifyCanonicalRequest = resolve
    })
    const current = harness({
      fetch: (request) =>
        new Promise<TurboResponse>((resolve) => {
          canonicalRequest = { request, resolve }
          notifyCanonicalRequest()
        }),
      snapshotCache,
      visitLifecycle: lifecycle,
    })
    const releaseRenderer = retainDocumentRenderer(current.session)
    const events: string[] = []
    lifecycle.subscribe("render", (event) => {
      expect(current.controller.state.status).toBe("started")
      events.push(
        `render:${event.detail.preview ? "preview" : "canonical"}:${event.detail.generation}`,
      )
    })
    lifecycle.subscribe("load", (event) => {
      expect(current.controller.state.status).toBe("completed")
      events.push(`load:${event.detail.generation}`)
    })

    let renderRevision = documentRenderLifecycleRevision(current.session)
    const visit = current.controller.visit("/next")
    expect(current.session.tree.getElementById("preview")).toBeDefined()
    expect(current.session.treeState).toEqual({ generation: 1, preview: true })
    expect(canonicalRequest).toBeUndefined()
    await waitForDocumentRenderSeal(current.session, renderRevision)

    const previewAcknowledgement = acknowledgeDocumentRender(
      current.session,
      current.session.tree.document,
      current.session.treeGeneration,
      current.session.revision,
    )
    expect(events).toEqual(["render:preview:1"])
    previewAcknowledgement?.finish()
    await canonicalRequestStarted
    expect(canonicalRequest?.request.url).toBe(url)

    const canonicalCommitted = new Promise<void>((resolve) => {
      const unsubscribe = current.session.subscribeTreeState(() => {
        if (current.session.treeGeneration !== 2) return
        unsubscribe()
        resolve()
      })
    })
    let settled = false
    void visit.then(() => {
      settled = true
    })
    renderRevision = documentRenderLifecycleRevision(current.session)
    canonicalRequest?.resolve(response('<Gallery><Canonical id="canonical" /></Gallery>', { url }))
    await canonicalCommitted
    await waitForDocumentRenderSeal(current.session, renderRevision)
    expect(current.session.tree.getElementById("canonical")).toBeDefined()
    expect(current.controller.state).toMatchObject({ busy: true, status: "started" })
    expect({ events, settled }).toEqual({ events: ["render:preview:1"], settled: false })

    const canonicalAcknowledgement = acknowledgeDocumentRender(
      current.session,
      current.session.tree.document,
      current.session.treeGeneration,
      current.session.revision,
    )
    expect(events).toEqual(["render:preview:1", "render:canonical:2"])
    canonicalAcknowledgement?.finish()

    expect(await visit).toMatchObject({ classification: "success", status: "committed" })
    expect(events).toEqual(["render:preview:1", "render:canonical:2", "load:2"])
    expect(current.controller.state).toMatchObject({ busy: false, status: "completed" })
    releaseRenderer()
  })

  test("revalidates a preview when progress timer setup fails", async () => {
    const snapshotCache = new DocumentSnapshotCache()
    snapshotCache.put(
      "https://example.test/next",
      parseExpoTurboDocument('<Gallery><Preview id="preview" /></Gallery>', {
        url: "https://example.test/next",
      }),
    )
    const current = harness({
      clock: new ThrowingProgressSetupClock(),
      snapshotCache,
    })
    const errors: Error[] = []
    current.controller.subscribeErrors((error) => errors.push(error))

    const visit = current.controller.visit("/next")

    expect(current.pending).toHaveLength(1)
    expect(current.pending[0]?.request.url).toBe("https://example.test/next")
    expect(current.controller.state).toMatchObject({
      busy: true,
      previewVisible: true,
      status: "started",
    })
    expect(errors).toHaveLength(1)
    expect(errors[0]).toBeInstanceOf(StateError)
    expect(errors[0]?.message).not.toContain("sensitive")
    expect(errors[0]?.cause).toBeUndefined()

    current.pending[0]?.resolve(
      response('<Gallery><Canonical id="canonical" /></Gallery>', {
        url: "https://example.test/next",
      }),
    )
    expect(await visit).toMatchObject({ status: "committed" })
    expect(current.session.tree.getElementById("canonical")).toBeDefined()
    expect(current.controller.state).toMatchObject({
      busy: false,
      previewVisible: false,
      status: "completed",
    })
  })

  test("completes preview revalidation when progress timer cleanup fails", async () => {
    const snapshotCache = new DocumentSnapshotCache()
    snapshotCache.put(
      "https://example.test/next",
      parseExpoTurboDocument('<Gallery><Preview id="preview" /></Gallery>', {
        url: "https://example.test/next",
      }),
    )
    const current = harness({
      clock: new ThrowingProgressCleanupClock(),
      snapshotCache,
    })
    const errors: Error[] = []
    current.controller.subscribeErrors((error) => errors.push(error))
    const visit = current.controller.visit("/next")

    current.pending[0]?.resolve(
      response('<Gallery><Canonical id="canonical" /></Gallery>', {
        url: "https://example.test/next",
      }),
    )

    expect(await visit).toMatchObject({ status: "committed" })
    expect(errors).toHaveLength(1)
    expect(errors[0]).toBeInstanceOf(StateError)
    expect(errors[0]?.message).not.toContain("sensitive")
    expect(errors[0]?.cause).toBeUndefined()
    expect(current.session.tree.getElementById("canonical")).toBeDefined()
    expect(current.controller.state).toMatchObject({
      busy: false,
      previewVisible: false,
      status: "completed",
    })
  })

  test("publishes preview provenance even when a node listener reads state first", async () => {
    const snapshotCache = new DocumentSnapshotCache()
    snapshotCache.put(
      "https://example.test/next",
      parseExpoTurboDocument('<Gallery><Preview id="preview" /></Gallery>', {
        url: "https://example.test/next",
      }),
    )
    const current = harness({ snapshotCache })
    const observed: boolean[] = []
    current.controller.subscribe(() => observed.push(current.controller.state.previewVisible))
    const unsubscribe = current.session.subscribe("id:old", () => {
      unsubscribe()
      expect(current.controller.state.previewVisible).toBe(true)
    })

    const visit = current.controller.visit("/next")

    expect(observed).toEqual([false, true])
    current.pending[0]?.resolve(
      response('<Gallery><Canonical id="canonical" /></Gallery>', {
        url: "https://example.test/next",
      }),
    )
    await visit
    expect(observed).toEqual([false, true, false, false])
  })

  test("ignores cancellation inside the guarded preview history commit", async () => {
    const snapshotCache = new DocumentSnapshotCache()
    snapshotCache.put(
      "https://example.test/next",
      parseExpoTurboDocument('<Gallery><Preview id="preview" /></Gallery>', {
        url: "https://example.test/next",
      }),
    )
    let controller: DocumentVisitController
    let statusDuringCommit: string | undefined
    const fixture = historyFixture(() => {
      controller.cancel()
      statusDuringCommit = controller.state.status
    })
    const current = harness({ history: fixture.history, snapshotCache })
    controller = current.controller

    const visit = controller.visit("/next")

    expect(statusDuringCommit).toBe("started")
    expect(current.session.tree.getElementById("preview")).toBeDefined()
    expect(current.pending).toHaveLength(1)
    expect(current.pending[0]?.request.signal?.aborted).toBe(false)
    current.pending[0]?.resolve(
      response('<Gallery><Canonical id="canonical" /></Gallery>', {
        url: "https://example.test/next",
      }),
    )
    expect(await visit).toMatchObject({ status: "committed" })
    expect(controller.state.status).toBe("completed")
  })

  test("honors cancellation during preview finalization before canonical ownership", async () => {
    const snapshotCache = new DocumentSnapshotCache()
    snapshotCache.put(
      "https://example.test/next",
      parseExpoTurboDocument('<Gallery><Preview id="preview" /></Gallery>', {
        url: "https://example.test/next",
      }),
    )
    const current = harness({ snapshotCache })
    const unsubscribe = current.session.subscribe("id:old", () => {
      unsubscribe()
      current.controller.cancel()
    })

    expect(await current.controller.visit("/next")).toEqual({
      source: "preview",
      status: "canceled",
      url: "https://example.test/next",
    })
    expect(current.pending).toEqual([])
    expect(current.session.tree.getElementById("preview")).toBeDefined()
    expect(current.controller.state).toMatchObject({
      busy: false,
      previewVisible: true,
      status: "canceled",
    })
  })

  test("revalidates a committed preview after its synchronous finalization reports an error", async () => {
    const snapshotCache = new DocumentSnapshotCache()
    snapshotCache.put(
      "https://example.test/next",
      parseExpoTurboDocument('<Gallery><Preview id="preview" /></Gallery>', {
        url: "https://example.test/next",
      }),
    )
    const fixture = historyFixture()
    const current = harness({ history: fixture.history, snapshotCache })
    const errors: Error[] = []
    current.controller.subscribeErrors((error) => errors.push(error))
    current.session.registerDisposal("id:old", () => {
      throw new Error("preview finalization failed")
    })

    const visit = current.controller.visit("/next")

    expect(current.pending).toHaveLength(1)
    expect(current.session.tree.getElementById("preview")).toBeDefined()
    expect(current.controller.state).toMatchObject({
      busy: true,
      previewVisible: true,
      status: "started",
    })
    current.pending[0]?.resolve(
      response('<Gallery><Canonical id="canonical" /></Gallery>', {
        url: "https://example.test/next",
      }),
    )

    await expect(visit).rejects.toBeInstanceOf(DocumentSnapshotPreviewCommitError)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toBeInstanceOf(DocumentSnapshotPreviewCommitError)
    expect(current.session.tree.getElementById("canonical")).toBeDefined()
    expect(current.controller.state).toMatchObject({
      busy: false,
      previewVisible: false,
      status: "completed",
    })
    expect(fixture.writes).toHaveLength(1)
  })

  test("does not reclaim a newer peer request started by preview finalization", async () => {
    const snapshotCache = new DocumentSnapshotCache()
    snapshotCache.put(
      "https://example.test/outer",
      parseExpoTurboDocument('<Gallery><Preview id="preview" /></Gallery>', {
        url: "https://example.test/outer",
      }),
    )
    const current = harness({ snapshotCache })
    const peer = new DocumentVisitController(current.loader, new ManualClock())
    let peerVisit: Promise<unknown> | undefined
    const unsubscribe = current.session.subscribe("id:old", () => {
      unsubscribe()
      peerVisit = peer.visit("/peer")
    })

    expect(await current.controller.visit("/outer")).toEqual({
      source: "preview",
      status: "canceled",
      url: "https://example.test/outer",
    })
    if (!peerVisit) throw new Error("peer visit did not start")
    expect(current.pending).toHaveLength(1)
    expect(current.pending[0]?.request.url).toBe("https://example.test/peer")
    expect(current.pending[0]?.request.signal?.aborted).toBe(false)
    current.pending[0]?.resolve(
      response('<Gallery><Peer id="peer" /></Gallery>', {
        url: "https://example.test/peer",
      }),
    )
    expect(await peerVisit).toMatchObject({ status: "committed" })
    expect(current.session.tree.getElementById("peer")).toBeDefined()
  })

  test("does not reclaim a newer peer request started by canonical request-ID allocation", async () => {
    const snapshotCache = new DocumentSnapshotCache()
    snapshotCache.put(
      "https://example.test/outer",
      parseExpoTurboDocument('<Gallery><Preview id="preview" /></Gallery>', {
        url: "https://example.test/outer",
      }),
    )
    let peer: DocumentVisitController
    let peerVisit: Promise<unknown> | undefined
    let triggerPeer = true
    const current = harness({
      onRequestId: () => {
        if (!triggerPeer) return
        triggerPeer = false
        peerVisit = peer.visit("/peer")
      },
      snapshotCache,
    })
    peer = new DocumentVisitController(current.loader, new ManualClock())

    expect(await current.controller.visit("/outer")).toEqual({
      source: "preview",
      status: "canceled",
      url: "https://example.test/outer",
    })
    if (!peerVisit) throw new Error("peer visit did not start")
    expect(current.pending).toHaveLength(1)
    expect(current.pending[0]?.request.url).toBe("https://example.test/peer")
    expect(current.pending[0]?.request.signal?.aborted).toBe(false)
    current.pending[0]?.resolve(
      response('<Gallery><Peer id="peer" /></Gallery>', {
        url: "https://example.test/peer",
      }),
    )
    expect(await peerVisit).toMatchObject({ status: "committed" })
    expect(current.session.tree.getElementById("peer")).toBeDefined()
  })

  test("does not continue after finalization installs a newer same-URL preview", async () => {
    const snapshotCache = new DocumentSnapshotCache()
    snapshotCache.put(
      "https://example.test/next",
      parseExpoTurboDocument('<Gallery><OlderPreview id="older-preview" /></Gallery>', {
        url: "https://example.test/next",
      }),
    )
    const current = harness({ snapshotCache })
    const unsubscribe = current.session.subscribe("id:old", () => {
      unsubscribe()
      current.session.replaceTreePreview(
        parseExpoTurboDocument('<Gallery><NewerPreview id="newer-preview" /></Gallery>', {
          url: "https://example.test/next",
        }),
      )
    })

    expect(await current.controller.visit("/next")).toEqual({
      source: "preview",
      status: "canceled",
      url: "https://example.test/next",
    })
    expect(current.pending).toEqual([])
    expect(current.session.tree.getElementById("newer-preview")).toBeDefined()
  })

  test("selects a same-location preview before replacing its cache entry with outgoing truth", async () => {
    const snapshotCache = new DocumentSnapshotCache()
    snapshotCache.put(
      "https://example.test/current",
      parseExpoTurboDocument('<Gallery><Cached id="cached" data-state="stale" /></Gallery>', {
        url: "https://example.test/current",
      }),
    )
    const fixture = historyFixture()
    const current = harness({
      documentXml: '<Gallery><Old id="old" data-state="initial" /></Gallery>',
      history: fixture.history,
      snapshotCache,
    })
    current.session.setAttribute("id:old", "data-state", "latest")

    const visit = current.controller.visit("/current")

    expect(current.session.tree.getElementById("cached")).toBeDefined()
    expect(current.session.tree.getElementById("old")).toBeUndefined()
    expect(fixture.writes).toEqual([
      {
        entry: {
          restorationIdentifier: "history-1",
          restorationIndex: 0,
          url: "https://example.test/current",
        },
        method: "replace",
      },
    ])
    const outgoing = snapshotCache.get("https://example.test/current")
    const old = outgoing?.getElementById("old")
    expect(old ? attributeValue(old, "data-state") : undefined).toBe("latest")
    current.pending[0]?.resolve(
      response('<Gallery><Canonical id="canonical" /></Gallery>', {
        url: "https://example.test/current",
      }),
    )
    expect(await visit).toMatchObject({ status: "committed" })
    expect(current.session.tree.getElementById("canonical")).toBeDefined()
  })

  test("keeps explicit replace history at one index across preview and canonical redirect", async () => {
    const snapshotCache = new DocumentSnapshotCache()
    snapshotCache.put(
      "https://example.test/requested",
      parseExpoTurboDocument('<Gallery><Preview id="preview" /></Gallery>', {
        url: "https://example.test/requested",
      }),
    )
    const fixture = historyFixture(() => undefined, "https://example.test/current", 7)
    const current = harness({ history: fixture.history, snapshotCache })

    const visit = current.controller.visit("/requested", { action: "replace" })

    expect(fixture.writes).toEqual([
      {
        entry: {
          restorationIdentifier: "history-1",
          restorationIndex: 7,
          url: "https://example.test/requested",
        },
        method: "replace",
      },
    ])
    current.pending[0]?.resolve(
      response('<Gallery><Final id="final" /></Gallery>', {
        redirected: true,
        url: "https://example.test/final",
      }),
    )
    expect(await visit).toMatchObject({ status: "committed" })
    expect(fixture.writes).toEqual([
      {
        entry: {
          restorationIdentifier: "history-1",
          restorationIndex: 7,
          url: "https://example.test/requested",
        },
        method: "replace",
      },
      {
        entry: {
          restorationIdentifier: "history-2",
          restorationIndex: 7,
          url: "https://example.test/final",
        },
        method: "replace",
      },
    ])
  })

  test("replaces a preview with authoritative client and server error XML", async () => {
    for (const candidate of [
      { classification: "client-error", status: 422 },
      { classification: "server-error", status: 500 },
    ] as const) {
      const url = `https://example.test/error-${candidate.status}`
      const snapshotCache = new DocumentSnapshotCache()
      snapshotCache.put(
        url,
        parseExpoTurboDocument('<Gallery><Preview id="preview" /></Gallery>', { url }),
      )
      const current = harness({ snapshotCache })

      const visit = current.controller.visit(`/error-${candidate.status}`)
      current.pending[0]?.resolve(
        response(`<Gallery><ErrorResult id="error-${candidate.status}" /></Gallery>`, {
          status: candidate.status,
          url,
        }),
      )

      expect(await visit).toMatchObject({
        classification: candidate.classification,
        status: "committed",
      })
      expect(current.session.tree.getElementById(`error-${candidate.status}`)).toBeDefined()
      expect(current.session.tree.getElementById("preview")).toBeUndefined()
      expect(current.controller.state).toMatchObject({
        busy: false,
        previewVisible: false,
        status: "failed",
      })
    }
  })

  test("retains canonical committed classification when finalization fails after a preview", async () => {
    for (const candidate of [
      { expected: "completed", status: 200 },
      { expected: "failed", status: 422 },
    ] as const) {
      const url = `https://example.test/commit-${candidate.status}`
      const snapshotCache = new DocumentSnapshotCache()
      snapshotCache.put(
        url,
        parseExpoTurboDocument('<Gallery><Preview id="preview" /></Gallery>', { url }),
      )
      const current = harness({ snapshotCache })
      const visit = current.controller.visit(`/commit-${candidate.status}`)
      current.session.registerDisposal("id:preview", () => {
        throw new Error("canonical finalization failed")
      })
      current.pending[0]?.resolve(
        response(`<Gallery><Canonical id="canonical-${candidate.status}" /></Gallery>`, {
          status: candidate.status,
          url,
        }),
      )

      await expect(visit).rejects.toBeInstanceOf(DocumentCommitError)
      expect(current.session.tree.getElementById(`canonical-${candidate.status}`)).toBeDefined()
      expect(current.controller.state).toMatchObject({
        busy: false,
        previewVisible: false,
        status: candidate.expected,
      })
    }
  })

  test("keeps no-preview explicit replace tree and history unchanged on canonical failure", async () => {
    const snapshotCache = new DocumentSnapshotCache()
    snapshotCache.put(
      "https://example.test/next",
      parseExpoTurboDocument(
        '<Gallery data-turbo-cache-control="no-preview"><Retained id="retained" /></Gallery>',
        { url: "https://example.test/next" },
      ),
    )
    const fixture = historyFixture()
    const current = harness({
      fetch: async () => Promise.reject(new Error("offline")),
      history: fixture.history,
      snapshotCache,
    })
    const tree = current.session.tree
    const entry = fixture.history.current

    await expect(current.controller.visit("/next", { action: "replace" })).rejects.toBeInstanceOf(
      RequestError,
    )
    expect(current.session.tree).toBe(tree)
    expect(fixture.history.current).toBe(entry)
    expect(fixture.writes).toEqual([])
    expect(snapshotCache.get("https://example.test/next")?.getElementById("retained")).toBeDefined()
  })

  test("lets an external canonical replacement supersede pending preview revalidation", async () => {
    const snapshotCache = new DocumentSnapshotCache()
    snapshotCache.put(
      "https://example.test/next",
      parseExpoTurboDocument('<Gallery><Preview id="preview" /></Gallery>', {
        url: "https://example.test/next",
      }),
    )
    const current = harness({ snapshotCache })
    const visit = current.controller.visit("/next")

    current.session.replaceTree(
      parseExpoTurboDocument('<Gallery><PeerCanonical id="peer-canonical" /></Gallery>', {
        url: "https://example.test/peer",
      }),
    )
    current.pending[0]?.resolve(
      response('<Gallery><Late id="late" /></Gallery>', {
        url: "https://example.test/next",
      }),
    )

    expect(await visit).toMatchObject({ status: "canceled" })
    expect(current.session.tree.getElementById("peer-canonical")).toBeDefined()
    expect(current.session.tree.getElementById("late")).toBeUndefined()
    expect(current.controller.state).toMatchObject({
      previewVisible: false,
      status: "canceled",
    })
  })

  test("does not let a peer from initial preview lookup get reclaimed", async () => {
    const snapshotCache = new ReentrantSnapshotCache()
    snapshotCache.put(
      "https://example.test/outer",
      parseExpoTurboDocument('<Gallery><Preview id="preview" /></Gallery>', {
        url: "https://example.test/outer",
      }),
    )
    const current = harness({ snapshotCache })
    const peer = new DocumentVisitController(current.loader, new ManualClock())
    let peerVisit: Promise<unknown> | undefined
    snapshotCache.onGet = () => {
      peerVisit = peer.visit("/peer")
    }

    await expect(current.controller.visit("/outer")).rejects.toBeInstanceOf(StateError)
    if (!peerVisit) throw new Error("peer visit did not start")
    expect(current.pending).toHaveLength(1)
    expect(current.pending[0]?.request.url).toBe("https://example.test/peer")
    expect(current.pending[0]?.request.signal?.aborted).toBe(false)
    current.pending[0]?.resolve(
      response('<Gallery><Peer id="peer" /></Gallery>', {
        url: "https://example.test/peer",
      }),
    )
    expect(await peerVisit).toMatchObject({ status: "committed" })
  })

  test("does not let an initial preview lookup overwrite a reentrant authoritative tree", async () => {
    const snapshotCache = new ReentrantSnapshotCache()
    snapshotCache.put(
      "https://example.test/outer",
      parseExpoTurboDocument('<Gallery><Preview id="preview" /></Gallery>', {
        url: "https://example.test/outer",
      }),
    )
    const current = harness({ snapshotCache })
    snapshotCache.onGet = () => {
      current.session.replaceTree(
        parseExpoTurboDocument('<Gallery><Peer id="peer" /></Gallery>', {
          url: "https://example.test/peer",
        }),
      )
    }

    await expect(current.controller.visit("/outer")).rejects.toBeInstanceOf(StateError)
    expect(current.pending).toHaveLength(0)
    expect(current.session.tree.getElementById("peer")).toBeDefined()
    expect(current.session.tree.getElementById("preview")).toBeUndefined()
    expect(current.session.treeState.preview).toBe(false)
    expect(current.controller.state).toMatchObject({
      busy: false,
      previewVisible: false,
      status: "initialized",
    })
  })

  test("keeps a guarded preview commit authoritative when cache storage starts rejected work", async () => {
    const snapshotCache = new ReentrantSnapshotCache()
    snapshotCache.put(
      "https://example.test/outer",
      parseExpoTurboDocument('<Gallery><Preview id="preview" /></Gallery>', {
        url: "https://example.test/outer",
      }),
    )
    const current = harness({ snapshotCache })
    let peerVisit: Promise<unknown> | undefined
    snapshotCache.onPut = () => {
      peerVisit = current.controller.visit("/peer")
    }

    const outer = current.controller.visit("/outer")

    if (!peerVisit) throw new Error("peer visit did not start")
    await expect(peerVisit).rejects.toBeInstanceOf(StateError)
    expect(current.pending).toHaveLength(1)
    expect(current.pending[0]?.request.url).toBe("https://example.test/outer")
    current.pending[0]?.resolve(
      response('<Gallery><Canonical id="canonical" /></Gallery>', {
        url: "https://example.test/outer",
      }),
    )
    expect(await outer).toMatchObject({ status: "committed" })
    expect(current.session.tree.getElementById("canonical")).toBeDefined()
  })

  test("replaces preview history with a fresh same-index entry after a canonical redirect", async () => {
    const snapshotCache = new DocumentSnapshotCache()
    snapshotCache.put(
      "https://example.test/requested",
      parseExpoTurboDocument('<Gallery><Preview id="preview" /></Gallery>', {
        url: "https://example.test/requested",
      }),
    )
    const fixture = historyFixture()
    const { controller, pending, session } = harness({
      history: fixture.history,
      snapshotCache,
    })

    const visit = controller.visit("/requested")
    expect(session.tree.getElementById("preview")).toBeDefined()
    expect(fixture.writes).toEqual([
      {
        entry: {
          restorationIdentifier: "history-1",
          restorationIndex: 1,
          url: "https://example.test/requested",
        },
        method: "push",
      },
    ])

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
          restorationIndex: 1,
          url: "https://example.test/requested",
        },
        method: "push",
      },
      {
        entry: {
          restorationIdentifier: "history-2",
          restorationIndex: 1,
          url: "https://example.test/final",
        },
        method: "replace",
      },
    ])
    expect(session.tree.document.url).toBe("https://example.test/final")
    expect(session.tree.getElementById("final")).toBeDefined()
    expect(controller.state.previewVisible).toBe(false)
  })

  test("treats no-preview snapshots as ordinary network-only visits", async () => {
    const snapshotCache = new DocumentSnapshotCache()
    snapshotCache.put(
      "https://example.test/next",
      parseExpoTurboDocument(
        '<Gallery data-turbo-cache-control="no-preview"><Hidden id="hidden" /></Gallery>',
        { url: "https://example.test/next" },
      ),
    )
    const fixture = historyFixture()
    const { controller, pending, session } = harness({
      history: fixture.history,
      snapshotCache,
    })
    const oldTree = session.tree

    const visit = controller.visit("/next")

    expect(session.tree).toBe(oldTree)
    expect(session.tree.getElementById("hidden")).toBeUndefined()
    expect(controller.state.previewVisible).toBe(false)
    expect(fixture.writes).toEqual([])
    expect(snapshotCache.get("https://example.test/next")?.getElementById("hidden")).toBeDefined()
    pending[0]?.resolve(
      response('<Gallery><Canonical id="canonical" /></Gallery>', {
        url: "https://example.test/next",
      }),
    )

    expect(await visit).toMatchObject({ status: "committed" })
    expect(session.tree.getElementById("canonical")).toBeDefined()
    expect(controller.state.previewVisible).toBe(false)
    expect(fixture.writes).toHaveLength(1)
  })

  test("keeps a completed preview visible after canonical no-tree responses", async () => {
    for (const candidate of [
      { headers: {}, status: 204, text: "unused" },
      {
        headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
        status: 201,
        text: " \n ",
      },
    ] as const) {
      const snapshotCache = new DocumentSnapshotCache()
      snapshotCache.put(
        "https://example.test/next",
        parseExpoTurboDocument('<Gallery><Preview id="preview" /></Gallery>', {
          url: "https://example.test/next",
        }),
      )
      const fixture = historyFixture()
      const { controller, pending, session } = harness({
        history: fixture.history,
        snapshotCache,
      })

      const visit = controller.visit("/next")
      pending[0]?.resolve(
        response(candidate.text, {
          headers: candidate.headers,
          status: candidate.status,
          url: "https://example.test/next",
        }),
      )

      expect(await visit).toMatchObject({ status: "empty" })
      expect(session.tree.getElementById("preview")).toBeDefined()
      expect(controller.state).toMatchObject({
        busy: false,
        previewVisible: true,
        status: "completed",
      })
      expect(fixture.history.current?.url).toBe("https://example.test/next")
      expect(fixture.writes).toHaveLength(1)
    }
  })

  test("keeps a failed or canceled canonical revalidation explicitly provisional", async () => {
    const failingCache = new DocumentSnapshotCache()
    failingCache.put(
      "https://example.test/failure",
      parseExpoTurboDocument('<Gallery><Preview id="failed-preview" /></Gallery>', {
        url: "https://example.test/failure",
      }),
    )
    const lifecycle = new DocumentVisitLifecycle()
    const reloads: unknown[] = []
    lifecycle.subscribe("reload", (event) => {
      reloads.push(event.detail)
    })
    const failing = harness({
      fetch: async () => Promise.reject(new Error("offline")),
      history: historyFixture().history,
      snapshotCache: failingCache,
      visitLifecycle: lifecycle,
    })

    await expect(failing.controller.visit("/failure")).rejects.toBeInstanceOf(RequestError)
    expect(failing.session.tree.getElementById("failed-preview")).toBeDefined()
    expect(failing.controller.state).toMatchObject({
      busy: false,
      previewVisible: true,
      status: "failed",
    })
    expect(reloads).toEqual([{ cause: "transport", reason: "request-failed" }])

    const canceledCache = new DocumentSnapshotCache()
    canceledCache.put(
      "https://example.test/canceled",
      parseExpoTurboDocument('<Gallery><Preview id="canceled-preview" /></Gallery>', {
        url: "https://example.test/canceled",
      }),
    )
    const canceled = harness({
      history: historyFixture().history,
      snapshotCache: canceledCache,
    })
    const visit = canceled.controller.visit("/canceled")
    canceled.controller.cancel()

    expect(canceled.pending[0]?.request.signal?.aborted).toBe(true)
    canceled.pending[0]?.resolve(
      response('<Gallery><Late id="late" /></Gallery>', {
        url: "https://example.test/canceled",
      }),
    )
    expect(await visit).toMatchObject({ status: "canceled" })
    expect(canceled.session.tree.getElementById("canceled-preview")).toBeDefined()
    expect(canceled.controller.state).toMatchObject({
      busy: false,
      previewVisible: true,
      status: "canceled",
    })
  })

  test("does not let a reentrant preview lookup reclaim ownership from a newer visit", async () => {
    const snapshotCache = new ReentrantSnapshotCache()
    snapshotCache.put(
      "https://example.test/older",
      parseExpoTurboDocument('<Gallery><Older id="older" /></Gallery>', {
        url: "https://example.test/older",
      }),
    )
    const fixture = historyFixture()
    const { controller, pending, requestIdCount, session } = harness({
      history: fixture.history,
      snapshotCache,
    })
    let newer: Promise<unknown> | undefined
    snapshotCache.onGet = () => {
      newer = controller.visit("/newer")
    }

    const older = controller.visit("/older")

    await expect(older).rejects.toBeInstanceOf(StateError)
    if (!newer) throw new Error("newer visit did not start")
    expect(pending).toHaveLength(1)
    expect(requestIdCount()).toBe(1)
    expect(session.tree.getElementById("older")).toBeUndefined()
    pending[0]?.resolve(
      response('<Gallery><Newer id="newer" /></Gallery>', {
        url: "https://example.test/newer",
      }),
    )
    expect(await newer).toMatchObject({ status: "committed" })
    expect(session.tree.getElementById("newer")).toBeDefined()
  })

  test("does not start stale revalidation when preview finalization starts a newer visit", async () => {
    const snapshotCache = new DocumentSnapshotCache()
    snapshotCache.put(
      "https://example.test/previewed",
      parseExpoTurboDocument('<Gallery><Preview id="preview" /></Gallery>', {
        url: "https://example.test/previewed",
      }),
    )
    const fixture = historyFixture()
    const { controller, pending, session } = harness({
      history: fixture.history,
      snapshotCache,
    })
    let newer: Promise<unknown> | undefined
    const unsubscribe = session.subscribe("id:old", () => {
      unsubscribe()
      newer = controller.visit("/newer")
    })

    const previewed = controller.visit("/previewed")

    expect(await previewed).toEqual({
      source: "preview",
      status: "canceled",
      url: "https://example.test/previewed",
    })
    if (!newer) throw new Error("newer visit did not start")
    expect(pending).toHaveLength(1)
    expect(pending[0]?.request.url).toBe("https://example.test/newer")
    pending[0]?.resolve(
      response('<Gallery><Newer id="newer" /></Gallery>', {
        url: "https://example.test/newer",
      }),
    )
    expect(await newer).toMatchObject({ status: "committed" })
    expect(session.tree.getElementById("newer")).toBeDefined()
    expect(controller.state.previewVisible).toBe(false)
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

    await expect(older).rejects.toBeInstanceOf(StateError)
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

  test("does not let traversal cache lookup reclaim a peer controller", async () => {
    for (const cached of [true, false]) {
      const target = `https://example.test/traversal-peer-${cached ? "hit" : "miss"}`
      const peerUrl = `https://example.test/peer-${cached ? "hit" : "miss"}`
      const snapshotCache = new ReentrantSnapshotCache()
      if (cached) {
        snapshotCache.put(
          target,
          parseExpoTurboDocument('<Gallery><Restored id="restored" /></Gallery>', {
            url: target,
          }),
        )
      }
      const { history } = historyFixture()
      const current = harness({ history, snapshotCache })
      const peer = new DocumentVisitController(current.loader, new ManualClock())
      let peerVisit: Promise<unknown> | undefined
      snapshotCache.onGet = () => {
        peerVisit = peer.visit(peerUrl)
      }

      const stale = current.controller.restoreTraversal({
        restorationIdentifier: `history-traversal-${cached ? "hit" : "miss"}`,
        restorationIndex: 1,
        url: target,
      })

      await expect(stale).rejects.toBeInstanceOf(StateError)
      if (!peerVisit) throw new Error("peer visit was not started")
      expect(current.controller.state.status).toBe("initialized")
      expect(peer.state.status).toBe("started")
      expect(current.pending).toHaveLength(1)
      expect(current.pending[0]?.request.url).toBe(peerUrl)
      expect(current.pending[0]?.request.signal?.aborted).toBe(false)
      expect(current.requestIdCount()).toBe(cached ? 1 : 2)
      expect(current.session.tree.getElementById("restored")).toBeUndefined()

      current.pending[0]?.resolve(
        response('<Gallery><Peer id="peer" /></Gallery>', {
          url: peerUrl,
        }),
      )
      expect(await peerVisit).toMatchObject({ status: "committed" })
      expect(peer.state.status).toBe("completed")
      expect(current.session.tree.getElementById("peer")).toBeDefined()
    }
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

  test("restores an explicit no-preview snapshot without fetching and commits snapshot before history before tree", async () => {
    const order: string[] = []
    const snapshotCache = new DocumentSnapshotCache()
    snapshotCache.put(
      "https://example.test/restored",
      parseExpoTurboDocument(
        '<Gallery data-turbo-cache-control="no-preview"><Restored id="restored" /></Gallery>',
        { url: "https://example.test/restored" },
      ),
    )
    let history: DocumentHistory
    let session: DocumentSession
    const fixture = historyFixture((method, entry) => {
      expect(method).toBe("push")
      expect(entry.url).toBe("https://example.test/restored")
      expect(snapshotCache.has("https://example.test/current")).toBe(true)
      expect(history.current?.restorationIdentifier).toBe("history-current")
      expect(session.tree.getElementById("old")).toBeDefined()
      expect(session.tree.getElementById("restored")).toBeUndefined()
      order.push("history")
    })
    history = fixture.history
    const current = harness({
      documentXml: '<Gallery><Old id="old" data-state="initial" /></Gallery>',
      fetch: async () => {
        throw new Error("cached restore must not fetch")
      },
      history,
      snapshotCache,
    })
    session = current.session
    session.setAttribute("id:old", "data-state", "latest")
    session.subscribe("id:old", () => {
      expect(history.current?.url).toBe("https://example.test/restored")
      expect(session.tree.getElementById("old")).toBeUndefined()
      expect(session.tree.getElementById("restored")).toBeDefined()
      order.push("tree")
    })

    const result = await current.controller.visit("/restored", { action: "restore" })

    expect(result).toEqual({
      source: "snapshot",
      status: "restored",
      url: "https://example.test/restored",
    })
    expect(order).toEqual(["history", "tree"])
    expect(current.pending).toHaveLength(0)
    expect(current.requestIdCount()).toBe(0)
    expect(current.controller.state.status).toBe("completed")
    expect(fixture.writes).toEqual([
      {
        entry: {
          restorationIdentifier: "history-1",
          restorationIndex: 1,
          url: "https://example.test/restored",
        },
        method: "push",
      },
    ])
    const outgoing = snapshotCache.get("https://example.test/current")
    const old = outgoing?.getElementById("old")
    expect(old ? attributeValue(old, "data-state") : undefined).toBe("latest")
  })

  test("replaces same-location history while restoring an older cached snapshot", async () => {
    const snapshotCache = new DocumentSnapshotCache()
    snapshotCache.put(
      "https://example.test/current",
      parseExpoTurboDocument('<Gallery><Cached id="cached" /></Gallery>', {
        url: "https://example.test/current",
      }),
    )
    const fixture = historyFixture()
    const current = harness({
      fetch: async () => {
        throw new Error("same-location cached restore must not fetch")
      },
      history: fixture.history,
      snapshotCache,
    })

    expect(
      await current.controller.visit("https://example.test/current", { action: "restore" }),
    ).toEqual({
      source: "snapshot",
      status: "restored",
      url: "https://example.test/current",
    })

    expect(current.pending).toHaveLength(0)
    expect(current.requestIdCount()).toBe(0)
    expect(fixture.writes).toEqual([
      {
        entry: {
          restorationIdentifier: "history-1",
          restorationIndex: 0,
          url: "https://example.test/current",
        },
        method: "replace",
      },
    ])
    expect(current.session.tree.getElementById("cached")).toBeDefined()
    expect(snapshotCache.get("https://example.test/current")?.getElementById("old")).toBeDefined()
  })

  test("falls back to one guarded GET for an explicit restore cache miss and retargets history", async () => {
    const snapshotCache = new DocumentSnapshotCache()
    const fixture = historyFixture()
    const current = harness({
      documentXml: '<Gallery><Old id="old" data-state="initial" /></Gallery>',
      history: fixture.history,
      snapshotCache,
    })

    const visit = current.controller.visit("/requested", { action: "restore" })
    expect(current.pending).toHaveLength(1)
    expect(current.requestIdCount()).toBe(1)
    current.session.setAttribute("id:old", "data-state", "latest")
    current.pending[0]?.resolve(
      response('<Gallery><Final id="final" /></Gallery>', {
        redirected: true,
        url: "https://example.test/final",
      }),
    )

    expect(await visit).toMatchObject({
      redirected: true,
      status: "committed",
      url: "https://example.test/final",
    })
    expect(fixture.writes).toEqual([
      {
        entry: {
          restorationIdentifier: "history-1",
          restorationIndex: 1,
          url: "https://example.test/final",
        },
        method: "push",
      },
    ])
    const outgoing = snapshotCache.get("https://example.test/current")
    const old = outgoing?.getElementById("old")
    expect(old ? attributeValue(old, "data-state") : undefined).toBe("latest")
    expect(current.session.tree.getElementById("final")).toBeDefined()
  })

  test("fails explicit restore cache-miss redirects closed when the final location is not visitable", async () => {
    for (const fixture of [
      {
        document: '<Gallery data-turbo-root="/other"><Discarded id="outside-root" /></Gallery>',
        url: "https://example.test/app/final",
      },
      {
        document: '<Gallery data-turbo-root="/app"><Discarded id="excluded-extension" /></Gallery>',
        url: "https://example.test/app/archive.pdf",
      },
    ]) {
      const navigationCalls: Array<{ action: VisitAction; url: string }> = []
      const navigation: NavigationAdapter = {
        back() {},
        openExternal() {},
        visit: (url, action) => {
          navigationCalls.push({ action, url })
        },
      }
      const snapshotCache = new DocumentSnapshotCache()
      const history = historyFixture(undefined, "https://example.test/app/current")
      const current = harness({
        documentUrl: "https://example.test/app/current",
        documentXml: '<Gallery data-turbo-root="/app"><Old id="old" /></Gallery>',
        history: history.history,
        snapshotCache,
      })
      const entry = history.history.current
      const tree = current.session.tree

      const restoring = current.controller.visit("/app/requested", {
        action: "restore",
        navigation,
      })
      current.pending[0]?.resolve(
        response(fixture.document, {
          redirected: true,
          url: fixture.url,
        }),
      )

      await expect(restoring).rejects.toBeInstanceOf(TargetError)
      expect(navigationCalls).toEqual([])
      expect(current.controller.state.status).toBe("failed")
      expect(current.requestIdCount()).toBe(1)
      expect(current.session.tree).toBe(tree)
      expect(current.session.tree.getElementById("outside-root")).toBeUndefined()
      expect(current.session.tree.getElementById("excluded-extension")).toBeUndefined()
      expect(snapshotCache.size).toBe(0)
      expect(history.history.current).toBe(entry)
      expect(history.writes).toEqual([])
    }
  })

  test("rejects a fragment-bearing explicit restore final URL before history or tree commit", async () => {
    for (const fragment of ["#anchor", "#"]) {
      const navigationCalls: Array<{ action: VisitAction; url: string }> = []
      const navigation: NavigationAdapter = {
        back() {},
        openExternal() {},
        visit: (url, action) => {
          navigationCalls.push({ action, url })
        },
      }
      const snapshotCache = new DocumentSnapshotCache()
      const history = historyFixture()
      const current = harness({
        history: history.history,
        snapshotCache,
      })
      const entry = history.history.current
      const tree = current.session.tree

      const restoring = current.controller.visit("/requested", {
        action: "restore",
        navigation,
      })
      current.pending[0]?.resolve(
        response('<Gallery><Discarded id="discarded" /></Gallery>', {
          redirected: true,
          url: `https://example.test/final${fragment}`,
        }),
      )

      await expect(restoring).rejects.toThrow("anchor restoration support")
      expect(navigationCalls).toEqual([])
      expect(current.controller.state.status).toBe("failed")
      expect(current.session.tree).toBe(tree)
      expect(current.session.tree.getElementById("discarded")).toBeUndefined()
      expect(snapshotCache.size).toBe(0)
      expect(history.history.current).toBe(entry)
      expect(history.writes).toEqual([])
    }
  })

  test("rejects explicit restore after cache lookup history drift without claiming or fetching", async () => {
    const snapshotCache = new ReentrantSnapshotCache()
    snapshotCache.put(
      "https://example.test/restored",
      parseExpoTurboDocument('<Gallery><Restored id="restored" /></Gallery>', {
        url: "https://example.test/restored",
      }),
    )
    const fixture = historyFixture()
    snapshotCache.onGet = () => {
      fixture.history.commitProposal(fixture.history.proposeAdvance("https://example.test/manual"))
    }
    const current = harness({
      history: fixture.history,
      snapshotCache,
    })
    const tree = current.session.tree

    await expect(
      current.controller.visit("/restored", { action: "restore" }),
    ).rejects.toBeInstanceOf(StateError)

    expect(current.controller.state.status).toBe("initialized")
    expect(current.pending).toHaveLength(0)
    expect(current.requestIdCount()).toBe(0)
    expect(current.session.tree).toBe(tree)
    expect(fixture.history.current?.url).toBe("https://example.test/manual")
    expect(fixture.writes).toEqual([
      {
        entry: {
          restorationIdentifier: "history-2",
          restorationIndex: 1,
          url: "https://example.test/manual",
        },
        method: "push",
      },
    ])
  })

  test("does not let stale explicit restore cache lookup reclaim ownership or start a miss fallback", async () => {
    for (const cached of [true, false]) {
      const target = `https://example.test/restored-${cached ? "hit" : "miss"}`
      const newerUrl = `https://example.test/newer-${cached ? "hit" : "miss"}`
      const snapshotCache = new ReentrantSnapshotCache()
      if (cached) {
        snapshotCache.put(
          target,
          parseExpoTurboDocument('<Gallery><Restored id="restored" /></Gallery>', {
            url: target,
          }),
        )
      }
      const history = historyFixture()
      const current = harness({ history: history.history, snapshotCache })
      let newer: Promise<unknown> | undefined
      snapshotCache.onGet = () => {
        newer = current.controller.visit(newerUrl)
      }

      const stale = current.controller.visit(target, { action: "restore" })

      await expect(stale).rejects.toBeInstanceOf(StateError)
      if (!newer) throw new Error("newer visit was not started")
      expect(current.controller.state.status).toBe("started")
      expect(current.pending).toHaveLength(1)
      expect(current.pending[0]?.request.url).toBe(newerUrl)
      expect(current.pending[0]?.request.signal?.aborted).toBe(false)
      expect(current.requestIdCount()).toBe(1)
      expect(history.writes).toEqual([])
      expect(current.session.tree.getElementById("restored")).toBeUndefined()

      current.pending[0]?.resolve(
        response('<Gallery><Newer id="newer" /></Gallery>', {
          url: newerUrl,
        }),
      )
      expect(await newer).toMatchObject({ status: "committed" })
      expect(current.controller.state.status).toBe("completed")
      expect(current.session.tree.getElementById("newer")).toBeDefined()
      expect(history.history.current).toEqual({
        restorationIdentifier: "history-2",
        restorationIndex: 1,
        url: newerUrl,
      })
      expect(history.writes).toHaveLength(1)
    }
  })

  test("does not let explicit restore cache lookup reclaim a peer controller", async () => {
    for (const cached of [true, false]) {
      const target = `https://example.test/restored-peer-${cached ? "hit" : "miss"}`
      const peerUrl = `https://example.test/peer-${cached ? "hit" : "miss"}`
      const snapshotCache = new ReentrantSnapshotCache()
      if (cached) {
        snapshotCache.put(
          target,
          parseExpoTurboDocument('<Gallery><Restored id="restored" /></Gallery>', {
            url: target,
          }),
        )
      }
      const history = historyFixture()
      const current = harness({ history: history.history, snapshotCache })
      const peer = new DocumentVisitController(current.loader, new ManualClock())
      let peerVisit: Promise<unknown> | undefined
      snapshotCache.onGet = () => {
        peerVisit = peer.visit(peerUrl)
      }

      const stale = current.controller.visit(target, { action: "restore" })

      await expect(stale).rejects.toBeInstanceOf(StateError)
      if (!peerVisit) throw new Error("peer visit was not started")
      expect(current.controller.state.status).toBe("initialized")
      expect(peer.state.status).toBe("started")
      expect(current.pending).toHaveLength(1)
      expect(current.pending[0]?.request.url).toBe(peerUrl)
      expect(current.pending[0]?.request.signal?.aborted).toBe(false)
      expect(current.requestIdCount()).toBe(1)
      expect(history.writes).toEqual([])
      expect(current.session.tree.getElementById("restored")).toBeUndefined()

      current.pending[0]?.resolve(
        response('<Gallery><Peer id="peer" /></Gallery>', {
          url: peerUrl,
        }),
      )
      expect(await peerVisit).toMatchObject({ status: "committed" })
      expect(peer.state.status).toBe("completed")
      expect(current.session.tree.getElementById("peer")).toBeDefined()
    }
  })

  test("does not let explicit restore cache lookup overwrite a same-URL authoritative tree", async () => {
    const target = "https://example.test/restored"
    const snapshotCache = new ReentrantSnapshotCache()
    snapshotCache.put(
      target,
      parseExpoTurboDocument('<Gallery><Restored id="restored" /></Gallery>', {
        url: target,
      }),
    )
    const history = historyFixture()
    const current = harness({ history: history.history, snapshotCache })
    snapshotCache.onGet = () => {
      current.session.replaceTree(
        parseExpoTurboDocument('<Gallery><Peer id="peer" /></Gallery>', {
          url: "https://example.test/current",
        }),
      )
    }

    await expect(current.controller.visit(target, { action: "restore" })).rejects.toBeInstanceOf(
      StateError,
    )
    expect(current.pending).toHaveLength(0)
    expect(current.requestIdCount()).toBe(0)
    expect(history.writes).toEqual([])
    expect(current.session.tree.getElementById("peer")).toBeDefined()
    expect(current.session.tree.getElementById("restored")).toBeUndefined()
    expect(current.controller.state.status).toBe("initialized")
  })

  test("does not let restore request-ID reentrancy displace newer work on cache-miss or no-cache paths", async () => {
    for (const snapshotCache of [new DocumentSnapshotCache(), undefined]) {
      const history = historyFixture()
      let current: ReturnType<typeof harness>
      let newer: Promise<unknown> | undefined
      let reenter = true
      current = harness({
        history: history.history,
        onRequestId: () => {
          if (!reenter) return
          reenter = false
          newer = current.controller.visit("/newer")
        },
        ...(snapshotCache ? { snapshotCache } : {}),
      })

      const stale = current.controller.visit("/restored", { action: "restore" })

      await expect(stale).rejects.toBeInstanceOf(StateError)
      if (!newer) throw new Error("newer visit was not started")
      expect(current.controller.state.status).toBe("started")
      expect(current.pending).toHaveLength(1)
      expect(current.pending[0]?.request.url).toBe("https://example.test/newer")
      expect(current.pending[0]?.request.signal?.aborted).toBe(false)
      expect(current.requestIdCount()).toBe(2)
      expect(history.writes).toEqual([])

      current.pending[0]?.resolve(
        response('<Gallery><Newer id="newer" /></Gallery>', {
          url: "https://example.test/newer",
        }),
      )
      expect(await newer).toMatchObject({ status: "committed" })
      expect(current.controller.state.status).toBe("completed")
      expect(current.session.tree.getElementById("newer")).toBeDefined()
      expect(history.history.current).toEqual({
        restorationIdentifier: "history-2",
        restorationIndex: 1,
        url: "https://example.test/newer",
      })
      expect(history.writes).toHaveLength(1)
    }
  })

  test("rechecks explicit restore history after outgoing snapshot capture", async () => {
    const snapshotCache = new ReentrantSnapshotCache()
    snapshotCache.put(
      "https://example.test/restored",
      parseExpoTurboDocument('<Gallery><Restored id="restored" /></Gallery>', {
        url: "https://example.test/restored",
      }),
    )
    const fixture = historyFixture()
    snapshotCache.onPut = () => {
      fixture.history.commitProposal(fixture.history.proposeAdvance("https://example.test/manual"))
    }
    const current = harness({
      history: fixture.history,
      snapshotCache,
    })
    const tree = current.session.tree

    await expect(
      current.controller.visit("/restored", { action: "restore" }),
    ).rejects.toBeInstanceOf(StateError)

    expect(current.controller.state.status).toBe("failed")
    expect(current.requestIdCount()).toBe(0)
    expect(current.session.tree).toBe(tree)
    expect(current.session.tree.getElementById("restored")).toBeUndefined()
    expect(snapshotCache.has("https://example.test/current")).toBe(true)
    expect(fixture.history.current?.url).toBe("https://example.test/manual")
    expect(fixture.writes).toEqual([
      {
        entry: {
          restorationIdentifier: "history-2",
          restorationIndex: 1,
          url: "https://example.test/manual",
        },
        method: "push",
      },
    ])
  })

  test("lets a newer visit supersede an explicit cached restore before history or tree commit", async () => {
    const snapshotCache = new DocumentSnapshotCache()
    snapshotCache.put(
      "https://example.test/restored",
      parseExpoTurboDocument('<Gallery><Restored id="restored" /></Gallery>', {
        url: "https://example.test/restored",
      }),
    )
    const fixture = historyFixture()
    const current = harness({ history: fixture.history, snapshotCache })
    let newer: Promise<unknown> | undefined
    let started = false
    const unsubscribe = current.controller.subscribe(() => {
      if (started || current.controller.state.status !== "started") return
      started = true
      unsubscribe()
      newer = current.controller.visit("/newer")
    })

    expect(await current.controller.visit("/restored", { action: "restore" })).toEqual({
      source: "snapshot",
      status: "canceled",
      url: "https://example.test/restored",
    })
    expect(current.pending).toHaveLength(1)
    expect(current.session.tree.getElementById("restored")).toBeUndefined()
    expect(fixture.writes).toEqual([])

    current.pending[0]?.resolve(
      response('<Gallery><Newer id="newer" /></Gallery>', {
        url: "https://example.test/newer",
      }),
    )
    expect(await newer).toMatchObject({ status: "committed" })
    expect(fixture.history.current).toEqual({
      restorationIdentifier: "history-2",
      restorationIndex: 1,
      url: "https://example.test/newer",
    })
    expect(current.session.tree.getElementById("newer")).toBeDefined()
  })

  test("keeps cached explicit restore history and tree atomic across host and finalization failure", async () => {
    const hostFailureCache = new DocumentSnapshotCache()
    hostFailureCache.put(
      "https://example.test/host-failure",
      parseExpoTurboDocument('<Gallery><Failed id="failed" /></Gallery>', {
        url: "https://example.test/host-failure",
      }),
    )
    const hostFailureHistory = historyFixture(() => {
      throw new Error("history host failed with secret-token")
    })
    const hostFailure = harness({
      history: hostFailureHistory.history,
      snapshotCache: hostFailureCache,
    })
    const oldTree = hostFailure.session.tree
    const oldEntry = hostFailureHistory.history.current

    await expect(
      hostFailure.controller.visit("/host-failure", { action: "restore" }),
    ).rejects.toBeInstanceOf(StateError)

    expect(hostFailure.controller.state.status).toBe("failed")
    expect(hostFailure.requestIdCount()).toBe(0)
    expect(hostFailure.session.tree).toBe(oldTree)
    expect(hostFailureHistory.history.current).toBe(oldEntry)
    expect(hostFailureCache.has("https://example.test/current")).toBe(true)

    const finalizationCache = new DocumentSnapshotCache()
    finalizationCache.put(
      "https://example.test/finalization",
      parseExpoTurboDocument('<Gallery><Final id="final" /></Gallery>', {
        url: "https://example.test/finalization",
      }),
    )
    const finalizationHistory = historyFixture()
    const finalization = harness({
      history: finalizationHistory.history,
      snapshotCache: finalizationCache,
    })
    const errors: Error[] = []
    finalization.controller.subscribeErrors((error) => errors.push(error))
    finalization.session.registerDisposal("id:old", () => {
      throw new Error("finalization failed")
    })

    await expect(
      finalization.controller.visit("/finalization", { action: "restore" }),
    ).rejects.toBeInstanceOf(DocumentSnapshotRestoreCommitError)

    expect(finalization.controller.state.status).toBe("completed")
    expect(finalizationHistory.history.current?.url).toBe("https://example.test/finalization")
    expect(finalization.session.tree.getElementById("final")).toBeDefined()
    expect(errors).toHaveLength(1)
    expect(errors[0]).toBeInstanceOf(DocumentSnapshotRestoreCommitError)
  })

  test("rejects fragment-bearing explicit restores before history planning, cache, or ownership", async () => {
    for (const fragment of ["#anchor", "#"]) {
      for (const cached of [true, false]) {
        const snapshotCache = new ReentrantSnapshotCache()
        if (cached) {
          snapshotCache.put(
            "https://example.test/restored",
            parseExpoTurboDocument('<Gallery><Restored id="restored" /></Gallery>', {
              url: "https://example.test/restored",
            }),
          )
        }
        let cacheRead = false
        snapshotCache.onGet = () => {
          cacheRead = true
        }
        const history = historyFixture()
        const current = harness({ history: history.history, snapshotCache })
        const entry = history.history.current
        const initial = current.controller.state
        const tree = current.session.tree

        await expect(
          current.controller.visit(`/restored${fragment}`, { action: "restore" }),
        ).rejects.toThrow("anchor restoration support")

        expect(cacheRead).toBe(false)
        expect(history.restorationIdCount()).toBe(0)
        expect(history.history.current).toBe(entry)
        expect(history.writes).toEqual([])
        expect(current.controller.state).toBe(initial)
        expect(current.pending).toHaveLength(0)
        expect(current.requestIdCount()).toBe(0)
        expect(current.session.tree).toBe(tree)
      }
    }
  })

  test("rejects invalid visit direction and restore presentation before ownership", async () => {
    const history = historyFixture()
    const current = harness({
      history: history.history,
      snapshotCache: new DocumentSnapshotCache(),
    })
    const initial = current.controller.state
    const entry = history.history.current

    for (const options of [
      { direction: "sideways" },
      { action: "advance", restorationData: {} },
      { action: "restore", restorationData: null },
      { action: "restore", restorationData: { extra: true } },
      { action: "restore", restorationData: { scrollPosition: { x: Number.NaN, y: 0 } } },
      { action: "restore", restorationData: { scrollPosition: { x: 0, y: Infinity } } },
    ]) {
      await expect(current.controller.visit("/restored", options as never)).rejects.toBeInstanceOf(
        PropsError,
      )
    }

    expect(current.controller.state).toBe(initial)
    expect(history.history.current).toBe(entry)
    expect(history.writes).toEqual([])
    expect(current.pending).toHaveLength(0)
    expect(current.requestIdCount()).toBe(0)
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

  test("emits before-cache outside the commit transaction and captures listener mutations", async () => {
    const order: string[] = []
    const lifecycle = new DocumentVisitLifecycle()
    const snapshotCache = new DocumentSnapshotCache()
    let session: DocumentSession
    const history = historyFixture(() => {
      expect(order).toEqual(["before-visit", "visit", "before-cache"])
      expect(snapshotCache.has("https://example.test/current")).toBe(true)
      order.push("history")
    })
    lifecycle.subscribe("before-visit", () => {
      order.push("before-visit")
    })
    lifecycle.subscribe("visit", () => {
      order.push("visit")
    })
    lifecycle.subscribe("before-cache", () => {
      expect(snapshotCache.size).toBe(0)
      expect(session.tree.getElementById("old")).toBeDefined()
      session.setAttribute("id:old", "data-state", "cached")
      order.push("before-cache")
    })
    const current = harness({
      history: history.history,
      snapshotCache,
      visitLifecycle: lifecycle,
    })
    session = current.session
    session.subscribe("id:old", () => {
      if (!session.tree.getElementById("old")) order.push("tree")
    })

    const visit = current.controller.visit("/next")
    current.pending[0]?.resolve(
      response('<Gallery><Next id="next" /></Gallery>', {
        url: "https://example.test/next",
      }),
    )

    expect(await visit).toMatchObject({ status: "committed" })
    expect(order).toEqual(["before-visit", "visit", "before-cache", "history", "tree"])
    const cached = snapshotCache.get("https://example.test/current")
    const old = cached?.getElementById("old")
    expect(old ? attributeValue(old, "data-state") : undefined).toBe("cached")
  })

  test("lets before-cache reentrancy supersede stale capture, history, and tree work", async () => {
    const lifecycle = new DocumentVisitLifecycle()
    const snapshotCache = new DocumentSnapshotCache()
    const history = historyFixture()
    let controller: DocumentVisitController
    let newer: Promise<DocumentVisitResult> | undefined
    let events = 0
    lifecycle.subscribe("before-cache", () => {
      events += 1
      if (events === 1) newer = controller.visit("/newer")
    })
    const current = harness({
      history: history.history,
      snapshotCache,
      visitLifecycle: lifecycle,
    })
    controller = current.controller

    const stale = controller.visit("/stale")
    current.pending[0]?.resolve(
      response('<Gallery><Stale id="stale" /></Gallery>', {
        url: "https://example.test/stale",
      }),
    )
    expect(await stale).toMatchObject({ status: "canceled" })
    expect(snapshotCache.size).toBe(0)
    expect(history.writes).toEqual([])
    expect(current.session.tree.getElementById("old")).toBeDefined()

    const newerRequest = current.pending[1]
    if (!newerRequest || !newer) throw new Error("before-cache did not start newer work")
    newerRequest.resolve(
      response('<Gallery><Newer id="newer" /></Gallery>', {
        url: "https://example.test/newer",
      }),
    )
    expect(await newer).toMatchObject({ status: "committed" })
    expect(events).toBe(2)
    expect(history.writes).toHaveLength(1)
    expect(current.session.tree.getElementById("newer")).toBeDefined()
    expect(current.session.tree.getElementById("stale")).toBeUndefined()
  })

  test("rechecks outgoing cache policy after before-cache listener mutations", async () => {
    const lifecycle = new DocumentVisitLifecycle()
    const snapshotCache = new DocumentSnapshotCache()
    const history = historyFixture()
    let events = 0
    let session: DocumentSession
    lifecycle.subscribe("before-cache", () => {
      const root = session.tree.document.children.find(isElement)
      if (!root) throw new Error("before-cache fixture requires a document root")
      session.setAttribute(root.key, "data-turbo-cache-control", "no-cache")
      events += 1
    })
    const current = harness({
      history: history.history,
      snapshotCache,
      visitLifecycle: lifecycle,
    })
    session = current.session

    const visit = current.controller.visit("/next")
    current.pending[0]?.resolve(
      response('<Gallery><Next id="next" /></Gallery>', {
        url: "https://example.test/next",
      }),
    )

    expect(await visit).toMatchObject({ status: "committed" })
    expect(events).toBe(1)
    expect(snapshotCache.size).toBe(0)
    expect(history.writes).toHaveLength(1)
    expect(session.tree.getElementById("next")?.tagName).toBe("Next")
  })

  test("commits an advance without caching a no-cache outgoing document", async () => {
    const snapshotCache = new DocumentSnapshotCache()
    const lifecycle = new DocumentVisitLifecycle()
    let events = 0
    lifecycle.subscribe("before-cache", () => {
      events += 1
    })
    const { controller, pending, session } = harness({
      documentXml: '<Gallery data-turbo-cache-control="no-cache"><Old id="old" /></Gallery>',
      snapshotCache,
      visitLifecycle: lifecycle,
    })
    const visit = controller.visit("/next")
    pending[0]?.resolve(
      response('<Gallery><Next id="next" /></Gallery>', {
        url: "https://example.test/next",
      }),
    )

    expect(await visit).toMatchObject({ status: "committed" })
    expect(snapshotCache.size).toBe(0)
    expect(events).toBe(0)
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

  test("rejects historyless and misaligned explicit restore before reading cache or allocating a request", async () => {
    for (const fixture of [
      { history: undefined },
      { history: historyFixture(undefined, "https://example.test/other").history },
    ]) {
      const snapshotCache = new ReentrantSnapshotCache()
      snapshotCache.put(
        "https://example.test/restored",
        parseExpoTurboDocument('<Gallery><Restored id="restored" /></Gallery>', {
          url: "https://example.test/restored",
        }),
      )
      let cacheRead = false
      snapshotCache.onGet = () => {
        cacheRead = true
      }
      const current = harness({
        ...(fixture.history ? { history: fixture.history } : {}),
        snapshotCache,
      })
      const initial = current.controller.state

      await expect(
        current.controller.visit("/restored", { action: "restore" }),
      ).rejects.toBeInstanceOf(fixture.history ? StateError : TargetError)

      expect(cacheRead).toBe(false)
      expect(current.controller.state).toBe(initial)
      expect(current.pending).toHaveLength(0)
      expect(current.requestIdCount()).toBe(0)
      expect(current.session.tree.getElementById("old")).toBeDefined()
    }
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
    const lifecycle = new DocumentVisitLifecycle()
    let cacheEvents = 0
    lifecycle.subscribe("before-cache", () => {
      cacheEvents += 1
    })
    const { clock, controller, pending, session } = harness({
      snapshotCache,
      visitLifecycle: lifecycle,
    })
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
    expect(cacheEvents).toBe(0)
  })

  test("commits authoritative HTTP error documents before publishing failed", async () => {
    for (const fixture of [
      { classification: "client-error", status: 422 },
      { classification: "server-error", status: 500 },
    ] as const) {
      const snapshotCache = new DocumentSnapshotCache()
      const history = historyFixture()
      const lifecycle = new DocumentVisitLifecycle()
      let cacheEvents = 0
      lifecycle.subscribe("before-cache", () => {
        cacheEvents += 1
      })
      const { controller, pending, session } = harness({
        history: history.history,
        snapshotCache,
        visitLifecycle: lifecycle,
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
      expect(cacheEvents).toBe(1)
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
      reloadCause?: "content-type" | "transport"
      requestLifecycle?: RequestLifecycle
    }> = [
      {
        error: RequestError,
        fetch: async () => Promise.reject(new Error("network unavailable")),
        reloadCause: "transport",
      },
      {
        error: ContentTypeError,
        fetch: async () => Promise.reject(new ContentTypeError("fetch adapter rejected")),
        reloadCause: "transport",
      },
      {
        error: RequestError,
        fetch: async () =>
          response("", {
            text: async () => Promise.reject(new Error("response body unavailable")),
          }),
        reloadCause: "transport",
      },
      {
        error: RequestError,
        fetch: async () => Promise.reject(new Error("lifecycle network unavailable")),
        reloadCause: "transport",
        requestLifecycle: new RequestLifecycle(),
      },
      {
        error: ContentTypeError,
        fetch: async () => response("{}", { headers: { "Content-Type": "application/json" } }),
        reloadCause: "content-type",
      },
      {
        error: ParseError,
        fetch: async () => response("<Gallery>"),
      },
    ]

    for (const fixture of fixtures) {
      const history = historyFixture()
      const snapshotCache = new DocumentSnapshotCache()
      const lifecycle = new DocumentVisitLifecycle()
      let cacheEvents = 0
      const reloads: unknown[] = []
      lifecycle.subscribe("before-cache", () => {
        cacheEvents += 1
      })
      lifecycle.subscribe("reload", (event) => {
        reloads.push(event.detail)
      })
      const { clock, controller, session } = harness({
        fetch: fixture.fetch,
        history: history.history,
        ...(fixture.requestLifecycle ? { requestLifecycle: fixture.requestLifecycle } : {}),
        snapshotCache,
        visitLifecycle: lifecycle,
      })
      const tree = session.tree
      const errors: Error[] = []
      const notifications: string[] = []
      lifecycle.subscribe("reload", () => {
        notifications.push("reload")
      })
      controller.subscribeErrors((error) => {
        errors.push(error)
        notifications.push("error")
      })

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
      expect(cacheEvents).toBe(0)
      expect(history.writes).toEqual([])
      expect(reloads).toEqual(
        fixture.reloadCause ? [{ cause: fixture.reloadCause, reason: "request-failed" }] : [],
      )
      expect(notifications).toEqual(fixture.reloadCause ? ["reload", "error"] : ["error"])
    }
  })

  test("publishes reload after failure so its listener can start a new visit", async () => {
    const lifecycle = new DocumentVisitLifecycle()
    const order: string[] = []
    let recovery: Promise<DocumentVisitResult> | undefined
    const { controller, session } = harness({
      fetch: async (request) => {
        if (request.url.endsWith("/failed")) throw new Error("secret transport failure")
        return response('<Gallery><Recovered id="recovered" /></Gallery>', { url: request.url })
      },
      visitLifecycle: lifecycle,
    })
    lifecycle.subscribe("reload", (event) => {
      order.push("reload")
      expect(event.detail).toEqual({ cause: "transport", reason: "request-failed" })
      expect(controller.state.status).toBe("failed")
      recovery = controller.visit("/recovered")
    })
    controller.subscribeErrors(() => {
      order.push("error")
    })

    await expect(controller.visit("/failed")).rejects.toBeInstanceOf(RequestError)
    expect(order).toEqual(["reload", "error"])
    if (!recovery) throw new Error("Reload listener did not start recovery")
    expect(await recovery).toMatchObject({ status: "committed" })
    expect(controller.state.status).toBe("completed")
    expect(session.tree.getElementById("recovered")?.tagName).toBe("Recovered")
  })

  test("does not publish reload for a host commit error that only resembles a MIME failure", async () => {
    const lifecycle = new DocumentVisitLifecycle()
    const reloads: unknown[] = []
    lifecycle.subscribe("reload", (event) => {
      reloads.push(event.detail)
    })
    const { history } = historyFixture(() => {
      throw new ContentTypeError("Host history rejected the proposal")
    })
    const { controller } = harness({
      fetch: async (request) =>
        response('<Gallery><Next id="next" /></Gallery>', { url: request.url }),
      history,
      visitLifecycle: lifecycle,
    })

    await expect(controller.visit("/next")).rejects.toBeInstanceOf(StateError)
    expect(reloads).toEqual([])
  })

  test("does not publish reload after explicit cancellation", async () => {
    const lifecycle = new DocumentVisitLifecycle()
    const reloads: unknown[] = []
    let rejectFetch: ((error: unknown) => void) | undefined
    lifecycle.subscribe("reload", (event) => {
      reloads.push(event.detail)
    })
    const { controller } = harness({
      fetch: () =>
        new Promise<TurboResponse>((_resolve, reject) => {
          rejectFetch = reject
        }),
      visitLifecycle: lifecycle,
    })

    const visit = controller.visit("/pending")
    controller.cancel()
    rejectFetch?.(new Error("secret canceled transport failure"))

    expect(await visit).toMatchObject({ status: "canceled" })
    expect(reloads).toEqual([])
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
    const { clock, controller, pending, requestIdCount, session } = harness()
    let unsubscribe: () => void = () => undefined
    unsubscribe = controller.subscribe(() => {
      if (controller.state.status !== "started") return
      unsubscribe()
      controller.cancel()
    })

    const visit = controller.visit("/canceled-by-subscriber")

    expect(requestIdCount()).toBe(1)
    expect(pending).toHaveLength(0)
    expect(clock.timers).toHaveLength(0)
    expect(controller.state).toMatchObject({ busy: false, status: "canceled" })
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

    expect(pending).toHaveLength(1)
    expect(pending[0]?.request.url).toBe("https://example.test/newer-from-subscriber")
    expect(pending[0]?.request.signal?.aborted).toBe(false)
    expect(clock.timers).toHaveLength(1)
    expect(clock.timers[0]?.cleared).toBe(false)
    expect(await older).toMatchObject({ status: "canceled" })
    pending[0]?.resolve(
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
      visit: (url) => {
        navigationCalls.push(url)
      },
    }
    const snapshotCache = new DocumentSnapshotCache()
    const { controller, pending } = harness({ snapshotCache })
    const active = controller.visit("/pending")
    const started = controller.state

    await expect(
      controller.visit("/other", { action: "replace", navigation }),
    ).rejects.toBeInstanceOf(TargetError)
    await expect(
      controller.visit("/restore", { action: "restore", navigation }),
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

  test("refreshes exact current truth with replace history and no snapshot", async () => {
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
    expect(history.writes).toEqual([
      {
        entry: {
          restorationIdentifier: "history-1",
          restorationIndex: 0,
          url: "https://example.test/current",
        },
        method: "replace",
      },
    ])
    expect(history.history.current).toBe(history.writes[0]?.entry)
  })

  test("binds a successful reset refresh to one live document-render acknowledgement", async () => {
    const lifecycle = new DocumentVisitLifecycle()
    const current = harness({ visitLifecycle: lifecycle })
    const releaseRenderer = retainDocumentRenderer(current.session)
    const refreshing = current.controller.refreshCurrent(
      "https://example.test/current",
      "replace",
      "reset",
    )
    const renderRevision = documentRenderLifecycleRevision(current.session)
    current.pending[0]?.resolve(
      response('<Gallery><Fresh id="fresh" /></Gallery>', {
        url: "https://example.test/current",
      }),
    )

    await waitForDocumentRenderSeal(current.session, renderRevision)
    const acknowledgement = acknowledgeDocumentRender(
      current.session,
      current.session.tree.document,
      current.session.treeGeneration,
      current.session.revision,
    )
    expect(acknowledgement?.finish()).toBe(true)
    expect(
      consumeDocumentRefreshScroll(
        current.session,
        current.session.tree.document,
        current.session.treeGeneration,
      ),
    ).toBe(true)
    expect(await refreshing).toMatchObject({ status: "committed" })
    releaseRenderer()
  })

  test("does not stage a reset refresh without a mounted document renderer", async () => {
    const lifecycle = new DocumentVisitLifecycle()
    const { controller, pending, session } = harness({ visitLifecycle: lifecycle })
    const refreshing = controller.refreshCurrent("https://example.test/current", "replace", "reset")
    pending[0]?.resolve(
      response('<Gallery><Fresh id="fresh" /></Gallery>', {
        url: "https://example.test/current",
      }),
    )

    expect(await refreshing).toMatchObject({ status: "committed" })
    expect(
      consumeDocumentRefreshScroll(session, session.tree.document, session.treeGeneration),
    ).toBe(false)
  })

  test("drops a reset refresh that a tree listener supersedes before render acknowledgement", async () => {
    const lifecycle = new DocumentVisitLifecycle()
    const current = harness({ visitLifecycle: lifecycle })
    const releaseRenderer = retainDocumentRenderer(current.session)
    let successor: Promise<DocumentVisitResult> | undefined
    const unsubscribe = current.session.subscribe("id:old", () => {
      unsubscribe()
      successor = current.controller.visit("/successor")
    })
    const refreshing = current.controller.refreshCurrent(
      "https://example.test/current",
      "replace",
      "reset",
    )
    current.pending[0]?.resolve(
      response('<Gallery><Fresh id="fresh" /></Gallery>', {
        url: "https://example.test/current",
      }),
    )

    expect(await refreshing).toMatchObject({ status: "committed" })
    expect(current.pending[1]?.request.url).toBe("https://example.test/successor")
    expect(
      consumeDocumentRefreshScroll(
        current.session,
        current.session.tree.document,
        current.session.treeGeneration,
      ),
    ).toBe(false)

    const successorRevision = documentRenderLifecycleRevision(current.session)
    current.pending[1]?.resolve(
      response('<Gallery><Successor id="successor" /></Gallery>', {
        url: "https://example.test/successor",
      }),
    )
    await waitForDocumentRenderSeal(current.session, successorRevision)
    acknowledgeDocumentRender(
      current.session,
      current.session.tree.document,
      current.session.treeGeneration,
      current.session.revision,
    )?.finish()
    expect(await successor).toMatchObject({ status: "committed" })
    releaseRenderer()
  })

  test("morphs an exact current-document refresh while retaining compatible application identity", async () => {
    const history = historyFixture()
    const snapshotCache = new DocumentSnapshotCache()
    const { controller, pending, session } = harness({
      documentXml:
        '<Gallery id="gallery" data-turbo-root="/app" tone="before"><Panel id="retained" tone="before"/><Panel id="permanent" data-turbo-permanent="" tone="kept"><Locked id="locked" value="current"/></Panel><Removed id="removed"/></Gallery>',
      history: history.history,
      snapshotCache,
    })
    const tree = session.tree
    const root = session.tree.getElementById("gallery")
    const retained = session.tree.getElementById("retained")
    const permanent = session.tree.getElementById("permanent")
    const retainedIdentity = session.getNodeSnapshot("id:retained")?.identity
    const disposed: string[] = []
    session.registerDisposal("id:removed", () => disposed.push("removed"))

    const refreshing = controller.refreshCurrent("https://example.test/current", "morph")
    pending[0]?.resolve(
      response(
        '<Gallery id="gallery" data-turbo-root="/app" tone="after"><Panel id="permanent" data-turbo-permanent="" tone="incoming"><Locked id="locked" value="incoming"/></Panel><Panel id="retained" tone="after"/><Added id="added"/></Gallery>',
        { url: "https://example.test/current" },
      ),
    )

    expect(await refreshing).toMatchObject({ status: "committed" })
    expect(session.tree).toBe(tree)
    expect(session.tree.getElementById("gallery")).toBe(root)
    expect(session.tree.getElementById("retained")).toBe(retained)
    expect(session.tree.getElementById("permanent")).toBe(permanent)
    expect(session.getNodeSnapshot("id:retained")?.identity).toBe(retainedIdentity)
    const currentGallery = session.tree.getElementById("gallery")
    const currentRetained = session.tree.getElementById("retained")
    const currentPermanent = session.tree.getElementById("permanent")
    if (!currentGallery || !currentRetained || !currentPermanent) {
      throw new Error("Expected retained document morph fixtures")
    }
    expect(attributeValue(currentGallery, "tone")).toBe("after")
    expect(attributeValue(currentRetained, "tone")).toBe("after")
    expect(attributeValue(currentPermanent, "tone")).toBe("kept")
    expect(session.tree.getElementById("removed")).toBeUndefined()
    expect(session.tree.getElementById("added")).toBeDefined()
    expect(disposed).toEqual(["removed"])
    expect(session.treeGeneration).toBe(1)
    expect(snapshotCache.size).toBe(0)
    expect(history.writes).toEqual([
      {
        entry: {
          restorationIdentifier: "history-1",
          restorationIndex: 0,
          url: "https://example.test/current",
        },
        method: "replace",
      },
    ])
  })

  test("uses root-configured morph and reset semantics for a fragment-free same-path replace", async () => {
    const history = historyFixture()
    const snapshotCache = new DocumentSnapshotCache()
    const lifecycle = new DocumentVisitLifecycle()
    const current = harness({
      documentXml:
        '<Gallery id="gallery" data-turbo-root="/" data-turbo-refresh-method="morph"><Panel id="retained" tone="before"/><Removed id="removed"/></Gallery>',
      history: history.history,
      snapshotCache,
      visitLifecycle: lifecycle,
    })
    const releaseRenderer = retainDocumentRenderer(current.session)
    const destination = "https://example.test/current?revision=next"
    snapshotCache.put(
      destination,
      parseExpoTurboDocument('<Gallery id="cached"><Preview id="preview" /></Gallery>', {
        url: destination,
      }),
    )
    const tree = current.session.tree
    const retained = tree.getElementById("retained")
    const retainedIdentity = current.session.getNodeSnapshot("id:retained")?.identity
    const renderMethods: string[] = []
    lifecycle.subscribe("render", (event) => {
      renderMethods.push(event.detail.renderMethod)
    })

    const refreshing = current.controller.visit("/current?revision=next", { action: "replace" })
    expect(current.pending).toHaveLength(1)
    expect(current.pending[0]?.request.url).toBe(destination)
    expect(current.session.tree).toBe(tree)
    expect(current.controller.state.previewVisible).toBe(false)

    const renderRevision = documentRenderLifecycleRevision(current.session)
    current.pending[0]?.resolve(
      response(
        '<Gallery id="gallery" data-turbo-root="/" data-turbo-refresh-method="morph"><Panel id="retained" tone="after"/><Added id="added"/></Gallery>',
        { url: destination },
      ),
    )

    await waitForDocumentRenderSeal(current.session, renderRevision)
    const acknowledgement = acknowledgeDocumentRender(
      current.session,
      current.session.tree.document,
      current.session.treeGeneration,
      current.session.revision,
    )
    expect(acknowledgement?.finish()).toBe(true)

    expect(await refreshing).toMatchObject({ status: "committed", url: destination })
    expect(current.session.tree).toBe(tree)
    expect(current.session.tree.getElementById("retained")).toBe(retained)
    expect(current.session.getNodeSnapshot("id:retained")?.identity).toBe(retainedIdentity)
    const currentRetained = current.session.tree.getElementById("retained")
    if (!currentRetained) throw new Error("Expected retained same-path refresh fixture")
    expect(attributeValue(currentRetained, "tone")).toBe("after")
    expect(current.session.tree.getElementById("removed")).toBeUndefined()
    expect(current.session.tree.getElementById("added")).toBeDefined()
    expect(renderMethods).toEqual(["morph"])
    expect(
      consumeDocumentRefreshScroll(
        current.session,
        current.session.tree.document,
        current.session.treeGeneration,
      ),
    ).toBe(true)
    expect(history.writes).toEqual([
      {
        entry: {
          restorationIdentifier: "history-1",
          restorationIndex: 0,
          url: destination,
        },
        method: "replace",
      },
    ])
    releaseRenderer()
  })

  test("preserves root scroll for a fragment-free same-path replace only when configured", async () => {
    const lifecycle = new DocumentVisitLifecycle()
    const current = harness({
      documentXml:
        '<Gallery data-turbo-root="/" data-turbo-refresh-scroll="preserve"><Panel id="before" /></Gallery>',
      history: historyFixture().history,
      visitLifecycle: lifecycle,
    })
    const releaseRenderer = retainDocumentRenderer(current.session)
    const destination = "https://example.test/current?revision=preserved"
    const refreshing = current.controller.visit("/current?revision=preserved", {
      action: "replace",
    })
    const renderRevision = documentRenderLifecycleRevision(current.session)
    current.pending[0]?.resolve(
      response('<Gallery data-turbo-root="/"><Panel id="after" /></Gallery>', {
        url: destination,
      }),
    )

    await waitForDocumentRenderSeal(current.session, renderRevision)
    const acknowledgement = acknowledgeDocumentRender(
      current.session,
      current.session.tree.document,
      current.session.treeGeneration,
      current.session.revision,
    )
    expect(acknowledgement?.finish()).toBe(true)
    expect(await refreshing).toMatchObject({ status: "committed", url: destination })
    expect(
      consumeDocumentRefreshScroll(
        current.session,
        current.session.tree.document,
        current.session.treeGeneration,
      ),
    ).toBe(false)
    releaseRenderer()
  })

  test("replaces error documents after a morph refresh and reports replacement rendering", async () => {
    for (const candidate of [
      { classification: "client-error", status: 422 },
      { classification: "server-error", status: 500 },
    ] as const) {
      const history = historyFixture()
      const lifecycle = new DocumentVisitLifecycle()
      const current = harness({
        documentXml:
          '<Gallery id="gallery" data-turbo-root="/app"><Panel id="stable" tone="before"/></Gallery>',
        history: history.history,
        visitLifecycle: lifecycle,
      })
      const releaseRenderer = retainDocumentRenderer(current.session)
      const renderMethods: string[] = []
      lifecycle.subscribe("render", (event) => {
        renderMethods.push(event.detail.renderMethod)
      })
      const tree = current.session.tree
      const stable = current.session.tree.getElementById("stable")
      const stableIdentity = current.session.getNodeSnapshot("id:stable")?.identity
      const committed = new Promise<void>((resolve) => {
        const unsubscribe = current.session.subscribeTreeState(() => {
          if (current.session.treeGeneration !== 1) return
          unsubscribe()
          resolve()
        })
      })
      const refreshing = current.controller.refreshCurrent(
        "https://example.test/current",
        "morph",
        "reset",
      )
      const renderRevision = documentRenderLifecycleRevision(current.session)
      current.pending[0]?.resolve(
        response(
          '<Gallery id="gallery" data-turbo-root="/app"><Panel id="stable" tone="after"/></Gallery>',
          { status: candidate.status, url: "https://example.test/current" },
        ),
      )

      await committed
      await waitForDocumentRenderSeal(current.session, renderRevision)
      const acknowledgement = acknowledgeDocumentRender(
        current.session,
        current.session.tree.document,
        current.session.treeGeneration,
        current.session.revision,
      )
      expect(
        consumeDocumentRefreshScroll(
          current.session,
          current.session.tree.document,
          current.session.treeGeneration,
        ),
      ).toBe(false)
      acknowledgement?.finish()

      expect(await refreshing).toMatchObject({
        classification: candidate.classification,
        status: "committed",
      })
      expect(current.session.tree).not.toBe(tree)
      expect(current.session.tree.getElementById("stable")).not.toBe(stable)
      expect(current.session.getNodeSnapshot("id:stable")?.identity).not.toBe(stableIdentity)
      const currentStable = current.session.tree.getElementById("stable")
      if (!currentStable) throw new Error("Expected replacement document fixture")
      expect(attributeValue(currentStable, "tone")).toBe("after")
      expect(renderMethods).toEqual(["replace"])
      expect(current.controller.state.status).toBe("failed")
      expect(history.writes).toHaveLength(1)
      expect(history.writes[0]?.method).toBe("replace")
      releaseRenderer()
    }
  })

  test("rejects unsupported document refresh morphs before history or tree commit", async () => {
    for (const candidate of [
      {
        documentXml: '<Gallery><Panel id="stable" tone="before"/></Gallery>',
        name: "incompatible application root",
        responseXml: '<Other><Panel id="stable" tone="after"/></Other>',
      },
      {
        documentXml: '<Gallery id="gallery"><Panel id="stable" tone="before"/></Gallery>',
        name: "absent application root ID",
        responseXml: '<Gallery><Panel id="stable" tone="after"/></Gallery>',
      },
      {
        documentXml: '<Gallery id="gallery"><Panel id="stable" tone="before"/></Gallery>',
        name: "changed application root ID",
        responseXml: '<Gallery id="next"><Panel id="stable" tone="after"/></Gallery>',
      },
      {
        documentXml: '<Gallery><Panel id="stable" tone="before"/></Gallery>',
        name: "permanent application root",
        responseXml: '<Gallery data-turbo-permanent=""><Panel id="stable" tone="after"/></Gallery>',
      },
      {
        documentXml: '<Gallery><Panel id="stable" tone="before"/></Gallery>',
        name: "protocol descendants",
        responseXml:
          '<Gallery><Panel id="stable" tone="after"/><turbo-frame id="frame"><Panel/></turbo-frame></Gallery>',
      },
      {
        documentXml:
          '<Gallery><Panel id="stable"/><Panel id="permanent" data-turbo-permanent=""><Locked id="locked"/></Panel></Gallery>',
        name: "unmatched permanent children",
        responseXml: '<Gallery><Panel id="stable"/></Gallery>',
      },
      {
        documentXml:
          '<Gallery><Panel id="stable"/><Group id="left"><Field id="field"/></Group><Group id="right"/></Gallery>',
        name: "reparented stable IDs",
        responseXml:
          '<Gallery><Panel id="stable"/><Group id="left"/><Group id="right"><Field id="field"/></Group></Gallery>',
      },
    ] as const) {
      const history = historyFixture()
      const { controller, pending, session } = harness({
        documentXml: candidate.documentXml,
        history: history.history,
      })
      const tree = session.tree
      const disposed: string[] = []
      session.registerDisposal("id:stable", () => disposed.push(candidate.name))

      const refreshing = controller.refreshCurrent("https://example.test/current", "morph")
      pending[0]?.resolve(response(candidate.responseXml, { url: "https://example.test/current" }))

      await expect(refreshing).rejects.toBeInstanceOf(TargetError)
      expect(controller.state.status).toBe("failed")
      expect(history.writes).toEqual([])
      expect(session.tree).toBe(tree)
      expect(session.treeGeneration).toBe(0)
      expect(session.revision).toBe(0)
      expect(session.tree.getElementById("stable")).toBeDefined()
      expect(disposed).toEqual([])
    }
  })

  test("does not let refresh request-ID allocation reclaim a peer controller", async () => {
    const history = historyFixture()
    let peer: DocumentVisitController
    let peerVisit: Promise<unknown> | undefined
    let triggerPeer = true
    const current = harness({
      history: history.history,
      onRequestId: () => {
        if (!triggerPeer) return
        triggerPeer = false
        peerVisit = peer.visit("/peer")
      },
    })
    peer = new DocumentVisitController(current.loader, new ManualClock())

    await expect(
      current.controller.refreshCurrent("https://example.test/current"),
    ).rejects.toBeInstanceOf(StateError)
    if (!peerVisit) throw new Error("peer visit did not start")
    expect(current.controller.state.status).toBe("initialized")
    expect(peer.state.status).toBe("started")
    expect(current.pending).toHaveLength(1)
    expect(current.pending[0]?.request.url).toBe("https://example.test/peer")
    expect(current.pending[0]?.request.signal?.aborted).toBe(false)
    expect(current.requestIdCount()).toBe(2)
    expect(history.writes).toEqual([])

    current.pending[0]?.resolve(
      response('<Gallery><Peer id="peer" /></Gallery>', {
        url: "https://example.test/peer",
      }),
    )
    expect(await peerVisit).toMatchObject({ status: "committed" })
    expect(peer.state.status).toBe("completed")
    expect(current.session.tree.getElementById("peer")).toBeDefined()
  })

  test("refreshes canonical-equivalent current history with a canonical replace", async () => {
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
    expect(history.writes).toEqual([
      {
        entry: {
          restorationIdentifier: "history-1",
          restorationIndex: 0,
          url: "https://example.test/current",
        },
        method: "replace",
      },
    ])
    expect(history.history.current?.url).toBe("https://example.test/current")
    expect(session.tree.document.url).toBe("https://example.test/current")
  })

  test("retargets redirected refresh history before committing the final tree", async () => {
    const history = historyFixture()
    const { controller, pending, session } = harness({ history: history.history })

    const refreshing = controller.refreshCurrent("https://example.test/current")
    pending[0]?.resolve(
      response('<Gallery data-turbo-root="/"><Redirected id="redirected" /></Gallery>', {
        redirected: true,
        url: "https://example.test/redirected",
      }),
    )

    expect(await refreshing).toMatchObject({ redirected: true, status: "committed" })
    expect(controller.state.status).toBe("completed")
    expect(history.writes).toEqual([
      {
        entry: {
          restorationIdentifier: "history-1",
          restorationIndex: 0,
          url: "https://example.test/redirected",
        },
        method: "replace",
      },
    ])
    expect(history.history.current).toBe(history.writes[0]?.entry)
    expect(session.tree.document.url).toBe("https://example.test/redirected")
    expect(session.tree.getElementById("redirected")).toBeDefined()
  })

  test("replaces history for authoritative refresh error documents", async () => {
    for (const fixtureCase of [
      { classification: "client-error", status: 422, tag: "Invalid" },
      { classification: "server-error", status: 500, tag: "Broken" },
    ] as const) {
      const history = historyFixture()
      const { controller, pending, session } = harness({ history: history.history })

      const refreshing = controller.refreshCurrent(
        "https://example.test/current",
        "replace",
        "reset",
      )
      pending[0]?.resolve(
        response(`<Gallery><${fixtureCase.tag} id="result" /></Gallery>`, {
          status: fixtureCase.status,
          url: "https://example.test/current",
        }),
      )

      expect(await refreshing).toMatchObject({
        classification: fixtureCase.classification,
        status: "committed",
      })
      expect(controller.state.status).toBe("failed")
      expect(history.writes).toEqual([
        {
          entry: {
            restorationIdentifier: "history-1",
            restorationIndex: 0,
            url: "https://example.test/current",
          },
          method: "replace",
        },
      ])
      expect(session.tree.getElementById("result")?.tagName).toBe(fixtureCase.tag)
    }
  })

  test("keeps refresh history and tree unchanged when no document commits", async () => {
    const fixtureCases: ReadonlyArray<
      Readonly<{
        error?: typeof ContentTypeError | typeof ParseError
        name: string
        reloadCause?: "content-type"
        response: TurboResponse
      }>
    > = [
      {
        name: "empty",
        response: response("", {
          status: 204,
          text: async () => "",
          url: "https://example.test/current",
        }),
      },
      {
        error: ContentTypeError,
        name: "wrong MIME",
        reloadCause: "content-type",
        response: response('{"ignored":true}', {
          headers: { "Content-Type": "application/json" },
          url: "https://example.test/current",
        }),
      },
      {
        error: ParseError,
        name: "malformed XML",
        response: response("<Gallery><Broken></Gallery>", {
          url: "https://example.test/current",
        }),
      },
    ]

    for (const fixtureCase of fixtureCases) {
      const history = historyFixture()
      const lifecycle = new DocumentVisitLifecycle()
      const reloads: unknown[] = []
      lifecycle.subscribe("reload", (event) => {
        reloads.push(event.detail)
      })
      const { controller, pending, session } = harness({
        history: history.history,
        visitLifecycle: lifecycle,
      })
      const tree = session.tree
      const entry = history.history.current

      const refreshing = controller.refreshCurrent("https://example.test/current")
      pending[0]?.resolve(fixtureCase.response)
      if (fixtureCase.error) {
        await expect(refreshing).rejects.toBeInstanceOf(fixtureCase.error)
      } else {
        expect(await refreshing).toMatchObject({ status: "empty" })
      }

      expect(history.writes, fixtureCase.name).toEqual([])
      expect(history.history.current, fixtureCase.name).toBe(entry)
      expect(session.tree, fixtureCase.name).toBe(tree)
      expect(
        consumeDocumentRefreshScroll(session, session.tree.document, session.treeGeneration),
        fixtureCase.name,
      ).toBe(false)
      expect(reloads, fixtureCase.name).toEqual(
        fixtureCase.reloadCause
          ? [{ cause: fixtureCase.reloadCause, reason: "request-failed" }]
          : [],
      )
    }
  })

  test("keeps the active refresh tree when its replace history host rejects", async () => {
    const history = historyFixture(() => {
      throw new Error("history host rejected secret-token")
    })
    const { controller, pending, session } = harness({ history: history.history })
    const tree = session.tree
    const entry = history.history.current

    const refreshing = controller.refreshCurrent("https://example.test/current")
    pending[0]?.resolve(
      response('<Gallery><Fresh id="fresh" /></Gallery>', {
        url: "https://example.test/current",
      }),
    )

    await expect(refreshing).rejects.toBeInstanceOf(StateError)
    expect(controller.state.status).toBe("failed")
    expect(history.writes).toHaveLength(1)
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
      openExternal: (url) => {
        externalCalls.push(url)
      },
      visit: (url, action) => {
        navigationCalls.push({ action, url })
      },
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
    await expect(
      controller.visit("/outside-restore", { action: "restore", navigation }),
    ).rejects.toBeInstanceOf(TargetError)
    await expect(
      controller.visit("https://outside.test/restore", { action: "restore", navigation }),
    ).rejects.toBeInstanceOf(TargetError)

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
      visit: (url, action) => {
        navigationCalls.push({ action, url })
      },
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
      visit: (url) => {
        navigationCalls.push(url)
      },
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
        visit: (url) => {
          navigationCalls.push(url)
        },
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
        visit: (url, action) => {
          navigationCalls.push({ action, url })
        },
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

  test("settles superseded redirect navigation promptly and consumes its late rejection", async () => {
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
    expect(await stale).toMatchObject({ status: "canceled" })
    expect(controller.state).toBe(currentStarted)

    rejectNavigation(failure)
    await Promise.resolve()
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

  test("does not invoke redirect navigation after cancellation wins its queued call", async () => {
    let navigationCalls = 0
    const navigation: NavigationAdapter = {
      back() {},
      openExternal() {},
      visit: () => {
        navigationCalls += 1
      },
    }
    const { controller, pending } = harness({
      documentXml: '<Gallery data-turbo-root="/app"><Old id="old" /></Gallery>',
    })
    const visiting = controller.visit("/app/start", { navigation })
    const xml = '<Gallery data-turbo-root="/other"><Discarded /></Gallery>'
    pending[0]?.resolve(
      response(xml, {
        redirected: true,
        text: () =>
          ({
            // biome-ignore lint/suspicious/noThenProperty: model cancellation between body settlement and queued navigation
            then(resolve: (value: string) => void) {
              resolve(xml)
              queueMicrotask(() => controller.cancel())
            },
          }) as Promise<string>,
        url: "https://example.test/app/final",
      }),
    )

    expect(await visiting).toMatchObject({ status: "canceled" })
    await Promise.resolve()
    expect(navigationCalls).toBe(0)
  })

  test("cancels pending redirect navigation without waiting for its adapter", async () => {
    let rejectNavigation: (error: Error) => void = () => undefined
    let signalNavigationStarted: () => void = () => undefined
    const navigationStarted = new Promise<void>((resolve) => {
      signalNavigationStarted = resolve
    })
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
    const { controller, pending } = harness({
      documentXml: '<Gallery data-turbo-root="/app"><Old id="old" /></Gallery>',
    })
    const errors: Error[] = []
    controller.subscribeErrors((error) => errors.push(error))
    const visiting = controller.visit("/app/start", { navigation })
    pending[0]?.resolve(
      response('<Gallery data-turbo-root="/other"><Discarded /></Gallery>', {
        redirected: true,
        url: "https://example.test/app/final",
      }),
    )
    await navigationStarted

    controller.cancel()

    expect(await visiting).toMatchObject({ status: "canceled" })
    expect(controller.state).toMatchObject({ busy: false, status: "canceled" })

    rejectNavigation(new Error("late secret router failure"))
    await Promise.resolve()
    expect(controller.state).toMatchObject({ busy: false, status: "canceled" })
    expect(errors).toEqual([])
  })

  test("settles redirect navigation when a peer document owner supersedes it", async () => {
    let rejectNavigation: (error: Error) => void = () => undefined
    let signalNavigationStarted: () => void = () => undefined
    const navigationStarted = new Promise<void>((resolve) => {
      signalNavigationStarted = resolve
    })
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
    const { controller, loader, pending, session } = harness({
      documentXml: '<Gallery data-turbo-root="/app"><Old id="old" /></Gallery>',
    })
    const peer = new DocumentVisitController(loader, new ManualClock())
    const errors: Error[] = []
    controller.subscribeErrors((error) => errors.push(error))
    const stale = controller.visit("/app/start", { navigation })
    pending[0]?.resolve(
      response('<Gallery data-turbo-root="/other"><Discarded /></Gallery>', {
        redirected: true,
        url: "https://example.test/app/final",
      }),
    )
    await navigationStarted

    const current = peer.visit("/app/current")

    expect(await stale).toMatchObject({ status: "canceled" })
    expect(controller.state).toMatchObject({ busy: false, status: "canceled" })
    expect(peer.state).toMatchObject({ busy: true, status: "started" })

    rejectNavigation(new Error("late secret router failure"))
    await Promise.resolve()
    expect(errors).toEqual([])
    expect(peer.state).toMatchObject({ busy: true, status: "started" })

    pending[1]?.resolve(
      response('<Gallery data-turbo-root="/app"><Current id="current" /></Gallery>', {
        url: "https://example.test/app/current",
      }),
    )
    expect(await current).toMatchObject({ status: "committed" })
    expect(session.tree.getElementById("current")?.tagName).toBe("Current")
  })

  test("settles redirect navigation when the active tree is replaced externally", async () => {
    let rejectNavigation: (error: Error) => void = () => undefined
    let signalNavigationStarted: () => void = () => undefined
    const navigationStarted = new Promise<void>((resolve) => {
      signalNavigationStarted = resolve
    })
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
    const visiting = controller.visit("/app/start", { navigation })
    pending[0]?.resolve(
      response('<Gallery data-turbo-root="/other"><Discarded /></Gallery>', {
        redirected: true,
        url: "https://example.test/app/final",
      }),
    )
    await navigationStarted
    const replacement = parseExpoTurboDocument(
      '<Gallery data-turbo-root="/app"><External id="external" /></Gallery>',
      { url: "https://example.test/app/external" },
    )

    session.replaceTree(replacement)

    expect(await visiting).toMatchObject({ status: "canceled" })
    expect(controller.state).toMatchObject({ busy: false, status: "canceled" })
    expect(session.tree).toBe(replacement)

    rejectNavigation(new Error("late secret router failure"))
    await Promise.resolve()
    expect(controller.state).toMatchObject({ busy: false, status: "canceled" })
    expect(errors).toEqual([])
    expect(session.tree).toBe(replacement)
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

  test("reads controller options once and redacts hostile option boundaries", () => {
    const { loader } = harness()
    const lifecycle = new DocumentVisitLifecycle()
    let lifecycleReads = 0
    const controller = new DocumentVisitController(loader, new ManualClock(), {
      get visitLifecycle() {
        lifecycleReads += 1
        return lifecycle
      },
    })

    expect(controller.state.status).toBe("initialized")
    expect(lifecycleReads).toBe(1)
    expect(
      () =>
        new DocumentVisitController(loader, new ManualClock(), {
          visitLifecycle: "secret" as never,
        }),
    ).toThrow("Document visit controller visit lifecycle is invalid")

    const revoked = Proxy.revocable({}, {})
    revoked.revoke()
    expect(() => new DocumentVisitController(loader, new ManualClock(), revoked.proxy)).toThrow(
      "Document visit controller options could not be read",
    )
  })
})
