/// <reference types="bun" />

import { describe, expect, test } from "bun:test"
import { createElement, type ReactNode, StrictMode, useEffect, useState } from "react"
import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { z } from "zod"

import {
  defineStyleAdapter,
  type TurboRequest,
  type TurboResponse,
} from "expo-turbo/adapters"
import {
  applyFrameResponse,
  attributeValue,
  dispatchTurboStreamFragment,
  DocumentRequestLoader,
  DocumentStateScopes,
  DocumentStateStore,
  DocumentSession,
  DocumentVisitController,
  EXPO_TURBO_MIME_TYPE,
  type FrameController,
  type FrameControllerCollection,
  FrameControllerRegistry,
  FrameMissingError,
  FrameRequestLoader,
  parseExpoTurboDocument,
} from "expo-turbo/core"
import {
  createComponentActionRegistry,
  createComponentActionRunner,
  createRegistry,
  defineComponentAction,
  defineComponentActionModule,
  defineComponent,
  defineComponentModule,
  stringCodec,
  tokenListCodec,
} from "expo-turbo/registry"
import {
  createComponentStyleHook,
  type ExpoTurboDocumentBoundaryProps,
  type ExpoTurboFrameBoundaryProps,
  ExpoTurboProvider,
  type ExpoTurboProviderProps,
  type ExpoTurboRenderError,
  ExpoTurboRoot,
  ExpoTurboStateScope,
  useComponentAction,
  useDocumentState,
  useExpoTurboDocument,
  useExpoTurboFrame,
  useNodeDisposal,
  useScopedState,
} from "expo-turbo/react"

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
  registry: ExpoTurboProviderProps["registry"],
  options: Readonly<{
    documentComponent?: ExpoTurboProviderProps["documentComponent"]
    documentController?: ExpoTurboProviderProps["documentController"]
    frameComponent?: ExpoTurboProviderProps["frameComponent"]
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

  test("resolves explicit semantic tokens without treating structural class as native style", () => {
    type TestStyle = Readonly<Record<string, string>>
    const resolved: Readonly<{ component: string; tokens: readonly string[] }>[] = []
    const styles = defineStyleAdapter<"tone:info", TestStyle>({
      compose: (layers) => Object.freeze(Object.assign({}, ...layers)),
      maxTokens: 1,
      tokens: {
        "tone:info": {
          components: ["DemoStyled"],
          group: "tone",
          style: { color: "blue" },
        },
      },
    })
    const originalResolve = styles.resolve
    const recordingStyles: typeof styles = Object.freeze({
      ...styles,
      resolve(tokens: readonly string[], context: Readonly<{ component: string }>) {
        resolved.push({ component: context.component, tokens: [...tokens] })
        return originalResolve(tokens, context)
      },
    })
    const useTestComponentStyle = createComponentStyleHook(recordingStyles)
    type TestStyleLayers = Parameters<typeof useTestComponentStyle>[0]
    const typedLayers: TestStyleLayers = { component: { color: "black" }, tokens: [] }
    // @ts-expect-error The bound hook rejects layers from another style contract.
    const invalidLayers: TestStyleLayers = { component: ["black"], tokens: [] }
    expect(typedLayers.component).toEqual({ color: "black" })
    void invalidLayers

    function Styled({ styleTokens }: { styleTokens: string[] }): ReactNode {
      const style = useTestComponentStyle({
        component: { color: "black" },
        tokens: styleTokens,
      })
      return createElement("div", { style })
    }
    const styled = defineComponent({
      aliases: ["LegacyStyled"],
      attributes: {
        "style-tokens": {
          codec: tokenListCodec("renderer-style", ["tone:info"] as const, { maxTokens: 1 }),
          prop: "styleTokens",
        },
      },
      children: "none",
      component: Styled,
      schema: z.object({ styleTokens: z.array(z.literal("tone:info")).default([]) }),
      tag: "DemoStyled",
    })
    const componentRegistry = registryWithCounters().use(
      defineComponentModule({
        components: [styled],
        name: "renderer-style-component",
        version: "0.1.0",
      }),
    )
    const session = new DocumentSession(
      parseExpoTurboDocument(
        '<Gallery><LegacyStyled class="tone:critical" style-tokens="tone:info"/></Gallery>',
      ),
    )
    let renderer: ReactTestRenderer | undefined
    act(() => {
      renderer = create(
        createElement(
          ExpoTurboProvider,
          { registry: componentRegistry, session, styles: recordingStyles },
          createElement(ExpoTurboRoot),
        ),
      )
    })
    if (!renderer) throw new Error("renderer was not created")
    const activeRenderer = renderer

    expect(activeRenderer.root.findByType("div").props.style).toEqual({ color: "blue" })
    expect(resolved).toEqual([{ component: "DemoStyled", tokens: ["tone:info"] }])

    const mismatchedAdapterErrors: ExpoTurboRenderError[] = []
    act(() => {
      create(
        createElement(
          ExpoTurboProvider,
          {
            onError: (event) => mismatchedAdapterErrors.push(event),
            registry: componentRegistry,
            renderError: () => createElement("style-error"),
            session,
            styles,
          },
          createElement(ExpoTurboRoot),
        ),
      )
    })
    expect(mismatchedAdapterErrors[0]?.error.message).toContain("matching provider adapter")

    const missingAdapterErrors: ExpoTurboRenderError[] = []
    act(() => {
      create(
        createElement(
          ExpoTurboProvider,
          {
            onError: (event) => missingAdapterErrors.push(event),
            registry: componentRegistry,
            renderError: () => createElement("style-error"),
            session,
          },
          createElement(ExpoTurboRoot),
        ),
      )
    })
    expect(missingAdapterErrors[0]?.error.message).toContain("provider adapter")
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

  test("invokes a provider-owned typed component action from a registered component", async () => {
    const state = new DocumentStateStore()
    const record = defineComponentAction({
      action: "record",
      handler: ({ params, state: actionState }) => {
        actionState.set("recorded", params.value)
        return params.value
      },
      schema: z.object({ value: z.string() }),
    })
    const actions = createComponentActionRunner(
      createComponentActionRegistry(
        defineComponentActionModule({
          actions: [record],
          name: "renderer-actions",
          version: "0.1.0",
        }),
      ),
      state,
    )
    function ActionTrigger({ value }: { value: string }): ReactNode {
      const execute = useComponentAction(record)
      const recorded = useDocumentState<string>("recorded")
      return createElement("button", {
        "data-recorded": recorded.value,
        onClick: () => execute({ value }),
      })
    }
    const trigger = defineComponent({
      attributes: { value: { codec: stringCodec, prop: "value" } },
      children: "none",
      component: ActionTrigger,
      schema: z.object({ value: z.string() }),
      tag: "DemoTrigger",
    })
    const componentRegistry = registryWithCounters().use(
      defineComponentModule({
        components: [trigger],
        name: "renderer-action-component",
        version: "0.1.0",
      }),
    )
    const session = new DocumentSession(
      parseExpoTurboDocument('<Gallery><DemoTrigger value="from-xml"/></Gallery>'),
    )
    let renderer: ReactTestRenderer | undefined
    act(() => {
      renderer = create(
        createElement(
          ExpoTurboProvider,
          { actions, registry: componentRegistry, session, state },
          createElement(ExpoTurboRoot),
        ),
      )
    })
    if (!renderer) throw new Error("renderer was not created")
    const activeRenderer = renderer
    const press = activeRenderer.root.findByType("button").props.onClick
    await act(async () => {
      await press()
    })
    expect(state.get("recorded")).toBe("from-xml")
    expect(activeRenderer.root.findByType("button").props["data-recorded"]).toBe("from-xml")
    act(() => activeRenderer.unmount())
    expect(state.isDisposed).toBe(true)
  })

  test("inherits the nearest Frame or form state for hooks and component actions", async () => {
    const documentState = new DocumentStateStore()
    const record = defineComponentAction({
      action: "record-scoped",
      handler: ({ params, state }) => {
        state.set("recorded", params.value)
        return params.value
      },
      schema: z.object({ value: z.string() }),
    })
    const actions = createComponentActionRunner(
      createComponentActionRegistry(
        defineComponentActionModule({
          actions: [record],
          name: "scoped-renderer-actions",
          version: "0.1.0",
        }),
      ),
      documentState,
    )
    function ScopedTrigger({ value }: { value: string }): ReactNode {
      const execute = useComponentAction(record)
      const recorded = useScopedState<string>("recorded")
      return createElement("button", {
        "data-recorded": recorded.value,
        onClick: () => execute({ value }),
        value,
      })
    }
    function ScopedForm(props: Readonly<{ children?: ReactNode }>): ReactNode {
      return createElement(ExpoTurboStateScope, { kind: "form" }, props.children)
    }
    const form = defineComponent({
      attributes: {},
      children: "nodes",
      component: ScopedForm,
      schema: z.object({}),
      tag: "DemoForm",
    })
    const trigger = defineComponent({
      attributes: { value: { codec: stringCodec, prop: "value" } },
      children: "none",
      component: ScopedTrigger,
      schema: z.object({ value: z.string() }),
      tag: "ScopedTrigger",
    })
    const componentRegistry = registryWithCounters().use(
      defineComponentModule({
        components: [form, trigger],
        name: "scoped-renderer-components",
        version: "0.1.0",
      }),
    )
    const session = new DocumentSession(
      parseExpoTurboDocument(
        '<Gallery><turbo-frame id="frame"><DemoForm id="form"><ScopedTrigger value="first"/></DemoForm></turbo-frame></Gallery>',
      ),
    )
    const scopes = new DocumentStateScopes(session)
    let renderer: ReactTestRenderer | undefined
    act(() => {
      renderer = create(
        createElement(
          ExpoTurboProvider,
          { actions, registry: componentRegistry, scopes, session, state: documentState },
          createElement(ExpoTurboRoot),
        ),
      )
    })
    if (!renderer) throw new Error("renderer was not created")
    const activeRenderer = renderer
    const frameNode = session.tree.getElementById("frame")
    const formNode = session.tree.getElementById("form")
    if (!frameNode || !formNode) throw new Error("scoped fixtures are missing")
    const frameScope = scopes.scopeFor(frameNode.key, "frame")
    const formScope = scopes.scopeFor(formNode.key, "form")

    await act(async () => {
      await activeRenderer.root.findByType("button").props.onClick()
    })
    expect(documentState.get("recorded")).toBeUndefined()
    expect(frameScope.state.get("recorded")).toBeUndefined()
    expect(formScope.state.get("recorded")).toBe("first")

    act(() => {
      dispatchTurboStreamFragment(
        session,
        '<turbo-stream action="update" target="form"><template><ScopedTrigger value="second"/></template></turbo-stream>',
      )
    })
    expect(scopes.scopeFor(formNode.key, "form")).toBe(formScope)
    expect(activeRenderer.root.findByType("button").props["data-recorded"]).toBe("first")
    await act(async () => {
      await activeRenderer.root.findByType("button").props.onClick()
    })
    expect(formScope.state.get("recorded")).toBe("second")

    act(() => {
      dispatchTurboStreamFragment(
        session,
        '<turbo-stream action="replace" target="form"><template><DemoForm id="form"><ScopedTrigger value="replacement"/></DemoForm></template></turbo-stream>',
      )
    })
    expect(formScope.state.isDisposed).toBe(true)
    const replacement = session.tree.getElementById("form")
    if (!replacement) throw new Error("replacement form is missing")
    const replacementScope = scopes.scopeFor(replacement.key, "form")
    expect(replacementScope).not.toBe(formScope)
    expect(activeRenderer.root.findByType("button").props["data-recorded"]).toBeUndefined()
    await act(async () => {
      await activeRenderer.root.findByType("button").props.onClick()
    })
    expect(replacementScope.state.get("recorded")).toBe("replacement")

    act(() => activeRenderer.unmount())
    expect(replacementScope.state.isDisposed).toBe(true)
    expect(frameScope.state.isDisposed).toBe(true)
    expect(documentState.isDisposed).toBe(true)
  })

  test("runs registered component disposal before a Stream removes its logical node", () => {
    const disposed: string[] = []
    function Disposable({ label }: { label: string }): ReactNode {
      useNodeDisposal(() => disposed.push(label))
      return createElement("section", null, label)
    }
    const disposable = defineComponent({
      attributes: { label: { codec: stringCodec, prop: "label" } },
      children: "none",
      component: Disposable,
      schema: z.object({ label: z.string() }),
      tag: "Disposable",
    })
    const componentRegistry = registryWithCounters().use(
      defineComponentModule({
        components: [disposable],
        name: "disposal-component",
        version: "0.1.0",
      }),
    )
    const session = new DocumentSession(
      parseExpoTurboDocument('<Gallery><Disposable id="resource" label="old"/></Gallery>'),
    )
    let renderer: ReactTestRenderer | undefined
    act(() => {
      renderer = create(
        createElement(
          ExpoTurboProvider,
          { registry: componentRegistry, session },
          createElement(ExpoTurboRoot),
        ),
      )
    })
    if (!renderer) throw new Error("renderer was not created")

    act(() => {
      dispatchTurboStreamFragment(
        session,
        '<turbo-stream action="replace" target="resource"><template><Disposable id="resource" label="new"/></template></turbo-stream>',
      )
    })
    act(() => {
      dispatchTurboStreamFragment(
        session,
        '<turbo-stream action="remove" target="resource"/>',
      )
    })

    expect(disposed).toEqual(["old", "new"])
  })

  test("preserves update identity and remounts same-id replacements exactly once", () => {
    let nextInstance = 0
    const disposed: number[] = []
    const unmounted: number[] = []
    function Stateful(props: Readonly<{ children?: ReactNode }>): ReactNode {
      const [instance] = useState(() => ++nextInstance)
      useEffect(
        () => () => {
          unmounted.push(instance)
        },
        [instance],
      )
      useNodeDisposal(() => disposed.push(instance))
      return createElement("section", { instance }, props.children)
    }
    const stateful = defineComponent({
      attributes: {},
      children: "text",
      component: Stateful,
      schema: z.object({}),
      tag: "Stateful",
    })
    const componentRegistry = registryWithCounters().use(
      defineComponentModule({
        components: [stateful],
        name: "identity-component",
        version: "0.1.0",
      }),
    )
    const session = new DocumentSession(
      parseExpoTurboDocument(
        '<Gallery id="gallery"><Stateful id="same">Initial</Stateful></Gallery>',
      ),
    )
    const renderer = render(session, componentRegistry)
    const instance = () => renderer.root.findByType("section").props.instance

    expect(instance()).toBe(1)
    act(() => {
      dispatchTurboStreamFragment(
        session,
        '<turbo-stream action="update" target="same"><template>Updated</template></turbo-stream>',
      )
    })
    expect(instance()).toBe(1)
    expect(disposed).toEqual([])
    expect(unmounted).toEqual([])

    act(() => {
      dispatchTurboStreamFragment(
        session,
        '<turbo-stream action="replace" target="same"><template><Stateful id="same">Replaced</Stateful></template></turbo-stream>',
      )
    })
    expect(instance()).toBe(2)
    expect(disposed).toEqual([1])
    expect(unmounted).toEqual([1])

    act(() => {
      dispatchTurboStreamFragment(
        session,
        '<turbo-stream action="append" target="gallery"><template><Stateful id="same">Collision</Stateful></template></turbo-stream>',
      )
    })
    expect(instance()).toBe(3)
    expect(disposed).toEqual([1, 2])
    expect(unmounted).toEqual([1, 2])

    const replacementSession = new DocumentSession(
      parseExpoTurboDocument(
        '<Gallery id="gallery"><Stateful id="same">New document</Stateful></Gallery>',
      ),
    )
    act(() => {
      renderer.update(
        createElement(
          ExpoTurboProvider,
          { registry: componentRegistry, session: replacementSession },
          createElement(ExpoTurboRoot),
        ),
      )
    })
    expect(instance()).toBe(4)
    expect(disposed).toEqual([1, 2, 3])
    expect(unmounted).toEqual([1, 2, 3])

    act(() => renderer.unmount())
    expect(disposed).toEqual([1, 2, 3, 4])
    expect(unmounted).toEqual([1, 2, 3, 4])
  })

  test("exposes document visit accessibility and progress without remounting its boundary", async () => {
    const pending: {
      request: TurboRequest
      resolve: (response: TurboResponse) => void
    }[] = []
    const timers: {
      callback: () => void
      cleared: boolean
      handle: object
    }[] = []
    let nextBoundary = 0
    let nextProbe = 0
    let stableRenders = 0
    const boundaryUnmounts: number[] = []
    const probeUnmounts: number[] = []
    function DocumentBoundary(props: ExpoTurboDocumentBoundaryProps): ReactNode {
      const [instance] = useState(() => ++nextBoundary)
      useEffect(
        () => () => {
          boundaryUnmounts.push(instance)
        },
        [instance],
      )
      return createElement(
        "div",
        {
          accessibilityState: props.accessibilityState,
          busy: props.state.busy,
          instance,
          progressVisible: props.state.progressVisible,
          status: props.state.status,
        },
        props.children,
      )
    }
    function DocumentProbe(): ReactNode {
      const document = useExpoTurboDocument()
      const [instance] = useState(() => ++nextProbe)
      useEffect(
        () => () => {
          probeUnmounts.push(instance)
        },
        [instance],
      )
      return createElement("section", {
        busy: document?.state.busy,
        instance,
        progressVisible: document?.state.progressVisible,
        status: document?.state.status,
      })
    }
    function StableProbe(): ReactNode {
      stableRenders += 1
      return createElement("stable-probe")
    }
    const documentProbe = defineComponent({
      attributes: {},
      children: "none",
      component: DocumentProbe,
      schema: z.object({}),
      tag: "DocumentProbe",
    })
    const stableProbe = defineComponent({
      attributes: {},
      children: "none",
      component: StableProbe,
      schema: z.object({}),
      tag: "StableProbe",
    })
    const componentRegistry = registryWithCounters().use(
      defineComponentModule({
        components: [documentProbe, stableProbe],
        name: "document-loading-components",
        version: "0.1.0",
      }),
    )
    const session = new DocumentSession(
      parseExpoTurboDocument(
        '<Gallery><DocumentProbe /><StableProbe /><DemoText>Before</DemoText></Gallery>',
        { url: "https://example.test/gallery" },
      ),
    )
    let requestId = 0
    const controller = new DocumentVisitController(
      new DocumentRequestLoader(
        session,
        {
          fetch: (request) =>
            new Promise<TurboResponse>((resolve) => pending.push({ request, resolve })),
        },
        { next: () => `request-${++requestId}` },
      ),
      {
        clearTimeout(handle) {
          const timer = timers.find((candidate) => candidate.handle === handle)
          if (timer) timer.cleared = true
        },
        now: () => 0,
        setTimeout(callback) {
          const handle = Object.freeze({})
          timers.push({ callback, cleared: false, handle })
          return handle
        },
      },
    )
    const errors: ExpoTurboRenderError[] = []
    const renderer = render(session, componentRegistry, {
      documentComponent: DocumentBoundary,
      documentController: controller,
      onError: (event) => errors.push(event),
    })
    const boundary = () => renderer.root.findByType("div").props
    const renderedProbe = () => renderer.root.findByType("section").props

    expect(boundary()).toMatchObject({ busy: false, instance: 1, status: "initialized" })
    expect(boundary().accessibilityState).toEqual({ busy: false })
    expect(Object.isFrozen(boundary().accessibilityState)).toBe(true)
    expect(renderedProbe()).toMatchObject({ busy: false, instance: 1, status: "initialized" })
    expect(stableRenders).toBe(1)

    let visit: Promise<unknown> | undefined
    act(() => {
      visit = controller.visit("/next")
    })
    expect(boundary()).toMatchObject({ busy: true, instance: 1, status: "started" })
    expect(boundary().accessibilityState).toEqual({ busy: true })
    expect(renderedProbe()).toMatchObject({ busy: true, instance: 1, status: "started" })
    expect(stableRenders).toBe(1)

    act(() => timers[0]?.callback())
    expect(boundary()).toMatchObject({ progressVisible: true, status: "started" })
    expect(renderedProbe()).toMatchObject({ progressVisible: true, status: "started" })
    expect(stableRenders).toBe(1)

    await act(async () => {
      pending[0]?.resolve({
        headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
        redirected: false,
        status: 200,
        text: async () =>
          '<Gallery><DocumentProbe /><StableProbe /><DemoText>After</DemoText></Gallery>',
        url: "https://example.test/next",
      })
      await visit
    })
    expect(boundary()).toMatchObject({
      busy: false,
      instance: 1,
      progressVisible: false,
      status: "completed",
    })
    expect(renderedProbe()).toMatchObject({ busy: false, instance: 2, status: "completed" })
    expect(stableRenders).toBe(2)
    expect(boundaryUnmounts).toEqual([])
    expect(probeUnmounts).toEqual([1])
    expect(JSON.stringify(renderer.toJSON())).toContain("After")

    let failed: Promise<unknown> | undefined
    act(() => {
      failed = controller.visit("/broken")
    })
    await act(async () => {
      pending[1]?.resolve({
        headers: { "Content-Type": "application/json" },
        redirected: false,
        status: 200,
        text: async () => "{}",
        url: "https://example.test/broken",
      })
      await failed?.catch(() => undefined)
    })
    expect(boundary()).toMatchObject({ busy: false, instance: 1, status: "failed" })
    expect(renderedProbe()).toMatchObject({ busy: false, instance: 2, status: "failed" })
    expect(stableRenders).toBe(2)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ nodeKey: "document" })

    act(() => renderer.unmount())
    expect(boundaryUnmounts).toEqual([1])
    expect(probeUnmounts).toEqual([1, 2])
  })

  test("keeps the injected document controller host-owned across React unmount", async () => {
    const pending: {
      request: TurboRequest
      resolve: (response: TurboResponse) => void
    }[] = []
    const session = new DocumentSession(
      parseExpoTurboDocument('<Gallery><DemoText>Before</DemoText></Gallery>', {
        url: "https://example.test/gallery",
      }),
    )
    const controller = new DocumentVisitController(
      new DocumentRequestLoader(
        session,
        {
          fetch: (request) =>
            new Promise<TurboResponse>((resolve) => pending.push({ request, resolve })),
        },
        { next: () => "request-1" },
      ),
      {
        clearTimeout: () => undefined,
        now: () => 0,
        setTimeout: () => Object.freeze({}),
      },
    )
    const renderer = render(session, registryWithCounters(), {
      documentController: controller,
    })
    let visit: Promise<unknown> | undefined
    act(() => {
      visit = controller.visit("/pending")
    })

    act(() => renderer.unmount())
    expect(pending[0]?.request.signal?.aborted).toBe(false)
    expect(controller.state.status).toBe("started")
    controller.cancel()
    expect(pending[0]?.request.signal?.aborted).toBe(true)
    pending[0]?.resolve({
      headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
      redirected: false,
      status: 200,
      text: async () => '<Gallery><DemoText>Late</DemoText></Gallery>',
      url: "https://example.test/pending",
    })
    expect(await visit).toMatchObject({ status: "canceled" })
  })

  test("provides the nearest connected Frame binding to boundaries and descendants", () => {
    function FrameProbe({ label }: { label: string }): ReactNode {
      const frame = useExpoTurboFrame()
      return createElement("section", {
        busy: frame?.state.busy,
        frameId: frame?.state.frameId,
        label,
      })
    }
    function FrameBoundary(props: ExpoTurboFrameBoundaryProps): ReactNode {
      const frame = useExpoTurboFrame()
      return createElement(
        "div",
        {
          busy: props.accessibilityState.busy,
          contextFrameId: frame?.state.frameId,
          frameId: props.state.frameId,
        },
        props.children,
      )
    }
    const probe = defineComponent({
      attributes: { label: { codec: stringCodec, prop: "label" } },
      children: "none",
      component: FrameProbe,
      schema: z.object({ label: z.string() }),
      tag: "FrameProbe",
    })
    const componentRegistry = registryWithCounters().use(
      defineComponentModule({
        components: [probe],
        name: "frame-binding-component",
        version: "0.1.0",
      }),
    )
    const session = new DocumentSession(
      parseExpoTurboDocument(`<Gallery>
        <FrameProbe label="outside" />
        <turbo-frame id="outer">
          <FrameProbe label="outer" />
          <turbo-frame id="inner"><FrameProbe label="inner" /></turbo-frame>
        </turbo-frame>
      </Gallery>`),
    )
    const frames = new FrameControllerRegistry(
      session,
      new FrameRequestLoader(
        session,
        { fetch: async () => Promise.reject(new Error("fixture Frame must not fetch")) },
        { next: () => "request-1" },
      ),
    )
    const renderer = render(session, componentRegistry, {
      frameComponent: FrameBoundary,
      frames,
    })

    expect(
      renderer.root.findAllByType("section").map(({ props }) => ({
        busy: props.busy,
        frameId: props.frameId,
        label: props.label,
      })),
    ).toEqual([
      { busy: undefined, frameId: undefined, label: "outside" },
      { busy: false, frameId: "outer", label: "outer" },
      { busy: false, frameId: "inner", label: "inner" },
    ])
    expect(
      renderer.root.findAllByType("div").map(({ props }) => ({
        busy: props.busy,
        contextFrameId: props.contextFrameId,
        frameId: props.frameId,
      })),
    ).toEqual([
      { busy: false, contextFrameId: "outer", frameId: "outer" },
      { busy: false, contextFrameId: "inner", frameId: "inner" },
    ])

    act(() => renderer.unmount())
  })

  test("exposes Frame GET busy accessibility without remounting stable native boundaries", async () => {
    const pending: {
      request: TurboRequest
      resolve: (response: TurboResponse) => void
    }[] = []
    let nextBoundary = 0
    let nextProbe = 0
    let stableRenders = 0
    const boundaryUnmounts: number[] = []
    const probeUnmounts: number[] = []
    function FrameBoundary(props: ExpoTurboFrameBoundaryProps): ReactNode {
      const [instance] = useState(() => ++nextBoundary)
      useEffect(
        () => () => {
          boundaryUnmounts.push(instance)
        },
        [instance],
      )
      return createElement(
        "div",
        {
          accessibilityState: props.accessibilityState,
          busy: props.state.busy,
          complete: props.state.complete,
          instance,
          status: props.state.status,
        },
        props.children,
      )
    }
    function FrameProbe(): ReactNode {
      const frame = useExpoTurboFrame()
      const [instance] = useState(() => ++nextProbe)
      useEffect(
        () => () => {
          probeUnmounts.push(instance)
        },
        [instance],
      )
      return createElement("section", {
        busy: frame?.state.busy,
        instance,
        status: frame?.state.status,
      })
    }
    function StableProbe(): ReactNode {
      stableRenders += 1
      return createElement("article")
    }
    const probe = defineComponent({
      attributes: {},
      children: "none",
      component: FrameProbe,
      schema: z.object({}),
      tag: "FrameProbe",
    })
    const stable = defineComponent({
      attributes: {},
      children: "none",
      component: StableProbe,
      schema: z.object({}),
      tag: "StableProbe",
    })
    const componentRegistry = registryWithCounters().use(
      defineComponentModule({
        components: [probe, stable],
        name: "frame-loading-component",
        version: "0.1.0",
      }),
    )
    const session = new DocumentSession(
      parseExpoTurboDocument(
        '<Gallery><turbo-frame id="frame" src="/frame"><FrameProbe /><StableProbe /></turbo-frame></Gallery>',
        { url: "https://example.test/gallery" },
      ),
    )
    const frames = new FrameControllerRegistry(
      session,
      new FrameRequestLoader(
        session,
        {
          fetch: (request) =>
            new Promise<TurboResponse>((resolve) => pending.push({ request, resolve })),
        },
        { next: () => `request-${pending.length + 1}` },
      ),
    )
    const errors: ExpoTurboRenderError[] = []
    const renderer = render(session, componentRegistry, {
      frameComponent: FrameBoundary,
      frames,
      onError: (event) => errors.push(event),
    })
    const controller = frames.get("frame")
    const boundary = () => renderer.root.findByType("div").props
    const renderedProbe = () => renderer.root.findByType("section").props
    const response = (
      status: number,
      xml = "",
      contentType: string = EXPO_TURBO_MIME_TYPE,
    ): TurboResponse => ({
      headers: { "Content-Type": contentType },
      redirected: false,
      status,
      text: async () => xml,
      url: "https://example.test/frame",
    })

    expect(pending).toHaveLength(1)
    expect(boundary()).toMatchObject({ busy: true, complete: false, instance: 1, status: "loading" })
    expect(boundary().accessibilityState).toEqual({ busy: true })
    expect(Object.isFrozen(boundary().accessibilityState)).toBe(true)
    expect(renderedProbe()).toMatchObject({ busy: true, instance: 1, status: "loading" })
    expect(stableRenders).toBe(1)
    const frame = session.tree.getElementById("frame")
    if (!frame) throw new Error("fixture Frame is missing")
    expect(attributeValue(frame, "busy")).toBeUndefined()
    expect(attributeValue(frame, "complete")).toBeUndefined()
    expect(attributeValue(frame, "aria-busy")).toBeUndefined()

    await act(async () => {
      pending[0]?.resolve(response(204))
      await controller.loaded
    })
    expect(boundary()).toMatchObject({ busy: false, complete: true, instance: 1, status: "empty" })
    expect(boundary().accessibilityState).toEqual({ busy: false })
    expect(renderedProbe()).toMatchObject({ busy: false, instance: 1, status: "empty" })
    expect(stableRenders).toBe(1)

    let failed: Promise<unknown> | undefined
    act(() => {
      failed = controller.reload()
    })
    expect(boundary()).toMatchObject({ busy: true, instance: 1, status: "loading" })
    await act(async () => {
      pending[1]?.resolve(response(200, "{}", "application/json"))
      await failed?.catch(() => undefined)
    })
    expect(errors).toHaveLength(1)
    expect(boundary()).toMatchObject({ busy: false, complete: true, instance: 1, status: "error" })
    expect(renderedProbe()).toMatchObject({ busy: false, instance: 1, status: "error" })
    expect(stableRenders).toBe(1)

    let canceled: Promise<unknown> | undefined
    act(() => {
      canceled = controller.reload()
    })
    act(() => controller.cancel())
    expect(boundary()).toMatchObject({ busy: false, instance: 1, status: "canceled" })
    pending[2]?.resolve(response(200, '<turbo-frame id="frame"><FrameProbe /></turbo-frame>'))
    await act(async () => {
      await canceled
    })
    expect(boundary()).toMatchObject({ busy: false, instance: 1, status: "canceled" })
    expect(renderedProbe()).toMatchObject({ instance: 1, status: "canceled" })
    expect(stableRenders).toBe(1)

    let completed: Promise<unknown> | undefined
    act(() => {
      completed = controller.reload()
    })
    pending[3]?.resolve(
      response(200, '<turbo-frame id="frame"><FrameProbe /><StableProbe /></turbo-frame>'),
    )
    await act(async () => {
      await completed
    })
    expect(boundary()).toMatchObject({ busy: false, complete: true, instance: 1, status: "completed" })
    expect(renderedProbe()).toMatchObject({ busy: false, instance: 2, status: "completed" })
    expect(stableRenders).toBe(2)
    expect(boundaryUnmounts).toEqual([])
    expect(probeUnmounts).toEqual([1])

    act(() => renderer.unmount())
    expect(boundaryUnmounts).toEqual([1])
    expect(probeUnmounts).toEqual([1, 2])
  })

  test("keeps one Frame controller owner through StrictMode effect replay", () => {
    const requests: TurboRequest[] = []
    const session = new DocumentSession(
      parseExpoTurboDocument(
        '<Gallery><turbo-frame id="frame" src="/frame"><DemoText>Before</DemoText></turbo-frame></Gallery>',
        { url: "https://example.test/gallery" },
      ),
    )
    const frames = new FrameControllerRegistry(
      session,
      new FrameRequestLoader(
        session,
        {
          fetch: (request) => {
            requests.push(request)
            return new Promise<TurboResponse>(() => undefined)
          },
        },
        { next: () => `request-${requests.length + 1}` },
      ),
    )
    let renderedController: FrameController | undefined
    function FrameBoundary(props: ExpoTurboFrameBoundaryProps): ReactNode {
      renderedController = props.controller
      return createElement("frame-boundary", null, props.children)
    }
    let renderer: ReactTestRenderer | undefined
    act(() => {
      renderer = create(
        createElement(
          StrictMode,
          null,
          createElement(
            ExpoTurboProvider,
            {
              frameComponent: FrameBoundary,
              frames,
              registry: registryWithCounters(),
              session,
            },
            createElement(ExpoTurboRoot),
          ),
        ),
      )
    })
    if (!renderer) throw new Error("renderer was not created")

    expect(renderedController).toBe(frames.get("frame"))
    expect(requests.filter((request) => !request.signal?.aborted)).toHaveLength(1)
    expect(renderedController?.state).toMatchObject({ busy: true, connected: true })

    act(() => renderer?.unmount())
    expect(requests.every((request) => request.signal?.aborted)).toBe(true)
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
    const boundaryUnmounts: FrameController[] = []
    let renderedController: FrameController | undefined
    function FrameBoundary(props: ExpoTurboFrameBoundaryProps): ReactNode {
      renderedController = props.controller
      useEffect(
        () => () => {
          boundaryUnmounts.push(props.controller)
        },
        [props.controller],
      )
      return createElement("frame-boundary", null, props.children)
    }
    const errors: ExpoTurboRenderError[] = []
    const renderer = render(session, registryWithCounters(), {
      frameComponent: FrameBoundary,
      frames,
      onError: (event) => errors.push(event),
    })
    const controller = frames.get("frame")
    const turboResponse = (
      xml: string,
      contentType: string = EXPO_TURBO_MIME_TYPE,
    ): TurboResponse => ({
      headers: { "Content-Type": contentType },
      redirected: false,
      status: 200,
      text: async () => xml,
      url: "https://example.test/frame",
    })

    expect(pending).toHaveLength(1)
    expect(controller.state).toMatchObject({ busy: true, connected: true })
    expect(renderedController).toBe(controller)
    await act(async () => {
      pending[0]?.resolve(turboResponse('<turbo-frame id="frame"><DemoText>Loaded</DemoText></turbo-frame>'))
      await controller.loaded
    })
    expect(JSON.stringify(renderer.toJSON())).toContain("Loaded")

    let broken: Promise<unknown> | undefined
    act(() => {
      broken = controller.setSource("/broken")
    })
    expect(pending).toHaveLength(2)
    pending[1]?.resolve(turboResponse("{}", "application/json"))
    await act(async () => {
      await broken?.catch(() => undefined)
    })
    expect(errors[0]).toMatchObject({ nodeKey: "id:frame" })
    expect(controller.state.status).toBe("error")

    let changed: Promise<unknown> | undefined
    act(() => {
      changed = controller.setSource("/slow")
    })
    expect(pending).toHaveLength(3)
    act(() => {
      dispatchTurboStreamFragment(
        session,
        '<turbo-stream action="replace" target="frame"><template><turbo-frame id="frame" src="/replacement"><DemoText>Replacement</DemoText></turbo-frame></template></turbo-stream>',
      )
    })
    expect(pending[2]?.request.signal?.aborted).toBe(true)
    expect(controller.state).toMatchObject({ connected: false, status: "canceled" })
    const replacementController = frames.get("frame")
    expect(replacementController).not.toBe(controller)
    expect(boundaryUnmounts).toEqual([controller])
    expect(renderedController).toBe(replacementController)
    expect(pending).toHaveLength(4)
    expect(pending[3]?.request.url).toBe("https://example.test/replacement")
    pending[2]?.resolve(turboResponse('<turbo-frame id="frame"><DemoText>Late</DemoText></turbo-frame>'))
    await act(async () => {
      await changed
    })
    expect(JSON.stringify(renderer.toJSON())).not.toContain("Late")
    expect(JSON.stringify(renderer.toJSON())).toContain("Replacement")

    act(() => {
      dispatchTurboStreamFragment(session, '<turbo-stream action="remove" target="frame"/>')
    })
    expect(pending[3]?.request.signal?.aborted).toBe(true)
    expect(replacementController.state).toMatchObject({ connected: false, status: "canceled" })
    expect(boundaryUnmounts).toEqual([controller, replacementController])
    expect(() => frames.get("frame")).toThrow(FrameMissingError)
    pending[3]?.resolve(
      turboResponse('<turbo-frame id="frame"><DemoText>Late replacement</DemoText></turbo-frame>'),
    )
    await act(async () => {
      await replacementController.loaded
    })
    expect(JSON.stringify(renderer.toJSON())).not.toContain("Late replacement")
  })

  test("contains transient host Frame boundary errors and retries on controller state", () => {
    function FrameBoundary(props: ExpoTurboFrameBoundaryProps): ReactNode {
      if (props.state.status === "loading") throw new Error("Broken loading boundary")
      return createElement("div", { status: props.state.status }, props.children)
    }
    const session = new DocumentSession(
      parseExpoTurboDocument(
        '<Gallery><turbo-frame id="frame" src="/frame"><DemoText>Before</DemoText></turbo-frame></Gallery>',
        { url: "https://example.test/gallery" },
      ),
    )
    const requests: TurboRequest[] = []
    const frames = new FrameControllerRegistry(
      session,
      new FrameRequestLoader(
        session,
        {
          fetch: (request) => {
            requests.push(request)
            return new Promise<TurboResponse>(() => undefined)
          },
        },
        { next: () => "request-1" },
      ),
    )
    const errors: ExpoTurboRenderError[] = []
    const renderer = render(session, registryWithCounters(), {
      frameComponent: FrameBoundary,
      frames,
      onError: (event) => errors.push(event),
      renderError: (event) => createElement("protocol-error", null, event.error.message),
    })

    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ nodeKey: "id:frame" })
    expect(JSON.stringify(renderer.toJSON())).toContain("Broken loading boundary")
    expect(requests).toHaveLength(1)
    const documentRevision = session.revision

    act(() => frames.get("frame").cancel())

    expect(session.revision).toBe(documentRevision)
    expect(requests[0]?.signal?.aborted).toBe(true)
    expect(renderer.root.findByType("div").props.status).toBe("canceled")
    expect(JSON.stringify(renderer.toJSON())).not.toContain("Broken loading boundary")
    expect(JSON.stringify(renderer.toJSON())).toContain("Before")
    act(() => renderer.unmount())
  })

  test("resubscribes Frame errors without reconnecting when the provider callback changes", async () => {
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
    const frames = new FrameControllerRegistry(
      session,
      new FrameRequestLoader(
        session,
        {
          fetch: (request) =>
            new Promise<TurboResponse>((resolve) => pending.push({ request, resolve })),
        },
        { next: () => "request-1" },
      ),
    )
    const componentRegistry = registryWithCounters()
    const provider = (onError: (event: ExpoTurboRenderError) => void) =>
      createElement(
        ExpoTurboProvider,
        { frames, onError, registry: componentRegistry, session },
        createElement(ExpoTurboRoot),
      )
    let renderer: ReactTestRenderer | undefined
    act(() => {
      renderer = create(provider(() => undefined))
    })
    if (!renderer) throw new Error("renderer was not created")
    const activeRenderer = renderer
    const controller = frames.get("frame")

    expect(pending).toHaveLength(1)
    act(() => activeRenderer.update(provider(() => undefined)))
    expect(frames.get("frame")).toBe(controller)
    expect(pending).toHaveLength(1)
    expect(pending[0]?.request.signal?.aborted).toBe(false)

    act(() => activeRenderer.unmount())
    expect(pending[0]?.request.signal?.aborted).toBe(true)
    pending[0]?.resolve({
      headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
      redirected: false,
      status: 200,
      text: async () => '<turbo-frame id="frame"><DemoText>Late</DemoText></turbo-frame>',
      url: "https://example.test/frame",
    })
    expect(await controller.loaded).toMatchObject({ status: "canceled" })
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
