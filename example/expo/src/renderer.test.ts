/// <reference types="bun" />

import { describe, expect, test } from "bun:test"
import { createElement, type ReactNode } from "react"
import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { z } from "zod"

import type { TurboRequest, TurboResponse } from "expo-turbo/adapters"
import {
  applyFrameResponse,
  dispatchTurboStreamFragment,
  DocumentSession,
  EXPO_TURBO_MIME_TYPE,
  type FrameControllerCollection,
  FrameControllerRegistry,
  FrameMissingError,
  FrameRequestLoader,
  parseExpoTurboDocument,
} from "expo-turbo/core"
import {
  createRegistry,
  defineComponent,
  defineComponentModule,
  stringCodec,
} from "expo-turbo/registry"
import { ExpoTurboProvider, type ExpoTurboRenderError, ExpoTurboRoot } from "expo-turbo/react"

const globalWithAct = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean
}
globalWithAct.IS_REACT_ACT_ENVIRONMENT = true

function host(type: string, props: Readonly<{ children?: ReactNode }>): ReactNode {
  return createElement(type, null, props.children)
}

function registryWithCounters(counters = { left: 0, right: 0 }) {
  const gallery = defineComponent({
    attributes: {},
    children: "nodes",
    component: (props) => host("gallery", props),
    schema: z.object({}),
    tag: "Gallery",
  })
  const left = defineComponent({
    attributes: { title: { codec: stringCodec, prop: "title" } },
    children: "none",
    component: (props) => {
      counters.left += 1
      return createElement("card", { side: "left", title: props.title })
    },
    schema: z.object({ title: z.string() }),
    tag: "DemoLeft",
  })
  const right = defineComponent({
    attributes: { title: { codec: stringCodec, prop: "title" } },
    children: "none",
    component: (props) => {
      counters.right += 1
      return createElement("card", { side: "right", title: props.title })
    },
    schema: z.object({ title: z.string() }),
    tag: "DemoRight",
  })
  const text = defineComponent({
    attributes: {},
    children: "text",
    component: (props) => host("text", props),
    schema: z.object({}),
    tag: "DemoText",
  })
  return createRegistry(
    defineComponentModule({
      components: [gallery, left, right, text],
      name: "renderer-fixtures",
      version: "0.1.0",
    }),
  )
}

function render(
  session: DocumentSession,
  registry: ReturnType<typeof registryWithCounters>,
  options: Readonly<{
    frames?: FrameControllerCollection
    onError?: (event: ExpoTurboRenderError) => void
    renderError?: (event: ExpoTurboRenderError) => ReactNode
  }> = {},
): ReactTestRenderer {
  let renderer: ReactTestRenderer | undefined
  act(() => {
    renderer = create(
      createElement(
        ExpoTurboProvider,
        { registry, session, ...options },
        createElement(ExpoTurboRoot),
      ),
    )
  })
  if (!renderer) throw new Error("renderer was not created")
  return renderer
}

describe("React protocol renderer", () => {
  test("renders registered nodes while omitting comments, templates, Streams, and sources", () => {
    const tree = parseExpoTurboDocument(`<Gallery>
      <!-- ignored -->
      <turbo-frame id="frame"><DemoText>Frame text</DemoText></turbo-frame>
      <template><DemoText>Template text</DemoText></template>
      <turbo-stream action="remove" target="stale"></turbo-stream>
      <turbo-cable-stream-source channel="DemoChannel" />
    </Gallery>`)
    const renderer = render(new DocumentSession(tree), registryWithCounters())
    const output = JSON.stringify(renderer.toJSON())

    expect(output).toContain("Frame text")
    expect(output).not.toContain("Template text")
    expect(output).not.toContain("DemoChannel")
  })

  test("keeps node snapshots stable and rerenders only the changed registered subtree", () => {
    const counters = { left: 0, right: 0 }
    const session = new DocumentSession(
      parseExpoTurboDocument(
        '<Gallery><DemoLeft id="left" title="Left"/><DemoRight id="right" title="Right"/></Gallery>',
      ),
    )
    const renderer = render(session, registryWithCounters(counters))
    const leftBefore = session.getNodeSnapshot("id:left")
    const rightBefore = session.getNodeSnapshot("id:right")

    expect(counters).toEqual({ left: 1, right: 1 })
    act(() => session.setAttribute("id:left", "title", "Updated"))

    expect(counters).toEqual({ left: 2, right: 1 })
    expect(session.getNodeSnapshot("id:left")).not.toBe(leftBefore)
    expect(session.getNodeSnapshot("id:right")).toBe(rightBefore)
    expect(JSON.stringify(renderer.toJSON())).toContain("Updated")
  })

  test("renders an ordered Stream update through the same document session", () => {
    const session = new DocumentSession(
      parseExpoTurboDocument('<Gallery><DemoText id="copy">Before</DemoText></Gallery>'),
    )
    const renderer = render(session, registryWithCounters())

    act(() => {
      dispatchTurboStreamFragment(
        session,
        '<turbo-stream action="update" target="copy"><template>After</template></turbo-stream>',
      )
    })

    expect(JSON.stringify(renderer.toJSON())).not.toContain("Before")
    expect(JSON.stringify(renderer.toJSON())).toContain("After")
  })

  test("renders a matching Frame response without replacing its mounted wrapper", () => {
    const session = new DocumentSession(
      parseExpoTurboDocument(
        '<Gallery><turbo-frame id="frame"><DemoText>Before</DemoText></turbo-frame></Gallery>',
      ),
    )
    const frame = session.tree.getElementById("frame")
    const renderer = render(session, registryWithCounters())

    act(() => {
      applyFrameResponse(
        session,
        "frame",
        '<turbo-frame id="frame"><DemoText>After</DemoText></turbo-frame>',
      )
    })

    expect(session.tree.getElementById("frame")).toBe(frame)
    expect(JSON.stringify(renderer.toJSON())).not.toContain("Before")
    expect(JSON.stringify(renderer.toJSON())).toContain("After")
  })

  test("connects eager Frame controllers and cancels them when a subtree unmounts", async () => {
    const pending: {
      request: TurboRequest
      resolve: (response: TurboResponse) => void
    }[] = []
    const session = new DocumentSession(
      parseExpoTurboDocument(
        '<Gallery><turbo-frame id="frame" src="/frame"><DemoText>Before</DemoText></turbo-frame></Gallery>',
        { url: "https://example.test/gallery" },
      ),
    )
    let requestId = 0
    const frames = new FrameControllerRegistry(
      session,
      new FrameRequestLoader(
        session,
        {
          fetch: (request) =>
            new Promise<TurboResponse>((resolve) => pending.push({ request, resolve })),
        },
        { next: () => `request-${++requestId}` },
      ),
    )
    const renderer = render(session, registryWithCounters(), { frames })
    const controller = frames.get("frame")
    const turboResponse = (xml: string): TurboResponse => ({
      headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
      redirected: false,
      status: 200,
      text: async () => xml,
      url: "https://example.test/frame",
    })

    expect(pending).toHaveLength(1)
    expect(controller.state).toMatchObject({ busy: true, connected: true })
    await act(async () => {
      pending[0]?.resolve(turboResponse('<turbo-frame id="frame"><DemoText>Loaded</DemoText></turbo-frame>'))
      await controller.loaded
    })
    expect(JSON.stringify(renderer.toJSON())).toContain("Loaded")

    let changed: Promise<unknown> | undefined
    act(() => {
      changed = controller.setSource("/slow")
    })
    expect(pending).toHaveLength(2)
    act(() => {
      dispatchTurboStreamFragment(
        session,
        '<turbo-stream action="remove" target="frame"></turbo-stream>',
      )
    })
    expect(pending[1]?.request.signal?.aborted).toBe(true)
    expect(controller.state).toMatchObject({ connected: false, status: "canceled" })
    expect(() => frames.get("frame")).toThrow(FrameMissingError)
    pending[1]?.resolve(turboResponse('<turbo-frame id="frame"><DemoText>Late</DemoText></turbo-frame>'))
    await act(async () => {
      await changed
    })
    expect(JSON.stringify(renderer.toJSON())).not.toContain("Late")
  })

  test("contains unknown components behind an actionable retryable error surface", () => {
    const errors: ExpoTurboRenderError[] = []
    const session = new DocumentSession(
      parseExpoTurboDocument('<Gallery><Unknown id="unknown" /></Gallery>'),
    )
    const renderer = render(session, registryWithCounters(), {
      onError: (event) => errors.push(event),
      renderError: (event) => createElement("protocol-error", null, event.error.name),
    })

    expect(errors).toHaveLength(1)
    expect(errors[0]?.nodeKey).toBe("id:unknown")
    expect(JSON.stringify(renderer.toJSON())).toContain("RegistryError")
  })
})
