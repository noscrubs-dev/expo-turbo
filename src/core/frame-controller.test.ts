import { describe, expect, test } from "bun:test"

import type { TurboRequest, TurboResponse, VisibilityAdapter } from "../adapters"
import { consumeFrameAutofocus } from "./frame-autofocus-internal"
import { FrameController } from "./frame-controller"
import { FrameControllerRegistry } from "./frame-controller-registry"
import { FrameLifecycle } from "./frame-lifecycle"
import { EXPO_TURBO_MIME_TYPE, FrameCommitError, FrameRequestLoader } from "./frame-loader"
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

function harness(attributes = 'src="/frame"', visibility?: VisibilityAdapter) {
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
      expect(events).toEqual(["render", "load"])
      expect(controller.state).toMatchObject({ busy: false, status: "completed" })

      unsubscribe()
      releaseRenderer()
    }
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

    dispatchTurboStreamFragment(
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
