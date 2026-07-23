import { describe, expect, test } from "bun:test"

import type {
  ClockAdapter,
  NavigationAdapter,
  TurboRequest,
  TurboResponse,
  VisibilityAdapter,
} from "../adapters"
import {
  DocumentHistory,
  type DocumentHistoryEntry,
  type DocumentHistoryWriteMethod,
} from "./document-history"
import { DocumentRequestLoader } from "./document-loader"
import { DocumentSnapshotCache } from "./document-snapshot-cache"
import { DocumentVisitController } from "./document-visit-controller"
import { DocumentVisitLifecycle } from "./document-visit-lifecycle"
import { ContentTypeError, PropsError, RequestError, StateError, TargetError } from "./errors"
import { FormSubmissionController } from "./form-submission-controller"
import { FormControlRegistry } from "./forms"
import { FrameControllerRegistry } from "./frame-controller-registry"
import { FrameHistoryCoordinator, prepareFrameHistoryCommit } from "./frame-history"
import { visitFrameWithHistory } from "./frame-history-internal"
import { FrameLifecycle } from "./frame-lifecycle"
import { EXPO_TURBO_MIME_TYPE, FrameCommitError, FrameRequestLoader } from "./frame-loader"
import {
  acknowledgeFrameRender,
  frameRenderLifecycleRevision,
  retainFrameRenderer,
  subscribeFrameRenderLifecycle,
} from "./frame-render-lifecycle-internal"
import { parseExpoTurboDocument } from "./parser"
import { RequestLifecycle } from "./request-lifecycle"
import { DocumentSession } from "./session"
import { attributeValue, isElement } from "./tree"

// @ts-expect-error Frame history coordinators are constructor-issued nominal handles.
const forgedFrameHistoryCoordinator: FrameHistoryCoordinator = {}
void forgedFrameHistoryCoordinator

const clock: ClockAdapter = {
  clearTimeout: () => undefined,
  now: () => 0,
  setTimeout: () => Object.freeze({}),
}

function response(xml: string, options: Partial<TurboResponse> = {}): TurboResponse {
  return {
    headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
    redirected: false,
    status: 200,
    text: async () => xml,
    url: "https://example.test/frame",
    ...options,
  }
}

function frameDocument(child = "Old", frameAttributes = 'src="/old"'): string {
  return `<Gallery data-turbo-root="/">
    <Shell id="shell" phase="initial" />
    <DemoForm id="document-form" action="/submit-document" />
    <turbo-frame id="details" ${frameAttributes}><${child} /></turbo-frame>
  </Gallery>`
}

function historyHarness(
  fetchFrame: (request: TurboRequest) => Promise<TurboResponse>,
  write: (method: DocumentHistoryWriteMethod, entry: DocumentHistoryEntry) => undefined = () =>
    undefined,
  options: Readonly<{
    document?: string
    documentUrl?: string
    frameLifecycle?: FrameLifecycle
    frameHistory?: boolean
    navigation?: NavigationAdapter
    requestLifecycle?: RequestLifecycle
    snapshotCache?: boolean
    visitLifecycle?: DocumentVisitLifecycle
    visibility?: VisibilityAdapter
  }> = {},
) {
  const session = new DocumentSession(
    parseExpoTurboDocument(options.document ?? frameDocument(), {
      url: options.documentUrl ?? "https://example.test/current",
    }),
  )
  let identifier = 0
  const writes: Array<{ entry: DocumentHistoryEntry; method: DocumentHistoryWriteMethod }> = []
  const history = new DocumentHistory(
    { next: () => `frame-history-${++identifier}` },
    {
      write(method, entry) {
        writes.push({ entry, method })
        return write(method, entry)
      },
    },
  )
  const initial = history.initialize({
    entry: {
      restorationIdentifier: "initial-history",
      restorationIndex: 0,
      url: options.documentUrl ?? "https://example.test/current",
    },
    kind: "managed",
  }).entry
  const cache = new DocumentSnapshotCache()
  const frameRequests: TurboRequest[] = []
  let requestId = 0
  const loader = new FrameRequestLoader(
    session,
    {
      fetch: async (request) => {
        frameRequests.push(request)
        return fetchFrame(request)
      },
    },
    { next: () => `frame-request-${++requestId}` },
    {
      ...(options.frameLifecycle ? { frameLifecycle: options.frameLifecycle } : {}),
      ...(options.requestLifecycle ? { requestLifecycle: options.requestLifecycle } : {}),
    },
  )
  const frameHistory = new FrameHistoryCoordinator(session, {
    history,
    ...(options.navigation ? { navigation: options.navigation } : {}),
    ...(options.snapshotCache === false ? {} : { snapshotCache: cache }),
    ...(options.visitLifecycle ? { visitLifecycle: options.visitLifecycle } : {}),
  })
  const registry = new FrameControllerRegistry(
    session,
    loader,
    options.visibility,
    undefined,
    undefined,
    options.frameHistory === false ? {} : { frameHistory },
  )
  return { cache, frameHistory, frameRequests, history, initial, registry, session, writes }
}

describe("promoted Frame history", () => {
  test("leaves Frame history and snapshots to the automatic response visitor", async () => {
    const responseVisits: unknown[] = []
    const frameLifecycle = new FrameLifecycle({
      visitResponse(request) {
        responseVisits.push(request)
      },
    })
    const current = historyHarness(
      async ({ url }) =>
        response(
          '<Gallery data-turbo-visit-control="reload"><turbo-frame id="details"><Ignored /></turbo-frame></Gallery>',
          { url },
        ),
      undefined,
      { frameLifecycle },
    )

    await expect(
      current.registry.visit("/promoted", { action: "replace", frame: "details" }),
    ).resolves.toMatchObject({
      action: "replace",
      load: { reason: "visit-control-reload", status: "promoted" },
    })
    expect(responseVisits).toMatchObject([
      {
        action: "advance",
        frameId: "details",
        reason: "visit-control-reload",
        response: { status: 200, url: "https://example.test/promoted" },
      },
    ])
    expect(current.writes).toEqual([])
    expect(current.history.current).toBe(current.initial)
    expect(current.session.tree.document.url).toBe("https://example.test/current")
    expect(current.cache.size).toBe(0)
    expect(
      current.session.tree.getElementById("details")?.children.filter(isElement)[0]?.tagName,
    ).toBe("Old")
    expect(attributeValue(current.session.tree.getElementById("details") as never, "src")).toBe(
      "https://example.test/promoted",
    )
  })

  test("snapshots and validates the promoted Frame visit lifecycle", () => {
    const current = historyHarness(async ({ url }) => response("<Gallery />", { url }))
    const lifecycle = new DocumentVisitLifecycle()
    let reads = 0
    new FrameHistoryCoordinator(current.session, {
      history: current.history,
      get visitLifecycle() {
        reads += 1
        return lifecycle
      },
    })

    expect(reads).toBe(1)
    expect(
      () =>
        new FrameHistoryCoordinator(current.session, {
          history: current.history,
          visitLifecycle: {} as DocumentVisitLifecycle,
        }),
    ).toThrow(PropsError)
    expect(
      () =>
        new FrameHistoryCoordinator(current.session, {
          history: current.history,
          get visitLifecycle(): DocumentVisitLifecycle {
            throw new Error("sensitive lifecycle getter failure")
          },
        }),
    ).toThrow(PropsError)
  })

  test("promotes the first delayed lazy appearance using the live Frame action", async () => {
    const lifecycle = new DocumentVisitLifecycle()
    const visits: string[] = []
    lifecycle.subscribe("visit", (event) => {
      visits.push(`${event.detail.action}:${event.detail.url}`)
    })
    let visible = false
    let appearance: ((visible: boolean) => void) | undefined
    let unsubscribed = 0
    let resolveFrame: ((response: TurboResponse) => void) | undefined
    const visibility: VisibilityAdapter = {
      isVisible: () => visible,
      subscribe(frameId, listener) {
        expect(frameId).toBe("details")
        appearance = listener
        return () => {
          unsubscribed += 1
        }
      },
    }
    const current = historyHarness(
      () =>
        new Promise<TurboResponse>((resolve) => {
          resolveFrame = resolve
        }),
      undefined,
      {
        document: frameDocument("Old", 'src="/stale-lazy" loading="lazy"'),
        visitLifecycle: lifecycle,
        visibility,
      },
    )
    const controller = current.registry.get("details")

    expect(await controller.connect()).toBeUndefined()
    expect(current.frameRequests).toHaveLength(0)
    expect(current.writes).toHaveLength(0)
    expect(current.cache.size).toBe(0)

    current.session.setAttribute("id:shell", "phase", "before-visible")
    current.session.setAttribute("id:details", "src", "/lazy")
    current.session.setAttribute("id:details", "data-turbo-action", "advance")
    const firstAppearance = appearance
    visible = true
    firstAppearance?.(true)

    expect(current.frameRequests).toHaveLength(1)
    expect(current.writes).toHaveLength(0)
    expect(unsubscribed).toBe(1)
    expect(attributeValue(current.session.tree.getElementById("details") as never, "src")).toBe(
      "https://example.test/lazy",
    )

    current.session.setAttribute("id:shell", "phase", "after-visible")
    const request = current.frameRequests[0]
    if (!request || !resolveFrame) throw new Error("lazy Frame request was not captured")
    resolveFrame(
      response('<turbo-frame id="details"><Visible /></turbo-frame>', { url: request.url }),
    )
    expect(await controller.loaded).toMatchObject({ status: "completed" })

    expect(current.writes).toEqual([
      {
        entry: {
          restorationIdentifier: "frame-history-1",
          restorationIndex: 1,
          url: "https://example.test/lazy",
        },
        method: "push",
      },
    ])
    expect(current.session.tree.document.url).toBe("https://example.test/lazy")
    expect(
      current.session.tree.getElementById("details")?.children.filter(isElement)[0]?.tagName,
    ).toBe("Visible")
    const outgoing = current.cache.get("https://example.test/current")
    expect(attributeValue(outgoing?.getElementById("shell") as never, "phase")).toBe(
      "before-visible",
    )
    expect(attributeValue(outgoing?.getElementById("details") as never, "src")).toBe("/lazy")
    expect(visits).toEqual(["advance:https://example.test/lazy"])

    firstAppearance?.(true)
    await Promise.resolve()
    expect(current.frameRequests).toHaveLength(1)
    expect(current.writes).toHaveLength(1)
  })

  test("emits one final redirected visit after a matching error Frame is committed", async () => {
    const lifecycle = new DocumentVisitLifecycle()
    const events: string[] = []
    const current = historyHarness(
      async () =>
        response('<turbo-frame id="details"><Handled /></turbo-frame>', {
          redirected: true,
          status: 422,
          url: "https://example.test/final",
        }),
      undefined,
      { visitLifecycle: lifecycle },
    )
    const controller = current.registry.get("details")
    const expectCommittedState = () => {
      expect(current.history.current?.url).toBe("https://example.test/final")
      expect(current.session.tree.document.url).toBe("https://example.test/final")
      expect(
        current.session.tree.getElementById("details")?.children.filter(isElement)[0]?.tagName,
      ).toBe("Handled")
      expect(controller.state.status).toBe("completed")
    }
    lifecycle.subscribe("before-visit", (event) => {
      expect(event.detail.url).toBe("https://example.test/final")
      expectCommittedState()
      events.push(`before:${event.detail.url}`)
    })
    lifecycle.subscribe("visit", (event) => {
      expectCommittedState()
      events.push(`visit:${event.detail.action}:${event.detail.url}`)
    })

    await expect(
      current.registry.visit("/requested", { action: "replace", frame: "details" }),
    ).resolves.toMatchObject({
      action: "replace",
      load: { responseStatus: 422, status: "completed", url: "https://example.test/final" },
    })
    expect(events).toEqual([
      "before:https://example.test/final",
      "visit:replace:https://example.test/final",
    ])
  })

  test("lets before-visit suppress notification without rolling back the promoted Frame", async () => {
    const lifecycle = new DocumentVisitLifecycle()
    const events: string[] = []
    lifecycle.subscribe("before-visit", (event) => {
      events.push(`before:${event.detail.url}`)
      event.preventDefault()
    })
    lifecycle.subscribe("visit", () => {
      events.push("visit")
    })
    const current = historyHarness(
      async ({ url }) => response('<turbo-frame id="details"><Prevented /></turbo-frame>', { url }),
      undefined,
      { visitLifecycle: lifecycle },
    )

    await expect(
      current.registry.visit("/prevented", { action: "advance", frame: "details" }),
    ).resolves.toMatchObject({ action: "advance", load: { status: "completed" } })
    expect(events).toEqual(["before:https://example.test/prevented"])
    expect(current.history.current?.url).toBe("https://example.test/prevented")
    expect(current.session.tree.document.url).toBe("https://example.test/prevented")
    expect(
      current.session.tree.getElementById("details")?.children.filter(isElement)[0]?.tagName,
    ).toBe("Prevented")
    expect(current.registry.get("details").state.status).toBe("completed")
  })

  test("reports redacted committed truth when promoted Frame before-visit fails", async () => {
    const lifecycle = new DocumentVisitLifecycle()
    lifecycle.subscribe("before-visit", () => {
      throw new Error("sensitive promoted Frame listener failure")
    })
    const current = historyHarness(
      async ({ url }) =>
        response('<turbo-frame id="details"><ListenerFailed /></turbo-frame>', { url }),
      undefined,
      { visitLifecycle: lifecycle },
    )
    const controller = current.registry.get("details")
    const errors: Error[] = []
    controller.subscribeErrors((error) => errors.push(error))

    let failure: unknown
    try {
      await current.registry.visit("/listener-failed", {
        action: "advance",
        frame: "details",
      })
    } catch (error) {
      failure = error
    }

    expect(failure).toBeInstanceOf(FrameCommitError)
    expect(JSON.stringify(failure)).not.toContain("sensitive")
    expect(errors).toHaveLength(1)
    expect(errors[0]).toBeInstanceOf(FrameCommitError)
    expect(controller.state).toMatchObject({ complete: true, status: "completed" })
    expect(current.history.current?.url).toBe("https://example.test/listener-failed")
    expect(current.session.tree.document.url).toBe("https://example.test/listener-failed")
    expect(
      current.session.tree.getElementById("details")?.children.filter(isElement)[0]?.tagName,
    ).toBe("ListenerFailed")
  })

  test("settles Frame visual lifecycle after promoted history finalization fails", async () => {
    const visitLifecycle = new DocumentVisitLifecycle()
    visitLifecycle.subscribe("before-visit", () => {
      events.push("before-visit")
      throw new Error("sensitive promoted Frame listener failure")
    })
    const frameLifecycle = new FrameLifecycle()
    const events: string[] = []
    frameLifecycle.subscribe("frame-render", () => {
      events.push("render")
    })
    frameLifecycle.subscribe("frame-load", () => {
      events.push("load")
    })
    const current = historyHarness(
      async ({ url }) =>
        response('<turbo-frame id="details"><ListenerFailed /></turbo-frame>', { url }),
      undefined,
      { frameLifecycle, visitLifecycle },
    )
    const frame = current.session.tree.getElementById("details")
    if (frame?.kind !== "frame") throw new Error("Frame fixture is missing")
    const releaseRenderer = retainFrameRenderer(current.session, frame)
    let lifecycleRevision = frameRenderLifecycleRevision(current.session)
    const unsubscribe = subscribeFrameRenderLifecycle(current.session, () => {
      if (frameRenderLifecycleRevision(current.session) <= lifecycleRevision) return
      lifecycleRevision = frameRenderLifecycleRevision(current.session)
      acknowledgeFrameRender(current.session, frame, "details", current.session.revision)?.finish()
    })
    const controller = current.registry.get("details")

    await expect(
      current.registry.visit("/listener-failed-visual", {
        action: "advance",
        frame: "details",
      }),
    ).rejects.toBeInstanceOf(FrameCommitError)

    expect(events).toEqual(["render", "load", "before-visit"])
    expect(controller.state).toMatchObject({ busy: false, complete: true, status: "completed" })

    unsubscribe()
    releaseRenderer()
  })

  test("freezes the initial relative Turbo root while awaiting outside-root navigation", async () => {
    const lifecycle = new DocumentVisitLifecycle()
    const events: string[] = []
    const navigationCalls: Array<{ action: string; url: string }> = []
    let navigationStarted: (() => void) | undefined
    let releaseNavigation: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      navigationStarted = resolve
    })
    const released = new Promise<void>((resolve) => {
      releaseNavigation = resolve
    })
    const navigation: NavigationAdapter = {
      back() {},
      openExternal() {},
      async visit(url, action) {
        navigationCalls.push({ action, url })
        navigationStarted?.()
        await released
      },
    }
    lifecycle.subscribe("before-visit", (event) => {
      events.push(`before:${event.detail.url}`)
    })
    lifecycle.subscribe("visit", () => {
      events.push("visit")
    })
    const current = historyHarness(
      async () =>
        response('<turbo-frame id="details"><Outside /></turbo-frame>', {
          redirected: true,
          url: "https://example.test/outside",
        }),
      undefined,
      {
        document: frameDocument("Old", 'src="/app/old" data-turbo-action="advance"').replace(
          'data-turbo-root="/"',
          'data-turbo-root="./"',
        ),
        documentUrl: "https://example.test/app/current",
        navigation,
        visitLifecycle: lifecycle,
      },
    )

    let settled = false
    const visiting = current.registry
      .visit("/app/requested", { action: "advance", frame: "details" })
      .finally(() => {
        settled = true
      })
    await started

    expect(settled).toBe(false)
    expect(events).toEqual(["before:https://example.test/outside"])
    expect(navigationCalls).toEqual([{ action: "advance", url: "https://example.test/outside" }])
    expect(current.history.current?.url).toBe("https://example.test/outside")
    expect(current.session.tree.document.url).toBe("https://example.test/outside")
    expect(
      current.session.tree.getElementById("details")?.children.filter(isElement)[0]?.tagName,
    ).toBe("Outside")
    expect(current.registry.get("details").state.status).toBe("completed")

    releaseNavigation?.()
    await expect(visiting).resolves.toMatchObject({ load: { status: "completed" } })
    expect(events).toEqual(["before:https://example.test/outside"])
  })

  for (const supersession of ["document", "frame", "disconnect"] as const) {
    test(`settles pending promoted navigation on ${supersession} supersession and consumes its late rejection`, async () => {
      let navigationStartedResolve: (() => void) | undefined
      const navigationStarted = new Promise<void>((resolve) => {
        navigationStartedResolve = resolve
      })
      let rejectNavigation: ((error: Error) => void) | undefined
      const pendingNavigation = new Promise<void>((_resolve, reject) => {
        rejectNavigation = reject
      })
      const navigation: NavigationAdapter = {
        back() {},
        openExternal() {},
        visit() {
          navigationStartedResolve?.()
          return pendingNavigation
        },
      }
      let frameRequestCount = 0
      let resolveNewFrame: ((response: TurboResponse) => void) | undefined
      const current = historyHarness(
        async () => {
          frameRequestCount += 1
          if (frameRequestCount === 1) {
            return response('<turbo-frame id="details"><Committed /></turbo-frame>', {
              redirected: true,
              url: "https://example.test/outside",
            })
          }
          return new Promise<TurboResponse>((resolve) => {
            resolveNewFrame = resolve
          })
        },
        undefined,
        {
          document: frameDocument("Old", 'src="/current/old"').replace(
            'data-turbo-root="/"',
            'data-turbo-root="/current"',
          ),
          navigation,
        },
      )
      const controller = current.registry.get("details")
      const visiting = current.registry.visit("/current/requested", {
        action: "advance",
        frame: "details",
      })
      await navigationStarted

      let superseding: Promise<unknown> | undefined
      let documentRequest: TurboRequest | undefined
      let resolveDocument: ((response: TurboResponse) => void) | undefined
      if (supersession === "document") {
        const documentController = new DocumentVisitController(
          new DocumentRequestLoader(
            current.session,
            {
              fetch(request) {
                documentRequest = request
                return new Promise<TurboResponse>((resolve) => {
                  resolveDocument = resolve
                })
              },
            },
            { next: () => "newer-document" },
          ),
          clock,
          { history: current.history, snapshotCache: current.cache },
        )
        superseding = documentController.visit("/current/newer-document")
      } else if (supersession === "frame") {
        superseding = controller.visit("/current/newer-frame")
      } else {
        controller.disconnect()
      }

      await expect(visiting).resolves.toMatchObject({ load: { status: "completed" } })
      rejectNavigation?.(new Error("sensitive late navigation failure"))
      await Promise.resolve()
      await Promise.resolve()

      if (supersession === "document") {
        if (!superseding || !documentRequest || !resolveDocument) {
          throw new Error("newer document request did not start")
        }
        resolveDocument(
          response('<Gallery data-turbo-root="/current"><NewerDocument /></Gallery>', {
            url: documentRequest.url,
          }),
        )
        await expect(superseding).resolves.toMatchObject({ status: "committed" })
      } else if (supersession === "frame") {
        const request = current.frameRequests[1]
        if (!superseding || !request || !resolveNewFrame) {
          throw new Error("newer Frame request did not start")
        }
        resolveNewFrame(
          response('<turbo-frame id="details"><NewerFrame /></turbo-frame>', {
            url: request.url,
          }),
        )
        await expect(superseding).resolves.toMatchObject({ status: "completed" })
      }
    })
  }

  test("preserves a committed Stream error when completion publication also fails", async () => {
    const lifecycle = new DocumentVisitLifecycle()
    const events: string[] = []
    lifecycle.subscribe("before-visit", () => {
      events.push("before")
    })
    lifecycle.subscribe("visit", () => {
      events.push("visit")
    })
    const current = historyHarness(
      async ({ url }) =>
        response(
          `<turbo-frame id="details">
             <CommittedFrame id="committed-frame" />
             <turbo-stream action="update" target="stream-target">
               <template><CommittedStream id="committed-stream" /></template>
             </turbo-stream>
           </turbo-frame>`,
          { url },
        ),
      undefined,
      {
        document: `<Gallery data-turbo-root="/">
          <Shell id="shell" />
          <List id="stream-target"><OldStream id="old-stream" /></List>
          <turbo-frame id="details" src="/old"><OldFrame /></turbo-frame>
        </Gallery>`,
        visitLifecycle: lifecycle,
      },
    )
    const removed = current.session.tree.getElementById("old-stream")
    if (!removed) throw new Error("embedded Stream failure fixture is incomplete")
    current.session.registerDisposal(removed.key, () => {
      throw new Error("sensitive embedded Stream disposal failure")
    })
    const controller = current.registry.get("details")
    const errors: Error[] = []
    controller.subscribeErrors((error) => errors.push(error))
    const unsubscribe = controller.subscribe(() => {
      if (controller.state.status === "completed") {
        throw new Error("sensitive rejection publication failure")
      }
    })

    let failure: unknown
    try {
      await current.registry.visit("/committed-stream-error", {
        action: "advance",
        frame: "details",
      })
    } catch (error) {
      failure = error
    }

    expect(failure).toBeInstanceOf(FrameCommitError)
    expect(JSON.stringify(failure)).not.toContain("sensitive")
    expect(events).toEqual([])
    expect(errors).toHaveLength(1)
    if (!(failure instanceof Error)) throw new Error("Expected a committed Frame failure")
    expect(errors[0]).toBe(failure)
    expect(controller.state).toMatchObject({ complete: true, status: "completed" })
    expect(current.history.current?.url).toBe("https://example.test/committed-stream-error")
    expect(current.session.tree.document.url).toBe("https://example.test/committed-stream-error")
    expect(current.session.tree.getElementById("committed-frame")).toBeDefined()
    expect(current.session.tree.getElementById("committed-stream")).toBeDefined()

    unsubscribe()
    await expect(
      current.registry.visit("/recovered-after-committed-error", {
        action: "replace",
        frame: "details",
      }),
    ).resolves.toMatchObject({ load: { status: "completed" } })
    expect(events).toEqual(["before", "visit"])
    expect(errors).toEqual([failure])
  })

  test("reports one redacted committed error when completion publication fails", async () => {
    const lifecycle = new DocumentVisitLifecycle()
    const events: string[] = []
    lifecycle.subscribe("before-visit", () => {
      events.push("before")
    })
    lifecycle.subscribe("visit", () => {
      events.push("visit")
    })
    let requestCount = 0
    const current = historyHarness(
      async ({ url }) => {
        requestCount += 1
        return response(
          `<turbo-frame id="details"><Committed id="committed-${requestCount}" /></turbo-frame>`,
          { url },
        )
      },
      undefined,
      { visitLifecycle: lifecycle },
    )
    const controller = current.registry.get("details")
    const errors: Error[] = []
    controller.subscribeErrors((error) => errors.push(error))
    const unsubscribe = controller.subscribe(() => {
      if (controller.state.status === "completed") {
        throw new Error("sensitive completion observer failure")
      }
    })

    let failure: unknown
    try {
      await current.registry.visit("/completion-failed", {
        action: "advance",
        frame: "details",
      })
    } catch (error) {
      failure = error
    }

    expect(failure).toBeInstanceOf(FrameCommitError)
    if (!(failure instanceof Error)) throw new Error("Expected a committed Frame failure")
    expect(JSON.stringify(failure)).not.toContain("sensitive")
    expect(errors).toEqual([failure])
    expect(events).toEqual([])
    expect(controller.state).toMatchObject({ complete: true, status: "completed" })
    expect(current.history.current?.url).toBe("https://example.test/completion-failed")
    expect(current.session.tree.getElementById("committed-1")).toBeDefined()

    unsubscribe()
    await expect(
      current.registry.visit("/recovered", { action: "replace", frame: "details" }),
    ).resolves.toMatchObject({ load: { status: "completed" } })
    expect(events).toEqual(["before", "visit"])
    expect(errors).toEqual([failure])
    expect(current.history.current?.url).toBe("https://example.test/recovered")
    expect(current.session.tree.getElementById("committed-2")).toBeDefined()
  })

  test("reports committed truth when promoted outside-root navigation is unavailable", async () => {
    for (const fixtureCase of ["missing", "rejecting"] as const) {
      const lifecycle = new DocumentVisitLifecycle()
      const events: string[] = []
      const navigationCalls: string[] = []
      let navigationSettled = false
      lifecycle.subscribe("before-visit", (event) => {
        events.push(`before:${event.detail.url}`)
      })
      lifecycle.subscribe("visit", () => {
        events.push("visit")
      })
      const navigation: NavigationAdapter | undefined =
        fixtureCase === "rejecting"
          ? {
              back() {},
              openExternal() {},
              async visit(url) {
                navigationCalls.push(url)
                await Promise.resolve()
                navigationSettled = true
                throw new Error("sensitive promoted navigation rejection")
              },
            }
          : undefined
      const current = historyHarness(
        async () =>
          response(
            `<turbo-frame id="details"><Outside id="outside-${fixtureCase}" /></turbo-frame>`,
            {
              redirected: true,
              url: "https://example.test/outside",
            },
          ),
        undefined,
        {
          document: frameDocument("Old", 'src="/current/old" data-turbo-action="advance"').replace(
            'data-turbo-root="/"',
            'data-turbo-root="/current"',
          ),
          ...(navigation ? { navigation } : {}),
          visitLifecycle: lifecycle,
        },
      )
      const controller = current.registry.get("details")
      const errors: Error[] = []
      controller.subscribeErrors((error) => errors.push(error))

      let failure: unknown
      try {
        await current.registry.visit("/current/requested", {
          action: "advance",
          frame: "details",
        })
      } catch (error) {
        failure = error
      }

      expect(failure).toBeInstanceOf(FrameCommitError)
      if (!(failure instanceof Error)) throw new Error("Expected a committed Frame failure")
      expect(JSON.stringify(failure)).not.toContain("sensitive")
      expect(events).toEqual(["before:https://example.test/outside"])
      expect(navigationCalls).toEqual(
        fixtureCase === "rejecting" ? ["https://example.test/outside"] : [],
      )
      expect(navigationSettled).toBe(fixtureCase === "rejecting")
      expect(errors).toHaveLength(1)
      expect(errors[0]).toBe(failure)
      expect(controller.state).toMatchObject({ complete: true, status: "completed" })
      expect(current.history.current?.url).toBe("https://example.test/outside")
      expect(current.session.tree.document.url).toBe("https://example.test/outside")
      expect(current.session.tree.getElementById(`outside-${fixtureCase}`)).toBeDefined()
    }
  })

  test("suppresses a stale promoted visit when before-visit starts newer document work", async () => {
    const lifecycle = new DocumentVisitLifecycle()
    const visits: string[] = []
    let documentController: DocumentVisitController
    let newerDocument: Promise<unknown> | undefined
    let resolveDocument: ((response: TurboResponse) => void) | undefined
    lifecycle.subscribe("before-visit", (event) => {
      if (event.detail.url.endsWith("/promoted")) {
        newerDocument = documentController.visit("/newer")
      }
    })
    lifecycle.subscribe("visit", (event) => {
      visits.push(event.detail.url)
    })
    const current = historyHarness(
      async ({ url }) => response('<turbo-frame id="details"><Promoted /></turbo-frame>', { url }),
      undefined,
      { visitLifecycle: lifecycle },
    )
    documentController = new DocumentVisitController(
      new DocumentRequestLoader(
        current.session,
        {
          fetch: () =>
            new Promise<TurboResponse>((resolve) => {
              resolveDocument = resolve
            }),
        },
        { next: () => "document-request" },
      ),
      clock,
      { history: current.history, snapshotCache: current.cache },
    )

    await expect(
      current.registry.visit("/promoted", { action: "advance", frame: "details" }),
    ).resolves.toMatchObject({ load: { status: "completed" } })
    expect(visits).toEqual([])
    if (!newerDocument || !resolveDocument) {
      throw new Error("reentrant document visit did not start")
    }
    resolveDocument(
      response('<Gallery data-turbo-root="/"><Newer id="newer" /></Gallery>', {
        url: "https://example.test/newer",
      }),
    )
    await expect(newerDocument).resolves.toMatchObject({ status: "committed" })
    expect(current.session.tree.getElementById("newer")).toBeDefined()
    expect(current.session.tree.getElementById("details")).toBeUndefined()
  })

  test("suppresses an old promoted GET visit when before-visit starts a same-Frame form", async () => {
    const lifecycle = new DocumentVisitLifecycle()
    const visits: string[] = []
    const current = historyHarness(
      async ({ url }) =>
        response(
          '<turbo-frame id="details"><DemoForm id="replacement-form" action="/submit-replacement" /></turbo-frame>',
          { url },
        ),
      undefined,
      { visitLifecycle: lifecycle },
    )
    let resolveForm: ((response: TurboResponse) => void) | undefined
    let formRequest: TurboRequest | undefined
    let formSubmission: Promise<unknown> | undefined
    const formController = new FormSubmissionController(current.session, {
      fetch(request) {
        formRequest = request
        return new Promise<TurboResponse>((resolve) => {
          resolveForm = resolve
        })
      },
    })
    lifecycle.subscribe("before-visit", (event) => {
      if (!event.detail.url.endsWith("/promoted-form")) return
      const form = current.session.tree.getElementById("replacement-form")
      if (!form) throw new Error("committed same-Frame form is missing")
      const controls = new FormControlRegistry(current.session, form.key)
      formSubmission = formController.submit((signal) =>
        controls.submissionProposal({ protocol: { requestId: "replacement-form" }, signal }),
      )
    })
    lifecycle.subscribe("visit", (event) => {
      visits.push(event.detail.url)
    })

    await expect(
      current.registry.visit("/promoted-form", { action: "advance", frame: "details" }),
    ).resolves.toMatchObject({ load: { status: "completed" } })

    expect(visits).toEqual([])
    expect(formRequest?.url).toBe("https://example.test/submit-replacement")
    if (!formSubmission || !formRequest || !resolveForm) {
      throw new Error("same-Frame form submission did not start")
    }
    resolveForm(response("", { status: 204, url: formRequest.url }))
    await expect(formSubmission).resolves.toMatchObject({ status: "empty" })
  })

  test("promotes an immediately visible lazy replacement with the mounted Frame scope", async () => {
    const visibility: VisibilityAdapter = {
      isVisible: () => false,
      subscribe(_frameId, listener) {
        listener(true)
        return () => undefined
      },
    }
    const current = historyHarness(
      async ({ url }) => response('<turbo-frame id="details"><Lazy /></turbo-frame>', { url }),
      undefined,
      {
        document: frameDocument("Old", 'src="/lazy" loading="lazy" data-turbo-action="replace"'),
        visibility,
      },
    )
    const controller = current.registry.get("details")

    expect(await controller.connect()).toMatchObject({ status: "completed" })
    await current.registry.visit("/explicit", { action: "advance", frame: "details" })

    expect(current.writes).toEqual([
      {
        entry: {
          restorationIdentifier: "frame-history-1",
          restorationIndex: 0,
          url: "https://example.test/lazy",
        },
        method: "replace",
      },
      {
        entry: {
          restorationIdentifier: "frame-history-1",
          restorationIndex: 1,
          url: "https://example.test/explicit",
        },
        method: "push",
      },
    ])
  })

  test("keeps invalid lazy actions history-neutral", async () => {
    const visibility: VisibilityAdapter = {
      isVisible: () => true,
      subscribe: () => () => undefined,
    }
    const current = historyHarness(
      async ({ url }) => response('<turbo-frame id="details"><Ordinary /></turbo-frame>', { url }),
      undefined,
      {
        document: frameDocument(
          "Old",
          'src="/ordinary" loading="lazy" data-turbo-action="Advance"',
        ),
        visibility,
      },
    )

    expect(await current.registry.get("details").connect()).toMatchObject({ status: "completed" })
    expect(current.frameRequests).toHaveLength(1)
    expect(current.writes).toHaveLength(0)
    expect(current.cache.size).toBe(0)
    expect(current.session.tree.document.url).toBe("https://example.test/current")
  })

  test("fails unsupported lazy promotions once before request ownership", async () => {
    for (const fixtureCase of [
      {
        action: "restore",
        error: TargetError,
        frameHistory: true,
        name: "restore",
        source: "/restore",
      },
      {
        action: "advance",
        error: TargetError,
        frameHistory: false,
        name: "missing-coordinator",
        source: "/missing-coordinator",
      },
      {
        action: "advance",
        error: TargetError,
        frameHistory: true,
        name: "unvisitable",
        source: "/archive.pdf",
      },
      {
        action: "advance",
        error: StateError,
        frameHistory: true,
        name: "history-drift",
        source: "/drift",
      },
    ] as const) {
      let appearance: ((visible: boolean) => void) | undefined
      let unsubscribed = 0
      const visibility: VisibilityAdapter = {
        isVisible: () => true,
        subscribe(_frameId, listener) {
          appearance = listener
          return () => {
            unsubscribed += 1
          }
        },
      }
      const current = historyHarness(
        async () => {
          throw new Error("unsupported lazy promotion fetched")
        },
        undefined,
        {
          document: frameDocument(
            "Old",
            `src="${fixtureCase.source}" loading="lazy" data-turbo-action="${fixtureCase.action}"`,
          ),
          frameHistory: fixtureCase.frameHistory,
          visibility,
        },
      )
      if (fixtureCase.name === "history-drift") {
        current.history.adoptTraversal({
          restorationIdentifier: "drifted-history",
          restorationIndex: 1,
          url: "https://example.test/drifted",
        })
      }
      const controller = current.registry.get("details")
      const errors: Error[] = []
      controller.subscribeErrors((error) => errors.push(error))

      await expect(controller.connect()).rejects.toBeInstanceOf(fixtureCase.error)
      expect(controller.state).toMatchObject({ connected: true, status: "error" })
      expect(current.frameRequests).toHaveLength(0)
      expect(current.writes).toHaveLength(0)
      expect(current.cache.size).toBe(0)
      expect(errors).toHaveLength(1)
      expect(unsubscribed).toBe(1)

      appearance?.(true)
      await Promise.resolve()
      expect(current.frameRequests).toHaveLength(0)
      expect(errors).toHaveLength(1)
    }
  })

  test("reuses one Frame restoration identifier across push, same-URL push, and replace", async () => {
    let request = 0
    const current = historyHarness(async ({ url }) => {
      request += 1
      const child = request === 1 ? "One" : request === 2 ? "OneAgain" : "Final"
      return response(`<turbo-frame id="details"><${child} /></turbo-frame>`, {
        redirected: request === 3,
        url: request === 3 ? "https://example.test/final" : url,
      })
    })

    const first = await current.registry.visit("/one", { action: "advance", frame: "details" })
    const repeated = await current.registry.visit("/one", {
      action: "advance",
      frame: "details",
    })
    const replaced = await current.registry.visit("/two", {
      action: "replace",
      frame: "details",
    })

    expect(first).toMatchObject({ action: "advance", kind: "frame" })
    expect(repeated).toMatchObject({ action: "advance", kind: "frame" })
    expect(replaced).toMatchObject({ action: "replace", kind: "frame" })
    expect(current.writes).toEqual([
      {
        entry: {
          restorationIdentifier: "frame-history-1",
          restorationIndex: 1,
          url: "https://example.test/one",
        },
        method: "push",
      },
      {
        entry: {
          restorationIdentifier: "frame-history-1",
          restorationIndex: 2,
          url: "https://example.test/one",
        },
        method: "push",
      },
      {
        entry: {
          restorationIdentifier: "frame-history-1",
          restorationIndex: 2,
          url: "https://example.test/final",
        },
        method: "replace",
      },
    ])
    expect(current.history.current).toBe(current.writes[2]?.entry)
    const frame = current.session.tree.getElementById("details")
    expect(attributeValue(frame as never, "src")).toBe("https://example.test/final")
    expect(frame?.children.filter(isElement)[0]?.tagName).toBe("Final")
    expect(current.session.tree.document.url).toBe("https://example.test/final")
    expect(
      current.cache
        .get("https://example.test/current")
        ?.getElementById("details")
        ?.children.filter(isElement)[0]?.tagName,
    ).toBe("Old")
    expect(
      current.cache
        .get("https://example.test/one")
        ?.getElementById("details")
        ?.children.filter(isElement)[0]?.tagName,
    ).toBe("OneAgain")
  })

  test("shares one mounted Frame restoration scope across form and GET promotions", async () => {
    const current = historyHarness(
      async ({ url }) => response('<turbo-frame id="details"><AfterGet /></turbo-frame>', { url }),
      undefined,
      {
        document: `<Gallery data-turbo-root="/">
          <turbo-frame id="details" src="/old">
            <DemoForm id="frame-form" action="/submit" data-turbo-action="advance" />
          </turbo-frame>
        </Gallery>`,
      },
    )
    current.registry.get("details")
    const form = current.session.tree.getElementById("frame-form")
    if (!form) throw new Error("fixture Frame form is missing")
    const controls = new FormControlRegistry(current.session, form.key)
    const formController = new FormSubmissionController(
      current.session,
      {
        fetch: async (request) =>
          response('<turbo-frame id="details"><AfterForm /></turbo-frame>', {
            url: request.url,
          }),
      },
      { frameControllers: current.registry, snapshotCache: current.cache },
    )

    await expect(
      formController.submit((signal) =>
        controls.submissionProposal({ protocol: { requestId: "form-request" }, signal }),
      ),
    ).resolves.toMatchObject({ application: "frame", status: "applied" })
    await expect(
      current.registry.visit("/after-get", { action: "advance", frame: "details" }),
    ).resolves.toMatchObject({ action: "advance", kind: "frame" })

    expect(current.writes).toEqual([
      {
        entry: {
          restorationIdentifier: "frame-history-1",
          restorationIndex: 1,
          url: "https://example.test/submit",
        },
        method: "push",
      },
      {
        entry: {
          restorationIdentifier: "frame-history-1",
          restorationIndex: 2,
          url: "https://example.test/after-get",
        },
        method: "push",
      },
    ])
  })

  test("commits independent promoted Frames in response-completion order", async () => {
    let resolveOne: ((response: TurboResponse) => void) | undefined
    let resolveTwo: ((response: TurboResponse) => void) | undefined
    const session = new DocumentSession(
      parseExpoTurboDocument(
        `<Gallery data-turbo-root="/">
          <turbo-frame id="one" src="/old-one"><OldOne /></turbo-frame>
          <turbo-frame id="two" src="/old-two"><OldTwo /></turbo-frame>
        </Gallery>`,
        { url: "https://example.test/current" },
      ),
    )
    let identifier = 0
    const writes: Array<{ entry: DocumentHistoryEntry; method: DocumentHistoryWriteMethod }> = []
    const history = new DocumentHistory(
      { next: () => `frame-history-${++identifier}` },
      {
        write(method, entry) {
          writes.push({ entry, method })
        },
      },
    )
    history.initialize({
      entry: {
        restorationIdentifier: "initial-history",
        restorationIndex: 0,
        url: "https://example.test/current",
      },
      kind: "managed",
    })
    const loader = new FrameRequestLoader(
      session,
      {
        fetch: ({ url }) =>
          new Promise<TurboResponse>((resolve) => {
            if (url.endsWith("/one")) resolveOne = resolve
            else resolveTwo = resolve
          }),
      },
      { next: () => "frame-request" },
    )
    const registry = new FrameControllerRegistry(session, loader, undefined, undefined, undefined, {
      frameHistory: new FrameHistoryCoordinator(session, {
        history,
        snapshotCache: new DocumentSnapshotCache(),
      }),
    })

    const one = registry.visit("/one", { action: "advance", frame: "one" })
    const two = registry.visit("/two", { action: "advance", frame: "two" })
    resolveTwo?.(
      response('<turbo-frame id="two"><Two /></turbo-frame>', {
        url: "https://example.test/two",
      }),
    )
    await two
    expect(history.current).toMatchObject({ restorationIndex: 1, url: "https://example.test/two" })

    resolveOne?.(
      response('<turbo-frame id="one"><One /></turbo-frame>', {
        url: "https://example.test/one",
      }),
    )
    await one

    expect(
      writes.map(({ entry, method }) => ({
        index: entry.restorationIndex,
        method,
        url: entry.url,
      })),
    ).toEqual([
      { index: 1, method: "push", url: "https://example.test/two" },
      { index: 2, method: "push", url: "https://example.test/one" },
    ])
    expect(session.tree.document.url).toBe("https://example.test/one")
    expect(session.tree.getElementById("one")?.children.filter(isElement)[0]?.tagName).toBe("One")
    expect(session.tree.getElementById("two")?.children.filter(isElement)[0]?.tagName).toBe("Two")
  })

  test("lets a newer document navigation invalidate an older promoted Frame", async () => {
    let resolveDocument: ((response: TurboResponse) => void) | undefined
    let resolveFrame: ((response: TurboResponse) => void) | undefined
    const current = historyHarness(
      () =>
        new Promise<TurboResponse>((resolve) => {
          resolveFrame = resolve
        }),
    )
    const documentRequests: TurboRequest[] = []
    const documentController = new DocumentVisitController(
      new DocumentRequestLoader(
        current.session,
        {
          fetch: (request) => {
            documentRequests.push(request)
            return new Promise<TurboResponse>((resolve) => {
              resolveDocument = resolve
            })
          },
        },
        { next: () => "document-request" },
      ),
      clock,
      { history: current.history, snapshotCache: current.cache },
    )

    const frameVisit = current.registry.visit("/frame", {
      action: "advance",
      frame: "details",
    })
    const documentVisit = documentController.visit("/document", { action: "advance" })
    expect(current.frameRequests).toHaveLength(1)
    expect(documentRequests).toHaveLength(1)

    resolveFrame?.(
      response('<turbo-frame id="details"><StaleFrame /></turbo-frame>', {
        url: "https://example.test/frame",
      }),
    )
    await expect(frameVisit).resolves.toMatchObject({ load: { status: "canceled" } })
    expect(current.history.current).toBe(current.initial)

    resolveDocument?.(
      response('<Gallery><CurrentDocument id="current-document" /></Gallery>', {
        url: "https://example.test/document",
      }),
    )
    await expect(documentVisit).resolves.toMatchObject({ status: "committed" })
    expect(current.writes).toHaveLength(1)
    expect(current.writes[0]).toMatchObject({
      entry: { restorationIndex: 1, url: "https://example.test/document" },
      method: "push",
    })
    expect(current.session.tree.document.url).toBe("https://example.test/document")
    expect(current.session.tree.getElementById("current-document")).toBeDefined()
    expect(current.session.tree.getElementById("details")).toBeUndefined()
  })

  test("lets a newer document form submission invalidate an older promoted Frame", async () => {
    let resolveForm: ((response: TurboResponse) => void) | undefined
    let resolveFrame: ((response: TurboResponse) => void) | undefined
    const current = historyHarness(
      () =>
        new Promise<TurboResponse>((resolve) => {
          resolveFrame = resolve
        }),
    )
    const formRequests: TurboRequest[] = []
    const formController = new FormSubmissionController(current.session, {
      fetch(request) {
        formRequests.push(request)
        return new Promise<TurboResponse>((resolve) => {
          resolveForm = resolve
        })
      },
    })
    const form = current.session.tree.getElementById("document-form")
    if (!form) throw new Error("fixture document form is missing")
    const controls = new FormControlRegistry(current.session, form.key)

    const frameVisit = current.registry.visit("/frame", {
      action: "advance",
      frame: "details",
    })
    const formSubmission = formController.submit((signal) =>
      controls.submissionProposal({ protocol: { requestId: "form-request" }, signal }),
    )
    expect(current.frameRequests).toHaveLength(1)
    expect(formRequests).toHaveLength(1)

    resolveFrame?.(
      response('<turbo-frame id="details"><StaleFrame /></turbo-frame>', {
        url: "https://example.test/frame",
      }),
    )
    await expect(frameVisit).resolves.toMatchObject({ load: { status: "canceled" } })
    expect(current.history.current).toBe(current.initial)
    expect(current.writes).toHaveLength(0)

    const formRequest = formRequests[0]
    if (!formRequest) throw new Error("document form request was not captured")
    resolveForm?.(
      response('<Gallery><Submitted id="submitted" /></Gallery>', {
        url: formRequest.url,
      }),
    )
    await expect(formSubmission).resolves.toMatchObject({
      application: "document",
      status: "applied",
    })
    expect(current.session.tree.getElementById("submitted")).toBeDefined()
    expect(current.session.tree.getElementById("details")).toBeUndefined()
  })

  test("captures the outgoing whole document before exposing the requested Frame source", async () => {
    let resolveResponse: ((value: TurboResponse) => void) | undefined
    const current = historyHarness(
      () =>
        new Promise<TurboResponse>((resolve) => {
          resolveResponse = resolve
        }),
    )
    const frame = current.session.tree.getElementById("details")
    if (!frame) throw new Error("fixture Frame is missing")

    const visiting = current.registry.visit("/next", { action: "advance", frame: "details" })
    expect(current.frameRequests).toHaveLength(1)
    expect(attributeValue(frame, "src")).toBe("https://example.test/next")
    current.session.setAttribute("id:shell", "phase", "late")
    resolveResponse?.(
      response('<turbo-frame id="details"><Next /></turbo-frame>', {
        url: "https://example.test/next",
      }),
    )
    await visiting

    const outgoing = current.cache.get("https://example.test/current")
    expect(attributeValue(outgoing?.getElementById("shell") as never, "phase")).toBe("initial")
    expect(attributeValue(outgoing?.getElementById("details") as never, "src")).toBe("/old")
    expect(outgoing?.getElementById("details")?.children.filter(isElement)[0]?.tagName).toBe("Old")
    expect(attributeValue(current.session.tree.getElementById("shell") as never, "phase")).toBe(
      "late",
    )
  })

  test("emits before-cache before exposing the requested Frame source and captures its mutations", async () => {
    const lifecycle = new DocumentVisitLifecycle()
    const events: string[] = []
    let current: ReturnType<typeof historyHarness>
    lifecycle.subscribe("before-cache", () => {
      events.push("before-cache")
      const frame = current.session.tree.getElementById("details")
      expect(attributeValue(frame as never, "src")).toBe("/old")
      expect(current.frameRequests).toHaveLength(0)
      current.session.setAttribute("id:shell", "phase", "before-cache")
    })
    current = historyHarness(
      async ({ url }) => response('<turbo-frame id="details"><Next /></turbo-frame>', { url }),
      undefined,
      { visitLifecycle: lifecycle },
    )

    await current.registry.visit("/next", { action: "advance", frame: "details" })

    expect(events).toEqual(["before-cache"])
    const outgoing = current.cache.get("https://example.test/current")
    expect(attributeValue(outgoing?.getElementById("shell") as never, "phase")).toBe("before-cache")
    expect(attributeValue(outgoing?.getElementById("details") as never, "src")).toBe("/old")
  })

  test("rejects a promoted Frame before fetch when before-cache replaces its document", async () => {
    const lifecycle = new DocumentVisitLifecycle()
    let current: ReturnType<typeof historyHarness>
    lifecycle.subscribe("before-cache", () => {
      current.session.replaceTree(
        parseExpoTurboDocument('<Gallery><Replacement id="replacement" /></Gallery>', {
          url: "https://example.test/current",
        }),
      )
    })
    current = historyHarness(
      async ({ url }) =>
        response('<turbo-frame id="details"><Unexpected /></turbo-frame>', { url }),
      undefined,
      { visitLifecycle: lifecycle },
    )

    await expect(
      current.registry.visit("/next", { action: "advance", frame: "details" }),
    ).rejects.toBeInstanceOf(StateError)
    expect(current.frameRequests).toEqual([])
    expect(current.writes).toEqual([])
    expect(current.cache.size).toBe(0)
    expect(current.session.tree.getElementById("replacement")).toBeDefined()
  })

  test("promotes the lifecycle-admitted Frame URL through history", async () => {
    const lifecycle = new RequestLifecycle()
    lifecycle.subscribe("before-fetch-request", (event) => {
      if (event.detail.context.kind === "frame") {
        event.detail.request.setUrl("https://example.test/lifecycle-frame")
      }
    })
    const current = historyHarness(
      async ({ url }) =>
        response('<turbo-frame id="details"><LifecycleFrame /></turbo-frame>', { url }),
      undefined,
      { requestLifecycle: lifecycle },
    )

    await expect(
      current.registry.visit("/original-frame", { action: "advance", frame: "details" }),
    ).resolves.toMatchObject({ action: "advance", kind: "frame" })
    expect(current.frameRequests[0]?.url).toBe("https://example.test/lifecycle-frame")
    expect(current.history.current).toMatchObject({
      restorationIndex: 1,
      url: "https://example.test/lifecycle-frame",
    })
    expect(current.session.tree.document.url).toBe("https://example.test/lifecycle-frame")
    expect(attributeValue(current.session.tree.getElementById("details") as never, "src")).toBe(
      "https://example.test/lifecycle-frame",
    )
  })

  test("promotes a Frame fragment through history without sending it to the server or Frame src", async () => {
    const current = historyHarness(async ({ url }) =>
      response('<turbo-frame id="details"><Section id="section" /></turbo-frame>', { url }),
    )

    await expect(
      current.registry.visit("/next?tab=one#section", {
        action: "advance",
        frame: "details",
      }),
    ).resolves.toMatchObject({
      action: "advance",
      kind: "frame",
      url: "https://example.test/next?tab=one#section",
    })

    expect(current.frameRequests.map((request) => request.url)).toEqual([
      "https://example.test/next?tab=one",
    ])
    expect(current.history.current?.url).toBe("https://example.test/next?tab=one#section")
    expect(current.session.tree.document.url).toBe("https://example.test/next?tab=one#section")
    expect(attributeValue(current.session.tree.getElementById("details") as never, "src")).toBe(
      "https://example.test/next?tab=one",
    )
  })

  test("leaves promoted Frame history uncommitted when before-frame-render declines default", async () => {
    const lifecycle = new FrameLifecycle()
    lifecycle.subscribe("before-frame-render", (event) => {
      event.detail.render = () => undefined
      return undefined
    })
    const current = historyHarness(
      async ({ url }) =>
        response('<turbo-frame id="details"><Blocked id="blocked" /></turbo-frame>', { url }),
      undefined,
      { frameLifecycle: lifecycle },
    )

    await expect(
      current.registry.visit("/blocked", { action: "advance", frame: "details" }),
    ).rejects.toMatchObject({ code: "state" })
    expect(current.writes).toEqual([])
    expect(current.history.current).toBe(current.initial)
    expect(current.cache.size).toBe(0)
    expect(current.session.tree.document.url).toBe("https://example.test/current")
    expect(attributeValue(current.session.tree.getElementById("details") as never, "src")).toBe(
      "https://example.test/blocked",
    )
    expect(
      current.session.tree.getElementById("details")?.children.filter(isElement)[0]?.tagName,
    ).toBe("Old")
    expect(current.session.tree.getElementById("blocked")).toBeUndefined()
  })

  test("rejects a settled opaque plan before another request starts", async () => {
    const current = historyHarness(async ({ url }) =>
      response('<turbo-frame id="details"><Loaded /></turbo-frame>', { url }),
    )
    const controller = current.registry.get("details")
    const frame = current.session.tree.getElementById("details")
    if (frame?.kind !== "frame") throw new Error("fixture Frame is missing")
    const plan = prepareFrameHistoryCommit(
      current.frameHistory,
      controller,
      frame,
      "https://example.test/once",
      "advance",
    )

    await visitFrameWithHistory(controller, "https://example.test/once", plan)
    expect(() => visitFrameWithHistory(controller, "https://example.test/once", plan)).toThrow(
      StateError,
    )
    expect(current.frameRequests).toHaveLength(1)
  })

  test("keeps history and tree unchanged when the host rejects while retaining a retryable snapshot", async () => {
    let attempts = 0
    const current = historyHarness(
      async ({ url }) => response('<turbo-frame id="details"><Loaded /></turbo-frame>', { url }),
      () => {
        attempts += 1
        if (attempts === 1) throw new Error("host failed with secret-token")
        return undefined
      },
    )
    const tree = current.session.tree

    await expect(
      current.registry.visit("/failed", { action: "advance", frame: "details" }),
    ).rejects.toBeInstanceOf(StateError)
    expect(current.history.current).toBe(current.initial)
    expect(current.session.tree).toBe(tree)
    expect(current.session.tree.document.url).toBe("https://example.test/current")
    expect(attributeValue(current.session.tree.getElementById("details") as never, "src")).toBe(
      "https://example.test/failed",
    )
    expect(current.cache.has("https://example.test/current")).toBe(true)

    await expect(
      current.registry.visit("/retry", { action: "advance", frame: "details" }),
    ).resolves.toMatchObject({ action: "advance", kind: "frame" })
    expect(current.history.current).toMatchObject({
      restorationIdentifier: "frame-history-1",
      restorationIndex: 1,
      url: "https://example.test/retry",
    })
    expect(current.session.tree.document.url).toBe("https://example.test/retry")
  })

  test("keeps protected cancellation inert and rejects controller mutation during history commit", async () => {
    let current: ReturnType<typeof historyHarness>
    let revisionBeforeCancel = -1
    let revisionAfterCancel = -1
    let sharedSession: DocumentSession
    current = historyHarness(
      async ({ url }) => response('<turbo-frame id="details"><Committed /></turbo-frame>', { url }),
      () => {
        const controller = current.registry.get("details")
        revisionBeforeCancel = controller.state.revision
        controller.cancel()
        revisionAfterCancel = controller.state.revision
        expect(controller.state.status).toBe("loading")
        expect(() => controller.load()).toThrow(StateError)
        expect(() => controller.reload()).toThrow(StateError)
        expect(() => controller.visit("/reentrant")).toThrow(StateError)
        expect(() => controller.setSource("/reentrant")).toThrow(StateError)
        expect(() => controller.setDisabled(true)).toThrow(StateError)
        expect(() => controller.setLoading("lazy")).toThrow(StateError)
        expect(() => current.session.setAttribute("id:shell", "phase", "reentrant")).toThrow(
          StateError,
        )
        const shell = current.session.tree.getElementById("shell")
        if (!shell) throw new Error("fixture shell is missing")
        expect(() => current.session.tree.setAttribute(shell, "phase", "direct")).toThrow(
          StateError,
        )
        expect(() => sharedSession.setAttribute(shell.key, "phase", "shared-session")).toThrow(
          StateError,
        )
        const frame = current.session.tree.getElementById("details")
        if (!frame) throw new Error("fixture Frame is missing")
        expect(() => (frame.children as unknown as unknown[]).splice(0, 1)).toThrow(TypeError)
        expect(() => {
          ;(frame as unknown as { children: readonly never[] }).children = []
        }).toThrow(TypeError)
        expect(() => {
          ;(frame as unknown as { parent: null }).parent = null
        }).toThrow(TypeError)
        const source = frame.attributes.find((attribute) => attribute.name === "src")
        if (!source) throw new Error("fixture Frame source is missing")
        expect(() => {
          ;(source as { value: string }).value = "/corrupt"
        }).toThrow(TypeError)
        const frames = current.session.tree.getFrames()
        expect(Object.isFrozen(frames)).toBe(true)
        expect(() => (frames as unknown as unknown[]).splice(0, 1)).toThrow(TypeError)
        expect(current.session.tree.getFrames()).toEqual([frame])
        controller.disconnect()
        expect(controller.state).toMatchObject({ connected: false, status: "loading" })
        return undefined
      },
    )
    sharedSession = new DocumentSession(current.session.tree)

    await expect(
      current.registry.visit("/committed", { action: "advance", frame: "details" }),
    ).resolves.toMatchObject({ action: "advance", kind: "frame" })

    expect(revisionAfterCancel).toBe(revisionBeforeCancel)
    expect(current.registry.get("details").state).toMatchObject({
      connected: false,
      status: "completed",
    })
    expect(current.history.current?.url).toBe("https://example.test/committed")
    expect(current.session.tree.document.url).toBe("https://example.test/committed")
  })

  test("inherits destination actions while an explicit null keeps the visit Frame-local", async () => {
    const current = historyHarness(async ({ url }) =>
      response('<turbo-frame id="details"><Loaded /></turbo-frame>', { url }),
    )
    current.session.setAttribute("id:details", "data-turbo-action", "replace")

    await expect(current.registry.visit("/inherited", { frame: "details" })).resolves.toMatchObject(
      {
        action: "replace",
        kind: "frame",
      },
    )
    expect(current.writes).toHaveLength(1)
    expect(current.writes[0]).toMatchObject({
      entry: { restorationIndex: 0, url: "https://example.test/inherited" },
      method: "replace",
    })

    current.session.setAttribute("id:details", "data-turbo-action", "advance")
    await expect(
      current.registry.visit("/masked", { action: null, frame: "details" }),
    ).resolves.toMatchObject({ kind: "frame", url: "https://example.test/masked" })
    expect(current.writes).toHaveLength(1)
    expect(current.session.tree.document.url).toBe("https://example.test/inherited")
    expect(attributeValue(current.session.tree.getElementById("details") as never, "src")).toBe(
      "https://example.test/masked",
    )
  })

  test("rejects restore and unvisitable promotions and leaves empty responses history-neutral", async () => {
    const current = historyHarness(async ({ url }) =>
      url.endsWith("/empty")
        ? response("", { headers: {}, status: 204, url })
        : response('<turbo-frame id="details"><Loaded /></turbo-frame>', { url }),
    )

    await expect(
      current.registry.visit("/restore", { action: "restore", frame: "details" }),
    ).rejects.toBeInstanceOf(TargetError)
    await expect(
      current.registry.visit("/archive.pdf", { action: "advance", frame: "details" }),
    ).rejects.toBeInstanceOf(TargetError)
    expect(current.frameRequests).toHaveLength(0)

    await expect(
      current.registry.visit("/empty", { action: "advance", frame: "details" }),
    ).resolves.toMatchObject({ action: "advance", load: { status: "empty" } })
    expect(current.writes).toHaveLength(0)
    expect(current.cache.size).toBe(0)
    expect(current.history.current).toBe(current.initial)
    expect(current.session.tree.document.url).toBe("https://example.test/current")
    expect(attributeValue(current.session.tree.getElementById("details") as never, "src")).toBe(
      "https://example.test/empty",
    )

    await current.registry.visit("/valid", { action: "advance", frame: "details" })
    expect(current.writes[0]?.entry).toMatchObject({
      restorationIdentifier: "frame-history-1",
      restorationIndex: 1,
      url: "https://example.test/valid",
    })
  })

  test("retains the primary requested or redirected source when the response cannot commit", async () => {
    let request = 0
    const current = historyHarness(async ({ url }) => {
      request += 1
      return request === 1
        ? response("", {
            headers: {},
            status: 204,
            url: "https://example.test/final-empty",
          })
        : response("<html></html>", {
            headers: { "Content-Type": "text/html" },
            url,
          })
    })

    await expect(
      current.registry.visit("/empty", { action: "advance", frame: "details" }),
    ).resolves.toMatchObject({ load: { status: "empty" } })
    expect(attributeValue(current.session.tree.getElementById("details") as never, "src")).toBe(
      "https://example.test/final-empty",
    )

    await expect(
      current.registry.visit("/wrong-mime", { action: "advance", frame: "details" }),
    ).rejects.toBeInstanceOf(ContentTypeError)
    expect(attributeValue(current.session.tree.getElementById("details") as never, "src")).toBe(
      "https://example.test/wrong-mime",
    )
    expect(current.history.current).toBe(current.initial)
    expect(current.session.tree.document.url).toBe("https://example.test/current")
    expect(
      current.session.tree.getElementById("details")?.children.filter(isElement)[0]?.tagName,
    ).toBe("Old")
    expect(current.cache.size).toBe(0)
    expect(current.writes).toHaveLength(0)
  })

  test("uses the primary redirected response URL across recurse and matching error responses", async () => {
    let request = 0
    const current = historyHarness(async () => {
      request += 1
      return request === 1
        ? response(
            '<Gallery><turbo-frame id="bridge" src="nested" recurse="details" /></Gallery>',
            {
              redirected: true,
              status: 422,
              url: "https://example.test/redirected/index",
            },
          )
        : response('<Gallery><turbo-frame id="details"><Loaded /></turbo-frame></Gallery>', {
            url: "https://example.test/redirected/nested",
          })
    })

    const result = await current.registry.visit("/initial", {
      action: "advance",
      frame: "details",
    })

    expect(result).toMatchObject({
      action: "advance",
      load: {
        requestIds: ["frame-request-1", "frame-request-2"],
        responseStatus: 422,
        url: "https://example.test/redirected/index",
      },
    })
    expect(current.history.current?.url).toBe("https://example.test/redirected/index")
    expect(current.session.tree.document.url).toBe("https://example.test/redirected/index")
    expect(attributeValue(current.session.tree.getElementById("details") as never, "src")).toBe(
      "https://example.test/redirected/index",
    )
  })

  test("fails snapshot storage before writing history or mutating the Frame", async () => {
    class FailingSnapshotCache extends DocumentSnapshotCache {
      override put(): void {
        throw new Error("snapshot failed with secret-token")
      }
    }

    const session = new DocumentSession(
      parseExpoTurboDocument(frameDocument(), { url: "https://example.test/current" }),
    )
    const writes: DocumentHistoryEntry[] = []
    const history = new DocumentHistory(
      { next: () => "frame-history" },
      {
        write(_method, entry) {
          writes.push(entry)
        },
      },
    )
    const initial = history.initialize({
      entry: {
        restorationIdentifier: "initial-history",
        restorationIndex: 0,
        url: "https://example.test/current",
      },
      kind: "managed",
    }).entry
    const loader = new FrameRequestLoader(
      session,
      {
        fetch: async ({ url }) =>
          response('<turbo-frame id="details"><Blocked /></turbo-frame>', { url }),
      },
      { next: () => "frame-request" },
    )
    const registry = new FrameControllerRegistry(session, loader, undefined, undefined, undefined, {
      frameHistory: new FrameHistoryCoordinator(session, {
        history,
        snapshotCache: new FailingSnapshotCache(),
      }),
    })
    const tree = session.tree

    await expect(
      registry.visit("/blocked", { action: "advance", frame: "details" }),
    ).rejects.toBeInstanceOf(RequestError)
    expect(writes).toHaveLength(0)
    expect(history.current).toBe(initial)
    expect(session.tree).toBe(tree)
    expect(session.tree.document.url).toBe("https://example.test/current")
    expect(attributeValue(session.tree.getElementById("details") as never, "src")).toBe(
      "https://example.test/blocked",
    )
    expect(session.tree.getElementById("details")?.children.filter(isElement)[0]?.tagName).toBe(
      "Old",
    )
  })

  test("restores promoted entries as whole documents from cache without another Frame request", async () => {
    const current = historyHarness(async ({ url }) => {
      const child = url.endsWith("/one") ? "One" : "Two"
      return response(`<turbo-frame id="details"><${child} /></turbo-frame>`, { url })
    })
    await current.registry.visit("/one", { action: "advance", frame: "details" })
    const first = current.history.current
    await current.registry.visit("/two", { action: "advance", frame: "details" })
    const second = current.history.current
    if (!first || !second) throw new Error("fixture history entries are missing")

    const documentRequests: TurboRequest[] = []
    const controller = new DocumentVisitController(
      new DocumentRequestLoader(
        current.session,
        {
          fetch: async (request) => {
            documentRequests.push(request)
            throw new Error("cache restoration must not fetch")
          },
        },
        { next: () => "document-request" },
      ),
      clock,
      { history: current.history, snapshotCache: current.cache },
    )

    await expect(controller.restoreTraversal(current.initial)).resolves.toMatchObject({
      source: "snapshot",
      status: "restored",
    })
    expect(current.session.tree.document.url).toBe("https://example.test/current")
    expect(
      current.session.tree.getElementById("details")?.children.filter(isElement)[0]?.tagName,
    ).toBe("Old")

    await expect(controller.restoreTraversal(second)).resolves.toMatchObject({
      source: "snapshot",
      status: "restored",
    })
    expect(current.session.tree.document.url).toBe("https://example.test/two")
    expect(
      current.session.tree.getElementById("details")?.children.filter(isElement)[0]?.tagName,
    ).toBe("Two")
    expect(current.frameRequests).toHaveLength(2)
    expect(documentRequests).toHaveLength(0)
  })

  test("falls back to one canonical document GET when the traversal snapshot is missing", async () => {
    const current = historyHarness(
      async ({ url }) => response('<turbo-frame id="details"><Promoted /></turbo-frame>', { url }),
      () => undefined,
      { snapshotCache: false },
    )
    await current.registry.visit("/promoted", { action: "advance", frame: "details" })
    expect(current.cache.size).toBe(0)
    const documentRequests: TurboRequest[] = []
    const controller = new DocumentVisitController(
      new DocumentRequestLoader(
        current.session,
        {
          fetch: async (request) => {
            documentRequests.push(request)
            return response(frameDocument("Network"), {
              url: "https://example.test/current",
            })
          },
        },
        { next: () => "document-request" },
      ),
      clock,
      { history: current.history, snapshotCache: current.cache },
    )

    await expect(controller.restoreTraversal(current.initial)).resolves.toMatchObject({
      source: "network",
    })
    expect(documentRequests).toHaveLength(1)
    expect(documentRequests[0]?.headers["Turbo-Frame"]).toBeUndefined()
    expect(current.frameRequests).toHaveLength(1)
    expect(current.session.tree.document.url).toBe("https://example.test/current")
    expect(
      current.session.tree.getElementById("details")?.children.filter(isElement)[0]?.tagName,
    ).toBe("Network")
  })
})
