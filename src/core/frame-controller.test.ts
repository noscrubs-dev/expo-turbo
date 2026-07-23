import { describe, expect, test } from "bun:test"

import type { TurboRequest, TurboResponse, VisibilityAdapter } from "../adapters"
import { consumeFrameAutofocus, consumeFrameRenderEffects } from "./frame-autofocus-internal"
import { FrameController } from "./frame-controller"
import { FrameControllerRegistry } from "./frame-controller-registry"
import { FrameLifecycle } from "./frame-lifecycle"
import {
  EXPO_TURBO_MIME_TYPE,
  FrameCommitError,
  FrameRequestLoader,
  type FrameRequestLoaderOptions,
} from "./frame-loader"
import { FramePreloadCache } from "./frame-preload-cache"
import {
  acknowledgeFrameRender,
  frameRenderLifecycleRevision,
  hasFrameRenderTicket,
  retainFrameRenderer,
  subscribeFrameRenderLifecycle,
} from "./frame-render-lifecycle-internal"
import { parseExpoTurboDocument } from "./parser"
import { RequestLifecycle } from "./request-lifecycle"
import { DocumentSession } from "./session"
import { dispatchTurboStreamFragment } from "./streams"
import { attributeValue, isElement } from "./tree"

interface PendingRequest {
  readonly request: TurboRequest
  readonly resolve: (response: TurboResponse) => void
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

function harness(
  attributes = 'src="/frame"',
  visibility?: VisibilityAdapter,
  options: FrameRequestLoaderOptions = {},
) {
  const pending: PendingRequest[] = []
  const session = new DocumentSession(
    parseExpoTurboDocument(
      `<Gallery><turbo-frame id="details" ${attributes}><Loading /></turbo-frame></Gallery>`,
      { url: "https://example.test/page" },
    ),
  )
  let requestId = 0
  const loader = new FrameRequestLoader(
    session,
    {
      fetch: (request) =>
        new Promise<TurboResponse>((resolve) => {
          pending.push({ request, resolve })
        }),
    },
    { next: () => `request-${++requestId}` },
    options,
  )
  return {
    controller: new FrameController(session, "details", loader, visibility),
    loader,
    pending,
    session,
  }
}

describe("Frame controller", () => {
  test("keeps a prevented fetch error rejected while suppressing default error delegation", async () => {
    const session = new DocumentSession(
      parseExpoTurboDocument(
        '<Gallery><turbo-frame id="details" src="/frame"><Loading /></turbo-frame></Gallery>',
        { url: "https://example.test/page" },
      ),
    )
    const lifecycle = new RequestLifecycle()
    lifecycle.subscribe("fetch-request-error", (event) => event.preventDefault())
    const controller = new FrameController(
      session,
      "details",
      new FrameRequestLoader(
        session,
        {
          fetch: async () => {
            throw new Error("secret transport failure")
          },
        },
        { next: () => "request-error" },
        { requestLifecycle: lifecycle },
      ),
    )
    const errors: Error[] = []
    controller.subscribeErrors((error) => errors.push(error))

    await expect(controller.connect()).rejects.toThrow("Fetch request failed")
    expect(controller.state).toMatchObject({ busy: false, status: "error" })
    expect(errors).toEqual([])
  })

  test("eagerly loads on connect and publishes stable terminal lifecycle state", async () => {
    const { controller, pending, session } = harness()
    const revisions: number[] = []
    controller.subscribe(() => revisions.push(controller.state.revision))

    const loaded = controller.connect()
    expect(pending).toHaveLength(1)
    expect(controller.state).toMatchObject({
      busy: true,
      complete: false,
      connected: true,
      loading: "eager",
      status: "loading",
    })
    const loadingSnapshot = controller.state
    expect(controller.state).toBe(loadingSnapshot)

    pending[0]?.resolve(response('<turbo-frame id="details"><Loaded /></turbo-frame>'))
    expect(await loaded).toMatchObject({ status: "completed" })
    expect(controller.state).toMatchObject({
      busy: false,
      complete: true,
      hasBeenLoaded: true,
      status: "completed",
    })
    expect(revisions).toEqual([1, 2, 3])
    expect(session.tree.getElementById("details")?.children.filter(isElement)[0]?.tagName).toBe(
      "Loaded",
    )
  })

  test("renders an exact cached Frame as a provisional preview before canonical revalidation", async () => {
    const session = new DocumentSession(
      parseExpoTurboDocument(
        '<Gallery><Outside id="outside" /><turbo-frame id="details" src="/frame"><Loading /></turbo-frame></Gallery>',
        { url: "https://example.test/page" },
      ),
    )
    const frame = session.tree.getElementById("details")
    if (frame?.kind !== "frame") throw new Error("Frame fixture is missing")
    const cache = new FramePreloadCache()
    cache.put({
      body: `<Gallery>
        <turbo-frame id="details"><Preview /></turbo-frame>
        <turbo-stream action="remove" target="outside"></turbo-stream>
      </Gallery>`,
      frameId: "details",
      redirected: false,
      requestId: "preview-request",
      responseStatus: 200,
      responseUrl: "https://example.test/frame",
      url: "https://example.test/frame",
    })
    const lifecycle = new FrameLifecycle()
    const events: string[] = []
    let controller!: FrameController
    lifecycle.subscribe("before-frame-render", (event) => {
      events.push(`before:${event.detail.newFrame.children.filter(isElement)[0]?.tagName}`)
    })
    lifecycle.subscribe("frame-render", () => {
      events.push(`render:${controller.state.previewVisible ? "preview" : "canonical"}`)
    })
    lifecycle.subscribe("frame-load", () => {
      events.push("load")
      return undefined
    })
    let canonicalStarted!: () => void
    const canonicalStart = new Promise<void>((resolve) => {
      canonicalStarted = resolve
    })
    let resolveCanonical!: (response: TurboResponse) => void
    const loader = new FrameRequestLoader(
      session,
      {
        fetch: () => {
          canonicalStarted()
          return new Promise<TurboResponse>((resolve) => {
            resolveCanonical = resolve
          })
        },
      },
      { next: () => "canonical-request" },
      { frameLifecycle: lifecycle, preloadBehavior: "preview", preloadCache: cache },
    )
    controller = new FrameController(session, "details", loader)
    const releaseRenderer = retainFrameRenderer(session, frame)
    let lifecycleRevision = frameRenderLifecycleRevision(session)
    const unsubscribe = subscribeFrameRenderLifecycle(session, () => {
      if (frameRenderLifecycleRevision(session) <= lifecycleRevision) return
      lifecycleRevision = frameRenderLifecycleRevision(session)
      acknowledgeFrameRender(session, frame, "details", session.revision)?.finish()
    })

    const loaded = controller.connect()
    await canonicalStart

    expect(controller.state).toMatchObject({
      busy: true,
      complete: false,
      hasBeenLoaded: false,
      previewVisible: true,
      status: "loading",
    })
    expect(frame.children.filter(isElement)[0]?.tagName).toBe("Preview")
    expect(session.tree.getElementById("outside")).toBeDefined()
    expect(events).toEqual(["before:Preview", "render:preview"])

    resolveCanonical(response('<turbo-frame id="details"><Canonical /></turbo-frame>'))
    await expect(loaded).resolves.toMatchObject({
      requestId: "canonical-request",
      status: "completed",
    })
    expect(controller.state).toMatchObject({
      busy: false,
      complete: true,
      hasBeenLoaded: true,
      previewVisible: false,
      status: "completed",
    })
    expect(frame.children.filter(isElement)[0]?.tagName).toBe("Canonical")
    expect(events).toEqual([
      "before:Preview",
      "render:preview",
      "before:Canonical",
      "render:canonical",
      "load",
    ])

    unsubscribe()
    releaseRenderer()
  })

  test("keeps the provisional Frame visible when canonical revalidation is empty", async () => {
    const cache = new FramePreloadCache()
    cache.put({
      body: '<turbo-frame id="details"><Preview id="preview" /></turbo-frame>',
      frameId: "details",
      redirected: false,
      requestId: "preview-request",
      responseStatus: 200,
      responseUrl: "https://example.test/frame",
      url: "https://example.test/frame",
    })
    const { controller, pending, session } = harness('src="/frame"', undefined, {
      preloadBehavior: "preview",
      preloadCache: cache,
    })
    const frame = session.tree.getElementById("details")
    if (frame?.kind !== "frame") throw new Error("Frame fixture is missing")
    const releaseRenderer = retainFrameRenderer(session, frame)
    let lifecycleRevision = frameRenderLifecycleRevision(session)
    const unsubscribe = subscribeFrameRenderLifecycle(session, () => {
      if (frameRenderLifecycleRevision(session) <= lifecycleRevision) return
      lifecycleRevision = frameRenderLifecycleRevision(session)
      acknowledgeFrameRender(session, frame, "details", session.revision)?.finish()
    })

    const loaded = controller.connect()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(pending).toHaveLength(1)
    expect(controller.state).toMatchObject({
      busy: true,
      previewVisible: true,
      status: "loading",
    })
    pending[0]?.resolve(
      response("", {
        status: 204,
      }),
    )

    await expect(loaded).resolves.toMatchObject({ status: "empty" })
    expect(controller.state).toMatchObject({
      busy: false,
      complete: true,
      hasBeenLoaded: true,
      previewVisible: true,
      status: "empty",
    })
    expect(session.tree.getElementById("preview")).toBeDefined()

    unsubscribe()
    releaseRenderer()
  })

  test("acknowledges matching Frame responses before render/load across success and errors", async () => {
    for (const responseStatus of [200, 422, 500]) {
      const session = new DocumentSession(
        parseExpoTurboDocument(
          '<Gallery><turbo-frame id="details" src="/frame"><Loading /></turbo-frame></Gallery>',
          { url: "https://example.test/page" },
        ),
      )
      const frame = session.tree.getElementById("details")
      if (frame?.kind !== "frame") throw new Error("Frame fixture is missing")
      const lifecycle = new FrameLifecycle()
      const events: string[] = []
      let frameController: FrameController | undefined
      lifecycle.subscribe("before-frame-render", (event) => {
        if (!frameController) throw new Error("Frame controller was not configured")
        events.push("before")
        expect(frame.children.filter(isElement)[0]?.tagName).toBe("Loading")
        expect(event.detail).toMatchObject({
          frameId: "details",
          renderMethod: "replace",
          url: "https://example.test/frame",
        })
        expect(event.detail.newFrame.children.filter(isElement)[0]?.tagName).toBe("Committed")
        expect(frameController.state).toMatchObject({ busy: true, status: "loading" })
        event.detail.render = (context) => {
          events.push("default")
          return context.renderDefault()
        }
        return undefined
      })
      lifecycle.subscribe("frame-render", () => {
        if (!frameController) throw new Error("Frame controller was not configured")
        events.push("render")
        expect(frameController.state).toMatchObject({
          busy: false,
          complete: true,
          status: "completed",
        })
        return undefined
      })
      lifecycle.subscribe("frame-load", () => {
        events.push("load")
        return undefined
      })
      const releaseRenderer = retainFrameRenderer(session, frame)
      let lifecycleRevision = frameRenderLifecycleRevision(session)
      const unsubscribe = subscribeFrameRenderLifecycle(session, () => {
        if (frameRenderLifecycleRevision(session) <= lifecycleRevision) return
        lifecycleRevision = frameRenderLifecycleRevision(session)
        const acknowledgement = acknowledgeFrameRender(session, frame, "details", session.revision)
        expect(acknowledgement).toBeDefined()
        acknowledgement?.finish()
      })
      const controller = new FrameController(
        session,
        "details",
        new FrameRequestLoader(
          session,
          {
            fetch: async () =>
              response('<turbo-frame id="details"><Committed /></turbo-frame>', {
                status: responseStatus,
              }),
          },
          { next: () => `request-${responseStatus}` },
          { frameLifecycle: lifecycle },
        ),
      )
      frameController = controller

      expect(await controller.connect()).toMatchObject({
        responseStatus,
        status: "completed",
      })
      expect(events).toEqual(["before", "default", "render", "load"])
      expect(controller.state).toMatchObject({ busy: false, status: "completed" })

      unsubscribe()
      releaseRenderer()
    }
  })

  test("uses bounded morph only for a direct reload with exact refresh metadata", async () => {
    const pending: PendingRequest[] = []
    const session = new DocumentSession(
      parseExpoTurboDocument(
        '<Gallery><turbo-frame id="details" src="/frame" refresh="morph"><Stable id="stable" tone="before" /></turbo-frame></Gallery>',
        { url: "https://example.test/page" },
      ),
    )
    const frame = session.tree.getElementById("details")
    const initialStable = session.tree.getElementById("stable")
    if (frame?.kind !== "frame" || !initialStable) throw new Error("Frame fixture is missing")
    const lifecycle = new FrameLifecycle()
    const events: string[] = []
    lifecycle.subscribe("before-frame-render", (event) => {
      events.push(`before:${event.detail.renderMethod}`)
      return undefined
    })
    lifecycle.subscribe("before-frame-morph", (event) => {
      expect(event.detail.currentFrame).toBe(frame)
      expect(event.detail.newFrame.kind).toBe("frame")
      expect(event.detail.frameId).toBe("details")
      events.push("morph")
      return undefined
    })
    lifecycle.subscribe("frame-render", (event) => {
      events.push(`render:${event.detail.renderMethod}`)
      return undefined
    })
    lifecycle.subscribe("frame-load", () => {
      events.push("load")
      return undefined
    })
    const loader = new FrameRequestLoader(
      session,
      {
        fetch: (request) =>
          new Promise<TurboResponse>((resolve) => {
            pending.push({ request, resolve })
          }),
      },
      { next: () => `request-${pending.length + 1}` },
      { frameLifecycle: lifecycle },
    )
    const controller = new FrameController(session, "details", loader)
    const releaseRenderer = retainFrameRenderer(session, frame)
    let lifecycleRevision = frameRenderLifecycleRevision(session)
    const unsubscribe = subscribeFrameRenderLifecycle(session, () => {
      if (frameRenderLifecycleRevision(session) <= lifecycleRevision) return
      lifecycleRevision = frameRenderLifecycleRevision(session)
      acknowledgeFrameRender(session, frame, "details", session.revision)?.finish()
    })

    const initial = controller.connect()
    pending[0]?.resolve(
      response(
        '<turbo-frame id="details"><Stable id="stable" tone="initial" /><Anonymous tone="initial" /><Permanent id="permanent" data-turbo-permanent="" tone="connected"><Locked id="locked" value="current" /></Permanent></turbo-frame>',
      ),
    )
    await initial
    const afterConnect = session.tree.getElementById("stable")
    const anonymous = frame.children[1]
    const permanent = session.tree.getElementById("permanent")
    const locked = session.tree.getElementById("locked")
    if (!afterConnect || anonymous?.kind !== "element" || !permanent || !locked)
      throw new Error("initial Frame response did not commit")
    expect(afterConnect).not.toBe(initialStable)

    const reloaded = controller.reload()
    pending[1]?.resolve(
      response(
        '<turbo-frame id="details"><Stable id="stable" tone="morphed" /><Anonymous tone="morphed" /><Permanent id="permanent" data-turbo-permanent="" tone="incoming"><Locked id="locked" value="incoming" /></Permanent></turbo-frame>',
      ),
    )
    await reloaded
    const afterReload = session.tree.getElementById("stable")
    const afterReloadPermanent = session.tree.getElementById("permanent")
    const afterReloadLocked = session.tree.getElementById("locked")
    if (!afterReload || !afterReloadPermanent || !afterReloadLocked) {
      throw new Error("morph Frame response did not commit")
    }
    expect(afterReload).toBe(afterConnect)
    expect(frame.children[1]).toBe(anonymous)
    expect(attributeValue(anonymous, "tone")).toBe("morphed")
    expect(afterReloadPermanent).toBe(permanent)
    expect(afterReloadLocked).toBe(locked)
    expect(attributeValue(afterReload, "tone")).toBe("morphed")
    expect(attributeValue(afterReloadPermanent, "tone")).toBe("connected")
    expect(attributeValue(afterReloadLocked, "value")).toBe("current")

    const loaded = controller.load()
    pending[2]?.resolve(
      response('<turbo-frame id="details"><Stable id="stable" tone="loaded" /></turbo-frame>'),
    )
    await loaded
    const afterLoad = session.tree.getElementById("stable")
    if (!afterLoad) throw new Error("explicit Frame load did not commit")
    expect(afterLoad).not.toBe(afterReload)

    const visited = controller.visit(controller.source ?? "")
    pending[3]?.resolve(
      response('<turbo-frame id="details"><Stable id="stable" tone="visited" /></turbo-frame>'),
    )
    await visited
    const afterVisit = session.tree.getElementById("stable")
    if (!afterVisit) throw new Error("same-source Frame visit did not commit")
    expect(afterVisit).not.toBe(afterLoad)
    expect(events).toEqual([
      "before:replace",
      "render:replace",
      "load",
      "before:morph",
      "morph",
      "render:morph",
      "load",
      "before:replace",
      "render:replace",
      "load",
      "before:replace",
      "render:replace",
      "load",
    ])

    unsubscribe()
    releaseRenderer()
  })

  test("cascades an acknowledged outer morph reload to its retained nested Frame", async () => {
    const pending: PendingRequest[] = []
    const session = new DocumentSession(
      parseExpoTurboDocument(
        '<Gallery><turbo-frame id="outer" src="/outer" refresh="morph" loading="lazy"><DemoPanel id="shell"><turbo-frame id="inner" src="/inner" refresh="morph" loading="lazy"><Before id="inner-content" /><turbo-frame id="leaf" src="/leaf" refresh="morph" loading="lazy"><LeafBefore id="leaf-content" /></turbo-frame></turbo-frame></DemoPanel></turbo-frame></Gallery>',
        { url: "https://example.test/page" },
      ),
    )
    const outerFrame = session.tree.getElementById("outer")
    const innerFrame = session.tree.getElementById("inner")
    const innerContent = session.tree.getElementById("inner-content")
    const leafFrame = session.tree.getElementById("leaf")
    const leafContent = session.tree.getElementById("leaf-content")
    if (
      outerFrame?.kind !== "frame" ||
      innerFrame?.kind !== "frame" ||
      !innerContent ||
      leafFrame?.kind !== "frame" ||
      !leafContent
    ) {
      throw new Error("Frame fixture is missing")
    }
    const lifecycle = new FrameLifecycle()
    const events: string[] = []
    lifecycle.subscribe("before-frame-morph", (event) => {
      events.push(`morph:${event.detail.frameId}`)
      return undefined
    })
    lifecycle.subscribe("frame-render", (event) => {
      events.push(`render:${event.detail.frameId}`)
      return undefined
    })
    lifecycle.subscribe("frame-load", (event) => {
      events.push(`load:${event.detail.frameId}`)
      return undefined
    })
    const loader = new FrameRequestLoader(
      session,
      {
        fetch: (request) =>
          new Promise<TurboResponse>((resolve) => {
            pending.push({ request, resolve })
          }),
      },
      { next: () => `nested-${pending.length + 1}` },
      { frameLifecycle: lifecycle },
    )
    const registry = new FrameControllerRegistry(session, loader)
    const outer = registry.get("outer")
    const inner = registry.get("inner")
    const leaf = registry.get("leaf")
    const releaseOuter = retainFrameRenderer(session, outerFrame)
    const releaseInner = retainFrameRenderer(session, innerFrame)
    const releaseLeaf = retainFrameRenderer(session, leafFrame)
    let lifecycleRevision = frameRenderLifecycleRevision(session)
    let outerAcknowledgement: ReturnType<typeof acknowledgeFrameRender> | undefined
    let outerPrepared!: () => void
    const outerPreparedPromise = new Promise<void>((resolve) => {
      outerPrepared = resolve
    })
    const unsubscribe = subscribeFrameRenderLifecycle(session, () => {
      if (frameRenderLifecycleRevision(session) <= lifecycleRevision) return
      lifecycleRevision = frameRenderLifecycleRevision(session)
      const currentOuter = session.tree.getElementById("outer")
      if (currentOuter?.kind === "frame") {
        const acknowledgement = acknowledgeFrameRender(
          session,
          currentOuter,
          "outer",
          session.revision,
        )
        if (acknowledgement) {
          outerAcknowledgement = acknowledgement
          outerPrepared()
          return
        }
      }
      const currentInner = session.tree.getElementById("inner")
      if (currentInner?.kind === "frame") {
        const acknowledgement = acknowledgeFrameRender(
          session,
          currentInner,
          "inner",
          session.revision,
        )
        if (acknowledgement) {
          acknowledgement.finish()
          return
        }
      }
      const currentLeaf = session.tree.getElementById("leaf")
      if (currentLeaf?.kind === "frame") {
        acknowledgeFrameRender(session, currentLeaf, "leaf", session.revision)?.finish()
      }
    })

    await outer.connect()
    await inner.connect()
    await leaf.connect()
    const reloaded = outer.reload()
    expect(pending).toHaveLength(1)
    expect(pending[0]?.request.url).toBe("https://example.test/outer")
    pending[0]?.resolve(
      response(
        '<turbo-frame id="outer"><DemoPanel id="shell" tone="incoming"><turbo-frame id="inner" src="/inner" refresh="morph" loading="lazy"><Ignored id="inner-content" /><turbo-frame id="leaf" src="/leaf" refresh="morph" loading="lazy"><IgnoredLeaf id="leaf-content" /></turbo-frame></turbo-frame></DemoPanel></turbo-frame>',
        { url: "https://example.test/outer" },
      ),
    )

    await outerPreparedPromise
    expect(pending).toHaveLength(1)
    expect(session.tree.getElementById("inner")).toBe(innerFrame)
    expect(session.tree.getElementById("inner-content")).toBe(innerContent)
    expect(session.tree.getElementById("leaf")).toBe(leafFrame)
    expect(session.tree.getElementById("leaf-content")).toBe(leafContent)
    expect(innerContent.tagName).toBe("Before")

    outerAcknowledgement?.finish()
    expect(await reloaded).toMatchObject({ frameId: "outer", status: "completed" })
    expect(pending).toHaveLength(2)
    expect(pending[1]?.request.url).toBe("https://example.test/inner")
    expect(events).toEqual(["morph:outer", "render:outer", "load:outer"])

    pending[1]?.resolve(
      response(
        '<turbo-frame id="inner"><Before id="inner-content" tone="after" /><turbo-frame id="leaf" src="/leaf" refresh="morph" loading="lazy"><IgnoredLeaf id="leaf-content" /></turbo-frame></turbo-frame>',
        { url: "https://example.test/inner" },
      ),
    )
    expect(await inner.loaded).toMatchObject({ frameId: "inner", status: "completed" })
    expect(session.tree.getElementById("inner")).toBe(innerFrame)
    expect(session.tree.getElementById("inner-content")).toBe(innerContent)
    expect(attributeValue(innerContent, "tone")).toBe("after")
    expect(pending).toHaveLength(3)
    expect(pending[2]?.request.url).toBe("https://example.test/leaf")
    expect(session.tree.getElementById("leaf")).toBe(leafFrame)
    expect(session.tree.getElementById("leaf-content")).toBe(leafContent)
    expect(events).toEqual([
      "morph:outer",
      "render:outer",
      "load:outer",
      "morph:inner",
      "render:inner",
      "load:inner",
    ])

    pending[2]?.resolve(
      response(
        '<turbo-frame id="leaf"><LeafBefore id="leaf-content" tone="after" /></turbo-frame>',
        {
          url: "https://example.test/leaf",
        },
      ),
    )
    expect(await leaf.loaded).toMatchObject({ frameId: "leaf", status: "completed" })
    expect(session.tree.getElementById("leaf")).toBe(leafFrame)
    expect(session.tree.getElementById("leaf-content")).toBe(leafContent)
    expect(attributeValue(leafContent, "tone")).toBe("after")
    expect(events).toEqual([
      "morph:outer",
      "render:outer",
      "load:outer",
      "morph:inner",
      "render:inner",
      "load:inner",
      "morph:leaf",
      "render:leaf",
      "load:leaf",
    ])

    unsubscribe()
    releaseLeaf()
    releaseInner()
    releaseOuter()
    registry.dispose()
  })

  test("cascades an acknowledged outer morph reload without lifecycle observers", async () => {
    const pending: PendingRequest[] = []
    const session = new DocumentSession(
      parseExpoTurboDocument(
        '<Gallery><turbo-frame id="outer" src="/outer" refresh="morph" loading="lazy"><turbo-frame id="inner" src="/inner" refresh="morph" loading="lazy"><Before id="inner-content" /></turbo-frame></turbo-frame></Gallery>',
        { url: "https://example.test/page" },
      ),
    )
    const outerFrame = session.tree.getElementById("outer")
    const innerFrame = session.tree.getElementById("inner")
    const innerContent = session.tree.getElementById("inner-content")
    if (outerFrame?.kind !== "frame" || innerFrame?.kind !== "frame" || !innerContent) {
      throw new Error("Frame fixture is missing")
    }
    const loader = new FrameRequestLoader(
      session,
      {
        fetch: (request) =>
          new Promise<TurboResponse>((resolve) => {
            pending.push({ request, resolve })
          }),
      },
      { next: () => `nested-without-lifecycle-${pending.length + 1}` },
    )
    const registry = new FrameControllerRegistry(session, loader)
    const outer = registry.get("outer")
    const inner = registry.get("inner")
    const releaseOuter = retainFrameRenderer(session, outerFrame)
    const releaseInner = retainFrameRenderer(session, innerFrame)
    let lifecycleRevision = frameRenderLifecycleRevision(session)
    const unsubscribe = subscribeFrameRenderLifecycle(session, () => {
      if (frameRenderLifecycleRevision(session) <= lifecycleRevision) return
      lifecycleRevision = frameRenderLifecycleRevision(session)
      for (const frameId of ["outer", "inner"]) {
        const current = session.tree.getElementById(frameId)
        if (current?.kind !== "frame") continue
        const acknowledgement = acknowledgeFrameRender(session, current, frameId, session.revision)
        if (acknowledgement) {
          acknowledgement.finish()
          return
        }
      }
    })

    await outer.connect()
    await inner.connect()
    const reloaded = outer.reload()
    pending[0]?.resolve(
      response(
        '<turbo-frame id="outer"><turbo-frame id="inner" src="/inner" refresh="morph" loading="lazy"><Ignored id="inner-content" /></turbo-frame></turbo-frame>',
        { url: "https://example.test/outer" },
      ),
    )

    await expect(reloaded).resolves.toMatchObject({ frameId: "outer", status: "completed" })
    expect(session.tree.getElementById("inner")).toBe(innerFrame)
    expect(session.tree.getElementById("inner-content")).toBe(innerContent)
    expect(pending).toHaveLength(2)
    pending[1]?.resolve(
      response('<turbo-frame id="inner"><Loaded id="inner-content" /></turbo-frame>', {
        url: "https://example.test/inner",
      }),
    )
    await expect(inner.loaded).resolves.toMatchObject({ frameId: "inner", status: "completed" })
    expect(session.tree.getElementById("inner-content")?.kind).toBe("element")
    expect(
      (session.tree.getElementById("inner-content") as { tagName?: string } | undefined)?.tagName,
    ).toBe("Loaded")

    unsubscribe()
    releaseInner()
    releaseOuter()
    registry.dispose()
  })

  test("keeps non-exact refresh values on the ordinary replacement path", async () => {
    for (const refresh of ["Morph", "MORPH", " morph"]) {
      const { controller, pending, session } = harness(`src="/frame" refresh="${refresh}"`)
      const initial = controller.connect()
      pending[0]?.resolve(
        response('<turbo-frame id="details"><Stable id="stable" /></turbo-frame>'),
      )
      await initial
      const stable = session.tree.getElementById("stable")
      if (!stable) throw new Error("initial Frame response did not commit")

      const reloaded = controller.reload()
      pending[1]?.resolve(
        response('<turbo-frame id="details"><Stable id="stable" /></turbo-frame>'),
      )
      await reloaded

      expect(session.tree.getElementById("stable")).not.toBe(stable)
    }
  })

  test("captures direct reload morph intent before the response arrives", async () => {
    const { controller, pending, session } = harness('src="/frame" refresh="morph"')
    const initial = controller.connect()
    pending[0]?.resolve(response('<turbo-frame id="details"><Stable id="stable" /></turbo-frame>'))
    await initial
    const stable = session.tree.getElementById("stable")
    const frame = session.tree.getElementById("details")
    if (!stable || frame?.kind !== "frame") throw new Error("initial Frame response did not commit")

    const reloaded = controller.reload()
    session.removeAttribute(frame.key, "refresh")
    pending[1]?.resolve(response('<turbo-frame id="details"><Stable id="stable" /></turbo-frame>'))
    await reloaded

    expect(session.tree.getElementById("stable")).toBe(stable)
  })

  test("keeps a direct reload resolved through recurse on the replacement path", async () => {
    const session = new DocumentSession(
      parseExpoTurboDocument(
        '<Gallery><turbo-frame id="details" src="/frame" refresh="morph"><Loading /></turbo-frame></Gallery>',
        { url: "https://example.test/page" },
      ),
    )
    const lifecycle = new FrameLifecycle()
    const renderMethods: string[] = []
    lifecycle.subscribe("before-frame-render", (event) => {
      renderMethods.push(event.detail.renderMethod)
      return undefined
    })
    let request = 0
    const controller = new FrameController(
      session,
      "details",
      new FrameRequestLoader(
        session,
        {
          fetch: async () => {
            request += 1
            if (request === 1) {
              return response(
                '<turbo-frame id="details"><Stable id="stable" tone="initial" /></turbo-frame>',
              )
            }
            if (request === 2) {
              return response(
                '<Gallery><turbo-frame id="bridge" src="/nested" recurse="details" /></Gallery>',
              )
            }
            return response(
              '<turbo-frame id="details"><Stable id="stable" tone="recursive" /></turbo-frame>',
            )
          },
        },
        { next: () => `recurse-${request + 1}` },
        { frameLifecycle: lifecycle },
      ),
    )

    await controller.connect()
    const stable = session.tree.getElementById("stable")
    if (!stable) throw new Error("initial Frame response did not commit")
    renderMethods.length = 0

    await controller.reload()

    const recursive = session.tree.getElementById("stable")
    if (!recursive) throw new Error("recursive Frame response did not commit")
    expect(recursive).not.toBe(stable)
    expect(attributeValue(recursive, "tone")).toBe("recursive")
    expect(renderMethods).toEqual(["replace"])
  })

  test("admits a newly permanent stable Frame child through the normal morph lifecycle", async () => {
    const lifecycle = new FrameLifecycle()
    const { controller, pending, session } = harness('src="/frame" refresh="morph"', undefined, {
      frameLifecycle: lifecycle,
    })
    const frame = session.tree.getElementById("details")
    if (frame?.kind !== "frame") throw new Error("Frame fixture is missing")
    const events: string[] = []
    lifecycle.subscribe("before-frame-render", () => {
      events.push("before")
      return undefined
    })
    const initial = controller.connect()
    pending[0]?.resolve(response('<turbo-frame id="details"><Stable id="stable" /></turbo-frame>'))
    await initial
    const stable = session.tree.getElementById("stable")
    if (!stable) throw new Error("initial Frame response did not commit")
    events.length = 0

    const reloaded = controller.reload()
    pending[1]?.resolve(
      response(
        '<turbo-frame id="details"><Stable id="stable" data-turbo-permanent="" /></turbo-frame>',
      ),
    )
    await reloaded
    expect(controller.state.status).toBe("completed")
    expect(session.tree.getElementById("stable")).toBe(stable)
    expect(attributeValue(stable, "data-turbo-permanent")).toBe("")
    expect(events).toEqual(["before"])
  })

  test("keeps a mounted Frame busy until its exact replacement commits without lifecycle observers", async () => {
    const { controller, pending, session } = harness()
    const frame = session.tree.getElementById("details")
    if (frame?.kind !== "frame") throw new Error("Frame fixture is missing")
    const releaseRenderer = retainFrameRenderer(session, frame)
    let lifecycleRevision = frameRenderLifecycleRevision(session)
    let resolveSealed!: () => void
    const renderSealed = new Promise<void>((resolve) => {
      resolveSealed = resolve
    })
    let acknowledge!: () => void
    const sealed = new Promise<void>((resolve) => {
      acknowledge = () => {
        const acknowledgement = acknowledgeFrameRender(session, frame, "details", session.revision)
        expect(acknowledgement).toBeDefined()
        acknowledgement?.finish()
        resolve()
      }
    })
    const unsubscribe = subscribeFrameRenderLifecycle(session, () => {
      if (frameRenderLifecycleRevision(session) <= lifecycleRevision) return
      lifecycleRevision = frameRenderLifecycleRevision(session)
      resolveSealed()
    })

    const loaded = controller.connect()
    pending[0]?.resolve(response('<turbo-frame id="details"><Committed /></turbo-frame>'))
    await renderSealed

    expect(controller.state).toMatchObject({ busy: true, complete: false, status: "loading" })
    acknowledge()
    await sealed
    expect(await loaded).toMatchObject({ status: "completed" })
    expect(controller.state).toMatchObject({ busy: false, complete: true, status: "completed" })

    unsubscribe()
    releaseRenderer()
  })

  test("suppresses a prior Frame load when its render observer reloads", async () => {
    const pending: PendingRequest[] = []
    const session = new DocumentSession(
      parseExpoTurboDocument(
        '<Gallery><turbo-frame id="details" src="/frame"><Loading /></turbo-frame></Gallery>',
        { url: "https://example.test/page" },
      ),
    )
    const frame = session.tree.getElementById("details")
    if (frame?.kind !== "frame") throw new Error("Frame fixture is missing")
    const lifecycle = new FrameLifecycle()
    const loader = new FrameRequestLoader(
      session,
      {
        fetch: (request) =>
          new Promise<TurboResponse>((resolve) => {
            pending.push({ request, resolve })
          }),
      },
      { next: () => `request-${pending.length + 1}` },
      { frameLifecycle: lifecycle },
    )
    const controller = new FrameController(session, "details", loader)
    const releaseRenderer = retainFrameRenderer(session, frame)
    let lifecycleRevision = frameRenderLifecycleRevision(session)
    const unsubscribe = subscribeFrameRenderLifecycle(session, () => {
      if (frameRenderLifecycleRevision(session) <= lifecycleRevision) return
      lifecycleRevision = frameRenderLifecycleRevision(session)
      const current = session.tree.getElementById("details")
      if (current?.kind !== "frame") throw new Error("Frame fixture was replaced")
      acknowledgeFrameRender(session, current, "details", session.revision)?.finish()
    })
    const events: string[] = []
    let second: Promise<unknown> | undefined
    let resolveFirstRender!: () => void
    const firstRender = new Promise<void>((resolve) => {
      resolveFirstRender = resolve
    })
    lifecycle.subscribe("frame-render", () => {
      events.push("render")
      if (!second) {
        second = controller.reload()
        resolveFirstRender()
      }
      return undefined
    })
    lifecycle.subscribe("frame-load", () => {
      events.push("load")
      return undefined
    })

    const first = controller.connect()
    pending[0]?.resolve(response('<turbo-frame id="details"><First /></turbo-frame>'))
    await firstRender
    expect(pending).toHaveLength(2)
    expect(events).toEqual(["render"])

    pending[1]?.resolve(response('<turbo-frame id="details"><Second /></turbo-frame>'))
    await expect(first).resolves.toMatchObject({ status: "completed" })
    await expect(second).resolves.toMatchObject({ status: "completed" })
    expect(events).toEqual(["render", "render", "load"])

    unsubscribe()
    releaseRenderer()
  })

  test("suppresses Frame load when its render observer disconnects the controller", async () => {
    const session = new DocumentSession(
      parseExpoTurboDocument(
        '<Gallery><turbo-frame id="details" src="/frame"><Loading /></turbo-frame></Gallery>',
        { url: "https://example.test/page" },
      ),
    )
    const frame = session.tree.getElementById("details")
    if (frame?.kind !== "frame") throw new Error("Frame fixture is missing")
    const lifecycle = new FrameLifecycle()
    const releaseRenderer = retainFrameRenderer(session, frame)
    let lifecycleRevision = frameRenderLifecycleRevision(session)
    const unsubscribe = subscribeFrameRenderLifecycle(session, () => {
      if (frameRenderLifecycleRevision(session) <= lifecycleRevision) return
      lifecycleRevision = frameRenderLifecycleRevision(session)
      acknowledgeFrameRender(session, frame, "details", session.revision)?.finish()
    })
    const controller = new FrameController(
      session,
      "details",
      new FrameRequestLoader(
        session,
        {
          fetch: async () => response('<turbo-frame id="details"><Committed /></turbo-frame>'),
        },
        { next: () => "disconnect-render" },
        { frameLifecycle: lifecycle },
      ),
    )
    const events: string[] = []
    lifecycle.subscribe("frame-render", () => {
      events.push("render")
      controller.disconnect()
      return undefined
    })
    lifecycle.subscribe("frame-load", () => {
      events.push("load")
      return undefined
    })

    await expect(controller.connect()).resolves.toMatchObject({ status: "completed" })
    expect(events).toEqual(["render"])
    expect(controller.state.connected).toBe(false)

    unsubscribe()
    releaseRenderer()
  })

  test("suppresses Frame load when its render observer releases the final renderer", async () => {
    const session = new DocumentSession(
      parseExpoTurboDocument(
        '<Gallery><turbo-frame id="details" src="/frame"><Loading /></turbo-frame></Gallery>',
        { url: "https://example.test/page" },
      ),
    )
    const frame = session.tree.getElementById("details")
    if (frame?.kind !== "frame") throw new Error("Frame fixture is missing")
    const lifecycle = new FrameLifecycle()
    const releaseRenderer = retainFrameRenderer(session, frame)
    let lifecycleRevision = frameRenderLifecycleRevision(session)
    const unsubscribe = subscribeFrameRenderLifecycle(session, () => {
      if (frameRenderLifecycleRevision(session) <= lifecycleRevision) return
      lifecycleRevision = frameRenderLifecycleRevision(session)
      acknowledgeFrameRender(session, frame, "details", session.revision)?.finish()
    })
    const controller = new FrameController(
      session,
      "details",
      new FrameRequestLoader(
        session,
        {
          fetch: async () => response('<turbo-frame id="details"><Committed /></turbo-frame>'),
        },
        { next: () => "release-renderer" },
        { frameLifecycle: lifecycle },
      ),
    )
    const events: string[] = []
    lifecycle.subscribe("frame-render", () => {
      events.push("render")
      releaseRenderer()
      return undefined
    })
    lifecycle.subscribe("frame-load", () => {
      events.push("load")
      return undefined
    })

    await expect(controller.connect()).resolves.toMatchObject({ status: "completed" })
    expect(events).toEqual(["render"])

    unsubscribe()
  })

  test("supersedes an unacknowledged Frame render before a newer load", async () => {
    const pending: PendingRequest[] = []
    const session = new DocumentSession(
      parseExpoTurboDocument(
        '<Gallery><turbo-frame id="details" src="/frame"><Loading /></turbo-frame></Gallery>',
        { url: "https://example.test/page" },
      ),
    )
    const frame = session.tree.getElementById("details")
    if (frame?.kind !== "frame") throw new Error("Frame fixture is missing")
    const lifecycle = new FrameLifecycle()
    const events: string[] = []
    lifecycle.subscribe("frame-render", () => {
      events.push("render")
      return undefined
    })
    lifecycle.subscribe("frame-load", () => {
      events.push("load")
      return undefined
    })
    const loader = new FrameRequestLoader(
      session,
      {
        fetch: (request) =>
          new Promise<TurboResponse>((resolve) => {
            pending.push({ request, resolve })
          }),
      },
      { next: () => `request-${pending.length + 1}` },
      { frameLifecycle: lifecycle },
    )
    const controller = new FrameController(session, "details", loader)
    const releaseRenderer = retainFrameRenderer(session, frame)
    const initialRevision = frameRenderLifecycleRevision(session)
    let resolveSealed!: () => void
    const sealed = new Promise<void>((resolve) => {
      resolveSealed = resolve
    })
    const unsubscribe = subscribeFrameRenderLifecycle(session, () => {
      if (frameRenderLifecycleRevision(session) > initialRevision) resolveSealed()
    })

    const first = controller.connect()
    pending[0]?.resolve(response('<turbo-frame id="details"><First /></turbo-frame>'))
    await sealed
    expect(hasFrameRenderTicket(session, frame, "details")).toBe(true)

    const second = controller.reload()
    expect(pending).toHaveLength(2)
    expect(hasFrameRenderTicket(session, frame, "details")).toBe(false)
    pending[1]?.resolve(response("", { status: 204 }))

    await expect(first).resolves.toMatchObject({ status: "completed" })
    await expect(second).resolves.toMatchObject({ status: "empty" })
    expect(events).toEqual([])
    expect(controller.state).toMatchObject({ busy: false, status: "empty" })

    unsubscribe()
    releaseRenderer()
  })

  test("publishes automatic response promotion as loaded without mutating Frame children", async () => {
    const session = new DocumentSession(
      parseExpoTurboDocument(
        '<Gallery><turbo-frame id="details" src="/frame"><Loading /></turbo-frame></Gallery>',
        { url: "https://example.test/page" },
      ),
    )
    const frame = session.tree.getElementById("details")
    const children = frame?.children
    const visits: unknown[] = []
    const controller = new FrameController(
      session,
      "details",
      new FrameRequestLoader(
        session,
        {
          fetch: async () =>
            response(
              '<Gallery data-turbo-visit-control="reload"><turbo-frame id="details"><Ignored /></turbo-frame></Gallery>',
              { url: "https://example.test/promoted" },
            ),
        },
        { next: () => "request-promoted" },
        {
          frameLifecycle: new FrameLifecycle({
            visitResponse(request) {
              visits.push(request)
            },
          }),
        },
      ),
    )

    expect(await controller.connect()).toMatchObject({
      reason: "visit-control-reload",
      status: "promoted",
    })
    expect(controller.state).toMatchObject({
      busy: false,
      complete: true,
      hasBeenLoaded: true,
      status: "promoted",
    })
    expect(frame?.children).toBe(children)
    expect(visits).toHaveLength(1)
  })

  test("settles promoted controller truth when the response visitor replaces the whole document", async () => {
    const session = new DocumentSession(
      parseExpoTurboDocument(
        '<Gallery><turbo-frame id="details" src="/frame"><Loading /></turbo-frame></Gallery>',
        { url: "https://example.test/page" },
      ),
    )
    const body =
      '<Gallery data-turbo-visit-control="reload"><PromotedDocument id="promoted-document" /></Gallery>'
    const errors: Error[] = []
    const loader = new FrameRequestLoader(
      session,
      {
        fetch: async () => response(body, { url: "https://example.test/promoted" }),
      },
      { next: () => "request-document-replacement" },
      {
        frameLifecycle: new FrameLifecycle({
          visitResponse(request) {
            session.replaceTree(parseExpoTurboDocument(request.body, { url: request.response.url }))
          },
        }),
      },
    )
    const controller = new FrameControllerRegistry(session, loader).get("details")
    controller.subscribeErrors((error) => errors.push(error))

    expect(await controller.connect()).toMatchObject({
      reason: "visit-control-reload",
      status: "promoted",
    })
    expect(controller.state).toMatchObject({
      busy: false,
      complete: true,
      connected: false,
      hasBeenLoaded: true,
      status: "promoted",
    })
    expect(session.tree.getElementById("details")).toBeUndefined()
    expect(session.tree.getElementById("promoted-document")).toBeDefined()
    expect(errors).toEqual([])
  })

  test("publishes each committed autofocus intent once and clears it after consumption", async () => {
    const { controller, pending } = harness()
    const loaded = controller.connect()
    pending[0]?.resolve(
      response(
        '<turbo-frame id="details"><Field id="first" autofocus="" /><Field id="second" autofocus="false" /></turbo-frame>',
      ),
    )

    expect(await loaded).toMatchObject({
      frame: { frameId: "details" },
      status: "completed",
    })
    const firstRevision = controller.state.revision
    expect(consumeFrameAutofocus(controller, firstRevision - 1)).toBeUndefined()
    const first = consumeFrameAutofocus(controller, firstRevision)
    expect(first).toEqual(["id:first", "id:second"])
    expect(Object.isFrozen(first)).toBe(true)
    expect(consumeFrameAutofocus(controller, controller.state.revision)).toBeUndefined()

    const reloaded = controller.reload()
    pending[1]?.resolve(
      response('<turbo-frame id="details"><Field id="latest" autofocus="" /></turbo-frame>'),
    )
    await reloaded
    const latestRevision = controller.state.revision
    expect(consumeFrameAutofocus(controller, firstRevision)).toBeUndefined()
    expect(consumeFrameAutofocus(controller, latestRevision)).toEqual(["id:latest"])
    expect(consumeFrameAutofocus(controller, controller.state.revision)).toBeUndefined()
  })

  test("publishes mounted Frame autoscroll once and clears it when visual work is canceled", async () => {
    const { controller, pending, session } = harness(
      'src="/frame" autoscroll="" data-autoscroll-block="start" data-autoscroll-behavior="smooth"',
    )
    const frame = session.tree.getElementById("details")
    if (frame?.kind !== "frame") throw new Error("Frame fixture is missing")
    const releaseRenderer = retainFrameRenderer(session, frame)
    let lifecycleRevision = frameRenderLifecycleRevision(session)
    let resolveSealed: (() => void) | undefined
    const waitForSeal = () =>
      new Promise<void>((resolve) => {
        resolveSealed = resolve
      })
    const unsubscribe = subscribeFrameRenderLifecycle(session, () => {
      if (frameRenderLifecycleRevision(session) <= lifecycleRevision) return
      lifecycleRevision = frameRenderLifecycleRevision(session)
      resolveSealed?.()
      resolveSealed = undefined
    })

    const loaded = controller.connect()
    const firstSealed = waitForSeal()
    pending[0]?.resolve(response('<turbo-frame id="details"><Loaded /></turbo-frame>'))
    await firstSealed

    expect(consumeFrameRenderEffects(controller, controller.state.revision)).toEqual({
      autoscroll: { alignment: "start", behavior: "smooth", frameId: "details" },
    })
    expect(consumeFrameRenderEffects(controller, controller.state.revision)).toBeUndefined()

    acknowledgeFrameRender(session, frame, "details", session.revision)?.finish()
    await expect(loaded).resolves.toMatchObject({ status: "completed" })

    const canceled = controller.reload()
    const cancellationSealed = waitForSeal()
    pending[1]?.resolve(response('<turbo-frame id="details"><Canceled /></turbo-frame>'))
    await cancellationSealed
    await controller.setDisabled(true)

    expect(consumeFrameRenderEffects(controller, controller.state.revision)).toBeUndefined()
    await expect(canceled).resolves.toMatchObject({ status: "completed" })

    unsubscribe()
    releaseRenderer()
  })

  test("keeps Frame autoscroll bound to its exact mounted wrapper", async () => {
    {
      const { controller, pending, session } = harness('src="/frame" autoscroll=""')
      const loaded = controller.connect()
      pending[0]?.resolve(
        response('<turbo-frame id="details"><Loaded id="loaded" /></turbo-frame>'),
      )
      await loaded
      session.setAttribute("id:loaded", "data-unrelated", "true")

      expect(consumeFrameRenderEffects(controller, controller.state.revision)).toEqual({
        autoscroll: { alignment: "end", behavior: "auto", frameId: "details" },
      })
    }

    {
      const { controller, pending, session } = harness('src="/frame" autoscroll=""')
      const loaded = controller.connect()
      pending[0]?.resolve(response('<turbo-frame id="details"><Loaded /></turbo-frame>'))
      await loaded
      session.replaceTree(
        parseExpoTurboDocument(
          '<Gallery><turbo-frame id="details"><Replacement /></turbo-frame></Gallery>',
          { url: "https://example.test/page" },
        ),
      )

      expect(consumeFrameRenderEffects(controller, controller.state.revision)).toBeUndefined()
    }
  })

  test("cancels on disable, source replacement, and disconnect without stale state commits", async () => {
    const { controller, pending } = harness()

    const initial = controller.connect()
    expect(pending[0]?.request.signal?.aborted).toBe(false)
    await controller.setDisabled(true)
    expect(pending[0]?.request.signal?.aborted).toBe(true)
    expect(controller.state).toMatchObject({ disabled: true, status: "canceled" })
    pending[0]?.resolve(response('<turbo-frame id="details"><Stale /></turbo-frame>'))
    expect(await initial).toMatchObject({ status: "canceled" })

    const retried = controller.setDisabled(false)
    expect(pending).toHaveLength(2)
    pending[1]?.resolve(response('<turbo-frame id="details"><Loaded /></turbo-frame>'))
    expect(await retried).toMatchObject({ status: "completed" })

    await controller.setLoading("lazy")
    const changed = controller.setSource("/next")
    expect(pending).toHaveLength(3)
    expect(pending[2]?.request.url).toBe("https://example.test/next")
    controller.disconnect()
    expect(pending[2]?.request.signal?.aborted).toBe(true)
    pending[2]?.resolve(response('<turbo-frame id="details"><Late /></turbo-frame>'))
    expect(await changed).toMatchObject({ status: "canceled" })
    expect(controller.state).toMatchObject({ connected: false, status: "canceled" })
  })

  test("reconciles externally morphed source, disabled, loading, and target attributes", async () => {
    let visible = false
    let visibilityListener: ((visible: boolean) => void) | undefined
    let visibilityUnsubscribed = 0
    const visibility: VisibilityAdapter = {
      isVisible: () => visible,
      subscribe(_frameId, listener) {
        visibilityListener = listener
        return () => {
          visibilityListener = undefined
          visibilityUnsubscribed += 1
        }
      },
    }
    const { controller, pending, session } = harness('src="/frame" target="before"', visibility)
    const frame = session.tree.getElementById("details")
    if (frame?.kind !== "frame") throw new Error("Frame fixture is missing")

    const initial = controller.connect()
    session.setAttribute(frame.key, "src", "/next")
    session.setAttribute(frame.key, "target", "after")
    const changed = controller.reconcileAttributes()

    expect(pending).toHaveLength(2)
    expect(pending[0]?.request.signal?.aborted).toBe(true)
    expect(pending[1]?.request.url).toBe("https://example.test/next")
    expect(controller.state).toMatchObject({
      source: "/next",
      target: "after",
      status: "loading",
    })
    pending[0]?.resolve(response('<turbo-frame id="details"><Stale /></turbo-frame>'))
    pending[1]?.resolve(response('<turbo-frame id="details"><Current /></turbo-frame>'))
    expect(await initial).toMatchObject({ status: "canceled" })
    expect(await changed).toMatchObject({ status: "completed" })

    session.setAttribute(frame.key, "disabled", "")
    await controller.reconcileAttributes()
    expect(controller.state).toMatchObject({ disabled: true })

    session.setAttribute(frame.key, "src", "/visible")
    await controller.reconcileAttributes()
    session.removeAttribute(frame.key, "disabled")
    session.setAttribute(frame.key, "loading", "lazy")
    await controller.reconcileAttributes()
    expect(controller.state).toMatchObject({
      disabled: false,
      loading: "lazy",
      source: "/visible",
    })
    expect(visibilityListener).toBeDefined()

    visible = true
    visibilityListener?.(true)
    expect(pending).toHaveLength(3)
    expect(visibilityUnsubscribed).toBe(1)
    pending[2]?.resolve(response('<turbo-frame id="details"><Visible /></turbo-frame>'))
    await expect(controller.loaded).resolves.toMatchObject({ status: "completed" })

    session.removeAttribute(frame.key, "src")
    await controller.reconcileAttributes()
    expect(controller.state).toMatchObject({ status: "idle" })
    expect(controller.state.source).toBeUndefined()
  })

  test("defers lazy sources until load, reloads the same source, and removes src", async () => {
    const { controller, pending, session } = harness('src="/frame" loading="lazy"')

    expect(await controller.connect()).toBeUndefined()
    expect(pending).toHaveLength(0)

    const first = controller.load()
    expect(pending).toHaveLength(1)
    pending[0]?.resolve(response('<turbo-frame id="details"><First /></turbo-frame>'))
    expect(await first).toMatchObject({ status: "completed" })

    const second = controller.reload()
    expect(pending).toHaveLength(2)
    pending[1]?.resolve(response('<turbo-frame id="details"><Second /></turbo-frame>'))
    expect(await second).toMatchObject({ status: "completed" })

    await controller.setSource(null)
    expect(controller.state.source).toBeUndefined()
    const frame = session.tree.getElementById("details")
    if (!frame) throw new Error("fixture lost its active frame")
    expect(attributeValue(frame, "src")).toBeUndefined()
  })

  test("loads a lazy source on first visibility and releases the observer", async () => {
    let listener: ((visible: boolean) => void) | undefined
    let visible = false
    let unsubscribed = 0
    const visibility: VisibilityAdapter = {
      isVisible: () => visible,
      subscribe(frameId, next) {
        expect(frameId).toBe("details")
        listener = next
        return () => {
          listener = undefined
          unsubscribed += 1
        }
      },
    }
    const { controller, pending } = harness('src="/frame" loading="lazy"', visibility)

    expect(await controller.connect()).toBeUndefined()
    expect(pending).toHaveLength(0)
    visible = true
    listener?.(true)
    expect(pending).toHaveLength(1)
    expect(unsubscribed).toBe(1)
    pending[0]?.resolve(response('<turbo-frame id="details"><Visible /></turbo-frame>'))
    expect(await controller.loaded).toMatchObject({ status: "completed" })
    expect(controller.state).toMatchObject({ hasBeenLoaded: true, status: "completed" })
  })

  test("prevents a stale direct controller from owning a same-id replacement", async () => {
    const { controller, loader, pending, session } = harness()
    const originalLoad = controller.connect()

    await dispatchTurboStreamFragment(
      session,
      '<turbo-stream action="replace" target="details"><template><turbo-frame id="details" src="/replacement"><Replacement/></turbo-frame></template></turbo-stream>',
    )
    expect(pending[0]?.request.signal?.aborted).toBe(false)
    pending[0]?.resolve(response('<turbo-frame id="details"><Late/></turbo-frame>'))
    expect(await originalLoad).toMatchObject({ status: "canceled" })
    expect(session.tree.getElementById("details")?.children.filter(isElement)[0]?.tagName).toBe(
      "Replacement",
    )

    const replacement = new FrameController(session, "details", loader)
    const replacementLoad = replacement.connect()
    expect(pending).toHaveLength(2)
    controller.cancel()
    expect(pending[1]?.request.signal?.aborted).toBe(false)
    replacement.cancel()
    expect(pending[1]?.request.signal?.aborted).toBe(true)
    pending[1]?.resolve(response('<turbo-frame id="details"><AlsoLate/></turbo-frame>'))
    expect(await replacementLoad).toMatchObject({ status: "canceled" })
  })

  test("publishes committed lifecycle truth when Frame finalization reports an error", async () => {
    const { controller, pending, session } = harness()
    const frame = session.tree.getElementById("details")
    const child = frame?.children[0]
    if (!child) throw new Error("fixture Frame child is missing")
    session.registerDisposal(child.key, () => {
      throw new Error("secret disposal failure")
    })
    const errors: Error[] = []
    controller.subscribeErrors((error) => errors.push(error))

    const loaded = controller.connect()
    pending[0]?.resolve(response('<turbo-frame id="details"><Committed /></turbo-frame>'))
    await expect(loaded).rejects.toBeInstanceOf(FrameCommitError)

    expect(controller.state).toMatchObject({
      busy: false,
      complete: true,
      hasBeenLoaded: true,
      status: "completed",
    })
    expect(errors).toHaveLength(1)
    expect(errors[0]).toBeInstanceOf(FrameCommitError)
    expect(frame?.children.filter(isElement)[0]?.tagName).toBe("Committed")
  })
})
