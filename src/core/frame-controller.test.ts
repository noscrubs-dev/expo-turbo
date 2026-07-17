import { describe, expect, test } from "bun:test"

import type { TurboRequest, TurboResponse, VisibilityAdapter } from "../adapters"
import { FrameController } from "./frame-controller"
import { EXPO_TURBO_MIME_TYPE, FrameRequestLoader } from "./frame-loader"
import { parseExpoTurboDocument } from "./parser"
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
})
