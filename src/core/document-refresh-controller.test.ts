import { describe, expect, test } from "bun:test"

import type { ClockAdapter, TurboRequest, TurboResponse } from "../adapters"
import { DocumentRequestLoader } from "./document-loader"
import {
  DOCUMENT_REFRESH_DEBOUNCE_MS,
  DocumentReconnectReconciler,
  DocumentRefreshController,
} from "./document-refresh-controller"
import { DocumentVisitController, type DocumentVisitSnapshot } from "./document-visit-controller"
import { RequestError, StateError } from "./errors"
import { parseExpoTurboDocument } from "./parser"
import { EXPO_TURBO_MIME_TYPE } from "./protocol-request"
import { RequestLifecycle } from "./request-lifecycle"
import { DocumentSession } from "./session"
import { dispatchTurboStreamFragment } from "./streams"

interface PendingRequest {
  readonly request: TurboRequest
  readonly reject: (reason?: unknown) => void
  readonly resolve: (response: TurboResponse) => void
}

interface TimerRecord {
  readonly callback: () => void
  cleared: boolean
  readonly delayMs: number
  readonly handle: object
}

class ManualClock implements ClockAdapter {
  readonly timers: TimerRecord[] = []

  clearTimeout(handle: unknown): void {
    const timer = this.timers.find((candidate) => candidate.handle === handle)
    if (timer) timer.cleared = true
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
    if (!timer.cleared) timer.callback()
  }
}

function response(xml: string, options: Partial<TurboResponse> = {}): TurboResponse {
  return {
    headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
    redirected: false,
    status: 200,
    text: async () => xml,
    url: "https://example.test/current",
    ...options,
  }
}

function harness(requestLifecycle?: RequestLifecycle) {
  const pending: PendingRequest[] = []
  const session = new DocumentSession(
    parseExpoTurboDocument('<Gallery><Old id="old"/><Later id="later"/></Gallery>', {
      url: "https://example.test/current",
    }),
  )
  let requestId = 0
  const loader = new DocumentRequestLoader(
    session,
    {
      fetch: (request) =>
        new Promise<TurboResponse>((resolve, reject) => {
          pending.push({ reject, request, resolve })
        }),
    },
    { next: () => `request-${++requestId}` },
    requestLifecycle ? { requestLifecycle } : {},
  )
  const clock = new ManualClock()
  const visits = new DocumentVisitController(loader, clock)
  const errors: Error[] = []
  const refresh = new DocumentRefreshController(session, visits, clock, {
    onError: (error) => errors.push(error),
  })
  return { clock, errors, pending, refresh, session, visits }
}

function terminalVisit(visits: DocumentVisitController): Promise<void> {
  return new Promise((resolve) => {
    const unsubscribe = visits.subscribe(() => {
      if (visits.state.status === "completed" || visits.state.status === "failed") {
        unsubscribe()
        resolve()
      }
    })
  })
}

class ReconnectVisitStub {
  private readonly listeners = new Set<() => void>()
  private status: DocumentVisitSnapshot["status"] = "initialized"

  get state(): DocumentVisitSnapshot {
    return Object.freeze({
      busy: this.status === "started",
      previewVisible: false,
      progressVisible: false,
      revision: 0,
      status: this.status,
    })
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  setStatus(status: DocumentVisitSnapshot["status"]): void {
    this.status = status
    for (const listener of [...this.listeners]) listener()
  }
}

describe("document refresh controller", () => {
  test("suppresses default refresh error reporting when fetch-error handling is prevented", async () => {
    const lifecycle = new RequestLifecycle()
    lifecycle.subscribe("fetch-request-error", (event) => event.preventDefault())
    const { clock, errors, pending, refresh, visits } = harness(lifecycle)
    const terminal = terminalVisit(visits)

    refresh.request({ baseUrl: "https://example.test/current" })
    clock.fire(0)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(pending).toHaveLength(1)
    pending[0]?.reject(new Error("secret transport failure"))
    await terminal
    await Promise.resolve()

    expect(visits.state.status).toBe("failed")
    expect(errors).toEqual([])
  })

  test("dispatches a plain refresh after Turbo's trailing debounce and ignores target content", async () => {
    const { clock, pending, refresh, session, visits } = harness()
    const report = await dispatchTurboStreamFragment(
      session,
      '<turbo-stream action="refresh" method="replace" target="missing"><template><Ignored/></template></turbo-stream>',
      { refresh },
    )

    expect(report.actions).toEqual([
      {
        action: "refresh",
        appliedTargets: 0,
        index: 0,
        matchedTargets: 0,
        status: "applied",
      },
    ])
    expect(clock.timers[0]?.delayMs).toBe(DOCUMENT_REFRESH_DEBOUNCE_MS)
    expect(pending).toHaveLength(0)

    clock.fire(0)
    expect(pending).toHaveLength(1)
    expect(pending[0]?.request).toMatchObject({
      method: "GET",
      url: "https://example.test/current",
    })
    expect(session.recentRequestIds.has("request-1")).toBe(true)

    const completed = terminalVisit(visits)
    pending[0]?.resolve(response('<Gallery><Fresh id="fresh"/></Gallery>'))
    await completed

    expect(visits.state.status).toBe("completed")
    expect(session.tree.getElementById("fresh")).toBeDefined()
    expect(session.tree.getElementById("old")).toBeUndefined()
  })

  test("uses replacement refresh semantics for every non-morph method value", async () => {
    const values = [undefined, "replace", "", "unknown", "MORPH"]

    for (const method of values) {
      const { clock, pending, refresh, session } = harness()
      const methodAttribute = method === undefined ? "" : ` method=${JSON.stringify(method)}`
      const report = await dispatchTurboStreamFragment(
        session,
        `<turbo-stream action="refresh"${methodAttribute}/>`,
        { refresh },
      )

      expect(report.actions[0]?.status).toBe("applied")
      expect(clock.timers).toHaveLength(1)
      clock.fire(0)
      expect(pending).toHaveLength(1)
      expect(pending[0]?.request.url).toBe("https://example.test/current")
    }
  })

  test("debounces to the latest refresh and suppresses a recent originating request at execution", async () => {
    const { clock, pending, refresh, session } = harness()

    await dispatchTurboStreamFragment(
      session,
      '<turbo-stream action="refresh" request-id="older"/>',
      {
        refresh,
      },
    )
    await dispatchTurboStreamFragment(
      session,
      '<turbo-stream action="refresh" request-id="originating"/>',
      { refresh },
    )
    session.recentRequestIds.add("originating")

    expect(clock.timers[0]?.cleared).toBe(true)
    clock.fire(0)
    clock.fire(1)
    expect(pending).toHaveLength(0)
  })

  test("does not interrupt an active visit or refresh a stale captured URL", async () => {
    const active = harness()
    const visiting = active.visits.visit("/slow")
    expect(active.pending).toHaveLength(1)

    await dispatchTurboStreamFragment(active.session, '<turbo-stream action="refresh"/>', {
      refresh: active.refresh,
    })
    active.clock.fire(1)
    expect(active.pending).toHaveLength(1)
    expect(active.pending[0]?.request.url).toBe("https://example.test/slow")

    active.pending[0]?.resolve(
      response('<Gallery><Visited id="visited"/></Gallery>', {
        url: "https://example.test/slow",
      }),
    )
    await visiting
    expect(active.session.tree.getElementById("visited")).toBeDefined()

    const stale = harness()
    await dispatchTurboStreamFragment(stale.session, '<turbo-stream action="refresh"/>', {
      refresh: stale.refresh,
    })
    stale.session.replaceTree(
      parseExpoTurboDocument('<Gallery><NewOwner id="new-owner"/></Gallery>', {
        url: "https://example.test/new-owner",
      }),
    )
    stale.clock.fire(0)
    expect(stale.pending).toHaveLength(0)
    expect(stale.session.tree.getElementById("new-owner")).toBeDefined()
  })

  test("accepts bounded morph and scroll policies while continuing later sibling actions", async () => {
    const { clock, refresh, session } = harness()
    const actionErrors: string[] = []
    const report = await dispatchTurboStreamFragment(
      session,
      `<turbo-stream action="refresh" method="morph"/>
       <turbo-stream action="refresh" scroll="preserve"/>
       <turbo-stream action="remove" target="later"/>`,
      { onActionError: (action) => actionErrors.push(action.error?.message ?? ""), refresh },
    )

    expect(report.actions.map((action) => action.status)).toEqual(["applied", "applied", "applied"])
    expect(actionErrors).toEqual([])
    expect(clock.timers).toHaveLength(2)
    expect(clock.timers[0]?.cleared).toBe(true)
    expect(session.tree.getElementById("later")).toBeUndefined()
  })

  test("preserves only exact refresh scroll=preserve and otherwise requests a reset", async () => {
    for (const [attribute, expected] of [
      ["", "reset"],
      [' scroll="preserve"', "preserve"],
      [' scroll="PRESERVE"', "reset"],
      [' scroll="unknown"', "reset"],
    ] as const) {
      const clock = new ManualClock()
      const session = new DocumentSession(
        parseExpoTurboDocument("<Gallery/>", { url: "https://example.test/current" }),
      )
      const calls: Array<readonly [string | undefined, string | undefined, string | undefined]> = []
      const refresh = new DocumentRefreshController(
        session,
        {
          refreshCurrent: async (url, method, scroll) => {
            calls.push([url, method, scroll])
            return undefined
          },
        },
        clock,
      )

      const report = await dispatchTurboStreamFragment(
        session,
        `<turbo-stream action="refresh"${attribute}/>`,
        { refresh },
      )
      expect(report.actions[0]?.status).toBe("applied")

      clock.fire(0)
      expect(calls).toEqual([["https://example.test/current", "replace", expected]])
    }
  })

  test("runs an exact Stream morph refresh through the identity-preserving document path", async () => {
    const { clock, pending, refresh, session, visits } = harness()
    const tree = session.tree
    const old = session.tree.getElementById("old")
    const oldIdentity = session.getNodeSnapshot("id:old")?.identity

    await dispatchTurboStreamFragment(session, '<turbo-stream action="refresh" method="morph"/>', {
      refresh,
    })
    clock.fire(0)
    const completed = terminalVisit(visits)
    pending[0]?.resolve(
      response('<Gallery><Old id="old" tone="after"/><Added id="added"/></Gallery>'),
    )
    await completed

    expect(visits.state.status).toBe("completed")
    expect(session.tree).toBe(tree)
    expect(session.tree.getElementById("old")).toBe(old)
    expect(session.getNodeSnapshot("id:old")?.identity).toBe(oldIdentity)
    expect(session.getNodeSnapshot("id:old")?.morphRevision).toBe(1)
    expect(session.tree.getElementById("old")?.attributes).toContainEqual({
      localName: "tone",
      name: "tone",
      namespaceUri: null,
      prefix: null,
      value: "after",
    })
    expect(session.tree.getElementById("added")).toBeDefined()
  })

  test("fails closed without an active refresh controller and after disposal", async () => {
    const { refresh, session } = harness()
    const missing = await dispatchTurboStreamFragment(session, '<turbo-stream action="refresh"/>')
    expect(missing.actions[0]?.status).toBe("error")
    expect(missing.actions[0]?.error?.message).toContain("requires a document refresh controller")

    refresh.dispose()
    expect(() => refresh.request({ baseUrl: "https://example.test/current" })).toThrow(StateError)
    expect(
      () =>
        new DocumentRefreshController(
          session,
          { refreshCurrent: async () => undefined },
          new ManualClock(),
          {
            debounceMs: -1,
          },
        ),
    ).toThrow(RequestError)
  })

  test("routes asynchronous refresh failures to the configured observer", async () => {
    const { clock, errors, pending, refresh, session } = harness()
    await dispatchTurboStreamFragment(session, '<turbo-stream action="refresh"/>', { refresh })
    clock.fire(0)
    pending[0]?.reject(new Error("private transport details"))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(errors).toHaveLength(1)
    expect(errors[0]).toBeInstanceOf(RequestError)
    expect(errors[0]?.message).toBe("Document request failed")
  })

  test("defers one reconnect reconciliation until the active visit settles", async () => {
    for (const status of ["completed", "failed", "canceled"] as const) {
      const visits = new ReconnectVisitStub()
      const requests: unknown[] = []
      const reconciler = new DocumentReconnectReconciler(
        { request: (request) => requests.push(request) },
        visits,
      )

      visits.setStatus("started")
      reconciler.request({ baseUrl: "https://example.test/older", scroll: "reset" })
      reconciler.request({ baseUrl: "https://example.test/current", scroll: "preserve" })
      expect(requests).toEqual([])

      visits.setStatus(status)
      expect(requests).toEqual([{ baseUrl: "https://example.test/current", scroll: "preserve" }])
      expect(Object.isFrozen(requests[0])).toBe(true)

      visits.setStatus(status)
      expect(requests).toHaveLength(1)
    }
  })

  test("drops a deferred reconnect reconciliation after disposal", async () => {
    const visits = new ReconnectVisitStub()
    const requests: unknown[] = []
    const reconciler = new DocumentReconnectReconciler(
      { request: (request) => requests.push(request) },
      visits,
    )

    visits.setStatus("started")
    reconciler.request({ baseUrl: "https://example.test/current", scroll: "preserve" })
    reconciler.dispose()
    visits.setStatus("completed")

    expect(requests).toEqual([])
    expect(() => reconciler.request({ baseUrl: "https://example.test/current" })).toThrow(
      StateError,
    )
  })

  test("waits through a reentrant newer visit before handing off once", async () => {
    const visits = new ReconnectVisitStub()
    const requests: unknown[] = []
    let startNewerVisit = true
    visits.subscribe(() => {
      if (!startNewerVisit || visits.state.status !== "completed") return
      startNewerVisit = false
      visits.setStatus("started")
    })
    const reconciler = new DocumentReconnectReconciler(
      { request: (request) => requests.push(request) },
      visits,
    )

    visits.setStatus("started")
    reconciler.request({ baseUrl: "https://example.test/current", scroll: "preserve" })
    visits.setStatus("completed")
    expect(requests).toEqual([])

    visits.setStatus("completed")
    expect(requests).toEqual([{ baseUrl: "https://example.test/current", scroll: "preserve" }])
  })

  test("redacts a deferred reconnect handoff failure", async () => {
    const visits = new ReconnectVisitStub()
    const errors: Error[] = []
    const reconciler = new DocumentReconnectReconciler(
      {
        request: () => {
          throw new Error("secret refresh transport details")
        },
      },
      visits,
      { onError: (error) => errors.push(error) },
    )

    visits.setStatus("started")
    reconciler.request({ baseUrl: "https://example.test/current", scroll: "preserve" })
    visits.setStatus("completed")

    expect(errors).toEqual([new RequestError("Document reconnect reconciliation failed")])
    expect(errors[0]?.cause).toBeUndefined()
  })
})
