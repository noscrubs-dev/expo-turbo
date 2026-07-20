/// <reference types="bun" />

import { describe, expect, mock, test } from "bun:test"
import {
  createElement,
  Fragment,
  type ReactNode,
  StrictMode,
  useEffect,
  useLayoutEffect,
  useState,
} from "react"
import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { z } from "zod"

import {
  type AutofocusAdapter,
  type CableAdapter,
  defineStyleAdapter,
  type FormConfirmationAdapter,
  type FormSubmissionAnnouncementAdapter,
  type FormSubmissionAnnouncementEvent,
  type NavigationAdapter,
  type TurboRequest,
  type TurboResponse,
} from "expo-turbo/adapters"
import {
  applyFrameResponse,
  attributeValue,
  CableStreamSourceRegistry,
  dispatchTurboStreamFragment,
  DocumentFormControls,
  DocumentHistory,
  type DocumentHistoryEntry,
  type DocumentHistoryWriteMethod,
  DocumentPreloader,
  DocumentRequestLoader,
  DocumentSnapshotCache,
  DocumentStateScopes,
  DocumentStateStore,
  DocumentSession,
  DocumentVisitController,
  type DocumentVisitControllerOptions,
  DocumentVisitLifecycle,
  EXPO_TURBO_MIME_TYPE,
  FormLinkSubmissionController,
  FormSubmissionController,
  type FormRequestPlan,
  type FormRequestProtocolOptions,
  type FormSubmissionProposal,
  type FrameController,
  type FrameControllerCollection,
  FrameControllerRegistry,
  FrameLifecycle,
  FrameMissingError,
  FrameRequestLoader,
  parseExpoTurboDocument,
  renderedNodeTextContent,
  RequestError,
  RequestLifecycle,
  StateError,
  SubscriptionError,
  TargetError,
} from "expo-turbo/core"
import {
  createComponentActionRegistry,
  createComponentActionRunner,
  createRegistry,
  booleanCodec,
  defineComponentAction,
  defineComponentActionModule,
  defineComponent,
  defineComponentModule,
  enumCodec,
  presenceCodec,
  stringCodec,
  tokenListCodec,
} from "expo-turbo/registry"
import {
  createComponentStyleHook,
  type ExpoTurboDocumentBoundaryProps,
  type ExpoTurboFormBinding,
  type ExpoTurboFormBoundaryProps,
  type ExpoTurboFrameBoundaryProps,
  ExpoTurboFormScope,
  ExpoTurboProvider,
  type ExpoTurboProviderProps,
  type ExpoTurboRenderError,
  ExpoTurboRoot,
  ExpoTurboStateScope,
  useComponentAction,
  useDocumentState,
  useExpoTurboDocument,
  useExpoTurboDocumentLink,
  useExpoTurboForm,
  useExpoTurboFormControl,
  useExpoTurboFrame,
  useNodeDisposal,
  useScopedState,
} from "expo-turbo/react"

const globalWithAct = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean
}
globalWithAct.IS_REACT_ACT_ENVIRONMENT = true
const TURBO_STREAM_MIME_TYPE = "text/vnd.turbo-stream.html"
const nextTurn = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

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
    autofocus?: AutofocusAdapter
    documentComponent?: ExpoTurboProviderProps["documentComponent"]
    documentController?: ExpoTurboProviderProps["documentController"]
    documentPreloader?: ExpoTurboProviderProps["documentPreloader"]
    formLinks?: ExpoTurboProviderProps["formLinks"]
    frameComponent?: ExpoTurboProviderProps["frameComponent"]
    frames?: FrameControllerCollection
    forms?: ExpoTurboProviderProps["forms"]
    navigation?: NavigationAdapter
    onError?: (event: ExpoTurboRenderError) => void
    renderError?: (event: ExpoTurboRenderError) => ReactNode
    strict?: boolean
    streamSources?: ExpoTurboProviderProps["streamSources"]
  }> = {},
): ReactTestRenderer {
  let renderer: ReactTestRenderer | undefined
  const { strict, ...providerOptions } = options
  act(() => {
    const provider = createElement(
      ExpoTurboProvider,
      { registry, session, ...providerOptions },
      createElement(ExpoTurboRoot),
    )
    renderer = create(strict ? createElement(StrictMode, null, provider) : provider)
  })
  if (!renderer) throw new Error("renderer was not created")
  return renderer
}

function formScopeUnmountFixture(
  autoSubmitRequestId?: string,
  confirmation?: FormConfirmationAdapter,
  providedSession?: DocumentSession,
) {
  const bindings = new Set<ExpoTurboFormBinding>()
  const pending: {
    request: TurboRequest
    resolve: (response: TurboResponse) => void
  }[] = []
  let automaticSubmission: Promise<unknown> | undefined

  function NativeForm(
    props: Readonly<{
      action?: string
      children?: ReactNode
      method?: string
      stream?: string
    }>,
  ): ReactNode {
    return createElement(ExpoTurboFormScope, null, props.children)
  }
  function CaptureForm(): ReactNode {
    const binding = useExpoTurboForm()
    useEffect(() => {
      bindings.add(binding)
      if (autoSubmitRequestId && !automaticSubmission) {
        automaticSubmission = binding.submit({ protocol: { requestId: autoSubmitRequestId } })
      }
      return () => {
        bindings.delete(binding)
      }
    }, [binding])
    return createElement("form-capture")
  }

  const form = defineComponent({
    attributes: {
      action: { codec: stringCodec, prop: "action" },
      "data-turbo-stream": { codec: stringCodec, prop: "stream" },
      method: { codec: stringCodec, prop: "method" },
    },
    children: "nodes",
    component: NativeForm,
    formOwner: true,
    schema: z.object({
      action: z.string().optional(),
      method: z.string().optional(),
      stream: z.string().optional(),
    }),
    tag: "UnmountForm",
  })
  const capture = defineComponent({
    attributes: {},
    children: "none",
    component: CaptureForm,
    schema: z.object({}),
    tag: "CaptureUnmountForm",
  })
  const registry = registryWithCounters().use(
    defineComponentModule({
      components: [form, capture],
      name: "form-scope-unmount-components",
      version: "0.1.0",
    }),
  )
  const session =
    providedSession ??
    new DocumentSession(
      parseExpoTurboDocument(
        '<Gallery><UnmountForm id="form" action="/submit" method="post" data-turbo-stream=""><CaptureUnmountForm /></UnmountForm><DemoText id="status">Before</DemoText></Gallery>',
        { url: "https://example.test/current" },
      ),
    )
  const controller = new FormSubmissionController(
    session,
    {
      fetch: (request) =>
        new Promise<TurboResponse>((resolve) => pending.push({ request, resolve })),
    },
    { ...(confirmation ? { confirmation } : {}) },
  )
  const provider = (
    forms: DocumentFormControls,
    options: Readonly<{
      formAnnouncements?: FormSubmissionAnnouncementAdapter
      onError?: (event: ExpoTurboRenderError) => void
    }> = {},
  ) =>
    createElement(
      ExpoTurboProvider,
      { forms, registry, session, ...options },
      createElement(ExpoTurboRoot),
    )

  return {
    automaticSubmission: () => automaticSubmission,
    binding: () => {
      const binding = bindings.values().next().value
      if (!binding) throw new Error("form binding was not captured")
      return binding
    },
    controller,
    forms: () => new DocumentFormControls(session, { submissionController: controller }),
    pending,
    provider,
    session,
  }
}

function formTerminalFixture(
  method: "get" | "post",
  options: Readonly<{
    formAnnouncements?: FormSubmissionAnnouncementAdapter
    onError?: (event: ExpoTurboRenderError) => void
    strict?: boolean
  }> = {},
) {
  const bindings = new Map<string, ExpoTurboFormBinding>()
  let boundary: ExpoTurboFormBoundaryProps | undefined
  let childMounts = 0
  let childUnmounts = 0
  const confirmations: string[] = []
  const pending: {
    request: TurboRequest
    resolve: (response: TurboResponse) => void
  }[] = []

  function NativeForm(props: Readonly<{ children?: ReactNode }>): ReactNode {
    return createElement(ExpoTurboFormScope, null, props.children)
  }
  function FormBoundary(props: ExpoTurboFormBoundaryProps): ReactNode {
    boundary = props
    return createElement(
      "form-boundary",
      {
        busy: props.state.busy,
        terminalRevision: props.terminalState.revision,
        terminalStatus: props.terminalState.status,
      },
      props.children,
    )
  }
  function CaptureForm({ slot }: { slot: string }): ReactNode {
    const binding = useExpoTurboForm()
    useEffect(() => {
      bindings.set(slot, binding)
      return () => {
        if (bindings.get(slot) === binding) bindings.delete(slot)
      }
    }, [binding, slot])
    return createElement("form-observer", { slot })
  }
  function MountProbe(): ReactNode {
    useEffect(() => {
      childMounts += 1
      return () => {
        childUnmounts += 1
      }
    }, [])
    return createElement("mount-probe")
  }
  function NativeLiveValue({ name, value }: { name: string; value: string }): ReactNode {
    const [current, setCurrent] = useState(value)
    useExpoTurboFormControl({ kind: "value", name, value: current })
    return createElement("terminal-live-value", { onChange: setCurrent, value: current })
  }
  function NativeSubmitter({ name, value }: { name: string; value: string }): ReactNode {
    const binding = useExpoTurboFormControl({ kind: "submitter", name, value })
    return createElement("terminal-submitter", {
      nodeKey: binding.nodeKey,
      selection: binding.selection,
      value,
    })
  }

  const form = defineComponent({
    attributes: {
      action: { codec: stringCodec, prop: "action" },
      method: { codec: stringCodec, prop: "method" },
    },
    children: "nodes",
    component: NativeForm,
    formOwner: true,
    schema: z.object({ action: z.string().optional(), method: z.string().optional() }),
    tag: "TerminalForm",
  })
  const capture = defineComponent({
    attributes: { slot: { codec: stringCodec, prop: "slot" } },
    children: "none",
    component: CaptureForm,
    schema: z.object({ slot: z.string() }),
    tag: "CaptureTerminalForm",
  })
  const probe = defineComponent({
    attributes: {},
    children: "none",
    component: MountProbe,
    schema: z.object({}),
    tag: "TerminalMountProbe",
  })
  const liveValue = defineComponent({
    attributes: {
      name: { codec: stringCodec, prop: "name" },
      value: { codec: stringCodec, prop: "value" },
    },
    children: "none",
    component: NativeLiveValue,
    schema: z.object({ name: z.string(), value: z.string() }),
    tag: "TerminalLiveValue",
  })
  const submitter = defineComponent({
    attributes: {
      formmethod: { codec: stringCodec, prop: "formmethod" },
      name: { codec: stringCodec, prop: "name" },
      value: { codec: stringCodec, prop: "value" },
    },
    children: "none",
    component: NativeSubmitter,
    schema: z.object({ formmethod: z.string().optional(), name: z.string(), value: z.string() }),
    tag: "TerminalSubmitter",
  })
  const registry = registryWithCounters().use(
    defineComponentModule({
      components: [form, capture, probe, liveValue, submitter],
      name: `form-terminal-${method}`,
      version: "0.1.0",
    }),
  )
  const session = new DocumentSession(
    parseExpoTurboDocument(
      `<Gallery><TerminalForm id="form" action="/search" method="${method}">
        <TerminalMountProbe />
        <TerminalLiveValue id="query" name="query" value="before" />
        <TerminalSubmitter id="submit" name="commit" value="search" />
        <CaptureTerminalForm slot="first" />
        <CaptureTerminalForm slot="second" />
      </TerminalForm><DemoText id="status">Before</DemoText></Gallery>`,
      { url: "https://example.test/current" },
    ),
  )
  const controller = new FormSubmissionController(
    session,
    {
      fetch: (request) =>
        new Promise<TurboResponse>((resolve) => pending.push({ request, resolve })),
    },
    {
      confirmation: {
        confirm: (message) => {
          confirmations.push(message)
          return true
        },
      },
    },
  )
  const forms = new DocumentFormControls(session, { submissionController: controller })
  let renderer: ReactTestRenderer | undefined
  act(() => {
    const provider =
      createElement(
        ExpoTurboProvider,
        {
          formComponent: FormBoundary,
          forms,
          registry,
          session,
          ...(options.formAnnouncements
            ? { formAnnouncements: options.formAnnouncements }
            : {}),
          ...(options.onError ? { onError: options.onError } : {}),
        },
        createElement(ExpoTurboRoot),
      )
    renderer = create(options.strict ? createElement(StrictMode, null, provider) : provider)
  })
  if (!renderer) throw new Error("terminal form renderer was not created")
  const activeRenderer = renderer

  return {
    binding(slot = "first") {
      const binding = bindings.get(slot)
      if (!binding) throw new Error(`terminal form binding ${slot} was not captured`)
      return binding
    },
    boundary() {
      if (!boundary) throw new Error("terminal form boundary was not captured")
      return boundary
    },
    childMounts: () => childMounts,
    childUnmounts: () => childUnmounts,
    confirmations,
    forms,
    hostNode(type: string) {
      const node = activeRenderer.root.findAll((candidate) => String(candidate.type) === type)[0]
      if (!node) throw new Error(`terminal form host node ${type} was not rendered`)
      return node
    },
    pending,
    renderer: activeRenderer,
    session,
  }
}

function renderDocumentLinks(
  xml: string,
  fetch: (request: TurboRequest) => Promise<TurboResponse>,
  url = "https://example.test/gallery",
  navigation?: NavigationAdapter,
  frameFetch?: (request: TurboRequest) => Promise<TurboResponse>,
  createFormLinks?: (session: DocumentSession) => FormLinkSubmissionController,
  controllerOptions?: DocumentVisitControllerOptions,
  createProviderOptions?: (session: DocumentSession) => Readonly<{
    autofocus?: AutofocusAdapter
    documentPreloader?: ExpoTurboProviderProps["documentPreloader"]
    onError?: (event: ExpoTurboRenderError) => void
    renderError?: (event: ExpoTurboRenderError) => ReactNode
    strict?: boolean
  }>,
) {
  const activations = new Map<string, () => Promise<unknown>>()
  let documentRequestIds = 0
  let renders = 0
  function DocumentLink({
    disabled,
    href,
  }: {
    confirm?: string
    disabled: boolean
    download: boolean
    href: string
    target?: string
  }): ReactNode {
    renders += 1
    activations.set(href, useExpoTurboDocumentLink(href))
    return createElement("link", { disabled, href })
  }
  const link = defineComponent({
    attributes: {
      confirm: { codec: stringCodec, prop: "confirm" },
      disabled: { codec: presenceCodec, prop: "disabled" },
      download: { codec: presenceCodec, prop: "download" },
      href: { codec: stringCodec, prop: "href" },
      target: { codec: stringCodec, prop: "target" },
    },
    children: "none",
    component: DocumentLink,
    schema: z.object({
      confirm: z.string().optional(),
      disabled: z.boolean().default(false),
      download: z.boolean().default(false),
      href: z.string().trim().min(1),
      target: z.string().optional(),
    }),
    tag: "DocumentLink",
  })
  const session = new DocumentSession(parseExpoTurboDocument(xml, { url }))
  const providerOptions = createProviderOptions?.(session) ?? {}
  const formLinks = createFormLinks?.(session)
  const controller = new DocumentVisitController(
    new DocumentRequestLoader(
      session,
      { fetch },
      { next: () => `request-link-${++documentRequestIds}` },
    ),
    {
      clearTimeout: () => undefined,
      now: () => 0,
      setTimeout: () => Object.freeze({}),
    },
    controllerOptions,
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
  const componentRegistry = registryWithCounters().use(
    defineComponentModule({
      components: [link],
      name: "document-link-component",
      version: "0.1.0",
    }),
  )
  const rendererOptions = {
    documentController: controller,
    formLinks,
    frames,
    navigation,
    ...providerOptions,
  }
  const renderer = render(session, componentRegistry, rendererOptions)
  return {
    activation(href: string) {
      const activation = activations.get(href)
      if (!activation) throw new Error(`Document link ${href} did not render`)
      return activation
    },
    controller,
    documentRequestIdCount: () => documentRequestIds,
    formLinks,
    frames,
    renderCount: () => renders,
    renderer,
    session,
    updateErrorObserver(onError: (event: ExpoTurboRenderError) => void) {
      const { strict, ...options } = rendererOptions
      const provider = createElement(
        ExpoTurboProvider,
        { registry: componentRegistry, session, ...options, onError },
        createElement(ExpoTurboRoot),
      )
      act(() => {
        renderer.update(strict ? createElement(StrictMode, null, provider) : provider)
      })
    },
  }
}

function renderPreloadingDocumentLinks(
  xml: string,
  fetch: (request: TurboRequest) => Promise<TurboResponse>,
  options: Readonly<{
    documentFetch?: (request: TurboRequest) => Promise<TurboResponse>
    onError?: (event: ExpoTurboRenderError) => void
    prepareSession?: (session: DocumentSession) => void
    requestLifecycle?: RequestLifecycle
    strict?: boolean
    url?: string
  }> = {},
) {
  const cache = new DocumentSnapshotCache()
  let requestIds = 0
  let preloader: DocumentPreloader | undefined
  const harness = renderDocumentLinks(
    xml,
    options.documentFetch ??
      (async () => {
        throw new Error("automatic preload invoked the document visit transport")
      }),
    options.url,
    undefined,
    undefined,
    undefined,
    { snapshotCache: cache },
    (session) => {
      options.prepareSession?.(session)
      preloader = new DocumentPreloader(
        session,
        { fetch },
        { next: () => `automatic-preload-${++requestIds}` },
        cache,
        options.requestLifecycle ? { requestLifecycle: options.requestLifecycle } : {},
      )
      return {
        documentPreloader: preloader,
        ...(options.onError ? { onError: options.onError } : {}),
        ...(options.strict ? { strict: true } : {}),
      }
    },
  )
  if (!preloader) throw new Error("automatic document preloader was not created")
  return { ...harness, cache, preloader, requestIdCount: () => requestIds }
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

  test("connects only rendered Cable sources and coalesces Strict Mode/provider leases", async () => {
    const tree = parseExpoTurboDocument(`<Gallery>
      <DemoText id="status">old</DemoText>
      <turbo-cable-stream-source id="first" channel="DemoChannel" data-room-name="one" />
      <turbo-cable-stream-source id="second" data-room-name="one" channel="DemoChannel" />
      <turbo-cable-stream-source id="outer" channel="DemoChannel" data-room-name="one">
        <turbo-cable-stream-source id="nested-source" channel="NestedChannel" />
      </turbo-cable-stream-source>
      <template>
        <turbo-cable-stream-source id="template-source" channel="TemplateChannel" />
      </template>
      <turbo-stream action="append" target="status">
        <template>
          <turbo-cable-stream-source id="stream-source" channel="StreamChannel" />
        </template>
      </turbo-stream>
    </Gallery>`)
    const session = new DocumentSession(tree)
    const subscriptions: {
      callbacks: Parameters<CableAdapter["subscribe"]>[1]
      identifier: string
      unsubscribeCalls: number
    }[] = []
    const cable: CableAdapter = {
      subscribe(identifier, callbacks) {
        const record = { callbacks, identifier, unsubscribeCalls: 0 }
        subscriptions.push(record)
        return {
          unsubscribe() {
            record.unsubscribeCalls += 1
          },
        }
      },
    }
    const errors: Error[] = []
    const streamSources = new CableStreamSourceRegistry(session, cable, {
      onError: (error) => {
        errors.push(error)
      },
    })
    let renderer: ReactTestRenderer | undefined
    await act(async () => {
      renderer = create(
        createElement(
          StrictMode,
          null,
          createElement(
            Fragment,
            null,
            ...[registryWithCounters(), registryWithCounters()].map((registry, index) =>
              createElement(
                ExpoTurboProvider,
                {
                  key: `registry-${index}`,
                  registry,
                  session,
                  streamSources,
                },
                createElement(ExpoTurboRoot),
              ),
            ),
          ),
        ),
      )
      await Promise.resolve()
    })

    expect(subscriptions).toHaveLength(1)
    expect(subscriptions[0]?.identifier).toBe(
      JSON.stringify({
        channel: "DemoChannel",
        signed_stream_name: null,
        room_name: "one",
      }),
    )
    expect(JSON.stringify(renderer?.toJSON())).not.toContain("turbo-cable-stream-source")

    act(() => {
      subscriptions[0]?.callbacks.received(
        '<turbo-stream action="update" target="status"><template>fresh</template></turbo-stream>',
      )
    })
    expect(JSON.stringify(renderer?.toJSON())).toContain("fresh")

    await act(async () => {
      session.setAttribute("id:first", "channel", "OtherChannel")
      await Promise.resolve()
    })
    expect(subscriptions).toHaveLength(2)
    expect(subscriptions[0]?.unsubscribeCalls).toBe(0)
    expect(subscriptions[1]?.identifier).toContain("OtherChannel")

    act(() => {
      session.mutate((activeTree) => {
        const second = activeTree.getElementById("second")
        return second ? activeTree.removeNode(second) : []
      })
      session.mutate((activeTree) => {
        const outer = activeTree.getElementById("outer")
        return outer ? activeTree.removeNode(outer) : []
      })
    })
    expect(subscriptions[0]?.unsubscribeCalls).toBe(1)

    await act(async () => {
      renderer?.unmount()
      await Promise.resolve()
    })
    expect(subscriptions[1]?.unsubscribeCalls).toBe(1)
    expect(errors).toEqual([])
  })

  test("contains invalid Cable sources locally and reconnects after correction", async () => {
    const session = new DocumentSession(
      parseExpoTurboDocument(`<Gallery>
        <DemoText id="status">still rendered</DemoText>
        <turbo-cable-stream-source id="source" />
      </Gallery>`),
    )
    const identifiers: string[] = []
    const cable: CableAdapter = {
      subscribe(identifier) {
        identifiers.push(identifier)
        return { unsubscribe: () => undefined }
      },
    }
    const errors: Error[] = []
    const streamSources = new CableStreamSourceRegistry(session, cable, {
      onError: (error) => errors.push(error),
    })
    const renderErrors: Error[] = []
    const renderer = render(session, registryWithCounters(), {
      onError: ({ error }) => renderErrors.push(error),
      streamSources,
    })

    expect(JSON.stringify(renderer.toJSON())).toContain("still rendered")
    expect(identifiers).toEqual([])

    act(() => {
      session.setAttribute("id:source", "channel", "RecoveredChannel")
    })

    expect(JSON.stringify(renderer.toJSON())).toContain("still rendered")
    expect(identifiers).toEqual([
      JSON.stringify({ channel: "RecoveredChannel", signed_stream_name: null }),
    ])
    expect(errors).toEqual([
      new SubscriptionError("Cable stream source channel must be a nonblank token", {
        target: "id:source",
      }),
    ])
    expect(renderErrors).toEqual([])

    await act(async () => {
      renderer.unmount()
      await Promise.resolve()
    })
  })

  test("retries a failed Cable source when the injected registry changes", async () => {
    const session = new DocumentSession(
      parseExpoTurboDocument(`<Gallery>
        <DemoText id="status">still rendered</DemoText>
        <turbo-cable-stream-source id="source" channel="DemoChannel" />
      </Gallery>`),
    )
    const failingErrors: Error[] = []
    const failingSources = new CableStreamSourceRegistry(
      session,
      {
        subscribe() {
          throw new Error("secret adapter details")
        },
      },
      { onError: (error) => failingErrors.push(error) },
    )
    const identifiers: string[] = []
    const workingSources = new CableStreamSourceRegistry(
      session,
      {
        subscribe(identifier) {
          identifiers.push(identifier)
          return { unsubscribe: () => undefined }
        },
      },
      { onError: (error) => failingErrors.push(error) },
    )
    const registry = registryWithCounters()
    const renderErrors: Error[] = []
    const renderRoot = (streamSources: CableStreamSourceRegistry) =>
      createElement(
        ExpoTurboProvider,
        {
          onError: ({ error }) => renderErrors.push(error),
          registry,
          session,
          streamSources,
        },
        createElement(ExpoTurboRoot),
      )
    let renderer: ReactTestRenderer | undefined

    act(() => {
      renderer = create(renderRoot(failingSources))
    })
    expect(JSON.stringify(renderer?.toJSON())).toContain("still rendered")
    expect(failingErrors).toEqual([
      new SubscriptionError("Cable stream source subscription failed", {
        target: "id:source",
      }),
    ])
    expect(renderErrors).toEqual([])
    expect(session.revision).toBe(0)

    act(() => {
      renderer?.update(renderRoot(workingSources))
    })
    expect(identifiers).toEqual([
      JSON.stringify({ channel: "DemoChannel", signed_stream_name: null }),
    ])
    expect(session.revision).toBe(0)

    await act(async () => {
      renderer?.unmount()
      await Promise.resolve()
    })
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
    await act(async () => {
      activeRenderer.unmount()
      await Promise.resolve()
    })
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

    await act(async () => {
      activeRenderer.unmount()
      await Promise.resolve()
    })
    expect(replacementScope.state.isDisposed).toBe(true)
    expect(frameScope.state.isDisposed).toBe(true)
    expect(documentState.isDisposed).toBe(true)
  })

  test("binds live native controls to the nearest exact form through StrictMode replay", async () => {
    const bindings = new Map<string, ExpoTurboFormBinding>()
    const entriesAtPassiveMount = new Map<
      string,
      ReturnType<ExpoTurboFormBinding["successfulEntries"]>
    >()
    function NativeForm(
      props: Readonly<{
        action?: string
        children?: ReactNode
        enctype?: string
        frameTarget?: string
        method?: string
        stream?: string
      }>,
    ): ReactNode {
      return createElement(ExpoTurboFormScope, null, props.children)
    }
    function CaptureForm({ slot }: { slot: string }): ReactNode {
      const binding = useExpoTurboForm()
      useEffect(() => {
        bindings.set(slot, binding)
        entriesAtPassiveMount.set(slot, binding.successfulEntries())
        return () => {
          if (bindings.get(slot) === binding) bindings.delete(slot)
          entriesAtPassiveMount.delete(slot)
        }
      }, [binding, slot])
      return createElement("capture", { slot })
    }
    function NativeValue({
      directionName,
      directionValue,
      disabled,
      name,
      value,
    }: {
      directionName?: string
      directionValue?: "ltr" | "rtl"
      disabled?: boolean
      name?: string
      value: string
    }): ReactNode {
      const binding = useExpoTurboFormControl({
        ...(disabled !== undefined ? { disabled } : {}),
        ...(directionName !== undefined && directionValue !== undefined
          ? { directionality: { name: directionName, value: directionValue } }
          : {}),
        kind: "value",
        ...(name !== undefined ? { name } : {}),
        value,
      })
      return createElement("native-value", { nodeKey: binding.nodeKey, value })
    }
    function NativeHidden({ name, value }: { name?: string; value?: string }): ReactNode {
      useExpoTurboFormControl({
        kind: "hidden",
        ...(name !== undefined ? { name } : {}),
        ...(value !== undefined ? { value } : {}),
      })
      return createElement("native-hidden", { name, value })
    }
    function NativeLiveValue({ name, value }: { name: string; value: string }): ReactNode {
      const [current, setCurrent] = useState(value)
      const binding = useExpoTurboFormControl({ kind: "value", name, value: current })
      return createElement("native-live-value", {
        nodeKey: binding.nodeKey,
        onChange: setCurrent,
        value: current,
      })
    }
    function NativeCheckable({
      checked,
      name,
      value,
    }: {
      checked: boolean
      name: string
      value?: string
    }): ReactNode {
      useExpoTurboFormControl({
        checked,
        kind: "checkable",
        name,
        ...(value !== undefined ? { value } : {}),
      })
      return createElement("native-checkable", { checked })
    }
    function NativeMultiple({ name, values }: { name: string; values: string }): ReactNode {
      useExpoTurboFormControl({ kind: "multiple", name, values: values.split("|") })
      return createElement("native-multiple", { values })
    }
    function NativeEntries({
      entryNames,
      entryValues,
    }: {
      entryNames: string
      entryValues: string
    }): ReactNode {
      const values = entryValues.split("|")
      const binding = useExpoTurboFormControl({
        entries: entryNames
          .split("|")
          .map((name, index) => ({ name, value: values[index] ?? "" })),
        kind: "entries",
      })
      return createElement("native-entries", {
        entryNames,
        entryValues,
        nodeKey: binding.nodeKey,
        selection: binding.selection,
      })
    }
    function NativeSubmitter(props: {
      disabled?: boolean
      formaction?: string
      formenctype?: string
      frameTarget?: string
      formmethod?: string
      name?: string
      stream?: string
      value?: string
    }): ReactNode {
      const { disabled, name, value } = props
      const binding = useExpoTurboFormControl({
        ...(disabled !== undefined ? { disabled } : {}),
        kind: "submitter",
        ...(name !== undefined ? { name } : {}),
        ...(value !== undefined ? { value } : {}),
      })
      return createElement("native-submitter", {
        accessibilityState: binding.accessibilityState,
        disabled: binding.disabled,
        nodeKey: binding.nodeKey,
        pending: binding.pending,
        selection: binding.selection,
        submitsWith: binding.submitsWith,
        value,
      })
    }

    const form = defineComponent({
      attributes: {
        action: { codec: stringCodec, prop: "action" },
        "data-turbo-frame": { codec: stringCodec, prop: "frameTarget" },
        "data-turbo-stream": { codec: stringCodec, prop: "stream" },
        enctype: { codec: stringCodec, prop: "enctype" },
        method: { codec: stringCodec, prop: "method" },
      },
      children: "nodes",
      component: NativeForm,
      formOwner: true,
      schema: z.object({
        action: z.string().optional(),
        enctype: z.string().optional(),
        frameTarget: z.string().optional(),
        method: z.string().optional(),
        stream: z.string().optional(),
      }),
      tag: "NativeForm",
    })
    const capture = defineComponent({
      attributes: { slot: { codec: stringCodec, prop: "slot" } },
      children: "none",
      component: CaptureForm,
      schema: z.object({ slot: z.string() }),
      tag: "CaptureForm",
    })
    const value = defineComponent({
      attributes: {
        "direction-name": { codec: stringCodec, prop: "directionName" },
        "direction-value": { codec: enumCodec(["ltr", "rtl"]), prop: "directionValue" },
        disabled: { codec: booleanCodec, prop: "disabled" },
        name: { codec: stringCodec, prop: "name" },
        value: { codec: stringCodec, prop: "value" },
      },
      children: "none",
      component: NativeValue,
      schema: z.object({
        directionName: z.string().optional(),
        directionValue: z.enum(["ltr", "rtl"]).optional(),
        disabled: z.boolean().optional(),
        name: z.string().optional(),
        value: z.string(),
      }),
      tag: "NativeValue",
    })
    const hidden = defineComponent({
      attributes: {
        name: { codec: stringCodec, prop: "name" },
        value: { codec: stringCodec, prop: "value" },
      },
      children: "none",
      component: NativeHidden,
      schema: z.object({ name: z.string().optional(), value: z.string().optional() }),
      tag: "NativeHidden",
    })
    const liveValue = defineComponent({
      attributes: {
        name: { codec: stringCodec, prop: "name" },
        value: { codec: stringCodec, prop: "value" },
      },
      children: "none",
      component: NativeLiveValue,
      schema: z.object({ name: z.string(), value: z.string() }),
      tag: "NativeLiveValue",
    })
    const checkable = defineComponent({
      attributes: {
        checked: { codec: booleanCodec, prop: "checked" },
        name: { codec: stringCodec, prop: "name" },
        value: { codec: stringCodec, prop: "value" },
      },
      children: "none",
      component: NativeCheckable,
      schema: z.object({
        checked: z.boolean(),
        name: z.string(),
        value: z.string().optional(),
      }),
      tag: "NativeCheckable",
    })
    const multiple = defineComponent({
      attributes: {
        name: { codec: stringCodec, prop: "name" },
        values: { codec: stringCodec, prop: "values" },
      },
      children: "none",
      component: NativeMultiple,
      schema: z.object({ name: z.string(), values: z.string() }),
      tag: "NativeMultiple",
    })
    const entries = defineComponent({
      attributes: {
        "entry-names": { codec: stringCodec, prop: "entryNames" },
        "entry-values": { codec: stringCodec, prop: "entryValues" },
      },
      children: "none",
      component: NativeEntries,
      schema: z.object({ entryNames: z.string(), entryValues: z.string() }),
      tag: "NativeEntries",
    })
    const submitter = defineComponent({
      attributes: {
        "data-turbo-frame": { codec: stringCodec, prop: "frameTarget" },
        "data-turbo-stream": { codec: stringCodec, prop: "stream" },
        disabled: { codec: booleanCodec, prop: "disabled" },
        formaction: { codec: stringCodec, prop: "formaction" },
        formenctype: { codec: stringCodec, prop: "formenctype" },
        formmethod: { codec: stringCodec, prop: "formmethod" },
        name: { codec: stringCodec, prop: "name" },
        value: { codec: stringCodec, prop: "value" },
      },
      children: "none",
      component: NativeSubmitter,
      schema: z.object({
        disabled: z.boolean().optional(),
        formaction: z.string().optional(),
        formenctype: z.string().optional(),
        frameTarget: z.string().optional(),
        formmethod: z.string().optional(),
        name: z.string().optional(),
        stream: z.string().optional(),
        value: z.string().optional(),
      }),
      tag: "NativeSubmitter",
    })
    const componentRegistry = registryWithCounters().use(
      defineComponentModule({
        components: [
          form,
          capture,
          hidden,
          value,
          liveValue,
          checkable,
          multiple,
          entries,
          submitter,
        ],
        name: "native-form-components",
        version: "0.1.0",
      }),
    )
    const session = new DocumentSession(
      parseExpoTurboDocument(`<Gallery>
        <NativeForm id="form" action="/profile" method="post" data-turbo-frame="profile-frame">
          <CaptureForm slot="primary" />
          <NativeValue id="first" name="item" value="" />
          <NativeHidden id="hidden-token" name="authenticity_token" value="token" />
          <NativeHidden id="hidden-charset" name="_CHARSET_" value="ignored" />
          <NativeValue id="directional" name="comment" value="مرحبا" direction-name="comment.dir" direction-value="rtl" />
          <NativeLiveValue id="local" name="local" value="before" />
          <NativeCheckable id="checked" checked="true" name="agree" />
          <NativeMultiple id="multiple" name="choices[]" values="one||one" />
          <NativeEntries id="entry-list" entry-names="profile[city]||_charset_" entry-values="London|empty-name|host-owned" />
          <NativeValue id="disabled" disabled="true" name="ignored" value="secret" />
          <NativeValue id="unnamed" value="ignored" />
          <NativeSubmitter id="submit" name="commit" value="save" formaction="/profile/save" formmethod="patch" data-turbo-stream="" data-turbo-submits-with="Saving…" />
          <NativeSubmitter id="alternate" name="commit" value="ignored" />
          <NativeSubmitter id="authored-disabled" disabled="true" name="commit" value="disabled" />
        </NativeForm>
        <turbo-frame id="profile-frame" />
        <NativeForm id="outer-form">
          <CaptureForm slot="outer" />
          <NativeValue id="outer-value" name="outer" value="parent" />
          <NativeForm id="other-form">
            <CaptureForm slot="other" />
            <NativeValue id="other-value" name="other" value="isolated" />
          </NativeForm>
        </NativeForm>
      </Gallery>`, { url: "https://example.test/forms/current" }),
    )
    const pendingSubmissions: {
      request: TurboRequest
      resolve: (response: TurboResponse) => void
    }[] = []
    const submissionController = new FormSubmissionController(session, {
      fetch: (request) =>
        new Promise<TurboResponse>((resolve) => pendingSubmissions.push({ request, resolve })),
    })
    const forms = new DocumentFormControls(session, { submissionController })
    const scopes = new DocumentStateScopes(session)
    const state = new DocumentStateStore()
    let renderer: ReactTestRenderer | undefined
    await act(async () => {
      renderer = create(
        createElement(
          StrictMode,
          null,
          createElement(
            ExpoTurboProvider,
            { forms, registry: componentRegistry, scopes, session, state },
            createElement(ExpoTurboRoot),
          ),
        ),
      )
      await Promise.resolve()
    })
    if (!renderer) throw new Error("renderer was not created")
    const activeRenderer = renderer
    const primary = bindings.get("primary")
    const outer = bindings.get("outer")
    const other = bindings.get("other")
    if (!primary || !outer || !other) throw new Error("form bindings were not captured")
    expect(scopes.isDisposed).toBe(false)
    expect(state.isDisposed).toBe(false)
    const activeForm = session.tree.getElementById("form")
    if (!activeForm) throw new Error("active form fixture is missing")
    const activeFormState = scopes.scopeFor(activeForm.key, "form").state
    activeFormState.set("strict-mode", "active")
    expect(activeFormState.get("strict-mode")).toBe("active")

    const submitterControl = activeRenderer.root
      .findAll((node) => String(node.type) === "native-submitter")
      .find((control) => control.props.nodeKey === "id:submit")
    if (!submitterControl) throw new Error("submitter control was not rendered")
    const submitterSelection = submitterControl.props.selection
    const selectedSubmitter = submitterSelection()
    const entryListControl = activeRenderer.root
      .findAll((node) => String(node.type) === "native-entries")
      .find((control) => control.props.nodeKey === "id:entry-list")
    if (!entryListControl) throw new Error("entry-list control was not rendered")
    const entryListSelection = entryListControl.props.selection()
    expect(primary.successfulEntries({ submitter: selectedSubmitter })).toEqual([
      { name: "item", value: "" },
      { name: "authenticity_token", value: "token" },
      { name: "_CHARSET_", value: "UTF-8" },
      { name: "comment", value: "مرحبا" },
      { name: "comment.dir", value: "rtl" },
      { name: "local", value: "before" },
      { name: "agree", value: "on" },
      { name: "choices[]", value: "one" },
      { name: "choices[]", value: "" },
      { name: "choices[]", value: "one" },
      { name: "profile[city]", value: "London" },
      { name: "", value: "empty-name" },
      { name: "_charset_", value: "host-owned" },
      { name: "commit", value: "save" },
    ])
    expect(
      primary.submissionProposal({
        protocol: { requestId: "react-request" },
        submitter: selectedSubmitter,
      }),
    ).toMatchObject({
      destination: {
        frameId: "profile-frame",
        kind: "frame",
        requestedTarget: "profile-frame",
      },
      plan: {
        effectiveMethod: "PATCH",
        entries: [
          { name: "item", value: "" },
          { name: "authenticity_token", value: "token" },
          { name: "_CHARSET_", value: "UTF-8" },
          { name: "comment", value: "مرحبا" },
          { name: "comment.dir", value: "rtl" },
          { name: "local", value: "before" },
          { name: "agree", value: "on" },
          { name: "choices[]", value: "one" },
          { name: "choices[]", value: "" },
          { name: "choices[]", value: "one" },
          { name: "profile[city]", value: "London" },
          { name: "", value: "empty-name" },
          { name: "_charset_", value: "host-owned" },
          { name: "commit", value: "save" },
          { name: "_method", value: "patch" },
        ],
        request: {
          headers: {
            Accept: "text/vnd.turbo-stream.html, application/vnd.expo-turbo+xml",
            "Turbo-Frame": "profile-frame",
            "X-Turbo-Request-Id": "react-request",
          },
          method: "POST",
          url: "https://example.test/profile/save",
        },
        sourceMethod: "PATCH",
      },
    })
    expect(entriesAtPassiveMount.get("primary")).toEqual(primary.successfulEntries())
    expect(outer.successfulEntries()).toEqual([{ name: "outer", value: "parent" }])
    expect(other.successfulEntries()).toEqual([{ name: "other", value: "isolated" }])

    let submission: Promise<unknown> | undefined
    await act(async () => {
      submission = primary.submit({
        protocol: { requestId: "react-submission" },
        submitter: selectedSubmitter,
      })
      await Promise.resolve()
    })
    expect(pendingSubmissions).toHaveLength(1)
    expect(bindings.get("primary")?.state).toMatchObject({
      busy: true,
      requestId: "react-submission",
      status: "submitting",
      submitterNodeKey: "id:submit",
    })
    expect(bindings.get("primary")?.accessibilityState).toEqual({ busy: true })
    const pendingSubmitter = activeRenderer.root
      .findAll((node) => String(node.type) === "native-submitter")
      .find((control) => control.props.nodeKey === "id:submit")
    const unaffectedSubmitter = activeRenderer.root
      .findAll((node) => String(node.type) === "native-submitter")
      .find((control) => control.props.nodeKey === "id:alternate")
    const authoredDisabledSubmitter = activeRenderer.root
      .findAll((node) => String(node.type) === "native-submitter")
      .find((control) => control.props.nodeKey === "id:authored-disabled")
    expect(pendingSubmitter?.props).toMatchObject({
      accessibilityState: { disabled: true },
      disabled: true,
      pending: true,
      submitsWith: "Saving…",
      value: "save",
    })
    expect(unaffectedSubmitter?.props).toMatchObject({
      accessibilityState: { disabled: false },
      disabled: false,
      pending: false,
      value: "ignored",
    })
    expect(unaffectedSubmitter?.props.submitsWith).toBeUndefined()
    expect(authoredDisabledSubmitter?.props).toMatchObject({
      accessibilityState: { disabled: true },
      disabled: true,
      pending: false,
      value: "disabled",
    })

    let duplicate: Promise<unknown> | undefined
    await act(async () => {
      duplicate = primary.submit({
        protocol: { requestId: "react-duplicate" },
        submitter: selectedSubmitter,
      })
      await Promise.resolve()
    })
    await expect(duplicate).resolves.toMatchObject({
      requestId: "react-duplicate",
      status: "canceled",
    })
    expect(pendingSubmissions).toHaveLength(1)
    expect(bindings.get("primary")?.state.requestId).toBe("react-submission")

    const activeSubmission = pendingSubmissions[0]
    if (!activeSubmission || !submission) throw new Error("form submission was not captured")
    await act(async () => {
      activeSubmission.resolve({
        headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
        redirected: false,
        status: 204,
        text: async () => "",
        url: activeSubmission.request.url,
      })
      await submission
    })
    expect(bindings.get("primary")?.state).toMatchObject({ busy: false, status: "idle" })
    expect(bindings.get("primary")?.accessibilityState).toEqual({ busy: false })
    const restoredSubmitter = activeRenderer.root
      .findAll((node) => String(node.type) === "native-submitter")
      .find((control) => control.props.nodeKey === "id:submit")
    expect(restoredSubmitter?.props).toMatchObject({
      accessibilityState: { disabled: false },
      disabled: false,
      pending: false,
      value: "save",
    })
    expect(restoredSubmitter?.props.submitsWith).toBeUndefined()

    const liveControl = activeRenderer.root
      .findAll((node) => String(node.type) === "native-live-value")
      .find((control) => control.props.nodeKey === "id:local")
    if (!liveControl) throw new Error("live form control was not rendered")
    act(() => liveControl.props.onChange("component-local"))
    expect(primary.successfulEntries().find((entry) => entry.name === "local")).toEqual({
      name: "local",
      value: "component-local",
    })
    expect(
      primary
        .requestPlan({ protocol: { requestId: "component-local-request" } })
        .entries.find((entry) => entry.name === "local"),
    ).toEqual({ name: "local", value: "component-local" })

    act(() => {
      dispatchTurboStreamFragment(
        session,
        '<turbo-stream action="replace" target="submit"><template><NativeSubmitter id="submit" name="commit" value="replacement" formaction="/profile/replacement" formmethod="post" /></template></turbo-stream>',
      )
    })
    expect(() => submitterSelection()).toThrow(StateError)
    expect(() => primary.successfulEntries({ submitter: selectedSubmitter })).toThrow(TargetError)
    const replacementSubmitterControl = activeRenderer.root
      .findAll((node) => String(node.type) === "native-submitter")
      .find((control) => control.props.nodeKey === "id:submit")
    if (!replacementSubmitterControl) throw new Error("replacement submitter was not rendered")
    const replacementSubmitterSelection = replacementSubmitterControl.props.selection
    const selectedReplacementSubmitter = replacementSubmitterSelection()
    expect(
      primary.requestPlan({
        protocol: { requestId: "replacement-submitter" },
        submitter: selectedReplacementSubmitter,
      }),
    ).toMatchObject({
      entries: [
        { name: "item", value: "" },
        { name: "authenticity_token", value: "token" },
        { name: "_CHARSET_", value: "UTF-8" },
        { name: "comment", value: "مرحبا" },
        { name: "comment.dir", value: "rtl" },
        { name: "local", value: "component-local" },
        { name: "agree", value: "on" },
        { name: "choices[]", value: "one" },
        { name: "choices[]", value: "" },
        { name: "choices[]", value: "one" },
        { name: "profile[city]", value: "London" },
        { name: "", value: "empty-name" },
        { name: "_charset_", value: "host-owned" },
        { name: "commit", value: "replacement" },
      ],
      request: { method: "POST", url: "https://example.test/profile/replacement" },
      sourceMethod: "POST",
    })

    act(() => session.setAttribute("id:entry-list", "entry-values", "Paris|changed|host-two"))
    const updatedEntryListControl = activeRenderer.root
      .findAll((node) => String(node.type) === "native-entries")
      .find((control) => control.props.nodeKey === "id:entry-list")
    if (!updatedEntryListControl) throw new Error("updated entry-list control was not rendered")
    expect(updatedEntryListControl.props.selection()).toBe(entryListSelection)
    const updatedEntryList = primary.successfulEntries()
    const updatedEntryListIndex = updatedEntryList.findIndex(
      ({ name }) => name === "profile[city]",
    )
    expect(updatedEntryList.slice(updatedEntryListIndex, updatedEntryListIndex + 3)).toEqual([
      { name: "profile[city]", value: "Paris" },
      { name: "", value: "changed" },
      { name: "_charset_", value: "host-two" },
    ])

    act(() => session.setAttribute("id:first", "value", "updated"))
    expect(primary.successfulEntries()[0]).toEqual({ name: "item", value: "updated" })
    expect(
      primary.requestPlan({ protocol: { requestId: "updated-request" } }).entries[0],
    ).toEqual({ name: "item", value: "updated" })

    act(() => {
      dispatchTurboStreamFragment(
        session,
        '<turbo-stream action="update" target="form"><template><CaptureForm slot="updated"/><NativeValue id="next" name="next" value="child-update"/></template></turbo-stream>',
      )
    })
    const updated = bindings.get("updated")
    expect(updated?.formNodeKey).toBe(primary.formNodeKey)
    expect(updated?.successfulEntries()).toEqual([{ name: "next", value: "child-update" }])
    expect(entriesAtPassiveMount.get("updated")).toEqual([
      { name: "next", value: "child-update" },
    ])
    expect(() => replacementSubmitterSelection()).toThrow(StateError)
    expect(() =>
      primary.successfulEntries({ submitter: selectedReplacementSubmitter }),
    ).toThrow(TargetError)
    expect(() =>
      primary.requestPlan({
        protocol: { requestId: "removed-submitter" },
        submitter: selectedReplacementSubmitter,
      }),
    ).toThrow(TargetError)

    act(() => {
      dispatchTurboStreamFragment(
        session,
        '<turbo-stream action="replace" target="form"><template><NativeForm id="form"><CaptureForm slot="replacement"/><NativeValue id="replacement-value" name="fresh" value="replacement"/></NativeForm></template></turbo-stream>',
      )
    })
    const replacement = bindings.get("replacement")
    if (!replacement) throw new Error("replacement form binding was not captured")
    expect(replacement).not.toBe(primary)
    expect(replacement.successfulEntries()).toEqual([{ name: "fresh", value: "replacement" }])
    expect(() => primary.successfulEntries()).toThrow(/disposed/)
    expect(outer.successfulEntries()).toEqual([{ name: "outer", value: "parent" }])
    expect(other.successfulEntries()).toEqual([{ name: "other", value: "isolated" }])

    await act(async () => {
      activeRenderer.unmount()
      await Promise.resolve()
    })
    expect(scopes.isDisposed).toBe(true)
    expect(state.isDisposed).toBe(true)
    expect(forms.isDisposed).toBe(false)
    expect(replacement.successfulEntries()).toEqual([])
    expect(outer.successfulEntries()).toEqual([])
    expect(other.successfulEntries()).toEqual([])
    forms.dispose()
    expect(() => replacement.successfulEntries()).toThrow(/disposed/)
  })

  test("updates selected option snapshots without re-registering through StrictMode replay", async () => {
    let captured: ExpoTurboFormBinding | undefined

    function NativeForm(props: Readonly<{ children?: ReactNode }>): ReactNode {
      return createElement(ExpoTurboFormScope, null, props.children)
    }
    function CaptureForm(): ReactNode {
      const binding = useExpoTurboForm()
      useEffect(() => {
        captured = binding
        return () => {
          if (captured === binding) captured = undefined
        }
      }, [binding])
      return createElement("select-form-capture")
    }
    function NativeSelect({ name }: { name: string }): ReactNode {
      const [alternate, setAlternate] = useState(false)
      const binding = useExpoTurboFormControl({
        kind: "select",
        name,
        options: [
          { kind: "option", selected: !alternate, textContent: " \tone\n " },
          {
            kind: "group",
            options: [
              { kind: "option", selected: alternate, value: "two" },
              { disabled: true, kind: "option", selected: true, value: "option-disabled" },
            ],
          },
          {
            disabled: true,
            kind: "group",
            options: [{ kind: "option", selected: true, value: "group-disabled" }],
          },
        ],
      })
      return createElement("native-select", {
        nodeKey: binding.nodeKey,
        onChange: () => setAlternate((current) => !current),
        selection: binding.selection,
        value: alternate ? "two" : "one",
      })
    }

    const form = defineComponent({
      attributes: {},
      children: "nodes",
      component: NativeForm,
      formOwner: true,
      schema: z.object({}),
      tag: "SelectForm",
    })
    const capture = defineComponent({
      attributes: {},
      children: "none",
      component: CaptureForm,
      schema: z.object({}),
      tag: "CaptureSelectForm",
    })
    const select = defineComponent({
      attributes: { name: { codec: stringCodec, prop: "name" } },
      children: "none",
      component: NativeSelect,
      schema: z.object({ name: z.string() }),
      tag: "NativeSelectSnapshot",
    })
    const componentRegistry = registryWithCounters().use(
      defineComponentModule({
        components: [form, capture, select],
        name: "native-select-snapshot",
        version: "0.1.0",
      }),
    )
    const session = new DocumentSession(
      parseExpoTurboDocument(
        '<Gallery><SelectForm id="form"><CaptureSelectForm/><NativeSelectSnapshot id="select" name="choice[]"/></SelectForm></Gallery>',
        { url: "https://example.test/select" },
      ),
    )
    const forms = new DocumentFormControls(session)
    let renderer: ReactTestRenderer | undefined
    await act(async () => {
      renderer = create(
        createElement(
          StrictMode,
          null,
          createElement(
            ExpoTurboProvider,
            { forms, registry: componentRegistry, session },
            createElement(ExpoTurboRoot),
          ),
        ),
      )
      await Promise.resolve()
    })
    if (!renderer || !captured) throw new Error("select form fixture was not captured")
    const activeRenderer = renderer
    const binding = captured

    expect(binding.successfulEntries()).toEqual([{ name: "choice[]", value: "one" }])
    const control = activeRenderer.root.findAll(
      (node) => String(node.type) === "native-select",
    )[0]
    if (!control) throw new Error("native select was not rendered")
    const selection = control.props.selection()
    act(() => control.props.onChange())
    const updatedControl = activeRenderer.root.findAll(
      (node) => String(node.type) === "native-select",
    )[0]
    if (!updatedControl) throw new Error("updated native select was not rendered")
    expect(updatedControl.props.selection()).toBe(selection)
    expect(binding.successfulEntries()).toEqual([{ name: "choice[]", value: "two" }])

    await act(async () => {
      activeRenderer.unmount()
      await Promise.resolve()
    })
    forms.dispose()
  })

  test("projects fieldset disabledness while datalist ancestry only bars submission", async () => {
    let captured: ExpoTurboFormBinding | undefined

    function NativeForm(props: Readonly<{ children?: ReactNode }>): ReactNode {
      return createElement(ExpoTurboFormScope, null, props.children)
    }
    function FormContainer(props: Readonly<{ children?: ReactNode }>): ReactNode {
      return createElement(Fragment, null, props.children)
    }
    function CaptureForm(): ReactNode {
      const binding = useExpoTurboForm()
      useEffect(() => {
        captured = binding
        return () => {
          if (captured === binding) captured = undefined
        }
      }, [binding])
      return createElement("fieldset-form-capture")
    }
    function NativeValue({ name, value }: { name: string; value: string }): ReactNode {
      const binding = useExpoTurboFormControl({ kind: "value", name, value })
      return createElement("fieldset-value", {
        accessibilityState: binding.accessibilityState,
        disabled: binding.disabled,
        nodeKey: binding.nodeKey,
      })
    }
    function NativeSubmitter({ name, value }: { name: string; value: string }): ReactNode {
      const binding = useExpoTurboFormControl({ kind: "submitter", name, value })
      return createElement("fieldset-submitter", {
        accessibilityState: binding.accessibilityState,
        disabled: binding.disabled,
        selection: binding.selection,
      })
    }

    const form = defineComponent({
      attributes: {},
      children: "nodes",
      component: NativeForm,
      formOwner: true,
      schema: z.object({}),
      tag: "FieldsetForm",
    })
    const capture = defineComponent({
      attributes: {},
      children: "none",
      component: CaptureForm,
      schema: z.object({}),
      tag: "CaptureFieldsetForm",
    })
    const fieldset = defineComponent({
      attributes: { disabled: { codec: presenceCodec, prop: "disabled" } },
      children: "nodes",
      component: FormContainer,
      formContainer: "fieldset",
      schema: z.object({ disabled: z.boolean().default(false) }),
      tag: "NativeFieldset",
    })
    const datalist = defineComponent({
      attributes: {},
      children: "nodes",
      component: FormContainer,
      formContainer: "datalist",
      schema: z.object({}),
      tag: "NativeDatalist",
    })
    const legend = defineComponent({
      attributes: {},
      children: "nodes",
      component: FormContainer,
      formContainer: "legend",
      schema: z.object({}),
      tag: "NativeLegend",
    })
    const value = defineComponent({
      attributes: {
        name: { codec: stringCodec, prop: "name" },
        value: { codec: stringCodec, prop: "value" },
      },
      children: "none",
      component: NativeValue,
      schema: z.object({ name: z.string(), value: z.string() }),
      tag: "FieldsetValue",
    })
    const submitter = defineComponent({
      attributes: {
        name: { codec: stringCodec, prop: "name" },
        value: { codec: stringCodec, prop: "value" },
      },
      children: "none",
      component: NativeSubmitter,
      schema: z.object({ name: z.string(), value: z.string() }),
      tag: "FieldsetSubmitter",
    })
    const componentRegistry = registryWithCounters().use(
      defineComponentModule({
        components: [form, capture, datalist, fieldset, legend, value, submitter],
        name: "native-fieldset-semantics",
        version: "0.1.0",
      }),
    )
    const session = new DocumentSession(
      parseExpoTurboDocument(
        '<Gallery><FieldsetForm id="form"><CaptureFieldsetForm/><NativeFieldset id="fieldset" disabled=""><FieldsetValue id="blocked" name="blocked" value="no"/><NativeLegend><FieldsetValue id="exempt" name="exempt" value="yes"/><FieldsetSubmitter id="save" name="commit" value="save"/></NativeLegend></NativeFieldset><NativeDatalist><FieldsetValue id="datalist-value" name="datalist" value="omitted"/></NativeDatalist></FieldsetForm></Gallery>',
        { url: "https://example.test/fieldset" },
      ),
    )
    const forms = new DocumentFormControls(session, { formSemantics: componentRegistry })
    let renderer: ReactTestRenderer | undefined
    await act(async () => {
      renderer = create(
        createElement(
          StrictMode,
          null,
          createElement(
            ExpoTurboProvider,
            { forms, registry: componentRegistry, session },
            createElement(ExpoTurboRoot),
          ),
        ),
      )
      await Promise.resolve()
    })
    if (!renderer || !captured) throw new Error("fieldset form fixture was not captured")
    const activeRenderer = renderer
    const binding = captured
    const control = (nodeKey: string) =>
      activeRenderer.root.findAll(
        (node) => String(node.type) === "fieldset-value" && node.props.nodeKey === nodeKey,
      )[0]
    const submitterNode = () =>
      activeRenderer.root.findAll((node) => String(node.type) === "fieldset-submitter")[0]

    expect(control("id:blocked")?.props).toMatchObject({
      accessibilityState: { disabled: true },
      disabled: true,
    })
    expect(control("id:exempt")?.props).toMatchObject({
      accessibilityState: { disabled: false },
      disabled: false,
    })
    expect(control("id:datalist-value")?.props).toMatchObject({
      accessibilityState: { disabled: false },
      disabled: false,
    })
    expect(submitterNode()?.props.disabled).toBe(false)
    const selection = submitterNode()?.props.selection()
    expect(binding.successfulEntries({ submitter: selection })).toEqual([
      { name: "exempt", value: "yes" },
      { name: "commit", value: "save" },
    ])

    act(() => session.removeAttribute("id:fieldset", "disabled"))
    expect(control("id:blocked")?.props).toMatchObject({
      accessibilityState: { disabled: false },
      disabled: false,
    })
    expect(binding.successfulEntries({ submitter: selection })).toEqual([
      { name: "blocked", value: "no" },
      { name: "exempt", value: "yes" },
      { name: "commit", value: "save" },
    ])

    act(() => session.setAttribute("id:fieldset", "disabled", "false"))
    expect(control("id:blocked")?.props.disabled).toBe(true)
    expect(submitterNode()?.props.disabled).toBe(false)

    await act(async () => {
      activeRenderer.unmount()
      await Promise.resolve()
    })
    forms.dispose()
  })

  test("exposes form interception modes without gating explicit request planning", async () => {
    let captured: ExpoTurboFormBinding | undefined

    function NativeForm(
      props: Readonly<{ action?: string; children?: ReactNode }>,
    ): ReactNode {
      return createElement(ExpoTurboFormScope, null, props.children)
    }
    function CaptureForm(): ReactNode {
      const binding = useExpoTurboForm()
      useEffect(() => {
        captured = binding
        return () => {
          if (captured === binding) captured = undefined
        }
      }, [binding])
      return createElement("mode-form-capture")
    }
    function NativeSubmitter(props: Readonly<{ name: string; value: string }>): ReactNode {
      const binding = useExpoTurboFormControl({
        kind: "submitter",
        name: props.name,
        value: props.value,
      })
      return createElement("mode-submitter", { selection: binding.selection })
    }

    const form = defineComponent({
      attributes: { action: { codec: stringCodec, prop: "action" } },
      children: "nodes",
      component: NativeForm,
      formOwner: true,
      schema: z.object({ action: z.string().optional() }),
      tag: "ModeForm",
    })
    const capture = defineComponent({
      attributes: {},
      children: "none",
      component: CaptureForm,
      schema: z.object({}),
      tag: "CaptureModeForm",
    })
    const submitter = defineComponent({
      attributes: {
        name: { codec: stringCodec, prop: "name" },
        value: { codec: stringCodec, prop: "value" },
      },
      children: "none",
      component: NativeSubmitter,
      schema: z.object({ name: z.string(), value: z.string() }),
      tag: "ModeSubmitter",
    })
    const componentRegistry = registryWithCounters().use(
      defineComponentModule({
        components: [form, capture, submitter],
        name: "form-interception-mode",
        version: "0.1.0",
      }),
    )
    const session = new DocumentSession(
      parseExpoTurboDocument(
        '<Gallery id="mode-root"><ModeForm id="form" action="/save"><CaptureModeForm/><ModeSubmitter id="save" name="commit" value="save"/></ModeForm></Gallery>',
        { url: "https://example.test/current" },
      ),
    )
    const forms = new DocumentFormControls(session, { formMode: "optin" })
    let renderer: ReactTestRenderer | undefined
    await act(async () => {
      renderer = create(
        createElement(
          StrictMode,
          null,
          createElement(
            ExpoTurboProvider,
            { forms, registry: componentRegistry, session },
            createElement(ExpoTurboRoot),
          ),
        ),
      )
      await Promise.resolve()
    })
    if (!renderer || !captured) throw new Error("form mode fixture was not captured")
    const activeRenderer = renderer
    const binding = captured
    const submitterNode = activeRenderer.root.findAll(
      (node) => String(node.type) === "mode-submitter",
    )[0]
    if (!submitterNode) throw new Error("form mode submitter was not rendered")
    const selected = submitterNode.props.selection()

    expect(binding.shouldInterceptSubmission({ submitter: selected })).toBe(false)
    expect(
      binding.requestPlan({
        protocol: { requestId: "explicit-plan" },
        submitter: selected,
      }),
    ).toMatchObject({
      entries: [{ name: "commit", value: "save" }],
      request: { method: "GET", url: "https://example.test/save?commit=save" },
    })
    act(() => session.setAttribute("id:mode-root", "data-turbo", "true"))
    expect(binding.shouldInterceptSubmission({ submitter: selected })).toBe(true)
    act(() => session.setAttribute("id:save", "data-turbo", "false"))
    expect(binding.shouldInterceptSubmission({ submitter: selected })).toBe(false)

    await act(async () => {
      activeRenderer.unmount()
      await Promise.resolve()
    })
    forms.dispose()
  })

  test("binds explicit form owners in document order and rebinds after same-id replacement", async () => {
    function NativeForm(
      props: Readonly<{ action?: string; children?: ReactNode; method?: string }>,
    ): ReactNode {
      return createElement(ExpoTurboFormScope, null, props.children)
    }
    function CaptureForm({ slot }: { slot: string }): ReactNode {
      const binding = useExpoTurboForm()
      return createElement("form-binding", { binding, slot })
    }
    function NativeValue({ name, value }: { name: string; value: string }): ReactNode {
      const binding = useExpoTurboFormControl({ kind: "value", name, value })
      return createElement("external-value", { nodeKey: binding.nodeKey, value })
    }
    function NativeSubmitter({ name, value }: { name: string; value: string }): ReactNode {
      const formBinding = useExpoTurboForm()
      const binding = useExpoTurboFormControl({ kind: "submitter", name, value })
      return createElement("external-submitter", {
        formBinding,
        nodeKey: binding.nodeKey,
        selection: binding.selection,
      })
    }

    const form = defineComponent({
      attributes: {
        action: { codec: stringCodec, prop: "action" },
        method: { codec: stringCodec, prop: "method" },
      },
      children: "nodes",
      component: NativeForm,
      formOwner: true,
      schema: z.object({ action: z.string().optional(), method: z.string().optional() }),
      tag: "NativeForm",
    })
    const capture = defineComponent({
      attributes: { slot: { codec: stringCodec, prop: "slot" } },
      children: "none",
      component: CaptureForm,
      schema: z.object({ slot: z.string() }),
      tag: "CaptureForm",
    })
    const value = defineComponent({
      attributes: {
        name: { codec: stringCodec, prop: "name" },
        value: { codec: stringCodec, prop: "value" },
      },
      children: "none",
      component: NativeValue,
      schema: z.object({ name: z.string(), value: z.string() }),
      tag: "NativeValue",
    })
    const submitter = defineComponent({
      attributes: {
        formaction: { codec: stringCodec, prop: "formaction" },
        formmethod: { codec: stringCodec, prop: "formmethod" },
        name: { codec: stringCodec, prop: "name" },
        value: { codec: stringCodec, prop: "value" },
      },
      children: "none",
      component: NativeSubmitter,
      schema: z.object({
        formaction: z.string().optional(),
        formmethod: z.string().optional(),
        name: z.string(),
        value: z.string(),
      }),
      tag: "NativeSubmitter",
    })
    const registry = registryWithCounters().use(
      defineComponentModule({
        components: [form, capture, value, submitter],
        name: "external-form-components",
        version: "0.1.0",
      }),
    )
    const session = new DocumentSession(
      parseExpoTurboDocument(
        `<Gallery id="gallery">
          <NativeValue id="before" form="form" name="before" value="A" />
          <NativeSubmitter id="external-submit" form="form" name="commit" value="external" formaction="/external" formmethod="patch" />
          <NativeForm id="form" action="/initial" method="post">
            <CaptureForm slot="inside" />
            <NativeValue id="inside" name="inside" value="B" />
          </NativeForm>
          <CaptureForm id="outside-capture" form="form" slot="outside" />
          <NativeValue id="after" form="form" name="after" value="C" />
          <NativeForm id="outer">
            <CaptureForm slot="outer" />
            <NativeValue id="override" form="other" name="override" value="D" />
            <NativeForm id="other">
              <CaptureForm slot="other" />
              <NativeValue id="other-child" name="other" value="E" />
            </NativeForm>
          </NativeForm>
        </Gallery>`,
        { url: "https://example.test/forms/current" },
      ),
    )
    const forms = new DocumentFormControls(session)
    const errors: ExpoTurboRenderError[] = []
    let renderer: ReactTestRenderer | undefined
    await act(async () => {
      renderer = create(
        createElement(
          StrictMode,
          null,
          createElement(
            ExpoTurboProvider,
            {
              forms,
              onError: (event) => errors.push(event),
              registry,
              renderError: (event) => createElement("protocol-error", null, event.error.message),
              session,
            },
            createElement(ExpoTurboRoot),
          ),
        ),
      )
      await Promise.resolve()
    })
    if (!renderer) throw new Error("renderer was not created")
    const activeRenderer = renderer
    const formBinding = (slot: string): ExpoTurboFormBinding => {
      const node = activeRenderer.root
        .findAll((candidate) => String(candidate.type) === "form-binding")
        .find((candidate) => candidate.props.slot === slot)
      if (!node) throw new Error(`form binding ${slot} was not rendered`)
      return node.props.binding
    }
    const externalSubmitter = () => {
      const node = activeRenderer.root
        .findAll((candidate) => String(candidate.type) === "external-submitter")
        .find((candidate) => candidate.props.nodeKey === "id:external-submit")
      if (!node) throw new Error("external submitter was not rendered")
      return node
    }

    const inside = formBinding("inside")
    const outside = formBinding("outside")
    const outer = formBinding("outer")
    const other = formBinding("other")
    const submitterNode = externalSubmitter()
    const selected = submitterNode.props.selection()
    expect(outside.formNodeKey).toBe(inside.formNodeKey)
    expect(submitterNode.props.formBinding.formNodeKey).toBe(inside.formNodeKey)
    expect(outside.successfulEntries({ submitter: selected })).toEqual([
      { name: "before", value: "A" },
      { name: "inside", value: "B" },
      { name: "after", value: "C" },
      { name: "commit", value: "external" },
    ])
    expect(outer.successfulEntries()).toEqual([])
    expect(other.successfulEntries()).toEqual([
      { name: "override", value: "D" },
      { name: "other", value: "E" },
    ])
    expect(
      submitterNode.props.formBinding.submissionProposal({
        protocol: { requestId: "external-submit" },
        submitter: selected,
      }),
    ).toMatchObject({
      plan: {
        effectiveMethod: "PATCH",
        entries: [
          { name: "before", value: "A" },
          { name: "inside", value: "B" },
          { name: "after", value: "C" },
          { name: "commit", value: "external" },
          { name: "_method", value: "patch" },
        ],
        request: { method: "POST", url: "https://example.test/external" },
        sourceMethod: "PATCH",
      },
    })

    act(() => {
      dispatchTurboStreamFragment(
        session,
        '<turbo-stream action="replace" target="form"><template><NativeForm id="form" action="/replacement" method="get"><CaptureForm slot="replacement"/><NativeValue id="fresh" name="fresh" value="F"/></NativeForm></template></turbo-stream>',
      )
    })

    const replacement = formBinding("replacement")
    const reboundOutside = formBinding("outside")
    expect(reboundOutside).not.toBe(outside)
    expect(reboundOutside.formNodeKey).toBe(replacement.formNodeKey)
    expect(() => outside.successfulEntries()).toThrow(/disposed/)
    expect(() => replacement.successfulEntries({ submitter: selected })).toThrow(TargetError)
    const reboundSelected = externalSubmitter().props.selection()
    expect(reboundOutside.successfulEntries({ submitter: reboundSelected })).toEqual([
      { name: "before", value: "A" },
      { name: "fresh", value: "F" },
      { name: "after", value: "C" },
      { name: "commit", value: "external" },
    ])

    act(() => {
      dispatchTurboStreamFragment(
        session,
        '<turbo-stream action="remove" target="form"></turbo-stream>',
      )
    })
    expect(errors.some((event) => event.error.message.includes("missing form owner"))).toBe(true)
    expect(JSON.stringify(activeRenderer.toJSON())).toContain("missing form owner")

    act(() => {
      dispatchTurboStreamFragment(
        session,
        '<turbo-stream action="append" target="gallery"><template><NativeForm id="form" action="/reinserted" method="get"><CaptureForm slot="reinserted"/><NativeValue id="reinserted-value" name="reinserted" value="G"/></NativeForm></template></turbo-stream>',
      )
    })
    const reinserted = formBinding("reinserted")
    const recoveredOutside = formBinding("outside")
    expect(JSON.stringify(activeRenderer.toJSON())).not.toContain("missing form owner")
    expect(recoveredOutside.formNodeKey).toBe(reinserted.formNodeKey)
    expect(() => reinserted.successfulEntries({ submitter: reboundSelected })).toThrow(
      TargetError,
    )
    const reinsertedSelected = externalSubmitter().props.selection()
    expect(recoveredOutside.successfulEntries({ submitter: reinsertedSelected })).toEqual([
      { name: "before", value: "A" },
      { name: "after", value: "C" },
      { name: "reinserted", value: "G" },
      { name: "commit", value: "external" },
    ])

    await act(async () => {
      activeRenderer.unmount()
      await Promise.resolve()
    })
    forms.dispose()
  })

  test("publishes and dismisses terminal state through the form boundary without remounting children", async () => {
    const announcements: FormSubmissionAnnouncementEvent[] = []
    let fixture: ReturnType<typeof formTerminalFixture>
    fixture = formTerminalFixture("get", {
      formAnnouncements: {
        announce(event) {
          expect(fixture.boundary().state.busy).toBe(false)
          announcements.push(event)
        },
      },
    })
    expect(announcements).toEqual([])
    const submitter = fixture.hostNode("terminal-submitter").props.selection()
    let submission: ReturnType<ExpoTurboFormBinding["submit"]> | undefined

    await act(async () => {
      submission = fixture.binding().submit({
        protocol: { requestId: "boundary-failure" },
        submitter,
      })
      await Promise.resolve()
    })
    const failedRequest = fixture.pending[0]
    if (!failedRequest || !submission) throw new Error("terminal request was not captured")

    await act(async () => {
      failedRequest.resolve({
        headers: { "Content-Type": "application/json" },
        redirected: false,
        status: 200,
        text: async () => "{}",
        url: failedRequest.request.url,
      })
      await expect(submission).rejects.toThrow()
      await Promise.resolve()
    })

    expect(fixture.boundary().terminalState).toMatchObject({
      requestId: "boundary-failure",
      retryDisposition: "safe",
      status: "failed",
      submitterNodeKey: "id:submit",
    })
    expect(fixture.binding("first").terminalState).toBe(
      fixture.binding("second").terminalState,
    )
    expect(fixture.hostNode("form-boundary").props).toMatchObject({
      busy: false,
      terminalStatus: "failed",
    })
    expect(fixture.childMounts()).toBe(1)
    expect(fixture.childUnmounts()).toBe(0)
    expect(announcements.map(({ terminalState }) => terminalState.status)).toEqual([
      "failed",
    ])

    act(() => fixture.boundary().dismissTerminal())

    expect(fixture.boundary().terminalState.status).toBe("none")
    expect(fixture.binding("first").terminalState).toBe(
      fixture.binding("second").terminalState,
    )
    expect(fixture.hostNode("form-boundary").props.terminalStatus).toBe("none")
    expect(fixture.childMounts()).toBe(1)
    expect(fixture.childUnmounts()).toBe(0)
    expect(announcements).toHaveLength(1)

    act(() => fixture.renderer.unmount())
    expect(fixture.childUnmounts()).toBe(1)
  })

  test("retries a safe failure once with a fresh request and current exact-form controls", async () => {
    const announcements: FormSubmissionAnnouncementEvent[] = []
    const fixture = formTerminalFixture("get", {
      formAnnouncements: { announce: (event) => {
          announcements.push(event)
        } },
      strict: true,
    })
    const submitter = fixture.hostNode("terminal-submitter").props.selection()
    let submission: ReturnType<ExpoTurboFormBinding["submit"]> | undefined

    await act(async () => {
      submission = fixture.binding("first").submit({
        protocol: { requestId: "initial-get" },
        submitter,
      })
      await Promise.resolve()
    })
    const failedRequest = fixture.pending[0]
    if (!failedRequest || !submission) throw new Error("initial retry request was not captured")
    await act(async () => {
      failedRequest.resolve({
        headers: { "Content-Type": "text/plain" },
        redirected: false,
        status: 200,
        text: async () => "retry me",
        url: failedRequest.request.url,
      })
      await expect(submission).rejects.toThrow()
      await Promise.resolve()
    })
    expect(fixture.pending).toHaveLength(1)
    expect(fixture.binding("first").terminalState).toBe(
      fixture.binding("second").terminalState,
    )
    expect(() =>
      fixture.binding("second").retryFailure({
        protocol: { requestId: "initial-get" },
      }),
    ).toThrow(/fresh request ID/)
    expect(fixture.pending).toHaveLength(1)

    await act(async () => {
      fixture.hostNode("terminal-live-value").props.onChange("after-failure")
      fixture.session.setAttribute("id:form", "action", "/current-form?stale=1")
      fixture.session.setAttribute("id:form", "method", "post")
      fixture.session.setAttribute("id:submit", "formmethod", "get")
      fixture.session.setAttribute(
        "id:submit",
        "data-turbo-confirm",
        "Confirm the current retry",
      )
      await Promise.resolve()
    })

    let retry: ReturnType<ExpoTurboFormBinding["retryFailure"]> | undefined
    await act(async () => {
      retry = fixture.binding("second").retryFailure({
        protocol: { requestId: "retry-get" },
      })
      await Promise.resolve()
    })
    const retriedRequest = fixture.pending[1]
    if (!retriedRequest || !retry) throw new Error("retried form request was not captured")
    const retriedUrl = new URL(retriedRequest.request.url)
    expect(fixture.pending).toHaveLength(2)
    expect(fixture.confirmations).toEqual(["Confirm the current retry"])
    expect(retriedRequest.request.method).toBe("GET")
    expect(retriedRequest.request.headers["X-Turbo-Request-Id"]).toBe("retry-get")
    expect(retriedUrl.pathname).toBe("/current-form")
    expect(retriedUrl.searchParams.has("stale")).toBe(false)
    expect(retriedUrl.searchParams.getAll("query")).toEqual(["after-failure"])
    expect(retriedUrl.searchParams.getAll("commit")).toEqual(["search"])

    await act(async () => {
      retriedRequest.resolve({
        headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
        redirected: false,
        status: 204,
        text: async () => "",
        url: retriedRequest.request.url,
      })
      await expect(retry).resolves.toMatchObject({ requestId: "retry-get", status: "empty" })
      await Promise.resolve()
    })
    expect(fixture.pending).toHaveLength(2)
    expect(fixture.boundary().terminalState).toMatchObject({
      requestId: "retry-get",
      status: "empty",
    })
    expect(announcements.map(({ terminalState }) => terminalState.status)).toEqual([
      "failed",
      "empty",
    ])
    act(() => fixture.renderer.unmount())
  })

  test("refuses to replay an unsafe terminal failure", async () => {
    const fixture = formTerminalFixture("post")
    const submitter = fixture.hostNode("terminal-submitter").props.selection()
    let submission: ReturnType<ExpoTurboFormBinding["submit"]> | undefined

    await act(async () => {
      submission = fixture.binding().submit({
        protocol: { requestId: "unsafe-post" },
        submitter,
      })
      await Promise.resolve()
    })
    const failedRequest = fixture.pending[0]
    if (!failedRequest || !submission) throw new Error("unsafe form request was not captured")
    await act(async () => {
      failedRequest.resolve({
        headers: { "Content-Type": "application/json" },
        redirected: false,
        status: 200,
        text: async () => "{}",
        url: failedRequest.request.url,
      })
      await expect(submission).rejects.toThrow()
      await Promise.resolve()
    })

    expect(fixture.boundary().terminalState).toMatchObject({
      requestId: "unsafe-post",
      retryDisposition: "unsafe",
      status: "failed",
    })
    await expect(
      Promise.resolve().then(() =>
        fixture.boundary().retryFailure({ protocol: { requestId: "unsafe-retry" } }),
      ),
    ).rejects.toThrow(/not safely retryable/)
    expect(fixture.pending).toHaveLength(1)
    expect(fixture.boundary().terminalState).toMatchObject({
      requestId: "unsafe-post",
      retryDisposition: "unsafe",
      status: "failed",
    })
    act(() => fixture.renderer.unmount())
  })

  test("refuses to replay a submission whose response already committed", async () => {
    const announcements: FormSubmissionAnnouncementEvent[] = []
    const fixture = formTerminalFixture("post", {
      formAnnouncements: { announce: (event) => {
          announcements.push(event)
        } },
    })
    fixture.session.subscribe("id:status", () => {
      throw new Error("committed observer secret")
    })
    const submitter = fixture.hostNode("terminal-submitter").props.selection()
    let submission: ReturnType<ExpoTurboFormBinding["submit"]> | undefined

    await act(async () => {
      submission = fixture.binding().submit({
        protocol: { requestId: "committed-post" },
        submitter,
      })
      await Promise.resolve()
    })
    const request = fixture.pending[0]
    if (!request || !submission) throw new Error("committed form request was not captured")
    await act(async () => {
      request.resolve({
        headers: { "Content-Type": "text/vnd.turbo-stream.html" },
        redirected: false,
        status: 200,
        text: async () =>
          '<turbo-stream action="update" target="status"><template>After</template></turbo-stream>',
        url: request.request.url,
      })
      await expect(submission).rejects.toThrow()
      await Promise.resolve()
    })

    expect(fixture.boundary().terminalState).toMatchObject({
      application: "stream",
      requestId: "committed-post",
      retryDisposition: "committed",
      status: "committed-error",
    })
    await expect(
      Promise.resolve().then(() =>
        fixture.boundary().retryFailure({ protocol: { requestId: "committed-retry" } }),
      ),
    ).rejects.toThrow(/not safely retryable/)
    expect(fixture.pending).toHaveLength(1)
    expect(JSON.stringify(fixture.boundary().terminalState)).not.toContain("secret")
    expect(announcements.map(({ terminalState }) => terminalState.status)).toEqual([
      "committed-error",
    ])
    act(() => fixture.renderer.unmount())
  })

  test("announces applied and explicitly canceled terminal results", async () => {
    const announcements: FormSubmissionAnnouncementEvent[] = []
    const appliedFixture = formTerminalFixture("post", {
      formAnnouncements: { announce: (event) => {
          announcements.push(event)
        } },
    })
    let appliedSubmission: ReturnType<ExpoTurboFormBinding["submit"]> | undefined
    await act(async () => {
      appliedSubmission = appliedFixture.binding().submit({
        protocol: { requestId: "announced-applied" },
      })
      await Promise.resolve()
    })
    const appliedRequest = appliedFixture.pending[0]
    if (!appliedRequest || !appliedSubmission) {
      throw new Error("applied announcement request was not captured")
    }
    await act(async () => {
      appliedRequest.resolve({
        headers: { "Content-Type": "text/vnd.turbo-stream.html" },
        redirected: false,
        status: 200,
        text: async () =>
          '<turbo-stream action="update" target="status"><template>Applied</template></turbo-stream>',
        url: appliedRequest.request.url,
      })
      await expect(appliedSubmission).resolves.toMatchObject({ status: "applied" })
      await Promise.resolve()
    })
    expect(announcements.map(({ terminalState }) => terminalState.status)).toEqual([
      "applied",
    ])
    act(() => appliedFixture.renderer.unmount())

    const canceledFixture = formTerminalFixture("get", {
      formAnnouncements: { announce: (event) => {
          announcements.push(event)
        } },
    })
    let canceledSubmission: ReturnType<ExpoTurboFormBinding["submit"]> | undefined
    await act(async () => {
      canceledSubmission = canceledFixture.binding().submit({
        protocol: { requestId: "announced-canceled" },
      })
      await Promise.resolve()
      canceledFixture.binding().cancelSubmission()
      await Promise.resolve()
    })
    if (!canceledSubmission) throw new Error("canceled announcement request was not captured")
    await expect(canceledSubmission).resolves.toMatchObject({ status: "canceled" })
    expect(announcements.map(({ terminalState }) => terminalState.status)).toEqual([
      "applied",
      "canceled",
    ])
    act(() => canceledFixture.renderer.unmount())
  })

  test("cancels the active form after its last mounted scope unmounts", async () => {
    const fixture = formScopeUnmountFixture()
    const forms = fixture.forms()
    const controls = forms.controlsFor("id:form")
    const announcements: FormSubmissionAnnouncementEvent[] = []
    let renderer: ReactTestRenderer | undefined
    act(() => {
      renderer = create(
        fixture.provider(forms, {
          formAnnouncements: { announce: (event) => {
          announcements.push(event)
        } },
        }),
      )
    })
    if (!renderer) throw new Error("renderer was not created")

    let submission: ReturnType<ExpoTurboFormBinding["submit"]> | undefined
    await act(async () => {
      submission = fixture.binding().submit({ protocol: { requestId: "provider-unmount" } })
      await Promise.resolve()
    })
    const request = fixture.pending[0]
    if (!request || !submission) throw new Error("form request was not captured")
    expect(controls.submissionState.busy).toBe(true)

    await act(async () => {
      renderer?.unmount()
      await Promise.resolve()
    })

    expect(request.request.signal?.aborted).toBe(true)
    expect(await submission).toMatchObject({ requestId: "provider-unmount", status: "canceled" })
    expect(controls.submissionState).toMatchObject({ busy: false, status: "idle" })
    expect(controls.submissionTerminalState).toMatchObject({
      requestId: "provider-unmount",
      status: "canceled",
    })
    expect(controls.isDisposed).toBe(false)
    expect(forms.isDisposed).toBe(false)
    expect(fixture.session.tree.getElementById("form")).toBeDefined()
    expect(announcements).toEqual([])
  })

  test("does not announce a denied pre-start confirmation", async () => {
    const announcements: FormSubmissionAnnouncementEvent[] = []
    const fixture = formScopeUnmountFixture(undefined, {
      confirm: () => false,
    })
    fixture.session.setAttribute("id:form", "data-turbo-confirm", "Continue?")
    const forms = fixture.forms()
    const controls = forms.controlsFor("id:form")
    let renderer: ReactTestRenderer | undefined
    act(() => {
      renderer = create(
        fixture.provider(forms, {
          formAnnouncements: { announce: (event) => {
          announcements.push(event)
        } },
        }),
      )
    })
    if (!renderer) throw new Error("renderer was not created")

    await expect(
      fixture.binding().submit({ protocol: { requestId: "confirm-denied" } }),
    ).resolves.toMatchObject({ requestId: "confirm-denied", status: "canceled" })

    expect(fixture.pending).toEqual([])
    expect(controls.submissionTerminalState.status).toBe("none")
    expect(announcements).toEqual([])
    act(() => renderer?.unmount())
  })

  test("cancels pending confirmation when its final mounted scope unmounts", async () => {
    let confirmationSignal: AbortSignal | undefined
    const fixture = formScopeUnmountFixture(undefined, {
      confirm(_message, signal) {
        confirmationSignal = signal
        return new Promise<boolean>(() => undefined)
      },
    })
    fixture.session.setAttribute("id:form", "data-turbo-confirm", "Continue?")
    const forms = fixture.forms()
    const controls = forms.controlsFor("id:form")
    let renderer: ReactTestRenderer | undefined
    act(() => {
      renderer = create(fixture.provider(forms))
    })
    if (!renderer) throw new Error("renderer was not created")

    let submission: ReturnType<ExpoTurboFormBinding["submit"]> | undefined
    await act(async () => {
      submission = fixture.binding().submit({ protocol: { requestId: "confirm-unmount" } })
      await Promise.resolve()
    })
    if (!submission) throw new Error("pending confirmation was not captured")
    expect(fixture.pending).toHaveLength(0)
    expect(controls.submissionState).toMatchObject({ busy: false, status: "idle" })
    expect(confirmationSignal?.aborted).toBe(false)

    await act(async () => {
      renderer?.unmount()
      await Promise.resolve()
    })

    expect(confirmationSignal?.aborted).toBe(true)
    expect(await submission).toMatchObject({ requestId: "confirm-unmount", status: "canceled" })
    expect(fixture.pending).toHaveLength(0)
    expect(controls.submissionTerminalState.status).toBe("none")
    expect(controls.isDisposed).toBe(false)
    expect(forms.isDisposed).toBe(false)
  })

  test("keeps an active form through StrictMode replay and cancels its real unmount", async () => {
    const fixture = formScopeUnmountFixture("strict-replay")
    const forms = fixture.forms()
    const controls = forms.controlsFor("id:form")
    let renderer: ReactTestRenderer | undefined
    await act(async () => {
      renderer = create(createElement(StrictMode, null, fixture.provider(forms)))
      await Promise.resolve()
    })
    if (!renderer) throw new Error("renderer was not created")
    const request = fixture.pending[0]
    const submission = fixture.automaticSubmission()
    if (!request || !submission) throw new Error("automatic form request was not captured")

    expect(fixture.pending).toHaveLength(1)
    expect(request.request.signal?.aborted).toBe(false)
    expect(controls.submissionState).toMatchObject({
      busy: true,
      requestId: "strict-replay",
      status: "submitting",
    })

    await act(async () => {
      renderer?.unmount()
      await Promise.resolve()
    })

    expect(request.request.signal?.aborted).toBe(true)
    expect(await submission).toMatchObject({ requestId: "strict-replay", status: "canceled" })
    expect(controls.submissionState).toMatchObject({ busy: false, status: "idle" })
  })

  test("cancels only after the last provider releases an exact form activity", async () => {
    const fixture = formScopeUnmountFixture()
    const formsA = fixture.forms()
    const formsB = fixture.forms()
    const controlsA = formsA.controlsFor("id:form")
    const controlsB = formsB.controlsFor("id:form")
    let rendererA: ReactTestRenderer | undefined
    let rendererB: ReactTestRenderer | undefined
    act(() => {
      rendererA = create(fixture.provider(formsA))
      rendererB = create(fixture.provider(formsB))
    })
    if (!rendererA || !rendererB) throw new Error("renderers were not created")
    expect(controlsA).not.toBe(controlsB)

    let submission: ReturnType<ExpoTurboFormBinding["submit"]> | undefined
    await act(async () => {
      submission = fixture.binding().submit({ protocol: { requestId: "shared-owner" } })
      await Promise.resolve()
    })
    const request = fixture.pending[0]
    if (!request || !submission) throw new Error("shared form request was not captured")
    expect(controlsA.submissionState).toBe(controlsB.submissionState)

    await act(async () => {
      rendererA?.unmount()
      await Promise.resolve()
    })
    expect(request.request.signal?.aborted).toBe(false)
    expect(controlsB.submissionState).toMatchObject({ busy: true, requestId: "shared-owner" })
    expect(formsA.isDisposed).toBe(false)

    await act(async () => {
      rendererB?.unmount()
      await Promise.resolve()
    })
    expect(request.request.signal?.aborted).toBe(true)
    expect(await submission).toMatchObject({ requestId: "shared-owner", status: "canceled" })
    expect(controlsA.submissionState).toMatchObject({ busy: false, status: "idle" })
    expect(formsA.isDisposed).toBe(false)
    expect(formsB.isDisposed).toBe(false)
  })

  test("deduplicates terminal announcements across StrictMode and providers and isolates adapter failure", async () => {
    const fixture = formScopeUnmountFixture()
    const formsA = fixture.forms()
    const formsB = fixture.forms()
    const errors: ExpoTurboRenderError[] = []
    const statuses: string[] = []
    const announcements: FormSubmissionAnnouncementAdapter = {
      announce({ terminalState }) {
        statuses.push(terminalState.status)
        if (statuses.length === 1) throw new Error("native announcement unavailable")
        if (statuses.length === 2) {
          return Promise.reject(new Error("async announcement unavailable"))
        }
      },
    }
    let rendererA: ReactTestRenderer | undefined
    let rendererB: ReactTestRenderer | undefined
    act(() => {
      rendererA = create(
        createElement(
          StrictMode,
          null,
          fixture.provider(formsA, { formAnnouncements: announcements, onError: (e) => errors.push(e) }),
        ),
      )
      rendererB = create(
        createElement(
          StrictMode,
          null,
          fixture.provider(formsB, { formAnnouncements: announcements, onError: (e) => errors.push(e) }),
        ),
      )
    })
    if (!rendererA || !rendererB) throw new Error("announcement renderers were not created")
    expect(statuses).toEqual([])

    for (const requestId of [
      "sync-failed-announcement",
      "async-failed-announcement",
      "later-announcement",
    ]) {
      let submission: ReturnType<ExpoTurboFormBinding["submit"]> | undefined
      await act(async () => {
        submission = fixture.binding().submit({ protocol: { requestId } })
        await Promise.resolve()
      })
      const request = fixture.pending.at(-1)
      if (!request || !submission) throw new Error("announcement request was not captured")
      await act(async () => {
        request.resolve({
          headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
          redirected: false,
          status: 204,
          text: async () => "",
          url: request.request.url,
        })
        await expect(submission).resolves.toMatchObject({ requestId, status: "empty" })
        await Promise.resolve()
      })
    }

    expect(statuses).toEqual(["empty", "empty", "empty"])
    expect(errors.map(({ error }) => error.message)).toEqual([
      "native announcement unavailable",
      "async announcement unavailable",
    ])
    act(() => {
      formsA.controlsFor("id:form").dismissSubmissionTerminal()
    })
    expect(statuses).toHaveLength(3)
    act(() => {
      rendererA?.unmount()
      rendererB?.unmount()
    })
  })

  test("does not announce a terminal result that predates provider mount", async () => {
    const fixture = formScopeUnmountFixture()
    const forms = fixture.forms()
    const controls = forms.controlsFor("id:form")
    const submission = controls.submit({ protocol: { requestId: "headless-result" } })
    await Promise.resolve()
    const request = fixture.pending[0]
    if (!request) throw new Error("headless form request was not captured")
    request.resolve({
      headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
      redirected: false,
      status: 204,
      text: async () => "",
      url: request.request.url,
    })
    await expect(submission).resolves.toMatchObject({
      requestId: "headless-result",
      status: "empty",
    })
    expect(controls.submissionTerminalState).toMatchObject({
      requestId: "headless-result",
      status: "empty",
    })

    const announcements: FormSubmissionAnnouncementEvent[] = []
    let renderer: ReactTestRenderer | undefined
    await act(async () => {
      renderer = create(
        fixture.provider(forms, {
          formAnnouncements: { announce: (event) => {
          announcements.push(event)
        } },
        }),
      )
      await Promise.resolve()
    })

    expect(announcements).toEqual([])
    act(() => renderer?.unmount())
  })

  test("deduplicates terminal revisions independently for sessions sharing one tree", async () => {
    const tree = parseExpoTurboDocument(
      '<Gallery><UnmountForm id="form" action="/submit" method="post" data-turbo-stream=""><CaptureUnmountForm /></UnmountForm><DemoText id="status">Before</DemoText></Gallery>',
      { url: "https://example.test/current" },
    )
    const first = formScopeUnmountFixture(undefined, undefined, new DocumentSession(tree))
    const second = formScopeUnmountFixture(undefined, undefined, new DocumentSession(tree))
    const firstForms = first.forms()
    const secondForms = second.forms()
    const announcements: FormSubmissionAnnouncementEvent[] = []
    const adapter: FormSubmissionAnnouncementAdapter = {
      announce: (event) => {
          announcements.push(event)
        },
    }
    let firstRenderer: ReactTestRenderer | undefined
    let secondRenderer: ReactTestRenderer | undefined
    act(() => {
      firstRenderer = create(
        first.provider(firstForms, { formAnnouncements: adapter }),
      )
      secondRenderer = create(
        second.provider(secondForms, { formAnnouncements: adapter }),
      )
    })

    for (const [fixture, requestId] of [
      [first, "shared-tree-first"],
      [second, "shared-tree-second"],
    ] as const) {
      let submission: ReturnType<ExpoTurboFormBinding["submit"]> | undefined
      await act(async () => {
        submission = fixture.binding().submit({ protocol: { requestId } })
        await Promise.resolve()
      })
      const request = fixture.pending[0]
      if (!request || !submission) throw new Error("shared-tree request was not captured")
      await act(async () => {
        request.resolve({
          headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
          redirected: false,
          status: 204,
          text: async () => "",
          url: request.request.url,
        })
        await expect(submission).resolves.toMatchObject({ requestId, status: "empty" })
        await Promise.resolve()
      })
    }

    expect(announcements.map(({ terminalState }) => terminalState.requestId)).toEqual([
      "shared-tree-first",
      "shared-tree-second",
    ])
    act(() => {
      firstRenderer?.unmount()
      secondRenderer?.unmount()
    })
  })

  test("announces only the newest terminal result after same-form supersession", async () => {
    const announcements: FormSubmissionAnnouncementEvent[] = []
    const fixture = formTerminalFixture("get", {
      formAnnouncements: { announce: (event) => {
          announcements.push(event)
        } },
    })
    let first: ReturnType<ExpoTurboFormBinding["submit"]> | undefined
    let second: ReturnType<ExpoTurboFormBinding["submit"]> | undefined
    await act(async () => {
      first = fixture.binding().submit({ protocol: { requestId: "stale-first" } })
      await Promise.resolve()
      second = fixture.binding().submit(
        { protocol: { requestId: "current-second" } },
        { duplicateBehavior: "supersede" },
      )
      await Promise.resolve()
    })
    const firstRequest = fixture.pending[0]
    const secondRequest = fixture.pending[1]
    if (!first || !second || !firstRequest || !secondRequest) {
      throw new Error("superseded announcement requests were not captured")
    }
    await expect(first).resolves.toMatchObject({ requestId: "stale-first", status: "canceled" })
    expect(announcements).toEqual([])

    await act(async () => {
      firstRequest.resolve({
        headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
        redirected: false,
        status: 204,
        text: async () => "",
        url: firstRequest.request.url,
      })
      secondRequest.resolve({
        headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
        redirected: false,
        status: 204,
        text: async () => "",
        url: secondRequest.request.url,
      })
      await expect(second).resolves.toMatchObject({ requestId: "current-second", status: "empty" })
      await Promise.resolve()
    })

    expect(announcements.map(({ terminalState }) => terminalState.requestId)).toEqual([
      "current-second",
    ])
    act(() => fixture.renderer.unmount())
  })

  test("does not announce cancellation into a same-key replacement mounted in flight", async () => {
    const announcements: FormSubmissionAnnouncementEvent[] = []
    const fixture = formTerminalFixture("get", {
      formAnnouncements: { announce: (event) => {
          announcements.push(event)
        } },
    })
    let submission: ReturnType<ExpoTurboFormBinding["submit"]> | undefined
    await act(async () => {
      submission = fixture.binding().submit({ protocol: { requestId: "replace-in-flight" } })
      await Promise.resolve()
    })
    const request = fixture.pending[0]
    if (!request || !submission) throw new Error("in-flight replacement was not captured")

    await act(async () => {
      dispatchTurboStreamFragment(
        fixture.session,
        '<turbo-stream action="replace" target="form"><template><TerminalForm id="form" action="/replacement" method="get"><CaptureTerminalForm slot="replacement" /></TerminalForm></template></turbo-stream>',
      )
      await Promise.resolve()
    })

    expect(request.request.signal?.aborted).toBe(true)
    await expect(submission).resolves.toMatchObject({
      requestId: "replace-in-flight",
      status: "canceled",
    })
    expect(fixture.binding("replacement").terminalState.status).toBe("none")
    expect(announcements).toEqual([])
    act(() => fixture.renderer.unmount())
  })

  test("does not replay terminal announcements into a same-key form replacement", async () => {
    const announcements: FormSubmissionAnnouncementEvent[] = []
    const fixture = formTerminalFixture("get", {
      formAnnouncements: { announce: (event) => {
          announcements.push(event)
        } },
    })
    let submission: ReturnType<ExpoTurboFormBinding["submit"]> | undefined
    await act(async () => {
      submission = fixture.binding().submit({ protocol: { requestId: "before-replacement" } })
      await Promise.resolve()
    })
    const request = fixture.pending[0]
    if (!request || !submission) throw new Error("replacement announcement request was not captured")
    await act(async () => {
      request.resolve({
        headers: { "Content-Type": "application/json" },
        redirected: false,
        status: 200,
        text: async () => "{}",
        url: request.request.url,
      })
      await expect(submission).rejects.toThrow()
      await Promise.resolve()
    })
    expect(announcements.map(({ terminalState }) => terminalState.status)).toEqual([
      "failed",
    ])

    act(() => {
      dispatchTurboStreamFragment(
        fixture.session,
        '<turbo-stream action="replace" target="form"><template><TerminalForm id="form" action="/replacement" method="get"><CaptureTerminalForm slot="replacement" /></TerminalForm></template></turbo-stream>',
      )
    })

    expect(fixture.binding("replacement").terminalState.status).toBe("none")
    expect(announcements).toHaveLength(1)
    act(() => fixture.renderer.unmount())
  })

  test("lets a self-removing form response apply its later Stream actions", async () => {
    const fixture = formScopeUnmountFixture()
    const forms = fixture.forms()
    const announcements: FormSubmissionAnnouncementEvent[] = []
    let renderer: ReactTestRenderer | undefined
    act(() => {
      renderer = create(
        fixture.provider(forms, {
          formAnnouncements: { announce: (event) => {
          announcements.push(event)
        } },
        }),
      )
    })
    if (!renderer) throw new Error("renderer was not created")

    let submission: ReturnType<ExpoTurboFormBinding["submit"]> | undefined
    await act(async () => {
      submission = fixture.binding().submit({ protocol: { requestId: "self-removal" } })
      await Promise.resolve()
    })
    const request = fixture.pending[0]
    if (!request || !submission) throw new Error("self-removing form request was not captured")
    let report: Awaited<typeof submission> | undefined
    await act(async () => {
      request.resolve({
        headers: { "Content-Type": "text/vnd.turbo-stream.html" },
        redirected: false,
        status: 200,
        text: async () => `<turbo-stream action="remove" target="form"></turbo-stream>
          <turbo-stream action="update" target="status"><template>After</template></turbo-stream>`,
        url: request.request.url,
      })
      report = await submission
      await Promise.resolve()
    })

    expect(report).toMatchObject({
      application: "stream",
      status: "applied",
      streams: {
        actions: [
          { action: "remove", status: "applied" },
          { action: "update", status: "applied" },
        ],
        interrupted: false,
      },
    })
    expect(request.request.signal?.aborted).toBe(false)
    expect(fixture.session.tree.getElementById("form")).toBeUndefined()
    expect(JSON.stringify(renderer.toJSON())).toContain("After")
    expect(forms.isDisposed).toBe(false)
    expect(announcements).toEqual([])
  })

  test("validates live React control snapshots and focuses before form submission lifecycle", async () => {
    let formBinding: ExpoTurboFormBinding | undefined
    let submit: (() => Promise<unknown>) | undefined
    let confirmations = 0
    let fetches = 0
    const focused: string[] = []

    function ValidationForm(props: Readonly<{ children?: ReactNode }>): ReactNode {
      return createElement(ExpoTurboFormScope, null, props.children)
    }
    function ValidationCapture(): ReactNode {
      formBinding = useExpoTurboForm()
      return createElement("validation-capture")
    }
    function ValidationInput({ value }: { value: string }): ReactNode {
      const [current, setCurrent] = useState(value)
      const binding = useExpoTurboFormControl({
        kind: "value",
        name: "profile[name]",
        value: current,
        validity:
          current.trim() === ""
            ? { message: "Name is required", valid: false }
            : { valid: true },
      })
      return createElement("validation-input", {
        invalid: current.trim() === "",
        nodeKey: binding.nodeKey,
        onChange: setCurrent,
        testId: "validation-input",
        value: current,
      })
    }
    function ValidationSubmitter(): ReactNode {
      const form = useExpoTurboForm()
      const binding = useExpoTurboFormControl({
        kind: "submitter",
        name: "commit",
        value: "save",
      })
      submit = () =>
        form.submit({
          protocol: { requestId: "react-validation" },
          submitter: binding.selection(),
        })
      return createElement("validation-submitter")
    }

    const form = defineComponent({
      attributes: { action: { codec: stringCodec, prop: "action" } },
      children: "nodes",
      component: ValidationForm,
      formOwner: true,
      schema: z.object({ action: z.string().optional() }),
      tag: "ValidationForm",
    })
    const capture = defineComponent({
      attributes: {},
      children: "none",
      component: ValidationCapture,
      schema: z.object({}),
      tag: "ValidationCapture",
    })
    const input = defineComponent({
      attributes: { value: { codec: stringCodec, prop: "value" } },
      children: "none",
      component: ValidationInput,
      schema: z.object({ value: z.string() }),
      tag: "ValidationInput",
    })
    const submitter = defineComponent({
      attributes: {},
      children: "none",
      component: ValidationSubmitter,
      schema: z.object({}),
      tag: "ValidationSubmitter",
    })
    const registry = registryWithCounters().use(
      defineComponentModule({
        components: [form, capture, input, submitter],
        name: "validation-components",
        version: "0.1.0",
      }),
    )
    const session = new DocumentSession(
      parseExpoTurboDocument(
        '<Gallery><ValidationForm id="form" action="/submit" data-turbo-confirm="Confirm"><ValidationCapture/><ValidationInput id="name" value=""/><ValidationSubmitter id="save"/></ValidationForm></Gallery>',
        { url: "https://example.test/current" },
      ),
    )
    const controller = new FormSubmissionController(
      session,
      {
        async fetch(request) {
          fetches += 1
          return {
            headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
            redirected: false,
            status: 204,
            text: async () => "",
            url: request.url,
          }
        },
      },
      {
        confirmation: {
          confirm: async () => {
            confirmations += 1
            return true
          },
        },
      },
    )
    const forms = new DocumentFormControls(session, {
      focus: {
        blur() {},
        focus: (nodeKey) => {
          focused.push(nodeKey)
        },
        getFocusedId: () => focused.at(-1),
      },
      submissionController: controller,
    })
    let renderer: ReactTestRenderer | undefined
    act(() => {
      renderer = create(
        createElement(
          StrictMode,
          null,
          createElement(
            ExpoTurboProvider,
            { forms, registry, session },
            createElement(ExpoTurboRoot),
          ),
        ),
      )
    })
    if (!renderer || !formBinding || !submit) {
      throw new Error("validation bindings were not captured")
    }

    expect(formBinding.checkValidity()).toMatchObject({
      firstInvalid: { nodeKey: "id:name" },
      valid: false,
    })
    let invalidReport: unknown
    await act(async () => {
      invalidReport = await submit?.()
    })
    expect(invalidReport).toMatchObject({
      requestId: "react-validation",
      status: "invalid",
    })
    expect(focused).toEqual(["id:name"])
    expect(confirmations).toBe(0)
    expect(fetches).toBe(0)
    expect(formBinding.state).toMatchObject({ busy: false, status: "idle" })
    expect(formBinding.terminalState).toEqual({ revision: 0, status: "none" })

    act(() => {
      renderer?.root.findByProps({ testId: "validation-input" }).props.onChange("Ada")
    })
    expect(formBinding.checkValidity()).toEqual({ invalidControls: [], valid: true })
    let validReport: unknown
    await act(async () => {
      validReport = await submit?.()
    })
    expect(validReport).toMatchObject({
      requestId: "react-validation",
      status: "empty",
    })
    expect(confirmations).toBe(1)
    expect(fetches).toBe(1)
  })

  test("reports a form control without an active nearest or explicit owner", () => {
    function OrphanControl(): ReactNode {
      useExpoTurboFormControl({ kind: "value", name: "orphan", value: "value" })
      return createElement("orphan")
    }
    const orphan = defineComponent({
      attributes: {},
      children: "none",
      component: OrphanControl,
      schema: z.object({}),
      tag: "OrphanControl",
    })
    const registry = registryWithCounters().use(
      defineComponentModule({
        components: [orphan],
        name: "orphan-form-control",
        version: "0.1.0",
      }),
    )
    for (const [document, message] of [
      ["<Gallery><OrphanControl id=\"orphan\"/></Gallery>", "requires a form scope"],
      [
        "<Gallery><OrphanControl id=\"orphan\" form=\"missing\"/></Gallery>",
        "references a missing form owner",
      ],
      [
        "<Gallery id=\"container\"><OrphanControl id=\"orphan\" form=\"container\"/></Gallery>",
        "is not a declared form owner",
      ],
    ] as const) {
      const session = new DocumentSession(parseExpoTurboDocument(document))
      const errors: ExpoTurboRenderError[] = []
      const renderer = render(session, registry, {
        forms: new DocumentFormControls(session),
        onError: (event) => errors.push(event),
        renderError: (event) => createElement("protocol-error", null, event.error.message),
      })

      expect(errors[0]?.error.message).toContain(message)
      expect(JSON.stringify(renderer.toJSON())).toContain(message)
    }
  })

  test("reports an explicit form scope without provider form controls", () => {
    function UnconfiguredForm(props: Readonly<{ children?: ReactNode }>): ReactNode {
      return createElement(ExpoTurboFormScope, null, props.children)
    }
    const form = defineComponent({
      attributes: {},
      children: "nodes",
      component: UnconfiguredForm,
      formOwner: true,
      schema: z.object({}),
      tag: "UnconfiguredForm",
    })
    const registry = registryWithCounters().use(
      defineComponentModule({
        components: [form],
        name: "unconfigured-form-scope",
        version: "0.1.0",
      }),
    )
    const session = new DocumentSession(
      parseExpoTurboDocument('<Gallery><UnconfiguredForm id="form"/></Gallery>'),
    )
    const errors: ExpoTurboRenderError[] = []
    const renderer = render(session, registry, {
      onError: (event) => errors.push(event),
      renderError: (event) => createElement("protocol-error", null, event.error.message),
    })

    expect(errors[0]?.error.message).toContain("provider form controls")
    expect(JSON.stringify(renderer.toJSON())).toContain("provider form controls")
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

  test("automatically preloads marked rendered document links through one shared cache", async () => {
    const requests: TurboRequest[] = []
    const harness = renderPreloadingDocumentLinks(
      `<Gallery data-turbo-root="/app">
        <DocumentLink id="first" href="/app/first" data-turbo-preload="" />
        <DocumentLink id="duplicate" href="./first" data-turbo-preload="false" />
        <DocumentLink id="self" href="/app/self" target="_self" data-turbo-preload="" />
        <turbo-frame id="frame">
          <DocumentLink id="top" href="/app/top" data-turbo-frame="_top" data-turbo-preload="" />
        </turbo-frame>
      </Gallery>`,
      async (request) => {
        requests.push(request)
        return {
          headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
          redirected: false,
          status: 200,
          text: async () => '<Gallery data-turbo-root="/app"><DemoText>Cached</DemoText></Gallery>',
          url: request.url,
        }
      },
      { strict: true, url: "https://example.test/app/current" },
    )

    await act(async () => {
      await nextTurn()
    })

    expect(requests.map((request) => request.url).sort()).toEqual([
      "https://example.test/app/first",
      "https://example.test/app/self",
      "https://example.test/app/top",
    ])
    expect(requests).toHaveLength(3)
    expect(harness.requestIdCount()).toBe(3)
    for (const request of requests) {
      expect(request).toMatchObject({
        headers: { Accept: EXPO_TURBO_MIME_TYPE, "X-Sec-Purpose": "prefetch" },
        method: "GET",
      })
    }
    expect(harness.cache.has("https://example.test/app/first")).toBe(true)
    expect(harness.cache.has("https://example.test/app/self")).toBe(true)
    expect(harness.cache.has("https://example.test/app/top")).toBe(true)
    expect(harness.session.revision).toBe(0)
    expect(harness.session.tree.document.url).toBe("https://example.test/app/current")

    act(() => harness.renderer.unmount())
  })

  test("uses an automatically preloaded snapshot as the next document visit preview", async () => {
    const documentRequests: TurboRequest[] = []
    let resolveDocument: ((response: TurboResponse) => void) | undefined
    const harness = renderPreloadingDocumentLinks(
      '<Gallery data-turbo-root="/app"><DocumentLink href="/app/next" data-turbo-preload="" /></Gallery>',
      async (request) => ({
        headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
        redirected: false,
        status: 200,
        text: async () =>
          '<Gallery data-turbo-root="/app"><DemoText id="preloaded">Preloaded preview</DemoText></Gallery>',
        url: request.url,
      }),
      {
        documentFetch: (request) => {
          documentRequests.push(request)
          return new Promise<TurboResponse>((resolve) => {
            resolveDocument = resolve
          })
        },
        url: "https://example.test/app/current",
      },
    )

    await act(async () => {
      await nextTurn()
    })
    expect(harness.cache.has("https://example.test/app/next")).toBe(true)

    let visit: Promise<unknown> | undefined
    act(() => {
      visit = harness.activation("/app/next")()
    })
    await act(async () => {
      await nextTurn()
    })
    expect(harness.session.treeState.preview).toBe(true)
    expect(harness.session.tree.getElementById("preloaded")).toBeDefined()
    expect(documentRequests.map((request) => request.url)).toEqual([
      "https://example.test/app/next",
    ])
    expect(harness.requestIdCount()).toBe(1)

    await act(async () => {
      if (!resolveDocument || !documentRequests[0] || !visit) {
        throw new Error("canonical preview revalidation did not start")
      }
      resolveDocument({
        headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
        redirected: false,
        status: 200,
        text: async () =>
          '<Gallery data-turbo-root="/app"><DemoText id="canonical">Canonical</DemoText></Gallery>',
        url: documentRequests[0].url,
      })
      await visit
    })
    expect(harness.session.treeState.preview).toBe(false)
    expect(harness.session.tree.getElementById("canonical")).toBeDefined()

    act(() => harness.renderer.unmount())
  })

  test("skips markers that do not represent a supported document preload", async () => {
    const requests: TurboRequest[] = []
    const harness = renderPreloadingDocumentLinks(
      `<Gallery id="gallery" data-turbo-root="/app">
        <DocumentLink href="/app/plain" />
        <DocumentLink disabled="" href="/app/disabled" data-turbo-preload="" />
        <Gallery id="opted-out-owner" data-turbo="false">
          <DocumentLink href="/app/opted-out" data-turbo-preload="" />
        </Gallery>
        <DocumentLink href="/app/method" data-turbo-method="" data-turbo-preload="" />
        <DocumentLink href="/app/stream" data-turbo-stream="false" data-turbo-preload="" />
        <DocumentLink download="" href="/app/download" data-turbo-preload="" />
        <DocumentLink href="/app/target" target="_blank" data-turbo-preload="" />
        <turbo-frame id="frame">
          <DocumentLink href="/app/frame" data-turbo-preload="" />
        </turbo-frame>
        <DocumentLink href="/app/named" data-turbo-frame="destination" data-turbo-preload="" />
        <turbo-frame id="destination" />
        <DocumentLink href="#" data-turbo-preload="" />
        <DocumentLink href="/app/empty-fragment#" data-turbo-preload="" />
        <DocumentLink href="/app/fragment#section" data-turbo-preload="" />
        <DocumentLink href="/app/&#x9;control" data-turbo-preload="" />
        <DocumentLink href="/outside" data-turbo-preload="" />
        <DocumentLink href="/app/archive.pdf" data-turbo-preload="" />
        <DocumentLink href="https://outside.test/app/external" data-turbo-preload="" />
        <template><DocumentLink href="/app/template" data-turbo-preload="" /></template>
        <turbo-stream action="append" target="gallery">
          <template><DocumentLink href="/app/stream-template" data-turbo-preload="" /></template>
        </turbo-stream>
        <turbo-cable-stream-source channel="DemoChannel">
          <DocumentLink href="/app/source" data-turbo-preload="" />
        </turbo-cable-stream-source>
      </Gallery>`,
      async (request) => {
        requests.push(request)
        return {
          headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
          redirected: false,
          status: 200,
          text: async () => '<Gallery data-turbo-root="/app"><DemoText>Cached</DemoText></Gallery>',
          url: request.url,
        }
      },
      { url: "https://example.test/app/current" },
    )

    await act(async () => {
      await nextTurn()
    })

    expect(requests).toEqual([])
    expect(harness.requestIdCount()).toBe(0)
    expect(harness.cache.size).toBe(0)

    await act(async () => {
      harness.session.removeAttribute("id:opted-out-owner", "data-turbo")
      harness.session.setAttribute("id:destination", "disabled", "")
      await nextTurn()
    })
    expect(requests.map((request) => request.url).sort()).toEqual([
      "https://example.test/app/named",
      "https://example.test/app/opted-out",
    ])
    act(() => harness.renderer.unmount())
  })

  test("subscribes only marked links while noticing target Frames inserted elsewhere", async () => {
    const response = (request: TurboRequest): TurboResponse => ({
      headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
      redirected: false,
      status: 200,
      text: async () => '<Gallery data-turbo-root="/app"><DemoText>Cached</DemoText></Gallery>',
      url: request.url,
    })
    let activeRevisionSubscriptions = 0
    const activeNodeSubscriptions = new Map<string, number>()
    const trackRevisionSubscriptions = (session: DocumentSession) => {
      const subscribe = session.subscribe.bind(session)
      const subscribeRevision = session.subscribeRevision.bind(session)
      session.subscribe = (key, listener) => {
        activeNodeSubscriptions.set(key, (activeNodeSubscriptions.get(key) ?? 0) + 1)
        const unsubscribe = subscribe(key, listener)
        let active = true
        return () => {
          if (!active) return
          active = false
          activeNodeSubscriptions.set(key, (activeNodeSubscriptions.get(key) ?? 1) - 1)
          unsubscribe()
        }
      }
      session.subscribeRevision = (listener) => {
        activeRevisionSubscriptions += 1
        const unsubscribe = subscribeRevision(listener)
        let active = true
        return () => {
          if (!active) return
          active = false
          activeRevisionSubscriptions -= 1
          unsubscribe()
        }
      }
    }
    const unmarked = renderPreloadingDocumentLinks(
      `<Gallery>
        <DocumentLink id="plain" href="/plain" />
        <DocumentLink id="other-plain" href="/other-plain" />
        <turbo-frame id="first-unrelated" />
        <turbo-frame id="second-unrelated" />
      </Gallery>`,
      async (request) => response(request),
      { prepareSession: trackRevisionSubscriptions },
    )
    await act(async () => {
      await nextTurn()
    })
    expect(activeRevisionSubscriptions).toBe(1)
    expect(activeNodeSubscriptions.get("id:first-unrelated")).toBe(1)
    expect(activeNodeSubscriptions.get("id:second-unrelated")).toBe(1)

    await act(async () => {
      unmarked.session.setAttribute("id:first-unrelated", "disabled", "")
      await nextTurn()
    })

    expect(activeRevisionSubscriptions).toBe(1)
    expect(unmarked.requestIdCount()).toBe(0)

    await act(async () => {
      unmarked.session.setAttribute("id:plain", "data-turbo-preload", "")
      await nextTurn()
    })
    expect(activeRevisionSubscriptions).toBe(2)
    expect(activeNodeSubscriptions.get("id:first-unrelated")).toBe(1)
    expect(activeNodeSubscriptions.get("id:second-unrelated")).toBe(1)

    await act(async () => {
      unmarked.session.removeAttribute("id:plain", "data-turbo-preload")
      await nextTurn()
    })
    expect(activeRevisionSubscriptions).toBe(1)
    act(() => unmarked.renderer.unmount())

    const requests: TurboRequest[] = []
    const insertedTarget = renderPreloadingDocumentLinks(
      `<Gallery data-turbo-root="/app">
        <turbo-frame id="source">
          <DocumentLink
            id="late-link"
            href="/app/late"
            data-turbo-frame="late"
            data-turbo-preload=""
          />
        </turbo-frame>
        <DocumentLink
          id="local-link"
          href="/app/local"
          data-turbo-frame="source"
          data-turbo-preload=""
        />
        <DocumentLink id="plain-link" href="/app/plain" />
        <turbo-frame id="other" />
        <Gallery id="sibling" />
      </Gallery>`,
      async (request) => {
        requests.push(request)
        return response(request)
      },
      {
        prepareSession: trackRevisionSubscriptions,
        url: "https://example.test/app/current",
      },
    )

    await act(async () => {
      await nextTurn()
    })
    expect(requests).toEqual([])
    expect(activeRevisionSubscriptions).toBe(3)
    expect(activeNodeSubscriptions.get("id:source")).toBe(1)
    expect(activeNodeSubscriptions.get("id:other")).toBe(1)

    await act(async () => {
      dispatchTurboStreamFragment(
        insertedTarget.session,
        '<turbo-stream action="append" target="sibling"><template><turbo-frame id="late" disabled="" /></template></turbo-stream>',
      )
      await nextTurn()
    })

    expect(requests.map((request) => request.url)).toEqual([
      "https://example.test/app/late",
    ])
    expect(insertedTarget.requestIdCount()).toBe(1)
    expect(activeRevisionSubscriptions).toBe(3)
    expect(activeNodeSubscriptions.get("id:late")).toBe(1)
    act(() => insertedTarget.renderer.unmount())
    expect(activeRevisionSubscriptions).toBe(0)
    expect([...activeNodeSubscriptions.values()].every((count) => count === 0)).toBe(true)
  })

  test("discovers newly rendered markers without canceling earlier shared preload work", async () => {
    const requests: TurboRequest[] = []
    let resolveFirst: ((response: TurboResponse) => void) | undefined
    const cachedResponse = (request: TurboRequest): TurboResponse => ({
      headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
      redirected: false,
      status: 200,
      text: async () => '<Gallery data-turbo-root="/app"><DemoText>Cached</DemoText></Gallery>',
      url: request.url,
    })
    const harness = renderPreloadingDocumentLinks(
      '<Gallery id="gallery" data-turbo-root="/app"><DocumentLink id="dynamic" href="/app/first" /></Gallery>',
      async (request) => {
        requests.push(request)
        if (request.url === "https://example.test/app/first") {
          return new Promise<TurboResponse>((resolve) => {
            resolveFirst = resolve
          })
        }
        return cachedResponse(request)
      },
      { url: "https://example.test/app/current" },
    )

    expect(requests).toEqual([])
    await act(async () => {
      harness.session.setAttribute("id:dynamic", "data-turbo-preload", "")
      await nextTurn()
    })
    expect(requests.map((request) => request.url)).toEqual(["https://example.test/app/first"])

    await act(async () => {
      harness.session.removeAttribute("id:dynamic", "data-turbo-preload")
      harness.session.setAttribute("id:dynamic", "href", "/app/second")
      await nextTurn()
    })
    expect(requests).toHaveLength(1)
    expect(requests[0]?.signal?.aborted).toBe(false)

    await act(async () => {
      harness.session.setAttribute("id:dynamic", "data-turbo-preload", "false")
      await nextTurn()
    })
    expect(requests.map((request) => request.url)).toEqual([
      "https://example.test/app/first",
      "https://example.test/app/second",
    ])

    await act(async () => {
      dispatchTurboStreamFragment(
        harness.session,
        '<turbo-stream action="append" target="gallery"><template><DocumentLink id="streamed" href="/app/streamed" data-turbo-preload="" /></template></turbo-stream>',
      )
      await nextTurn()
    })
    expect(requests.map((request) => request.url)).toEqual([
      "https://example.test/app/first",
      "https://example.test/app/second",
      "https://example.test/app/streamed",
    ])

    await act(async () => {
      harness.session.replaceTree(
        parseExpoTurboDocument(
          '<Gallery data-turbo-root="/app"><DocumentLink href="/app/replaced" data-turbo-preload="" /></Gallery>',
          { url: "https://example.test/app/current" },
        ),
      )
      await nextTurn()
    })
    await act(async () => {
      harness.session.replaceTreePreview(
        parseExpoTurboDocument(
          '<Gallery data-turbo-root="/app"><DocumentLink href="/app/previewed" data-turbo-preload="" /></Gallery>',
          { url: "https://example.test/app/current" },
        ),
      )
      await nextTurn()
    })
    await act(async () => {
      harness.session.replaceTree(
        parseExpoTurboDocument(
          '<Gallery data-turbo-root="/app"><turbo-frame id="replacement-frame" /></Gallery>',
          { url: "https://example.test/app/current" },
        ),
      )
      applyFrameResponse(
        harness.session,
        "replacement-frame",
        '<turbo-frame id="replacement-frame"><DocumentLink href="/app/framed" data-turbo-frame="_top" data-turbo-preload="" /></turbo-frame>',
      )
      await nextTurn()
    })
    expect(requests.map((request) => request.url)).toEqual([
      "https://example.test/app/first",
      "https://example.test/app/second",
      "https://example.test/app/streamed",
      "https://example.test/app/replaced",
      "https://example.test/app/previewed",
      "https://example.test/app/framed",
    ])
    expect(harness.requestIdCount()).toBe(6)
    expect(requests[0]?.signal?.aborted).toBe(false)

    await act(async () => {
      if (!resolveFirst || !requests[0]) throw new Error("first automatic preload did not start")
      resolveFirst(cachedResponse(requests[0]))
      await nextTurn()
    })

    act(() => harness.renderer.unmount())
  })

  test("reports one current redacted preload failure and suppresses stale link failures", async () => {
    let reject: ((error: unknown) => void) | undefined
    const originalErrors: ExpoTurboRenderError[] = []
    const currentErrors: ExpoTurboRenderError[] = []
    const harness = renderPreloadingDocumentLinks(
      '<Gallery><DocumentLink id="link" href="/failed" data-turbo-preload="" /></Gallery>',
      () =>
        new Promise<TurboResponse>((_resolve, fail) => {
          reject = fail
        }),
      { onError: (event) => originalErrors.push(event), strict: true },
    )
    await act(async () => {
      await Promise.resolve()
    })
    if (!reject) throw new Error("automatic preload request did not start")
    harness.updateErrorObserver((event) => currentErrors.push(event))
    expect(harness.requestIdCount()).toBe(1)

    await act(async () => {
      reject?.(new Error("private automatic preload secret"))
      await nextTurn()
    })

    expect(originalErrors).toEqual([])
    expect(currentErrors).toHaveLength(1)
    expect(currentErrors[0]).toMatchObject({
      error: new RequestError("Document preload request failed", { method: "GET" }),
      nodeKey: "id:link",
    })
    expect(currentErrors[0]?.error.cause).toBeUndefined()
    act(() => harness.renderer.unmount())

    let lateReject: ((error: unknown) => void) | undefined
    const lateErrors: ExpoTurboRenderError[] = []
    const unmounted = renderPreloadingDocumentLinks(
      '<Gallery><DocumentLink id="late" href="/late" data-turbo-preload="" /></Gallery>',
      () =>
        new Promise<TurboResponse>((_resolve, fail) => {
          lateReject = fail
        }),
      { onError: (event) => lateErrors.push(event) },
    )
    await act(async () => {
      await Promise.resolve()
    })
    if (!lateReject) throw new Error("late automatic preload request did not start")
    act(() => unmounted.renderer.unmount())
    await act(async () => {
      lateReject?.(new Error("private late preload secret"))
      await nextTurn()
    })
    expect(lateErrors).toEqual([])

    let changedReject: ((error: unknown) => void) | undefined
    const changedErrors: ExpoTurboRenderError[] = []
    const changed = renderPreloadingDocumentLinks(
      '<Gallery><DocumentLink id="changed" href="/before-change" data-turbo-preload="" /></Gallery>',
      () =>
        new Promise<TurboResponse>((_resolve, fail) => {
          changedReject = fail
        }),
      { onError: (event) => changedErrors.push(event) },
    )
    await act(async () => {
      await Promise.resolve()
    })
    if (!changedReject) throw new Error("changed automatic preload request did not start")
    await act(async () => {
      changed.session.removeAttribute("id:changed", "data-turbo-preload")
      changed.session.setAttribute("id:changed", "href", "/after-change")
      changedReject?.(new Error("private changed preload secret"))
      await nextTurn()
    })
    expect(changedErrors).toEqual([])
    act(() => changed.renderer.unmount())

    let replacedReject: ((error: unknown) => void) | undefined
    const replacedErrors: ExpoTurboRenderError[] = []
    const replaced = renderPreloadingDocumentLinks(
      '<Gallery><DocumentLink id="replaced" href="/replaced" data-turbo-preload="" /></Gallery>',
      () =>
        new Promise<TurboResponse>((_resolve, fail) => {
          replacedReject = fail
        }),
      { onError: (event) => replacedErrors.push(event) },
    )
    await act(async () => {
      await Promise.resolve()
    })
    if (!replacedReject) throw new Error("replaced automatic preload request did not start")
    await act(async () => {
      replaced.session.replaceTree(
        parseExpoTurboDocument(
          '<Gallery><DocumentLink id="replaced" href="/replaced" /></Gallery>',
          { url: "https://example.test/current" },
        ),
      )
      replacedReject?.(new Error("private replaced preload secret"))
      await nextTurn()
    })
    expect(replacedErrors).toEqual([])
    act(() => replaced.renderer.unmount())
  })

  test("suppresses automatic preload error delegation when fetch-error handling is prevented", async () => {
    let reject: ((error: unknown) => void) | undefined
    const errors: ExpoTurboRenderError[] = []
    const lifecycle = new RequestLifecycle()
    lifecycle.subscribe("fetch-request-error", (event) => event.preventDefault())
    const harness = renderPreloadingDocumentLinks(
      '<Gallery><DocumentLink id="link" href="/failed" data-turbo-preload="" /></Gallery>',
      () =>
        new Promise<TurboResponse>((_resolve, fail) => {
          reject = fail
        }),
      {
        onError: (event) => errors.push(event),
        requestLifecycle: lifecycle,
      },
    )
    await act(async () => {
      await Promise.resolve()
    })
    if (!reject) throw new Error("automatic preload request did not start")

    await act(async () => {
      reject?.(new Error("private automatic preload secret"))
      await nextTurn()
    })

    expect(errors).toEqual([])
    act(() => harness.renderer.unmount())
  })

  test("activates a confirm-only top-level document link without subscribing it to visit ticks", async () => {
    const pending: {
      request: TurboRequest
      resolve: (response: TurboResponse) => void
    }[] = []
    const harness = renderDocumentLinks(
      '<Gallery><DocumentLink id="link" href="../next?tab=details" data-turbo-confirm="Continue?" /><DemoText>Before</DemoText></Gallery>',
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

  test("orders one StrictMode document render before autofocus, completion, and load", async () => {
    const pending: {
      request: TurboRequest
      resolve: (response: TurboResponse) => void
    }[] = []
    const lifecycle = new DocumentVisitLifecycle()
    const order: string[] = []
    let harness: ReturnType<typeof renderDocumentLinks> | undefined
    lifecycle.subscribe("render", (event) => {
      expect(harness?.controller.state).toMatchObject({ busy: true, status: "started" })
      expect(JSON.stringify(harness?.renderer.toJSON())).toContain("After")
      order.push(`render:${event.detail.generation}`)
    })
    lifecycle.subscribe("load", (event) => {
      expect(harness?.controller.state).toMatchObject({ busy: false, status: "completed" })
      expect(order).toEqual([`render:${event.detail.generation}`, "focus:id:focus"])
      order.push(`load:${event.detail.generation}`)
    })
    harness = renderDocumentLinks(
      '<Gallery><DocumentLink href="/next" /><DemoText>Before</DemoText></Gallery>',
      (request) => new Promise<TurboResponse>((resolve) => pending.push({ request, resolve })),
      "https://example.test/current",
      undefined,
      undefined,
      undefined,
      { visitLifecycle: lifecycle },
      () => ({
        autofocus: {
          canFocus: () => true,
          focus: (nodeKey) => {
            order.push(`focus:${nodeKey}`)
          },
        },
        strict: true,
      }),
    )

    let visit: Promise<unknown> | undefined
    act(() => {
      visit = harness?.activation("/next")()
    })
    await act(async () => {
      pending[0]?.resolve({
        headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
        redirected: false,
        status: 200,
        text: async () => '<Gallery><DemoText id="focus" autofocus="">After</DemoText></Gallery>',
        url: "https://example.test/next",
      })
      await visit
    })

    expect(order).toEqual(["render:1", "focus:id:focus", "load:1"])
    expect(harness.controller.state).toMatchObject({ busy: false, status: "completed" })
    act(() => harness?.renderer.unmount())
  })

  test("retains document rendering before a child layout effect starts a cached visit", async () => {
    const currentUrl = "https://example.test/current"
    const nextUrl = "https://example.test/next"
    const snapshotCache = new DocumentSnapshotCache()
    snapshotCache.put(
      nextUrl,
      parseExpoTurboDocument('<Gallery><DemoText>Preview</DemoText></Gallery>', {
        url: nextUrl,
      }),
    )
    const pending: {
      request: TurboRequest
      resolve: (response: TurboResponse) => void
    }[] = []
    const session = new DocumentSession(
      parseExpoTurboDocument('<Gallery><VisitOnMount /></Gallery>', { url: currentUrl }),
    )
    const lifecycle = new DocumentVisitLifecycle()
    const events: string[] = []
    lifecycle.subscribe("render", (event) => {
      events.push(`render:${event.detail.preview ? "preview" : "canonical"}`)
    })
    lifecycle.subscribe("load", () => {
      events.push("load")
    })
    const controller = new DocumentVisitController(
      new DocumentRequestLoader(
        session,
        {
          fetch: (request) =>
            new Promise<TurboResponse>((resolve) => pending.push({ request, resolve })),
        },
        { next: () => "initial-layout-request" },
      ),
      {
        clearTimeout: () => undefined,
        now: () => 0,
        setTimeout: () => Object.freeze({}),
      },
      { snapshotCache, visitLifecycle: lifecycle },
    )
    let visit: Promise<unknown> | undefined
    function VisitOnMount(): ReactNode {
      useLayoutEffect(() => {
        visit = controller.visit(nextUrl)
      }, [])
      return createElement("visit-on-mount")
    }
    const visitOnMount = defineComponent({
      attributes: {},
      children: "none",
      component: VisitOnMount,
      schema: z.object({}),
      tag: "VisitOnMount",
    })
    const componentRegistry = registryWithCounters().use(
      defineComponentModule({
        components: [visitOnMount],
        name: "initial-layout-visit",
        version: "0.1.0",
      }),
    )

    const renderer = render(session, componentRegistry, {
      documentController: controller,
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(events).toEqual(["render:preview"])
    expect(JSON.stringify(renderer.toJSON())).toContain("Preview")
    expect(pending).toHaveLength(1)
    expect(pending[0]?.request.url).toBe(nextUrl)

    await act(async () => {
      pending[0]?.resolve({
        headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
        redirected: false,
        status: 200,
        text: async () => '<Gallery><DemoText>Canonical</DemoText></Gallery>',
        url: nextUrl,
      })
      await visit
    })

    expect(events).toEqual(["render:preview", "render:canonical", "load"])
    expect(JSON.stringify(renderer.toJSON())).toContain("Canonical")
    expect(controller.state).toMatchObject({ busy: false, status: "completed" })
    act(() => renderer.unmount())
  })

  test("waits for an exact response revision before consuming document autofocus", async () => {
    const currentUrl = "https://example.test/current"
    const nextUrl = "https://example.test/next"
    const pending: {
      request: TurboRequest
      resolve: (response: TurboResponse) => void
    }[] = []
    const session = new DocumentSession(
      parseExpoTurboDocument('<Gallery><VisitOnMount /></Gallery>', { url: currentUrl }),
    )
    const lifecycle = new DocumentVisitLifecycle()
    const order: string[] = []
    lifecycle.subscribe("render", () => {
      order.push("render")
    })
    const controller = new DocumentVisitController(
      new DocumentRequestLoader(
        session,
        {
          fetch: (request) =>
            new Promise<TurboResponse>((resolve) => pending.push({ request, resolve })),
        },
        { next: () => "layout-revision-request" },
      ),
      {
        clearTimeout: () => undefined,
        now: () => 0,
        setTimeout: () => Object.freeze({}),
      },
      { visitLifecycle: lifecycle },
    )
    let visit: Promise<unknown> | undefined
    function VisitOnMount(): ReactNode {
      useLayoutEffect(() => {
        visit = controller.visit(nextUrl)
      }, [])
      return createElement("visit-on-mount")
    }
    function LayoutMutation(): ReactNode {
      useLayoutEffect(() => {
        order.push("layout")
        const gallery = session.tree.getElementById("gallery")
        if (gallery) session.setAttribute(gallery.key, "data-layout", "true")
      }, [])
      return createElement("layout-mutation")
    }
    const componentRegistry = registryWithCounters().use(
      defineComponentModule({
        components: [
          defineComponent({
            attributes: {},
            children: "none",
            component: VisitOnMount,
            schema: z.object({}),
            tag: "VisitOnMount",
          }),
          defineComponent({
            attributes: {},
            children: "none",
            component: LayoutMutation,
            schema: z.object({}),
            tag: "LayoutMutation",
          }),
        ],
        name: "layout-revision-fixture",
        version: "0.1.0",
      }),
    )

    const renderer = render(session, componentRegistry, {
      autofocus: {
        canFocus: () => true,
        focus: (nodeKey) => {
          order.push(`focus:${nodeKey}`)
        },
      },
      documentController: controller,
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(pending).toHaveLength(1)

    await act(async () => {
      pending[0]?.resolve({
        headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
        redirected: false,
        status: 200,
        text: async () =>
          '<Gallery id="gallery"><LayoutMutation /><DemoText id="focus" autofocus="">After</DemoText></Gallery>',
        url: nextUrl,
      })
      await visit
    })

    expect(order).toEqual(["layout", "render", "focus:id:focus"])
    expect(controller.state).toMatchObject({ busy: false, status: "completed" })
    act(() => renderer.unmount())
  })

  test("does not consume response autofocus after post-commit cancellation suppresses render", async () => {
    const currentUrl = "https://example.test/current"
    const nextUrl = "https://example.test/next"
    const pending: {
      resolve: (response: TurboResponse) => void
    }[] = []
    const session = new DocumentSession(
      parseExpoTurboDocument('<Gallery><VisitOnMount /></Gallery>', { url: currentUrl }),
    )
    const lifecycle = new DocumentVisitLifecycle()
    const events: string[] = []
    const focused: string[] = []
    lifecycle.subscribe("render", () => {
      events.push("render")
    })
    lifecycle.subscribe("load", () => {
      events.push("load")
    })
    const controller = new DocumentVisitController(
      new DocumentRequestLoader(
        session,
        {
          fetch: () => new Promise<TurboResponse>((resolve) => pending.push({ resolve })),
        },
        { next: () => "cancelled-render-request" },
      ),
      {
        clearTimeout: () => undefined,
        now: () => 0,
        setTimeout: () => Object.freeze({}),
      },
      { visitLifecycle: lifecycle },
    )
    let canceled = false
    session.subscribe(session.tree.document.key, () => {
      if (canceled || session.treeGeneration !== 1) return
      canceled = true
      controller.cancel()
    })
    let visit: Promise<unknown> | undefined
    function VisitOnMount(): ReactNode {
      useLayoutEffect(() => {
        visit = controller.visit(nextUrl)
      }, [])
      return createElement("visit-on-mount")
    }
    const componentRegistry = registryWithCounters().use(
      defineComponentModule({
        components: [
          defineComponent({
            attributes: {},
            children: "none",
            component: VisitOnMount,
            schema: z.object({}),
            tag: "VisitOnMount",
          }),
        ],
        name: "cancelled-render-fixture",
        version: "0.1.0",
      }),
    )
    const renderer = render(session, componentRegistry, {
      autofocus: {
        canFocus: () => true,
        focus: (nodeKey) => {
          focused.push(nodeKey)
        },
      },
      documentController: controller,
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(pending).toHaveLength(1)
    await act(async () => {
      pending[0]?.resolve({
        headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
        redirected: false,
        status: 200,
        text: async () => '<Gallery><DemoText id="focus" autofocus="">After</DemoText></Gallery>',
        url: nextUrl,
      })
      await visit
    })

    expect(controller.state).toMatchObject({ busy: false, status: "completed" })
    expect(canceled).toBe(true)
    expect(events).toEqual([])
    expect(focused).toEqual([])
    act(() => renderer.unmount())
  })

  test("acknowledges a root render-error fallback without hanging document load", async () => {
    const pending: {
      request: TurboRequest
      resolve: (response: TurboResponse) => void
    }[] = []
    const lifecycle = new DocumentVisitLifecycle()
    const events: string[] = []
    const errors: ExpoTurboRenderError[] = []
    let harness: ReturnType<typeof renderDocumentLinks> | undefined
    lifecycle.subscribe("render", (event) => {
      expect(harness?.controller.state.status).toBe("started")
      expect(JSON.stringify(harness?.renderer.toJSON())).toContain("Document fallback")
      events.push(`render:${event.detail.generation}`)
    })
    lifecycle.subscribe("load", (event) => {
      expect(harness?.controller.state.status).toBe("completed")
      events.push(`load:${event.detail.generation}`)
    })
    harness = renderDocumentLinks(
      '<Gallery><DocumentLink href="/broken" /></Gallery>',
      (request) => new Promise<TurboResponse>((resolve) => pending.push({ request, resolve })),
      "https://example.test/current",
      undefined,
      undefined,
      undefined,
      { visitLifecycle: lifecycle },
      () => ({
        onError: (event) => errors.push(event),
        renderError: () => createElement("document-fallback", null, "Document fallback"),
      }),
    )

    let visit: Promise<unknown> | undefined
    act(() => {
      visit = harness?.activation("/broken")()
    })
    await act(async () => {
      pending[0]?.resolve({
        headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
        redirected: false,
        status: 200,
        text: async () => "<Gallery><Unknown /></Gallery>",
        url: "https://example.test/broken",
      })
      await visit
    })

    expect(events).toEqual(["render:1", "load:1"])
    expect(errors).toHaveLength(1)
    expect(JSON.stringify(harness.renderer.toJSON())).toContain("Document fallback")
    act(() => harness?.renderer.unmount())
  })

  test("emits native click before document visit lifecycle and lets cancellation start no work", async () => {
    const events: string[] = []
    const requests: TurboRequest[] = []
    const lifecycle = new DocumentVisitLifecycle()
    lifecycle.subscribe("click", (event) => {
      events.push(`click:${event.detail.url}`)
      expect(event.detail.nodeKey).not.toBe("")
      expect(Object.isFrozen(event.detail)).toBe(true)
      if (event.detail.url.endsWith("/blocked")) event.preventDefault()
    })
    lifecycle.subscribe("before-visit", (event) => {
      events.push(`before-visit:${event.detail.url}`)
    })
    lifecycle.subscribe("visit", (event) => {
      events.push(`visit:${event.detail.url}`)
    })
    const harness = renderDocumentLinks(
      '<Gallery><DocumentLink href="/blocked" /><DocumentLink href="/next" /></Gallery>',
      async (request) => {
        events.push(`fetch:${request.url}`)
        requests.push(request)
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
      undefined,
      undefined,
      { visitLifecycle: lifecycle },
    )

    let canceled: unknown
    await act(async () => {
      canceled = await harness.activation("/blocked")()
    })
    expect(canceled).toEqual({
      kind: "link",
      status: "canceled",
      url: "https://example.test/blocked",
    })
    expect(Object.isFrozen(canceled)).toBe(true)
    expect(requests).toHaveLength(0)
    expect(harness.documentRequestIdCount()).toBe(0)
    expect(harness.controller.state.status).toBe("initialized")

    await act(async () => {
      await harness.activation("/next")()
    })
    expect(events).toEqual([
      "click:https://example.test/blocked",
      "click:https://example.test/next",
      "before-visit:https://example.test/next",
      "visit:https://example.test/next",
      "fetch:https://example.test/next",
    ])
    expect(requests).toHaveLength(1)
    act(() => harness.renderer.unmount())
  })

  test("rejects a failing click listener before request, Frame, or navigation ownership", async () => {
    const documentRequests: TurboRequest[] = []
    const frameRequests: TurboRequest[] = []
    const navigation: string[] = []
    const lifecycle = new DocumentVisitLifecycle()
    lifecycle.subscribe("click", () => {
      throw new Error("private click-listener secret")
    })
    const harness = renderDocumentLinks(
      '<Gallery><turbo-frame id="frame"><DocumentLink href="/blocked" /></turbo-frame></Gallery>',
      async (request) => {
        documentRequests.push(request)
        throw new Error("click listener failure must not fetch a document")
      },
      "https://example.test/gallery",
      {
        back() {},
        openExternal() {},
        visit(url) {
          navigation.push(url)
        },
      },
      async (request) => {
        frameRequests.push(request)
        throw new Error("click listener failure must not fetch a Frame")
      },
      undefined,
      { visitLifecycle: lifecycle },
    )

    await expect(harness.activation("/blocked")()).rejects.toEqual(
      new StateError("Click listener failed"),
    )
    expect(documentRequests).toEqual([])
    expect(frameRequests).toEqual([])
    expect(navigation).toEqual([])
    expect(harness.documentRequestIdCount()).toBe(0)
    expect(harness.controller.state.status).toBe("initialized")
    act(() => harness.renderer.unmount())
  })

  test("emits click before Frame capture and before _top visit while cancellation blocks a named Frame", async () => {
    const events: string[] = []
    const lifecycle = new DocumentVisitLifecycle()
    lifecycle.subscribe("click", (event) => {
      events.push(`click:${event.detail.url}`)
      if (event.detail.url.endsWith("/named")) event.preventDefault()
    })
    lifecycle.subscribe("before-visit", (event) => {
      events.push(`before-visit:${event.detail.url}`)
    })
    lifecycle.subscribe("visit", (event) => {
      events.push(`visit:${event.detail.url}`)
    })
    const harness = renderDocumentLinks(
      `<Gallery>
        <turbo-frame id="nearest"><DocumentLink href="/nearest" /></turbo-frame>
        <turbo-frame id="top-frame"><DocumentLink href="/top" data-turbo-frame="_top" /></turbo-frame>
        <turbo-frame id="destination" />
        <DocumentLink href="/named" data-turbo-frame="destination" />
      </Gallery>`,
      async (request) => {
        events.push(`document-fetch:${request.url}`)
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
        const frameId = request.headers["Turbo-Frame"]
        events.push(`frame-fetch:${frameId}:${request.url}`)
        return {
          headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
          redirected: false,
          status: 200,
          text: async () => `<turbo-frame id="${frameId}" />`,
          url: request.url,
        }
      },
      undefined,
      { visitLifecycle: lifecycle },
    )

    await act(async () => {
      await harness.activation("/nearest")()
    })
    await act(async () => {
      await expect(harness.activation("/named")()).resolves.toEqual({
        kind: "link",
        status: "canceled",
        url: "https://example.test/named",
      })
    })
    await act(async () => {
      await harness.activation("/top")()
    })

    expect(events).toEqual([
      "click:https://example.test/nearest",
      "frame-fetch:nearest:https://example.test/nearest",
      "click:https://example.test/named",
      "click:https://example.test/top",
      "before-visit:https://example.test/top",
      "visit:https://example.test/top",
      "document-fetch:https://example.test/top",
    ])
    act(() => harness.renderer.unmount())
  })

  test("admits empty and exact _self browser targets as current-context links", async () => {
    for (const { href, target } of [
      { href: "/empty-target", target: "" },
      { href: "/self-target", target: "_self" },
    ]) {
      const requests: TurboRequest[] = []
      const harness = renderDocumentLinks(
        `<Gallery><DocumentLink href="${href}" target="${target}" /></Gallery>`,
        async (request) => {
          requests.push(request)
          return {
            headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
            redirected: false,
            status: 200,
            text: async () => "<Gallery />",
            url: request.url,
          }
        },
      )

      let result: unknown
      await act(async () => {
        result = await harness.activation(href)()
      })

      expect(result).toMatchObject({ status: "committed", url: `https://example.test${href}` })
      expect(requests).toHaveLength(1)
      expect(requests[0]?.headers).not.toHaveProperty("Turbo-Frame")
      act(() => harness.renderer.unmount())
    }
  })

  test("uses advance for exact advance and Turbo non-actions on plain top-level links", async () => {
    for (const { action, href } of [
      { action: "advance", href: "/advance-action" },
      { action: "", href: "/blank-action" },
      { action: "bogus", href: "/invalid-action" },
      { action: "Advance", href: "/case-action" },
      { action: " advance ", href: "/spaced-action" },
    ]) {
      const requests: TurboRequest[] = []
      const harness = renderDocumentLinks(
        `<Gallery><DocumentLink href="${href}" data-turbo-action="${action}" /></Gallery>`,
        async (request) => {
          requests.push(request)
          return {
            headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
            redirected: false,
            status: 200,
            text: async () => "<Gallery />",
            url: request.url,
          }
        },
      )

      let result: unknown
      await act(async () => {
        result = await harness.activation(href)()
      })

      expect(result).toMatchObject({ status: "committed", url: `https://example.test${href}` })
      expect(requests).toHaveLength(1)
      act(() => harness.renderer.unmount())
    }
  })

  test("restores an exact top-level restore link from cache with aligned history", async () => {
    const currentUrl = "https://example.test/gallery"
    const restoredUrl = "https://example.test/restored"
    const writes: Readonly<{
      entry: DocumentHistoryEntry
      method: DocumentHistoryWriteMethod
    }>[] = []
    let restorationIdentifier = 0
    const history = new DocumentHistory(
      { next: () => `restore-history-${++restorationIdentifier}` },
      {
        write(method, entry) {
          writes.push(Object.freeze({ entry, method }))
        },
      },
    )
    history.initialize({
      entry: {
        restorationIdentifier: "restore-history-current",
        restorationIndex: 4,
        url: currentUrl,
      },
      kind: "managed",
    })
    const snapshotCache = new DocumentSnapshotCache()
    snapshotCache.put(
      restoredUrl,
      parseExpoTurboDocument(
        '<Gallery><DocumentLink href="/later" /><DemoText>Restored from cache</DemoText></Gallery>',
        { url: restoredUrl },
      ),
    )
    const requests: TurboRequest[] = []
    const harness = renderDocumentLinks(
      '<Gallery><DocumentLink href="/restored" data-turbo-action="restore" /><DemoText>Before</DemoText></Gallery>',
      async (request) => {
        requests.push(request)
        throw new Error("cached restore must not fetch")
      },
      currentUrl,
      undefined,
      undefined,
      undefined,
      { history, snapshotCache },
    )

    let result: unknown
    await act(async () => {
      result = await harness.activation("/restored")()
    })

    expect(result).toEqual({
      source: "snapshot",
      status: "restored",
      url: restoredUrl,
    })
    expect(Object.isFrozen(result)).toBe(true)
    expect(requests).toHaveLength(0)
    expect(harness.documentRequestIdCount()).toBe(0)
    expect(harness.controller.state).toMatchObject({ busy: false, status: "completed" })
    expect(harness.session.tree.document.url).toBe(restoredUrl)
    expect(JSON.stringify(harness.renderer.toJSON())).toContain("Restored from cache")
    expect(snapshotCache.has(currentUrl)).toBe(true)
    expect(writes).toEqual([
      {
        entry: {
          restorationIdentifier: "restore-history-1",
          restorationIndex: 5,
          url: restoredUrl,
        },
        method: "push",
      },
    ])
    expect(history.current).toBe(writes[0]?.entry)

    act(() => harness.renderer.unmount())
  })

  test("keeps Turbo non-actions and browser-bypassed actions on their existing paths", async () => {
    const documentRequests: TurboRequest[] = []
    const external: string[] = []
    const frameRequests: TurboRequest[] = []
    const navigation: { action: string; url: string }[] = []
    const harness = renderDocumentLinks(
      `<Gallery data-turbo-root="/app">
        <turbo-frame id="frame"><DocumentLink href="/app/frame-non-action" data-turbo-action="bogus" /></turbo-frame>
        <turbo-frame id="named" />
        <DocumentLink href="/app/named-frame-non-action" data-turbo-frame="named" data-turbo-action="" />
        <DocumentLink href="https://outside.test/action" data-turbo-action="replace" />
        <DocumentLink href="mailto:action@example.com" data-turbo-action="restore" />
        <DocumentLink href="/outside-root-action" data-turbo-action="restore" />
        <Gallery data-turbo="false"><DocumentLink href="/app/opted-out-action" data-turbo-action="replace" /></Gallery>
      </Gallery>`,
      async (request) => {
        documentRequests.push(request)
        throw new Error("delegated action link must not fetch")
      },
      "https://example.test/app/gallery",
      {
        back() {},
        openExternal: (url) => {
          external.push(url)
        },
        visit: (url, action) => {
          navigation.push({ action, url })
        },
      },
      async (request) => {
        frameRequests.push(request)
        const frameId = request.headers["Turbo-Frame"]
        if (!frameId) throw new Error("Frame request is missing its target header")
        return {
          headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
          redirected: false,
          status: 200,
          text: async () => `<turbo-frame id="${frameId}" />`,
          url: request.url,
        }
      },
    )

    const results: unknown[] = []
    for (const href of ["/app/frame-non-action", "/app/named-frame-non-action"]) {
      await act(async () => {
        results.push(await harness.activation(href)())
      })
    }
    results.push(await harness.activation("https://outside.test/action")())
    results.push(await harness.activation("mailto:action@example.com")())
    results.push(await harness.activation("/outside-root-action")())
    results.push(await harness.activation("/app/opted-out-action")())

    expect(results.map((result) => (result as { kind: string }).kind)).toEqual([
      "frame",
      "frame",
      "external",
      "external",
      "navigation",
      "navigation",
    ])
    expect(documentRequests).toHaveLength(0)
    expect(frameRequests.map((request) => request.headers["Turbo-Frame"])).toEqual([
      "frame",
      "named",
    ])
    expect(external).toEqual([
      "https://outside.test/action",
      "mailto:action@example.com",
    ])
    expect(navigation).toEqual([
      { action: "advance", url: "https://example.test/outside-root-action" },
      { action: "advance", url: "https://example.test/app/opted-out-action" },
    ])
    expect(harness.controller.state.status).toBe("initialized")
    act(() => harness.renderer.unmount())
  })

  test("supports promoted advance and rejects promoted history actions before ownership", async () => {
    const documentRequests: TurboRequest[] = []
    const frameRequests: TurboRequest[] = []
    const harness = renderDocumentLinks(
      `<Gallery>
        <turbo-frame id="frame">
          <DocumentLink href="/top-action" data-turbo-action="advance" data-turbo-frame="_top" />
        </turbo-frame>
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
        throw new Error("promoted action link must not fetch a Frame")
      },
    )

    let result: unknown
    await act(async () => {
      result = await harness.activation("/top-action")()
    })

    expect(result).toMatchObject({
      action: "advance",
      kind: "top",
      outcome: { status: "committed", url: "https://example.test/top-action" },
      target: { kind: "top", requestedTarget: "_top" },
      url: "https://example.test/top-action",
    })
    expect(documentRequests).toHaveLength(1)
    expect(documentRequests[0]?.headers).not.toHaveProperty("Turbo-Frame")
    expect(frameRequests).toHaveLength(0)
    act(() => harness.renderer.unmount())

    for (const action of ["replace", "restore"]) {
      const rejectedDocumentRequests: TurboRequest[] = []
      const rejectedFrameRequests: TurboRequest[] = []
      const rejected = renderDocumentLinks(
        `<Gallery>
          <turbo-frame id="frame">
            <DocumentLink href="/${action}-top-action" data-turbo-action="${action}" data-turbo-frame="_top" />
          </turbo-frame>
        </Gallery>`,
        async (request) => {
          rejectedDocumentRequests.push(request)
          throw new Error("promoted history action must not fetch a document")
        },
        "https://example.test/gallery",
        undefined,
        async (request) => {
          rejectedFrameRequests.push(request)
          throw new Error("promoted history action must not fetch a Frame")
        },
      )

      await expect(rejected.activation(`/${action}-top-action`)()).rejects.toBeInstanceOf(
        TargetError,
      )
      expect(rejectedDocumentRequests).toHaveLength(0)
      expect(rejectedFrameRequests).toHaveLength(0)
      expect(rejected.controller.state.status).toBe("initialized")
      act(() => rejected.renderer.unmount())
    }
  })

  test("keeps recognized Frame-local actions fail-closed before request ownership", async () => {
    const documentRequests: TurboRequest[] = []
    const frameRequests: TurboRequest[] = []
    const harness = renderDocumentLinks(
      `<Gallery>
        <turbo-frame id="frame"><DocumentLink href="/frame-action" data-turbo-action="advance" /></turbo-frame>
        <turbo-frame id="named" />
        <DocumentLink href="/named-frame-action" data-turbo-frame="named" data-turbo-action="replace" />
      </Gallery>`,
      async (request) => {
        documentRequests.push(request)
        throw new Error("Frame-local action link must not fetch a document")
      },
      "https://example.test/gallery",
      undefined,
      async (request) => {
        frameRequests.push(request)
        throw new Error("Frame-local action link must not fetch a Frame")
      },
    )

    for (const href of ["/frame-action", "/named-frame-action"]) {
      await expect(harness.activation(href)()).rejects.toBeInstanceOf(TargetError)
    }
    expect(documentRequests).toHaveLength(0)
    expect(frameRequests).toHaveLength(0)
    expect(harness.controller.state.status).toBe("initialized")
    act(() => harness.renderer.unmount())
  })

  test("inherits exact actions from the resolved destination Frame and lets link non-actions mask them", async () => {
    for (const fixture of [
      {
        href: "/current-inherited-action",
        xml: '<Gallery><turbo-frame id="frame" data-turbo-action="advance"><DocumentLink href="/current-inherited-action" /></turbo-frame></Gallery>',
      },
      {
        href: "/parent-inherited-action",
        xml: '<Gallery><turbo-frame id="outer" data-turbo-action="replace"><turbo-frame id="inner"><DocumentLink href="/parent-inherited-action" data-turbo-frame="_parent" /></turbo-frame></turbo-frame></Gallery>',
      },
      {
        href: "/named-inherited-action",
        xml: '<Gallery><turbo-frame id="named" data-turbo-action="restore" /><DocumentLink href="/named-inherited-action" data-turbo-frame="named" /></Gallery>',
      },
    ]) {
      const documentRequests: TurboRequest[] = []
      const frameRequests: TurboRequest[] = []
      const harness = renderDocumentLinks(
        fixture.xml,
        async (request) => {
          documentRequests.push(request)
          throw new Error("inherited Frame action must not fetch a document")
        },
        "https://example.test/gallery",
        undefined,
        async (request) => {
          frameRequests.push(request)
          throw new Error("inherited Frame action must not fetch a Frame")
        },
      )

      await act(async () => {
        await expect(harness.activation(fixture.href)()).rejects.toBeInstanceOf(TargetError)
      })
      expect(documentRequests).toHaveLength(0)
      expect(frameRequests).toHaveLength(0)
      act(() => harness.renderer.unmount())
    }

    for (const action of ["", "bogus", "Advance"]) {
      const frameRequests: TurboRequest[] = []
      const href = `/masked-frame-action-${action || "blank"}`
      const harness = renderDocumentLinks(
        `<Gallery><turbo-frame id="frame" data-turbo-action="advance"><DocumentLink href="${href}" data-turbo-action="${action}" /></turbo-frame></Gallery>`,
        async () => {
          throw new Error("masked Frame action must not fetch a document")
        },
        "https://example.test/gallery",
        undefined,
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
        await expect(harness.activation(href)()).resolves.toMatchObject({
          frameId: "frame",
          kind: "frame",
        })
      })
      expect(frameRequests).toHaveLength(1)
      act(() => harness.renderer.unmount())
    }

    const documentRequests: TurboRequest[] = []
    const promoted = renderDocumentLinks(
      '<Gallery><turbo-frame id="frame" data-turbo-action="replace"><DocumentLink href="/top-without-inheritance" data-turbo-frame="_top" /></turbo-frame></Gallery>',
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
      async () => {
        throw new Error("promoted Frame link must not fetch a Frame")
      },
    )

    await act(async () => {
      await expect(promoted.activation("/top-without-inheritance")()).resolves.toMatchObject({
        action: "advance",
        kind: "top",
      })
    })
    expect(documentRequests).toHaveLength(1)
    act(() => promoted.renderer.unmount())
  })

  test("submits method and Stream links through the generated-form controller", async () => {
    const documentRequests: TurboRequest[] = []
    const generatedRequests: TurboRequest[] = []
    const lifecycleEvents: string[] = []
    const visitLifecycle = new DocumentVisitLifecycle()
    visitLifecycle.subscribe("click", () => {
      lifecycleEvents.push("click")
    })
    let requestId = 0
    const harness = renderDocumentLinks(
      `<Gallery>
        <DocumentLink href="/generated-method?item=one&amp;item=two" data-turbo-method="delete" />
        <DocumentLink href="/generated-stream?filter=active" data-turbo-stream="" />
        <DemoText id="generated-status">Before</DemoText>
      </Gallery>`,
      async (request) => {
        documentRequests.push(request)
        throw new Error("generated form links must not use the document loader")
      },
      "https://example.test/gallery",
      undefined,
      undefined,
      (session) =>
        new FormLinkSubmissionController(
          session,
          new FormSubmissionController(session, {
            async fetch(request): Promise<TurboResponse> {
              generatedRequests.push(request)
              if (request.url === "https://example.test/generated-stream?filter=active") {
                return {
                  headers: { "Content-Type": TURBO_STREAM_MIME_TYPE },
                  redirected: false,
                  status: 200,
                  text: async () =>
                    '<turbo-stream action="update" target="generated-status"><template>Updated</template></turbo-stream>',
                  url: request.url,
                }
              }
              return {
                headers: {},
                redirected: false,
                status: 204,
                text: async () => "",
                url: request.url,
              }
            },
          }),
          { next: () => `generated-link-${++requestId}` },
        ),
      { visitLifecycle },
    )

    await act(async () => {
      await expect(
        harness.activation("/generated-method?item=one&item=two")(),
      ).resolves.toMatchObject({
        destination: { kind: "document" },
        effectiveMethod: "DELETE",
        status: "empty",
      })
      await expect(harness.activation("/generated-stream?filter=active")()).resolves.toMatchObject({
        application: "stream",
        destination: { kind: "document" },
        status: "applied",
      })
    })

    expect(documentRequests).toHaveLength(0)
    expect(generatedRequests).toHaveLength(2)
    expect(lifecycleEvents).toEqual([])
    expect(generatedRequests[0]).toMatchObject({
      body: {
        contentType: "application/x-www-form-urlencoded;charset=UTF-8",
        value: "item=one&item=two",
      },
      headers: {
        Accept: `${TURBO_STREAM_MIME_TYPE}, ${EXPO_TURBO_MIME_TYPE}`,
        "X-Turbo-Request-Id": "generated-link-1",
      },
      method: "DELETE",
      url: "https://example.test/generated-method",
    })
    expect(generatedRequests[1]).toMatchObject({
      headers: {
        Accept: `${TURBO_STREAM_MIME_TYPE}, ${EXPO_TURBO_MIME_TYPE}`,
        "X-Turbo-Request-Id": "generated-link-2",
      },
      method: "GET",
      url: "https://example.test/generated-stream?filter=active",
    })
    expect(renderedNodeTextContent(harness.session.tree.getElementById("generated-status")!)).toBe(
      "Updated",
    )
    act(() => harness.renderer.unmount())
  })

  test("uses Turbo Frame destinations for generated form links without the Frame loader", async () => {
    const documentRequests: TurboRequest[] = []
    const frameRequests: TurboRequest[] = []
    const generatedRequests: TurboRequest[] = []
    let requestId = 0
    const harness = renderDocumentLinks(
      `<Gallery>
        <turbo-frame id="source">
          <DocumentLink href="/generated-source" data-turbo-method="post" />
        </turbo-frame>
        <turbo-frame id="default-source" target="destination">
          <DocumentLink href="/generated-default" data-turbo-stream="" />
        </turbo-frame>
        <turbo-frame id="destination" />
        <DocumentLink href="/generated-named" data-turbo-method="post" data-turbo-frame="destination" />
        <turbo-frame id="top-source">
          <DocumentLink href="/generated-top" data-turbo-method="post" data-turbo-frame="_top" />
        </turbo-frame>
      </Gallery>`,
      async (request) => {
        documentRequests.push(request)
        throw new Error("generated form links must not use the document loader")
      },
      "https://example.test/gallery",
      undefined,
      async (request) => {
        frameRequests.push(request)
        throw new Error("generated form links must not use the Frame GET loader")
      },
      (session) =>
        new FormLinkSubmissionController(
          session,
          new FormSubmissionController(session, {
            async fetch(request) {
              generatedRequests.push(request)
              return {
                headers: {},
                redirected: false,
                status: 204,
                text: async () => "",
                url: request.url,
              }
            },
          }),
          { next: () => `generated-frame-link-${++requestId}` },
        ),
    )

    const results: unknown[] = []
    for (const href of [
      "/generated-source",
      "/generated-default",
      "/generated-named",
      "/generated-top",
    ]) {
      await act(async () => {
        results.push(await harness.activation(href)())
      })
    }

    expect(
      results.map((result) => (result as { destination: unknown }).destination),
    ).toEqual([
      { frameId: "source", kind: "frame" },
      { frameId: "destination", kind: "frame", requestedTarget: "destination" },
      { frameId: "destination", kind: "frame", requestedTarget: "destination" },
      { kind: "document", requestedTarget: "_top" },
    ])
    expect(
      generatedRequests.slice(0, 3).map((request) => request.headers["Turbo-Frame"]),
    ).toEqual(["source", "destination", "destination"])
    expect(generatedRequests[3]?.headers).not.toHaveProperty("Turbo-Frame")
    expect(documentRequests).toHaveLength(0)
    expect(frameRequests).toHaveLength(0)
    act(() => harness.renderer.unmount())
  })

  test("fails closed when generated form-link interception is disabled", async () => {
    const documentRequests: TurboRequest[] = []
    const generatedRequests: TurboRequest[] = []
    let requestIds = 0
    const harness = renderDocumentLinks(
      '<Gallery><DocumentLink href="/generated-disabled" data-turbo-method="post" /></Gallery>',
      async (request) => {
        documentRequests.push(request)
        throw new Error("disabled generated form links must not become document GETs")
      },
      "https://example.test/gallery",
      undefined,
      undefined,
      (session) =>
        new FormLinkSubmissionController(
          session,
          new FormSubmissionController(session, {
            async fetch(request) {
              generatedRequests.push(request)
              throw new Error("disabled generated form links must not fetch")
            },
          }),
          { next: () => `disabled-generated-link-${++requestIds}` },
          { formMode: "off" },
        ),
    )

    await expect(harness.activation("/generated-disabled")()).rejects.toBeInstanceOf(TargetError)
    expect(requestIds).toBe(0)
    expect(documentRequests).toHaveLength(0)
    expect(generatedRequests).toHaveLength(0)
    expect(harness.controller.state.status).toBe("initialized")
    act(() => harness.renderer.unmount())
  })

  test("projects authored disabled link presence through the Expo Pressable", async () => {
    mock.module("react-native", () => ({
      AccessibilityInfo: { announceForAccessibility: () => undefined },
      Alert: { alert: () => undefined },
      Linking: { openURL: async () => undefined },
      Platform: { OS: "web" },
      Pressable: (props: Readonly<Record<string, unknown>>) => createElement("pressable", props),
      Text: (props: Readonly<Record<string, unknown>>) => createElement("native-text", props),
      TextInput: (props: Readonly<Record<string, unknown>>) => createElement("text-input", props),
      View: (props: Readonly<Record<string, unknown>>) => createElement("view", props),
    }))
    const { DEMO_REGISTRY } = await import("./demo-registry")
    const session = new DocumentSession(
      parseExpoTurboDocument(
        '<Gallery><DemoDocumentLink disabled="" href="/disabled"><DemoText>Disabled</DemoText></DemoDocumentLink></Gallery>',
        { url: "https://example.test/gallery" },
      ),
    )
    const controller = new DocumentVisitController(
      new DocumentRequestLoader(
        session,
        {
          fetch: () => {
            throw new Error("Disabled demo link must not fetch")
          },
        },
        { next: () => "request-disabled-demo-link" },
      ),
      {
        clearTimeout: () => undefined,
        now: () => 0,
        setTimeout: () => Object.freeze({}),
      },
    )
    const renderer = render(session, DEMO_REGISTRY, { documentController: controller })
    const pressables = renderer.root.findAll((node) => String(node.type) === "pressable")

    expect(pressables).toHaveLength(1)
    for (const pressable of pressables) {
      expect(pressable.props.accessibilityState).toEqual({ busy: false, disabled: true })
    }

    act(() => renderer.unmount())
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
        <DocumentLink href="https://outside.test/path" target="_self" data-turbo-confirm="Continue?" />
        <Gallery data-turbo="false"><DocumentLink href="/opted-out" target="" data-turbo-confirm="Continue?" data-turbo-method="delete" /></Gallery>
        <Gallery data-turbo="false"><DocumentLink href="https://outside.test/opted-out" data-turbo-confirm="Continue?" data-turbo-stream="" /></Gallery>
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

  test("delegates mail and telephone schemes from every link capture context", async () => {
    const external: string[] = []
    const requests: TurboRequest[] = []
    const adapter: NavigationAdapter = {
      back() {},
      openExternal: (url) => {
        external.push(url)
      },
      visit() {
        throw new Error("External schemes must not use host visits")
      },
    }
    const harness = renderDocumentLinks(
      `<Gallery>
        <DocumentLink href="MAILTO:help@example.com?subject=Hello World" target="_self" />
        <turbo-frame id="frame"><DocumentLink href="tel:+15551234567;ext=9" target="" /></turbo-frame>
        <turbo-frame id="named" />
        <DocumentLink href="mailto:named@example.com" data-turbo-frame="named" />
        <Gallery data-turbo="false"><DocumentLink href="tel:+18005550199" /></Gallery>
        <DocumentLink disabled="" href="mailto:disabled@example.com" />
        <DocumentLink href="mailto:metadata@example.com" data-turbo-method="get" />
      </Gallery>`,
      async (request) => {
        requests.push(request)
        throw new Error("External schemes must not fetch")
      },
      "https://example.test/gallery",
      adapter,
    )

    const results = await Promise.all([
      harness.activation("MAILTO:help@example.com?subject=Hello World")(),
      harness.activation("tel:+15551234567;ext=9")(),
      harness.activation("mailto:named@example.com")(),
      harness.activation("tel:+18005550199")(),
      harness.activation("mailto:metadata@example.com")(),
    ])

    expect(results).toEqual([
      {
        kind: "external",
        reason: "scheme",
        scheme: "mailto",
        status: "delegated",
        url: "mailto:help@example.com?subject=Hello%20World",
      },
      {
        kind: "external",
        reason: "scheme",
        scheme: "tel",
        status: "delegated",
        url: "tel:+15551234567;ext=9",
      },
      {
        kind: "external",
        reason: "scheme",
        scheme: "mailto",
        status: "delegated",
        url: "mailto:named@example.com",
      },
      {
        kind: "external",
        reason: "scheme",
        scheme: "tel",
        status: "delegated",
        url: "tel:+18005550199",
      },
      {
        kind: "external",
        reason: "scheme",
        scheme: "mailto",
        status: "delegated",
        url: "mailto:metadata@example.com",
      },
    ])
    expect(results.every(Object.isFrozen)).toBe(true)
    expect(await harness.activation("mailto:disabled@example.com")()).toEqual({
      kind: "disabled",
      status: "ignored",
    })
    expect(external).toEqual([
      "mailto:help@example.com?subject=Hello%20World",
      "tel:+15551234567;ext=9",
      "mailto:named@example.com",
      "tel:+18005550199",
      "mailto:metadata@example.com",
    ])
    expect(requests).toHaveLength(0)
    expect(harness.controller.state.status).toBe("initialized")
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
        <DocumentLink href="/application" data-turbo-method="delete" />
        <DocumentLink href="/app/archive.pdf" data-turbo-stream="" />
      </Gallery>`,
      (request) => new Promise<TurboResponse>((resolve) => pending.push({ request, resolve })),
      "https://example.test/app/gallery",
      {
        back() {},
        openExternal() {},
        visit: (url, action) => {
          navigation.push({ action, url })
        },
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

  test("keeps delegated and unsupported interactive links outside click and before-visit lifecycle", async () => {
    const events: string[] = []
    const external: string[] = []
    const navigation: string[] = []
    const lifecycle = new DocumentVisitLifecycle()
    lifecycle.subscribe("click", (event) => {
      events.push(`click:${event.detail.url}`)
    })
    lifecycle.subscribe("before-visit", (event) => {
      events.push(`before-visit:${event.detail.url}`)
    })
    const adapter: NavigationAdapter = {
      back() {},
      openExternal(url) {
        external.push(url)
      },
      visit(url) {
        navigation.push(url)
      },
    }
    const harness = renderDocumentLinks(
      `<Gallery data-turbo-root="/app">
        <DocumentLink href="/outside" />
        <DocumentLink href="https://outside.test/path" />
        <DocumentLink href="mailto:help@example.com" />
        <Gallery data-turbo="false"><DocumentLink href="/app/opted-out" /></Gallery>
        <DocumentLink disabled="" href="/app/disabled" />
        <DocumentLink href="/app/unsupported" target="_blank" />
        <DocumentLink download="" href="/app/download" />
      </Gallery>`,
      async () => {
        throw new Error("delegated links must not fetch")
      },
      "https://example.test/app/gallery",
      adapter,
      undefined,
      undefined,
      { visitLifecycle: lifecycle },
    )

    await harness.activation("/outside")()
    await harness.activation("https://outside.test/path")()
    await harness.activation("mailto:help@example.com")()
    await harness.activation("/app/opted-out")()
    await expect(harness.activation("/app/disabled")()).resolves.toEqual({
      kind: "disabled",
      status: "ignored",
    })
    await expect(harness.activation("/app/unsupported")()).rejects.toThrow(TargetError)
    await expect(harness.activation("/app/download")()).rejects.toThrow(TargetError)

    expect(events).toEqual([])
    expect(navigation).toEqual([
      "https://example.test/outside",
      "https://example.test/app/opted-out",
    ])
    expect(external).toEqual([
      "https://outside.test/path",
      "mailto:help@example.com",
    ])
    expect(harness.controller.state.status).toBe("initialized")
    expect(harness.documentRequestIdCount()).toBe(0)

    await harness.controller.visit("/outside", { navigation: adapter })
    expect(events).toEqual(["before-visit:https://example.test/outside"])
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
        visit: (url, action) => {
          navigation.push({ action, url })
        },
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
        <DocumentLink href="/top-named" data-turbo-confirm="Continue?" data-turbo-frame="named" />
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
          <turbo-frame id="inner"><DocumentLink href="/nearest" target="_self" data-turbo-confirm="Continue?" /></turbo-frame>
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
        <DocumentLink href="mailto:help@example.com" />
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
    await expect(harness.activation("mailto:help@example.com")()).rejects.toBe(failure)
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
      "file:///secret-token",
      "blob:https://example.test/secret-token",
      "sms:+15551234567",
      "custom:secret-token",
      "https://user:secret-token@outside.test/path",
      "http://[secret-token",
      "https://outside.test/path#section",
      "/empty-fragment#",
    ]
    const external: string[] = []
    const navigation: { action: string; url: string }[] = []
    const requests: TurboRequest[] = []
    const clicks: string[] = []
    const lifecycle = new DocumentVisitLifecycle()
    lifecycle.subscribe("click", (event) => {
      clicks.push(event.detail.url)
    })
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
      undefined,
      undefined,
      { visitLifecycle: lifecycle },
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
    expect(clicks).toHaveLength(0)
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
        <DocumentLink href="mailto:help@example.com" />
        <DocumentLink href="/fragment#section" />
        <DocumentLink href="#" />
        <DocumentLink href="/empty-fragment#" />
        <DocumentLink href="/method" data-turbo-confirm="Continue?" data-turbo-method="get" />
        <DocumentLink href="/stream" data-turbo-confirm="Continue?" data-turbo-stream="" />
        <DocumentLink href="/download" download="" />
        <DocumentLink href="/named-download" download="report.xml" />
        <DocumentLink href="/target" target="_blank" />
        <DocumentLink href="/case-target" target="_SELF" />
        <DocumentLink href="/action" data-turbo-action="replace" />
        <DocumentLink href="/restore-action" data-turbo-action="restore" />
        <DocumentLink href="/confirm-alias" confirm="Continue?" />
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
    await expect(harness.activation("mailto:help@example.com")()).rejects.toBeInstanceOf(
      TargetError,
    )
    for (const href of ["/fragment#section", "#", "/empty-fragment#"]) {
      await expect(harness.activation(href)()).rejects.toBeInstanceOf(TargetError)
    }
    for (const href of [
      "/method",
      "/stream",
      "/download",
      "/named-download",
      "/target",
      "/case-target",
      "/action",
      "/restore-action",
      "/confirm-alias",
      "/opted-out",
    ]) {
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

  test("ignores exact disabled links without disturbing ownership and reads presence at activation", async () => {
    const pending: {
      request: TurboRequest
      resolve: (response: TurboResponse) => void
    }[] = []
    const harness = renderDocumentLinks(
      `<Gallery>
        <DocumentLink href="/pending" />
        <DocumentLink id="dynamic" href="/dynamic" data-turbo-confirm="Continue?" />
        <DocumentLink disabled="" download="" href="/disabled" target="_blank" data-turbo-action="replace" data-turbo-confirm="Continue?" data-turbo-method="delete" />
        <turbo-frame id="frame"><DocumentLink disabled="false" href="/frame-disabled" data-turbo-confirm="Continue?" data-turbo-stream="" /></turbo-frame>
        <Gallery data-turbo="false"><DocumentLink disabled="disabled" href="/opted-out-disabled" data-turbo-confirm="Continue?" data-turbo-method="post" /></Gallery>
      </Gallery>`,
      (request) => new Promise<TurboResponse>((resolve) => pending.push({ request, resolve })),
    )
    const dynamic = harness.activation("/dynamic")
    let current: Promise<unknown> | undefined
    act(() => {
      current = harness.activation("/pending")()
      harness.session.setAttribute("id:dynamic", "disabled", "")
    })
    const started = harness.controller.state

    for (const activate of [
      dynamic,
      harness.activation("/disabled"),
      harness.activation("/frame-disabled"),
      harness.activation("/opted-out-disabled"),
    ]) {
      const result = await activate()
      expect(result).toEqual({ kind: "disabled", status: "ignored" })
      expect(Object.isFrozen(result)).toBe(true)
    }
    expect(pending).toHaveLength(1)
    expect(pending[0]?.request.signal?.aborted).toBe(false)
    expect(harness.controller.state).toBe(started)

    act(() => harness.session.removeAttribute("id:dynamic", "disabled"))
    let resumed: Promise<unknown> | undefined
    act(() => {
      resumed = dynamic()
    })
    expect(pending).toHaveLength(2)
    expect(pending[0]?.request.signal?.aborted).toBe(true)
    expect(pending[1]?.request.url).toBe("https://example.test/dynamic")

    await act(async () => {
      pending[0]?.resolve({
        headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
        redirected: false,
        status: 200,
        text: async () => '<Gallery><DocumentLink href="/stale" /></Gallery>',
        url: "https://example.test/pending",
      })
      await current
      pending[1]?.resolve({
        headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
        redirected: false,
        status: 200,
        text: async () => '<Gallery><DocumentLink href="/after" /></Gallery>',
        url: "https://example.test/dynamic",
      })
      await resumed
    })
    expect(harness.session.tree.document.url).toBe("https://example.test/dynamic")

    act(() => harness.renderer.unmount())
  })

  test("rejects stale and unconfigured Frame-scoped link activations before fetching", async () => {
    const pending: {
      request: TurboRequest
      resolve: (response: TurboResponse) => void
    }[] = []
    const clicks: string[] = []
    const lifecycle = new DocumentVisitLifecycle()
    lifecycle.subscribe("click", (event) => {
      clicks.push(event.detail.url)
    })
    const harness = renderDocumentLinks(
      `<Gallery>
        <DocumentLink href="/pending" />
        <DocumentLink id="top-link" href="/stale" />
        <turbo-frame id="frame"><DocumentLink href="/inside-frame" /></turbo-frame>
      </Gallery>`,
      (request) => new Promise<TurboResponse>((resolve) => pending.push({ request, resolve })),
      "https://example.test/gallery",
      undefined,
      undefined,
      undefined,
      { visitLifecycle: lifecycle },
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
        '<turbo-stream action="replace" target="top-link"><template><DocumentLink id="top-link" disabled="" href="/replacement" /></template></turbo-stream>',
      )
    })
    await expect(stale()).rejects.toBeInstanceOf(TargetError)
    expect(clicks).toEqual(["https://example.test/pending"])
    await expect(insideFrame()).rejects.toMatchObject({
      code: "target",
      context: { frameId: "frame" },
    })
    expect(clicks).toEqual([
      "https://example.test/pending",
      "https://example.test/inside-frame",
    ])
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

  function loadedAutofocusFrame(xml: string) {
    const session = new DocumentSession(
      parseExpoTurboDocument(
        '<Gallery><turbo-frame id="frame" src="/replacement"><DemoText>Before</DemoText></turbo-frame></Gallery>',
        { url: "https://example.test/document" },
      ),
    )
    const frames = new FrameControllerRegistry(
      session,
      new FrameRequestLoader(
        session,
        {
          async fetch(request): Promise<TurboResponse> {
            return {
              headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
              redirected: false,
              status: 200,
              text: async () => xml,
              url: request.url,
            }
          },
        },
        { next: () => "frame-autofocus-request" },
      ),
    )
    const controller = frames.get("frame")
    return { frames, loaded: controller.connect(), session }
  }

  function documentAutofocusFixture(xml: string) {
    const mounted = new Set<string>()
    const focused: string[] = []
    function FocusTarget(props: Readonly<{ focusKey: string; focusable: boolean }>): ReactNode {
      const nodeKey = `id:${props.focusKey}`
      useLayoutEffect(() => {
        if (!props.focusable) return
        mounted.add(nodeKey)
        return () => {
          mounted.delete(nodeKey)
        }
      }, [nodeKey, props.focusable])
      return createElement("document-focus-target", { nodeKey })
    }
    const focusTarget = defineComponent({
      attributes: {
        "focus-key": { codec: stringCodec, prop: "focusKey" },
        focusable: { codec: presenceCodec, prop: "focusable" },
      },
      children: "none",
      component: FocusTarget,
      schema: z.object({
        focusKey: z.string(),
        focusable: z.boolean().default(false),
      }),
      tag: "DocumentFocusTarget",
    })
    const registry = registryWithCounters().use(
      defineComponentModule({
        components: [focusTarget],
        name: "document-autofocus-component",
        version: "0.1.0",
      }),
    )
    const session = new DocumentSession(
      parseExpoTurboDocument(xml, { url: "https://example.test/document" }),
    )
    const autofocus: AutofocusAdapter = {
      canFocus: (nodeKey) => mounted.has(nodeKey),
      focus: (nodeKey) => {
        focused.push(nodeKey)
      },
    }
    return { autofocus, focused, mounted, registry, session }
  }

  test("focuses the first available initial document candidate once across StrictMode and providers", () => {
    const fixture = documentAutofocusFixture(
      `<Gallery>
        <DocumentFocusTarget id="unavailable" focus-key="unavailable" autofocus="" />
        <turbo-frame id="nested">
          <DocumentFocusTarget id="available" focus-key="available" focusable="" autofocus="" />
        </turbo-frame>
        <DocumentFocusTarget id="later" focus-key="later" focusable="" autofocus="false" />
      </Gallery>`,
    )
    let first: ReactTestRenderer | undefined
    let second: ReactTestRenderer | undefined
    act(() => {
      first = create(
        createElement(
          StrictMode,
          null,
          createElement(
            ExpoTurboProvider,
            {
              autofocus: fixture.autofocus,
              registry: fixture.registry,
              session: fixture.session,
            },
            createElement(ExpoTurboRoot),
          ),
        ),
      )
    })
    act(() => {
      second = create(
        createElement(
          ExpoTurboProvider,
          {
            autofocus: fixture.autofocus,
            registry: fixture.registry,
            session: fixture.session,
          },
          createElement(ExpoTurboRoot),
        ),
      )
    })

    expect(fixture.mounted).toEqual(new Set(["id:available", "id:later"]))
    expect(fixture.focused).toEqual(["id:available"])

    act(() => second?.unmount())
    act(() => first?.unmount())
  })

  test("consumes missing document adapters and focuses each whole-tree generation, not Streams", () => {
    const fixture = documentAutofocusFixture(
      '<Gallery id="gallery"><DocumentFocusTarget id="initial" focus-key="initial" focusable="" autofocus="" /></Gallery>',
    )
    const renderer = render(fixture.session, fixture.registry)

    act(() => {
      renderer.update(
        createElement(
          ExpoTurboProvider,
          {
            autofocus: fixture.autofocus,
            registry: fixture.registry,
            session: fixture.session,
          },
          createElement(ExpoTurboRoot),
        ),
      )
    })
    expect(fixture.focused).toEqual([])

    act(() => {
      fixture.session.replaceTree(
        parseExpoTurboDocument(
          '<Gallery id="gallery"><DocumentFocusTarget id="replacement" focus-key="replacement" focusable="" autofocus="" /></Gallery>',
          { url: "https://example.test/replacement" },
        ),
      )
    })
    expect(fixture.focused).toEqual(["id:replacement"])

    act(() => {
      dispatchTurboStreamFragment(
        fixture.session,
        '<turbo-stream action="append" target="gallery"><template><DocumentFocusTarget id="streamed" focus-key="streamed" focusable="" autofocus="" /></template></turbo-stream>',
      )
    })
    expect(fixture.focused).toEqual(["id:replacement"])

    act(() => {
      fixture.session.replaceTree(fixture.session.tree)
    })
    expect(fixture.focused).toEqual(["id:replacement", "id:replacement"])

    act(() => renderer.unmount())
  })

  test("reports redacted document autofocus failures without rolling back the rendered tree", async () => {
    for (const autofocus of [
      {
        canFocus() {
          throw new Error("secret document availability failure")
        },
        focus: () => undefined,
      },
      {
        canFocus: (() => "secret nonboolean result") as unknown as () => boolean,
        focus: () => undefined,
      },
      {
        canFocus: () => true,
        focus: (() =>
          Promise.reject(new Error("secret document focus failure"))) as unknown as () => void,
      },
    ] satisfies AutofocusAdapter[]) {
      const session = new DocumentSession(
        parseExpoTurboDocument(
          '<Gallery><DemoText id="candidate" autofocus="">After</DemoText></Gallery>',
          { url: "https://example.test/document" },
        ),
      )
      const errors: ExpoTurboRenderError[] = []
      let renderer: ReactTestRenderer | undefined
      await act(async () => {
        renderer = create(
          createElement(
            ExpoTurboProvider,
            {
              autofocus,
              onError: (event) => errors.push(event),
              registry: registryWithCounters(),
              session,
            },
            createElement(ExpoTurboRoot),
          ),
        )
        await Promise.resolve()
      })
      if (!renderer) throw new Error("renderer was not created")

      expect(errors).toHaveLength(1)
      expect(errors[0]?.error).toBeInstanceOf(StateError)
      expect(String(errors[0]?.error)).not.toContain("secret")
      expect(JSON.stringify(renderer.toJSON())).toContain("After")

      act(() => renderer?.unmount())
    }
  })

  test("contains a throwing document autofocus observer once behind a redacted fallback", () => {
    const session = new DocumentSession(
      parseExpoTurboDocument(
        '<Gallery><DemoText id="candidate" autofocus="">After</DemoText></Gallery>',
        { url: "https://example.test/document" },
      ),
    )
    const fallbacks: ExpoTurboRenderError[] = []
    let reports = 0
    let renderer: ReactTestRenderer | undefined
    act(() => {
      renderer = create(
        createElement(
          ExpoTurboProvider,
          {
            autofocus: {
              canFocus() {
                throw new Error("secret adapter failure")
              },
              focus: () => undefined,
            },
            onError() {
              reports += 1
              throw new Error("secret observer failure")
            },
            registry: registryWithCounters(),
            renderError: (event) => {
              fallbacks.push(event)
              return createElement("render-error", { message: event.error.message })
            },
            session,
          },
          createElement(ExpoTurboRoot),
        ),
      )
    })
    if (!renderer) throw new Error("renderer was not created")

    expect(reports).toBe(1)
    expect(fallbacks).toHaveLength(1)
    expect(fallbacks[0]?.error).toBeInstanceOf(StateError)
    expect(String(fallbacks[0]?.error)).toContain("Document autofocus error reporting failed")
    expect(JSON.stringify(renderer.toJSON())).not.toContain("secret")

    act(() => renderer?.unmount())
  })

  test("focuses the first mounted stable-id candidate once during StrictMode Frame mount", async () => {
    const mounted = new Set<string>()
    const focused: string[] = []
    const errors: ExpoTurboRenderError[] = []
    function FocusTarget(props: Readonly<{ focusKey: string; focusable: boolean }>): ReactNode {
      const nodeKey = `id:${props.focusKey}`
      useLayoutEffect(() => {
        if (!props.focusable) return
        mounted.add(nodeKey)
        return () => {
          mounted.delete(nodeKey)
        }
      }, [nodeKey, props.focusable])
      return createElement("focus-target", { nodeKey })
    }
    const focusTarget = defineComponent({
      attributes: {
        "focus-key": { codec: stringCodec, prop: "focusKey" },
        focusable: { codec: presenceCodec, prop: "focusable" },
      },
      children: "none",
      component: FocusTarget,
      schema: z.object({
        focusKey: z.string(),
        focusable: z.boolean().default(false),
      }),
      tag: "FocusTarget",
    })
    const registry = registryWithCounters().use(
      defineComponentModule({
        components: [focusTarget],
        name: "frame-autofocus-component",
        version: "0.1.0",
      }),
    )
    const { frames, loaded, session } = loadedAutofocusFrame(
      `<turbo-frame id="frame">
         <FocusTarget id="unavailable" focus-key="unavailable" autofocus="" />
         <FocusTarget id="available" focus-key="available" focusable="" autofocus="" />
         <FocusTarget id="later" focus-key="later" focusable="" autofocus="false" />
       </turbo-frame>`,
    )
    await loaded
    const autofocus: AutofocusAdapter = {
      canFocus: (nodeKey) => mounted.has(nodeKey),
      focus: (nodeKey) => {
        focused.push(nodeKey)
      },
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
              autofocus,
              frames,
              onError: (event) => errors.push(event),
              registry,
              session,
            },
            createElement(ExpoTurboRoot),
          ),
        ),
      )
    })
    if (!renderer) throw new Error("renderer was not created")

    expect(mounted).toEqual(new Set(["id:available", "id:later"]))
    expect(focused).toEqual(["id:available"])
    expect(errors).toEqual([])

    act(() => renderer?.unmount())
  })

  test("consumes missing-adapter and stale same-id autofocus intents without later focus", async () => {
    {
      const { frames, loaded, session } = loadedAutofocusFrame(
        '<turbo-frame id="frame"><DemoText id="candidate" autofocus="">After</DemoText></turbo-frame>',
      )
      await loaded
      const registry = registryWithCounters()
      const renderer = render(session, registry, { frames })

      const focused: string[] = []
      act(() => {
        renderer.update(
          createElement(
            ExpoTurboProvider,
            {
              autofocus: {
                canFocus: () => true,
                focus: (nodeKey) => focused.push(nodeKey),
              },
              frames,
              registry,
              session,
            },
            createElement(ExpoTurboRoot),
          ),
        )
      })
      expect(focused).toEqual([])
      act(() => renderer?.unmount())
    }

    {
      const { frames, loaded, session } = loadedAutofocusFrame(
        '<turbo-frame id="frame"><DemoText id="candidate" autofocus="">After</DemoText></turbo-frame>',
      )
      await loaded
      dispatchTurboStreamFragment(
        session,
        '<turbo-stream action="replace" target="candidate"><template><DemoText id="candidate">New owner</DemoText></template></turbo-stream>',
      )
      const focused: string[] = []
      const renderer = render(session, registryWithCounters(), {
        autofocus: {
          canFocus: () => true,
          focus: (nodeKey) => focused.push(nodeKey),
        },
        frames,
      })
      expect(focused).toEqual([])
      act(() => renderer?.unmount())
    }
  })

  test("reports redacted autofocus adapter contract failures after retaining committed children", async () => {
    const rejectedThenable = {
      then(_resolve: (value: unknown) => void, reject: (error: Error) => void) {
        reject(new Error("secret thenable failure"))
      },
    }
    for (const autofocus of [
      {
        canFocus: (() => "secret nonboolean result") as unknown as () => boolean,
        focus: () => undefined,
      },
      {
        canFocus: (() =>
          Promise.reject(new Error("secret availability failure"))) as unknown as () => boolean,
        focus: () => undefined,
      },
      {
        canFocus() {
          throw new Error("secret availability failure")
        },
        focus: () => undefined,
      },
      {
        canFocus: () => true,
        focus() {
          throw new Error("secret focus failure")
        },
      },
      {
        canFocus: () => true,
        focus: (() => "secret nonvoid result") as unknown as () => void,
      },
      {
        canFocus: () => true,
        focus: (() => Promise.reject(new Error("secret focus failure"))) as () => never,
      },
      {
        canFocus: () => true,
        focus: (() => rejectedThenable) as unknown as () => void,
      },
    ] satisfies AutofocusAdapter[]) {
      const { frames, loaded, session } = loadedAutofocusFrame(
        '<turbo-frame id="frame"><DemoText id="candidate" autofocus="">After</DemoText></turbo-frame>',
      )
      await loaded
      const errors: ExpoTurboRenderError[] = []
      let renderer: ReactTestRenderer | undefined
      await act(async () => {
        renderer = create(
          createElement(
            StrictMode,
            null,
            createElement(
              ExpoTurboProvider,
              {
                autofocus,
                frames,
                onError: (event) => errors.push(event),
                registry: registryWithCounters(),
                session,
              },
              createElement(ExpoTurboRoot),
            ),
          ),
        )
        await Promise.resolve()
      })
      if (!renderer) throw new Error("renderer was not created")

      expect(errors).toHaveLength(1)
      expect(errors[0]?.error).toBeInstanceOf(StateError)
      expect(String(errors[0]?.error)).not.toContain("secret")
      expect(JSON.stringify(renderer.toJSON())).toContain("After")

      act(() => renderer?.unmount())
    }
  })

  test("acknowledges a mounted Frame response before autofocus and Frame load", async () => {
    const pending: {
      request: TurboRequest
      resolve: (response: TurboResponse) => void
    }[] = []
    const events: string[] = []
    const mounted = new Set<string>()
    function FrameRenderProbe(): ReactNode {
      useLayoutEffect(() => {
        events.push("child-layout")
      }, [])
      return createElement("frame-render-probe")
    }
    function FocusTarget(props: Readonly<{ focusKey: string }>): ReactNode {
      const nodeKey = `id:${props.focusKey}`
      useLayoutEffect(() => {
        mounted.add(nodeKey)
        return () => {
          mounted.delete(nodeKey)
        }
      }, [nodeKey])
      return createElement("focus-target", { nodeKey })
    }
    const probe = defineComponent({
      attributes: {},
      children: "none",
      component: FrameRenderProbe,
      schema: z.object({}),
      tag: "FrameRenderProbe",
    })
    const focusTarget = defineComponent({
      attributes: { "focus-key": { codec: stringCodec, prop: "focusKey" } },
      children: "none",
      component: FocusTarget,
      schema: z.object({ focusKey: z.string() }),
      tag: "FocusTarget",
    })
    const registry = registryWithCounters().use(
      defineComponentModule({
        components: [probe, focusTarget],
        name: "frame-render-lifecycle-component",
        version: "0.1.0",
      }),
    )
    const session = new DocumentSession(
      parseExpoTurboDocument(
        '<Gallery><turbo-frame id="frame" src="/frame"><DemoText>Before</DemoText></turbo-frame></Gallery>',
        { url: "https://example.test/gallery" },
      ),
    )
    const lifecycle = new FrameLifecycle()
    lifecycle.subscribe("frame-render", () => {
      events.push("render")
    })
    lifecycle.subscribe("frame-load", () => {
      events.push("load")
    })
    const frames = new FrameControllerRegistry(
      session,
      new FrameRequestLoader(
        session,
        {
          fetch: (request) =>
            new Promise<TurboResponse>((resolve) => pending.push({ request, resolve })),
        },
        { next: () => `request-${pending.length + 1}` },
        { frameLifecycle: lifecycle },
      ),
    )
    const renderer = render(session, registry, {
      autofocus: {
        canFocus: (nodeKey) => mounted.has(nodeKey),
        focus: (nodeKey) => {
          events.push(`focus:${nodeKey}`)
        },
      },
      frames,
    })
    const controller = frames.get("frame")

    expect(pending).toHaveLength(1)
    await act(async () => {
      pending[0]?.resolve({
        headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
        redirected: false,
        status: 200,
        text: async () =>
          '<turbo-frame id="frame"><FrameRenderProbe /><FocusTarget id="focus" focus-key="focus" autofocus="" /></turbo-frame>',
        url: "https://example.test/frame",
      })
      await nextTurn()
    })
    await controller.loaded

    expect(events).toEqual(["child-layout", "focus:id:focus", "render", "load"])
    expect(controller.state.status).toBe("completed")
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

// Compile-time package-surface coverage for destination-aware form proposals.
function assertPublicFormProposalTypes(
  binding: ExpoTurboFormBinding,
  plan: FormRequestPlan,
  frameProtocol: FormRequestProtocolOptions,
): void {
  // @ts-expect-error Active forms derive Frame metadata from their exact destination.
  binding.requestPlan({ protocol: frameProtocol })
  // @ts-expect-error Submission proposals are opaque package-issued identities.
  const forged: FormSubmissionProposal = { destination: { kind: "document" }, plan }
  void forged
}
void assertPublicFormProposalTypes
