import { describe, expect, test } from "bun:test"

import type { ClockAdapter, TurboRequest, TurboResponse, VisibilityAdapter } from "../adapters"
import {
  DocumentHistory,
  type DocumentHistoryEntry,
  type DocumentHistoryWriteMethod,
} from "./document-history"
import { DocumentRequestLoader } from "./document-loader"
import { DocumentSnapshotCache } from "./document-snapshot-cache"
import { DocumentVisitController } from "./document-visit-controller"
import { ContentTypeError, RequestError, StateError, TargetError } from "./errors"
import { FormSubmissionController } from "./form-submission-controller"
import { FormControlRegistry } from "./forms"
import { FrameControllerRegistry } from "./frame-controller-registry"
import { FrameHistoryCoordinator, prepareFrameHistoryCommit } from "./frame-history"
import { visitFrameWithHistory } from "./frame-history-internal"
import { EXPO_TURBO_MIME_TYPE, FrameRequestLoader } from "./frame-loader"
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
    frameHistory?: boolean
    requestLifecycle?: RequestLifecycle
    snapshotCache?: boolean
    visibility?: VisibilityAdapter
  }> = {},
) {
  const session = new DocumentSession(
    parseExpoTurboDocument(options.document ?? frameDocument(), {
      url: "https://example.test/current",
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
      url: "https://example.test/current",
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
    options.requestLifecycle ? { requestLifecycle: options.requestLifecycle } : {},
  )
  const frameHistory = new FrameHistoryCoordinator(session, {
    history,
    ...(options.snapshotCache === false ? {} : { snapshotCache: cache }),
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
  test("promotes the first delayed lazy appearance using the live Frame action", async () => {
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

    firstAppearance?.(true)
    await Promise.resolve()
    expect(current.frameRequests).toHaveLength(1)
    expect(current.writes).toHaveLength(1)
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
