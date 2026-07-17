/// <reference types="bun" />

import { describe, expect, test } from "bun:test"
import { createElement, type ReactNode, StrictMode, useEffect, useState } from "react"
import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { z } from "zod"

import {
  defineStyleAdapter,
  type NavigationAdapter,
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
  TargetError,
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
  useExpoTurboDocumentLink,
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
    navigation?: NavigationAdapter
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

function renderDocumentLinks(
  xml: string,
  fetch: (request: TurboRequest) => Promise<TurboResponse>,
  url = "https://example.test/gallery",
  navigation?: NavigationAdapter,
  frameFetch?: (request: TurboRequest) => Promise<TurboResponse>,
) {
  const activations = new Map<string, () => Promise<unknown>>()
  let renders = 0
  function DocumentLink({ href }: { href: string; target?: string }): ReactNode {
    renders += 1
    activations.set(href, useExpoTurboDocumentLink(href))
    return createElement("link", { href })
  }
  const link = defineComponent({
    attributes: {
      href: { codec: stringCodec, prop: "href" },
      target: { codec: stringCodec, prop: "target" },
    },
    children: "none",
    component: DocumentLink,
    schema: z.object({ href: z.string().trim().min(1), target: z.string().optional() }),
    tag: "DocumentLink",
  })
  const session = new DocumentSession(parseExpoTurboDocument(xml, { url }))
  const controller = new DocumentVisitController(
    new DocumentRequestLoader(session, { fetch }, { next: () => "request-link" }),
    {
      clearTimeout: () => undefined,
      now: () => 0,
      setTimeout: () => Object.freeze({}),
    },
  )
  let frameRequestId = 0
  const frames = frameFetch
    ? new FrameControllerRegistry(
        session,
        new FrameRequestLoader(session, { fetch: frameFetch }, {
          next: () => `request-frame-link-${++frameRequestId}`,
        }),
        undefined,
        navigation,
        controller,
      )
    : undefined
  const renderer = render(
    session,
    registryWithCounters().use(
      defineComponentModule({
        components: [link],
        name: "document-link-component",
        version: "0.1.0",
      }),
    ),
    { documentController: controller, frames, navigation },
  )
  return {
    activation(href: string) {
      const activation = activations.get(href)
      if (!activation) throw new Error(`Document link ${href} did not render`)
      return activation
    },
    controller,
    frames,
    renderCount: () => renders,
    renderer,
    session,
  }
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

  test("activates an active top-level document link without subscribing it to visit ticks", async () => {
    const pending: {
      request: TurboRequest
      resolve: (response: TurboResponse) => void
    }[] = []
    const harness = renderDocumentLinks(
      '<Gallery><DocumentLink id="link" href="../next?tab=details" /><DemoText>Before</DemoText></Gallery>',
      (request) => new Promise<TurboResponse>((resolve) => pending.push({ request, resolve })),
      "https://example.test/current/gallery",
    )

    let visit: Promise<unknown> | undefined
    act(() => {
      visit = harness.activation("../next?tab=details")()
    })
    expect(pending).toHaveLength(1)
    expect(pending[0]?.request).toMatchObject({
      method: "GET",
      url: "https://example.test/next?tab=details",
    })
    expect(pending[0]?.request.headers.Accept).toBe(EXPO_TURBO_MIME_TYPE)
    expect(pending[0]?.request.headers).not.toHaveProperty("Turbo-Frame")
    expect(harness.controller.state).toMatchObject({ busy: true, status: "started" })
    expect(harness.renderCount()).toBe(1)

    await act(async () => {
      pending[0]?.resolve({
        headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
        redirected: false,
        status: 200,
        text: async () =>
          '<Gallery><DocumentLink id="link" href="/later" /><DemoText>After</DemoText></Gallery>',
        url: "https://example.test/next?tab=details",
      })
      await visit
    })
    expect(harness.controller.state).toMatchObject({ busy: false, status: "completed" })
    expect(harness.session.tree.document.url).toBe("https://example.test/next?tab=details")
    expect(JSON.stringify(harness.renderer.toJSON())).toContain("After")
    expect(harness.renderCount()).toBe(2)

    act(() => harness.renderer.unmount())
  })

  test("delegates external and opted-out links without disturbing the current visit owner", async () => {
    const pending: {
      request: TurboRequest
      resolve: (response: TurboResponse) => void
    }[] = []
    const external: string[] = []
    const navigation: { action: string; url: string }[] = []
    const adapter: NavigationAdapter = {
      back() {},
      openExternal: (url) => {
        external.push(url)
      },
      visit: (url, action) => {
        navigation.push({ action, url })
      },
    }
    const harness = renderDocumentLinks(
      `<Gallery>
        <DocumentLink href="/pending" />
        <DocumentLink href="https://outside.test/path" />
        <Gallery data-turbo="false"><DocumentLink href="/opted-out" /></Gallery>
        <Gallery data-turbo="false"><DocumentLink href="https://outside.test/opted-out" /></Gallery>
      </Gallery>`,
      (request) => new Promise<TurboResponse>((resolve) => pending.push({ request, resolve })),
      "https://example.test/gallery",
      adapter,
    )

    let current: Promise<unknown> | undefined
    act(() => {
      current = harness.activation("/pending")()
    })
    const started = harness.controller.state
    const externalResult = await harness.activation("https://outside.test/path")()
    const optOutResult = await harness.activation("/opted-out")()
    const externalOptOutResult = await harness.activation("https://outside.test/opted-out")()

    expect(externalResult).toEqual({
      kind: "external",
      reason: "external",
      status: "delegated",
      url: "https://outside.test/path",
    })
    expect(optOutResult).toEqual({
      action: "advance",
      kind: "navigation",
      reason: "opt-out",
      status: "delegated",
      url: "https://example.test/opted-out",
    })
    expect(externalOptOutResult).toEqual({
      kind: "external",
      reason: "opt-out",
      status: "delegated",
      url: "https://outside.test/opted-out",
    })
    expect(Object.isFrozen(externalResult)).toBe(true)
    expect(Object.isFrozen(optOutResult)).toBe(true)
    expect(Object.isFrozen(externalOptOutResult)).toBe(true)
    expect(external).toEqual([
      "https://outside.test/path",
      "https://outside.test/opted-out",
    ])
    expect(navigation).toEqual([{ action: "advance", url: "https://example.test/opted-out" }])
    expect(pending).toHaveLength(1)
    expect(pending[0]?.request.signal?.aborted).toBe(false)
    expect(harness.controller.state).toBe(started)

    act(() => harness.controller.cancel())
    pending[0]?.resolve({
      headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
      redirected: false,
      status: 200,
      text: async () => '<Gallery><DocumentLink href="/late" /></Gallery>',
      url: "https://example.test/pending",
    })
    await current
    act(() => harness.renderer.unmount())
  })

  test("delegates root-external and excluded-extension links without disturbing the current visit owner", async () => {
    const pending: {
      request: TurboRequest
      resolve: (response: TurboResponse) => void
    }[] = []
    const navigation: { action: string; url: string }[] = []
    const harness = renderDocumentLinks(
      `<Gallery data-turbo-root="/app">
        <DocumentLink href="/app/pending" />
        <DocumentLink href="/application" />
        <DocumentLink href="/app/archive.pdf" />
      </Gallery>`,
      (request) => new Promise<TurboResponse>((resolve) => pending.push({ request, resolve })),
      "https://example.test/app/gallery",
      {
        back() {},
        openExternal() {},
        visit: (url, action) => navigation.push({ action, url }),
      },
    )

    let current: Promise<unknown> | undefined
    act(() => {
      current = harness.activation("/app/pending")()
    })
    const started = harness.controller.state
    const outside = await harness.activation("/application")()
    const extension = await harness.activation("/app/archive.pdf")()

    expect(outside).toMatchObject({
      action: "advance",
      kind: "navigation",
      reason: "outside-root",
      status: "delegated",
    })
    expect(extension).toMatchObject({
      action: "advance",
      kind: "navigation",
      reason: "unvisitable-extension",
      status: "delegated",
    })
    expect(navigation).toEqual([
      { action: "advance", url: "https://example.test/application" },
      { action: "advance", url: "https://example.test/app/archive.pdf" },
    ])
    expect(pending).toHaveLength(1)
    expect(pending[0]?.request.signal?.aborted).toBe(false)
    expect(harness.controller.state).toBe(started)

    act(() => harness.controller.cancel())
    pending[0]?.resolve({
      headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
      redirected: false,
      status: 200,
      text: async () => '<Gallery data-turbo-root="/app" />',
      url: "https://example.test/app/pending",
    })
    await current
    act(() => harness.renderer.unmount())
  })

  test("applies root policy before interactive Frame capture and to promoted Frame visits", async () => {
    const documentRequests: TurboRequest[] = []
    const frameRequests: TurboRequest[] = []
    const navigation: { action: string; url: string }[] = []
    const harness = renderDocumentLinks(
      `<Gallery data-turbo-root="/app">
        <DocumentLink href="/app" />
        <DocumentLink href="/app/child" />
        <DocumentLink href="/outside-top" data-turbo-frame="_top" />
        <turbo-frame id="frame">
          <DocumentLink href="/app/frame-target" />
          <DocumentLink href="/outside-frame" />
          <DocumentLink href="/app/archive.pdf" />
          <DocumentLink href="/outside-promoted" data-turbo-frame="_top" />
        </turbo-frame>
      </Gallery>`,
      async (request) => {
        documentRequests.push(request)
        return {
          headers: {},
          redirected: false,
          status: 204,
          text: async () => "",
          url: request.url,
        }
      },
      "https://example.test/app/gallery",
      {
        back() {},
        openExternal() {},
        visit: (url, action) => navigation.push({ action, url }),
      },
      async (request) => {
        frameRequests.push(request)
        return {
          headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
          redirected: false,
          status: 200,
          text: async () => '<turbo-frame id="frame" />',
          url: request.url,
        }
      },
    )

    await act(async () => {
      await harness.activation("/app")()
    })
    await act(async () => {
      await harness.activation("/app/child")()
    })
    await act(async () => {
      await harness.activation("/outside-top")()
    })
    await act(async () => {
      await harness.activation("/outside-promoted")()
    })
    await act(async () => {
      await harness.activation("/outside-frame")()
    })
    await act(async () => {
      await harness.activation("/app/archive.pdf")()
    })
    await act(async () => {
      await harness.activation("/app/frame-target")()
    })

    expect(documentRequests.map((request) => request.url)).toEqual([
      "https://example.test/app",
      "https://example.test/app/child",
    ])
    expect(frameRequests).toHaveLength(1)
    expect(frameRequests[0]).toMatchObject({
      headers: { "Turbo-Frame": "frame" },
      url: "https://example.test/app/frame-target",
    })
    expect(navigation).toEqual([
      { action: "advance", url: "https://example.test/outside-top" },
      { action: "advance", url: "https://example.test/outside-promoted" },
      { action: "advance", url: "https://example.test/outside-frame" },
      { action: "advance", url: "https://example.test/app/archive.pdf" },
    ])
    act(() => harness.renderer.unmount())
  })

  test("uses the closest data-turbo setting for document-link ownership", async () => {
    const external: string[] = []
    const navigation: { action: string; url: string }[] = []
    const requests: TurboRequest[] = []
    const harness = renderDocumentLinks(
      `<Gallery data-turbo="false">
        <Gallery data-turbo="true"><DocumentLink href="/opted-in" /></Gallery>
      </Gallery>`,
      async (request) => {
        requests.push(request)
        return {
          headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
          redirected: false,
          status: 200,
          text: async () => '<Gallery><DocumentLink href="/after" /></Gallery>',
          url: request.url,
        }
      },
      "https://example.test/gallery",
      {
        back() {},
        openExternal: (url) => {
          external.push(url)
        },
        visit: (url, action) => {
          navigation.push({ action, url })
        },
      },
    )

    let result: unknown
    await act(async () => {
      result = await harness.activation("/opted-in")()
    })

    expect(result).toMatchObject({ status: "committed", url: "https://example.test/opted-in" })
    expect(requests).toHaveLength(1)
    expect(external).toHaveLength(0)
    expect(navigation).toHaveLength(0)
    act(() => harness.renderer.unmount())
  })

  test("captures current, default, explicit, and top-level named Frame links", async () => {
    const documentRequests: TurboRequest[] = []
    const frameRequests: TurboRequest[] = []
    const harness = renderDocumentLinks(
      `<Gallery>
        <DocumentLink href="/top-named" data-turbo-frame="named" />
        <DocumentLink href="/top-underscore" data-turbo-frame="_sidebar" />
        <DocumentLink href="/top-self" data-turbo-frame="_self" />
        <DocumentLink href="/top-parent" data-turbo-frame="_parent" />
        <turbo-frame id="named" />
        <turbo-frame id="_sidebar" />
        <turbo-frame id="_self" />
        <turbo-frame id="parent"><turbo-frame id="_parent" /></turbo-frame>
        <turbo-frame id="outer" target="named">
          <DocumentLink href="/default" />
          <DocumentLink href="/self" data-turbo-frame="_self" />
          <turbo-frame id="inner"><DocumentLink href="/nearest" /></turbo-frame>
        </turbo-frame>
      </Gallery>`,
      async (request) => {
        documentRequests.push(request)
        throw new Error("document fetch must not run")
      },
      "https://example.test/gallery",
      undefined,
      async (request) => {
        frameRequests.push(request)
        const frameId = request.headers["Turbo-Frame"]
        if (!frameId) throw new Error("Frame link request is missing its target header")
        return {
          headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
          redirected: false,
          status: 200,
          text: async () => `<turbo-frame id="${frameId}" />`,
          url: request.url,
        }
      },
    )
    const documentState = harness.controller.state

    let nearest: unknown
    let inherited: unknown
    let topLevelNamed: unknown
    let topLevelUnderscore: unknown
    let topLevelSelf: unknown
    let topLevelParent: unknown
    let self: unknown
    await act(async () => {
      nearest = await harness.activation("/nearest")()
    })
    await act(async () => {
      inherited = await harness.activation("/default")()
    })
    await act(async () => {
      topLevelNamed = await harness.activation("/top-named")()
    })
    await act(async () => {
      topLevelUnderscore = await harness.activation("/top-underscore")()
    })
    await act(async () => {
      topLevelSelf = await harness.activation("/top-self")()
    })
    await act(async () => {
      topLevelParent = await harness.activation("/top-parent")()
    })
    await act(async () => {
      self = await harness.activation("/self")()
    })

    expect(nearest).toMatchObject({ frameId: "inner", kind: "frame" })
    expect(inherited).toMatchObject({
      frameId: "named",
      kind: "frame",
      target: { requestedTarget: "named" },
    })
    expect(topLevelNamed).toMatchObject({
      frameId: "named",
      kind: "frame",
      target: { requestedTarget: "named" },
    })
    expect(topLevelUnderscore).toMatchObject({
      frameId: "_sidebar",
      kind: "frame",
      target: { requestedTarget: "_sidebar" },
    })
    expect(topLevelSelf).toMatchObject({
      frameId: "_self",
      kind: "frame",
      target: { requestedTarget: "_self" },
    })
    expect(topLevelParent).toMatchObject({
      frameId: "parent",
      kind: "frame",
      target: { requestedTarget: "_parent" },
    })
    expect(self).toMatchObject({
      frameId: "outer",
      kind: "frame",
      target: { requestedTarget: "_self" },
    })
    expect(frameRequests.map((request) => request.headers["Turbo-Frame"])).toEqual([
      "inner",
      "named",
      "named",
      "_sidebar",
      "_self",
      "parent",
      "outer",
    ])
    expect(frameRequests.map((request) => request.url)).toEqual([
      "https://example.test/nearest",
      "https://example.test/default",
      "https://example.test/top-named",
      "https://example.test/top-underscore",
      "https://example.test/top-self",
      "https://example.test/top-parent",
      "https://example.test/self",
    ])
    expect(documentRequests).toHaveLength(0)
    expect(harness.controller.state).toBe(documentState)
    act(() => harness.renderer.unmount())
  })

  test("keeps a top-level _top target document-scoped despite an ID collision", async () => {
    const documentRequests: TurboRequest[] = []
    const frameRequests: TurboRequest[] = []
    const harness = renderDocumentLinks(
      `<Gallery>
        <turbo-frame id="_top" />
        <DocumentLink href="/top" data-turbo-frame="_top" />
      </Gallery>`,
      async (request) => {
        documentRequests.push(request)
        return {
          headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
          redirected: false,
          status: 200,
          text: async () => "<Gallery />",
          url: request.url,
        }
      },
      "https://example.test/gallery",
      undefined,
      async (request) => {
        frameRequests.push(request)
        throw new Error("Frame fetch must not run")
      },
    )

    await act(async () => {
      expect(await harness.activation("/top")()).toMatchObject({
        status: "committed",
        url: "https://example.test/top",
      })
    })
    expect(documentRequests).toHaveLength(1)
    expect(documentRequests[0]?.headers).not.toHaveProperty("Turbo-Frame")
    expect(frameRequests).toHaveLength(0)
    act(() => harness.renderer.unmount())
  })

  test("routes _top, _parent, and Frame opt-out through their shared owners", async () => {
    const documentRequests: TurboRequest[] = []
    const frameRequests: TurboRequest[] = []
    const navigation: { action: string; url: string }[] = []
    const adapter: NavigationAdapter = {
      back() {},
      openExternal() {},
      visit: (url, action) => {
        navigation.push({ action, url })
      },
    }
    const harness = renderDocumentLinks(
      `<Gallery>
        <turbo-frame id="outer">
          <turbo-frame id="inner">
            <DocumentLink href="/top" data-turbo-frame="_top" />
            <Gallery data-turbo="false">
              <DocumentLink href="/opted-out" />
              <Gallery data-turbo="true">
                <DocumentLink href="/parent" data-turbo-frame="_parent" />
              </Gallery>
            </Gallery>
          </turbo-frame>
        </turbo-frame>
      </Gallery>`,
      async (request) => {
        documentRequests.push(request)
        return {
          headers: {},
          redirected: false,
          status: 204,
          text: async () => "",
          url: request.url,
        }
      },
      "https://example.test/gallery",
      adapter,
      async (request) => {
        frameRequests.push(request)
        const frameId = request.headers["Turbo-Frame"]
        if (!frameId) throw new Error("Frame link request is missing its target header")
        return {
          headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
          redirected: false,
          status: 200,
          text: async () => `<turbo-frame id="${frameId}" />`,
          url: request.url,
        }
      },
    )

    let top: unknown
    let optedOut: unknown
    let parent: unknown
    await act(async () => {
      top = await harness.activation("/top")()
    })
    await act(async () => {
      optedOut = await harness.activation("/opted-out")()
    })
    await act(async () => {
      parent = await harness.activation("/parent")()
    })

    expect(top).toMatchObject({
      action: "advance",
      kind: "top",
      outcome: { status: "empty" },
      target: { requestedTarget: "_top" },
    })
    expect(optedOut).toEqual({
      action: "advance",
      kind: "navigation",
      reason: "opt-out",
      status: "delegated",
      url: "https://example.test/opted-out",
    })
    expect(parent).toMatchObject({
      frameId: "outer",
      kind: "frame",
      target: { requestedTarget: "_parent" },
    })
    expect(navigation).toEqual([
      { action: "advance", url: "https://example.test/opted-out" },
    ])
    expect(frameRequests.map((request) => request.headers["Turbo-Frame"])).toEqual(["outer"])
    expect(documentRequests).toHaveLength(1)
    expect(documentRequests[0]).toMatchObject({
      headers: expect.not.objectContaining({ "Turbo-Frame": expect.anything() }),
      url: "https://example.test/top",
    })
    act(() => harness.renderer.unmount())
  })

  test("keeps Frame and document request ownership isolated across captured links", async () => {
    const documents: {
      request: TurboRequest
      resolve: (response: TurboResponse) => void
    }[] = []
    const frames: {
      request: TurboRequest
      resolve: (response: TurboResponse) => void
    }[] = []
    const harness = renderDocumentLinks(
      `<Gallery>
        <DocumentLink href="/document-pending" />
        <turbo-frame id="frame">
          <DocumentLink href="/first" />
          <DocumentLink href="/second" />
        </turbo-frame>
      </Gallery>`,
      (request) => new Promise<TurboResponse>((resolve) => documents.push({ request, resolve })),
      "https://example.test/gallery",
      undefined,
      (request) => new Promise<TurboResponse>((resolve) => frames.push({ request, resolve })),
    )

    let documentVisit: Promise<unknown> | undefined
    let first: Promise<unknown> | undefined
    let second: Promise<unknown> | undefined
    act(() => {
      documentVisit = harness.activation("/document-pending")()
    })
    const documentState = harness.controller.state
    act(() => {
      first = harness.activation("/first")()
    })
    act(() => {
      second = harness.activation("/second")()
    })

    expect(documents).toHaveLength(1)
    expect(documents[0]?.request.signal?.aborted).toBe(false)
    expect(harness.controller.state).toBe(documentState)
    expect(frames).toHaveLength(2)
    expect(frames[0]?.request.signal?.aborted).toBe(true)
    expect(frames[1]?.request.signal?.aborted).toBe(false)

    await act(async () => {
      frames[1]?.resolve({
        headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
        redirected: false,
        status: 200,
        text: async () => '<turbo-frame id="frame" />',
        url: "https://example.test/second",
      })
      await second
    })
    await act(async () => {
      frames[0]?.resolve({
        headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
        redirected: false,
        status: 200,
        text: async () => '<turbo-frame id="frame"><DocumentLink href="/late" /></turbo-frame>',
        url: "https://example.test/first",
      })
      await first
    })
    const activeFrame = harness.session.tree.getElementById("frame")
    if (!activeFrame) throw new Error("fixture Frame is missing")
    expect(attributeValue(activeFrame, "src")).toBe("https://example.test/second")
    expect(activeFrame.children).toHaveLength(0)
    expect(harness.controller.state).toBe(documentState)

    act(() => harness.controller.cancel())
    documents[0]?.resolve({
      headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
      redirected: false,
      status: 200,
      text: async () => '<Gallery><DocumentLink href="/late-document" /></Gallery>',
      url: "https://example.test/document-pending",
    })
    await documentVisit
    act(() => harness.renderer.unmount())
  })

  test("falls back to document loading for unavailable top-level Frame targets", async () => {
    for (const fixture of [
      { frame: "", target: "missing" },
      { frame: '<turbo-frame id="disabled" disabled="" />', target: "disabled" },
    ]) {
      const documentRequests: TurboRequest[] = []
      const frameRequests: TurboRequest[] = []
      const harness = renderDocumentLinks(
        `<Gallery>
          ${fixture.frame}
          <DocumentLink href="/fallback" data-turbo-frame="${fixture.target}" />
        </Gallery>`,
        async (request) => {
          documentRequests.push(request)
          return {
            headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
            redirected: false,
            status: 200,
            text: async () => '<Gallery><DocumentLink href="/after" /></Gallery>',
            url: request.url,
          }
        },
        "https://example.test/gallery",
        undefined,
        async (request) => {
          frameRequests.push(request)
          throw new Error("Frame fetch must not run")
        },
      )

      await act(async () => {
        expect(await harness.activation("/fallback")()).toMatchObject({
          status: "committed",
          url: "https://example.test/fallback",
        })
      })
      expect(documentRequests).toHaveLength(1)
      expect(documentRequests[0]?.headers).not.toHaveProperty("Turbo-Frame")
      expect(frameRequests).toHaveLength(0)
      act(() => harness.renderer.unmount())
    }
  })

  test("turns host navigation failures into rejected activation promises", async () => {
    const failure = new Error("Host navigation failed")
    const pending: {
      request: TurboRequest
      resolve: (response: TurboResponse) => void
    }[] = []
    const harness = renderDocumentLinks(
      `<Gallery>
        <DocumentLink href="/pending" />
        <DocumentLink href="https://outside.test/path" />
        <Gallery data-turbo="false"><DocumentLink href="/opted-out" /></Gallery>
      </Gallery>`,
      (request) => new Promise<TurboResponse>((resolve) => pending.push({ request, resolve })),
      "https://example.test/gallery",
      {
        back() {},
        async openExternal() {
          throw failure
        },
        async visit() {
          throw failure
        },
      },
    )

    let current: Promise<unknown> | undefined
    act(() => {
      current = harness.activation("/pending")()
    })
    const started = harness.controller.state
    const external = harness.activation("https://outside.test/path")()
    expect(external).toBeInstanceOf(Promise)
    await expect(external).rejects.toBe(failure)
    await expect(harness.activation("/opted-out")()).rejects.toBe(failure)
    expect(pending).toHaveLength(1)
    expect(pending[0]?.request.signal?.aborted).toBe(false)
    expect(harness.controller.state).toBe(started)

    act(() => harness.controller.cancel())
    pending[0]?.resolve({
      headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
      redirected: false,
      status: 200,
      text: async () => '<Gallery><DocumentLink href="/late" /></Gallery>',
      url: "https://example.test/pending",
    })
    await current
    act(() => harness.renderer.unmount())
  })

  test("rejects unsafe delegated links before navigation or fetching", async () => {
    const sources = [
      "javascript:secret-token",
      "data:text/plain,secret-token",
      "blob:https://example.test/secret-token",
      "https://user:secret-token@outside.test/path",
      "http://[secret-token",
      "https://outside.test/path#section",
      "/empty-fragment#",
    ]
    const external: string[] = []
    const navigation: { action: string; url: string }[] = []
    const requests: TurboRequest[] = []
    const harness = renderDocumentLinks(
      `<Gallery>${sources.map((href) => `<DocumentLink href="${href}" />`).join("")}</Gallery>`,
      async (request) => {
        requests.push(request)
        throw new Error("fetch must not run")
      },
      "https://example.test/gallery",
      {
        back() {},
        openExternal: (url) => {
          external.push(url)
        },
        visit: (url, action) => {
          navigation.push({ action, url })
        },
      },
    )

    for (const source of sources) {
      let error: unknown
      try {
        await harness.activation(source)()
      } catch (reason) {
        error = reason
      }
      expect(error).toBeInstanceOf(TargetError)
      if (!(error instanceof TargetError)) throw new Error("fixture link did not reject")
      expect(error.cause).toBeUndefined()
      expect(error.message).not.toContain("secret-token")
      expect(JSON.stringify(error.context)).not.toContain("secret-token")
    }
    expect(external).toHaveLength(0)
    expect(navigation).toHaveLength(0)
    expect(requests).toHaveLength(0)
    expect(harness.controller.state.status).toBe("initialized")
    act(() => harness.renderer.unmount())
  })

  test("rejects an unconfigured or unsupported document link without disturbing the current visit owner", async () => {
    const pending: {
      request: TurboRequest
      resolve: (response: TurboResponse) => void
    }[] = []
    const harness = renderDocumentLinks(
      `<Gallery>
        <DocumentLink href="/pending" />
        <DocumentLink href="https://outside.test/path" />
        <DocumentLink href="/fragment#section" />
        <DocumentLink href="#" />
        <DocumentLink href="/empty-fragment#" />
        <DocumentLink href="/method" data-turbo-method="get" />
        <DocumentLink href="/stream" data-turbo-stream="" />
        <DocumentLink href="/target" target="_blank" />
        <DocumentLink href="/action" data-turbo-action="replace" />
        <DocumentLink href="/confirm" data-turbo-confirm="Continue?" />
        <Gallery data-turbo="false"><DocumentLink href="/opted-out" /></Gallery>
      </Gallery>`,
      (request) => new Promise<TurboResponse>((resolve) => pending.push({ request, resolve })),
    )

    let current: Promise<unknown> | undefined
    act(() => {
      current = harness.activation("/pending")()
    })
    const started = harness.controller.state
    expect(pending).toHaveLength(1)
    expect(pending[0]?.request.signal?.aborted).toBe(false)

    await expect(harness.activation("https://outside.test/path")()).rejects.toBeInstanceOf(
      TargetError,
    )
    for (const href of ["/fragment#section", "#", "/empty-fragment#"]) {
      await expect(harness.activation(href)()).rejects.toBeInstanceOf(TargetError)
    }
    for (const href of ["/method", "/stream", "/target", "/action", "/confirm", "/opted-out"]) {
      await expect(harness.activation(href)()).rejects.toBeInstanceOf(TargetError)
    }
    expect(pending).toHaveLength(1)
    expect(pending[0]?.request.signal?.aborted).toBe(false)
    expect(harness.controller.state).toBe(started)

    act(() => harness.controller.cancel())
    pending[0]?.resolve({
      headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
      redirected: false,
      status: 200,
      text: async () => '<Gallery><DocumentLink href="/late" /></Gallery>',
      url: "https://example.test/pending",
    })
    await current
    act(() => harness.renderer.unmount())
  })

  test("rejects stale and unconfigured Frame-scoped link activations before fetching", async () => {
    const pending: {
      request: TurboRequest
      resolve: (response: TurboResponse) => void
    }[] = []
    const harness = renderDocumentLinks(
      `<Gallery>
        <DocumentLink href="/pending" />
        <DocumentLink id="top-link" href="/stale" />
        <turbo-frame id="frame"><DocumentLink href="/inside-frame" /></turbo-frame>
      </Gallery>`,
      (request) => new Promise<TurboResponse>((resolve) => pending.push({ request, resolve })),
    )
    const stale = harness.activation("/stale")
    const insideFrame = harness.activation("/inside-frame")
    let current: Promise<unknown> | undefined
    act(() => {
      current = harness.activation("/pending")()
    })
    const started = harness.controller.state

    act(() => {
      dispatchTurboStreamFragment(
        harness.session,
        '<turbo-stream action="replace" target="top-link"><template><DocumentLink id="top-link" href="/replacement" /></template></turbo-stream>',
      )
    })
    await expect(stale()).rejects.toBeInstanceOf(TargetError)
    await expect(insideFrame()).rejects.toMatchObject({
      code: "target",
      context: { frameId: "frame" },
    })
    expect(pending).toHaveLength(1)
    expect(pending[0]?.request.signal?.aborted).toBe(false)
    expect(harness.controller.state).toBe(started)

    act(() => harness.controller.cancel())
    pending[0]?.resolve({
      headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
      redirected: false,
      status: 200,
      text: async () => '<Gallery><DocumentLink href="/late" /></Gallery>',
      url: "https://example.test/pending",
    })
    await current

    act(() => harness.renderer.unmount())
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
