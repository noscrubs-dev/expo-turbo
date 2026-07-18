import { describe, expect, test } from "bun:test"

import type {
  ClockAdapter,
  FetchAdapter,
  NavigationAdapter,
  TurboRequest,
  TurboResponse,
} from "../adapters"
import { DocumentCommitError, DocumentRequestLoader } from "./document-loader"
import { DocumentSnapshotCache } from "./document-snapshot-cache"
import {
  DOCUMENT_VISIT_PROGRESS_DELAY_MS,
  DocumentVisitController,
} from "./document-visit-controller"
import { ContentTypeError, ParseError, RequestError, TargetError } from "./errors"
import { EXPO_TURBO_MIME_TYPE } from "./frame-loader"
import { parseExpoTurboDocument } from "./parser"
import { DocumentSession } from "./session"
import { attributeValue } from "./tree"

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
    timer.callback()
  }
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
    documentXml?: string
    fetch?: FetchAdapter["fetch"]
    onObserverError?: (error: AggregateError) => void
    progressDelayMs?: number
    snapshotCache?: DocumentSnapshotCache
  }> = {},
) {
  const pending: PendingRequest[] = []
  const session = new DocumentSession(
    parseExpoTurboDocument(options.documentXml ?? '<Gallery><Old id="old" /></Gallery>', {
      url: "https://example.test/current",
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
  const clock = new ManualClock()
  const controller = new DocumentVisitController(loader, clock, {
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
      const { controller, pending, session } = harness({ snapshotCache })
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
      const snapshotCache = new DocumentSnapshotCache()
      const { clock, controller, session } = harness({
        fetch: fixture.fetch,
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
    }
  })

  test("cancels immediately and ignores every later request and timer callback", async () => {
    const snapshotCache = new DocumentSnapshotCache()
    const { clock, controller, pending, session } = harness({ snapshotCache })
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

    const retry = controller.visit("/retry")
    pending[1]?.resolve(
      response('<Gallery><Retry id="retry" /></Gallery>', {
        url: "https://example.test/retry",
      }),
    )
    expect(await retry).toMatchObject({ status: "committed" })
    expect(controller.state.status).toBe("completed")
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

  test("rejects replace and restore before changing document ownership", async () => {
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

    for (const action of ["replace", "restore"] as const) {
      await expect(controller.visit("/other", { action, navigation })).rejects.toBeInstanceOf(
        TargetError,
      )
    }

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

  test("refreshes exact current truth without exposing general replace-history visits", async () => {
    const snapshotCache = new DocumentSnapshotCache()
    const { controller, pending, session } = harness({
      documentXml: '<Gallery data-turbo-root="/app"><Old id="old" /></Gallery>',
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
    const navigationCalls: { action: string; url: string }[] = []
    const navigation: NavigationAdapter = {
      back() {},
      openExternal() {},
      visit: (url, action) => navigationCalls.push({ action, url }),
    }
    const { controller, pending, session } = harness({
      documentXml: '<Gallery data-turbo-root="/app"><Old id="old" /></Gallery>',
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
    expect(first.state.status).toBe("canceled")
    expect(pending[1]?.request.signal?.aborted).toBe(false)

    pending[0]?.resolve(
      response('<Gallery><First id="first" /></Gallery>', {
        url: "https://example.test/first",
      }),
    )
    expect(await firstVisit).toMatchObject({ status: "canceled" })
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
      const snapshotCache = new DocumentSnapshotCache()
      const { controller, pending, session } = harness({ snapshotCache })
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
