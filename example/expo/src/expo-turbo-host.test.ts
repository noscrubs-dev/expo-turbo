/// <reference types="bun" />

import { describe, expect, test } from "bun:test"
import type { NavigationAdapter, TurboResponse, VisitAction } from "expo-turbo/adapters"
import { EXPO_TURBO_MIME_TYPE, TargetError } from "expo-turbo/core"
import {
  ExpoTurbo,
  useComponentAction,
  useDocumentState,
  useExpoTurboDisposable,
  useExpoTurboDocumentLink,
  useExpoTurboDocumentLinkPrefetch,
} from "expo-turbo/react"
import {
  createComponentActionRegistry,
  createRegistry,
  defineComponent,
  defineComponentAction,
  defineComponentActionModule,
  defineComponentModule,
  stringCodec,
} from "expo-turbo/registry"
import { Component, createElement, type ReactElement, type ReactNode, StrictMode } from "react"
import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { z } from "zod"

const globalWithAct = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean
}
globalWithAct.IS_REACT_ACT_ENVIRONMENT = true

const DOCUMENT_URL = "https://example.test/document"
const MAILTO_HREF = "mailto:support@example.test"
const nextTurn = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

/**
 * Activation handles keyed by href. The registered component below reaches the
 * navigation adapter only through the renderer's NavigationContext: it closes
 * over nothing but this map, so a recorded `openExternal` call can only have
 * arrived through the provider.
 */
const activations = new Map<string, () => Promise<unknown>>()
const actionExecutions = new Map<string, () => Promise<string>>()
const prefetches = new Map<string, ReturnType<typeof useExpoTurboDocumentLinkPrefetch>>()
let recoverableFailure = false

function DocumentLink({ href }: Readonly<{ href: string }>): ReactNode {
  activations.set(href, useExpoTurboDocumentLink(href))
  prefetches.set(href, useExpoTurboDocumentLinkPrefetch(href))
  return createElement("link", { href })
}

const recordAction = defineComponentAction({
  action: "record-host-value",
  handler: ({ params, state }) => {
    state.set("host-record", params.value)
    return params.value
  },
  schema: z.object({ value: z.string() }),
})

const actions = createComponentActionRegistry(
  defineComponentActionModule({
    actions: [recordAction],
    name: "host-actions",
    version: "1.0.0",
  }),
)

function ActionTrigger(): ReactNode {
  const execute = useComponentAction(recordAction)
  const recorded = useDocumentState<string>("host-record")
  actionExecutions.set("record", () => execute({ value: "from-high-level-runtime" }))
  return createElement("action-trigger", { recorded: recorded.value })
}

function RecoverableFailure(): ReactNode {
  if (recoverableFailure) throw new Error("recoverable component failure")
  return createElement("recovered-component")
}

const registry = createRegistry(
  defineComponentModule({
    components: [
      defineComponent({
        attributes: {},
        children: "nodes",
        component: (props: Readonly<{ children?: ReactNode }>) =>
          createElement("doc", null, props.children),
        schema: z.object({}),
        tag: "HostDoc",
      }),
      defineComponent({
        attributes: { href: { codec: stringCodec, prop: "href" } },
        children: "none",
        component: DocumentLink,
        schema: z.object({ href: z.string().trim().min(1) }),
        tag: "HostDocLink",
      }),
      defineComponent({
        attributes: {},
        children: "none",
        component: ActionTrigger,
        schema: z.object({}),
        tag: "HostActionTrigger",
      }),
      defineComponent({
        attributes: {},
        children: "none",
        component: RecoverableFailure,
        schema: z.object({}),
        tag: "HostRecoverableFailure",
      }),
    ],
    name: "expo-turbo-host-fixtures",
    version: "1.0.0",
  }),
)

function xmlResponse(xml: string, url: string): TurboResponse {
  return {
    headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
    redirected: false,
    status: 200,
    text: async () => xml,
    url,
  }
}

function documentFetch(xml: string) {
  let calls = 0
  return {
    get calls() {
      return calls
    },
    fetch: {
      fetch: async (request: Readonly<{ url: string }>) => {
        calls += 1
        return xmlResponse(xml, request.url)
      },
    },
  }
}

type RecordedVisit = Readonly<{ action: VisitAction; url: string }>

interface RecordedNavigation {
  readonly adapter: NavigationAdapter
  readonly external: string[]
  readonly visits: RecordedVisit[]
}

function recordingNavigation(): RecordedNavigation {
  const external: string[] = []
  const visits: RecordedVisit[] = []
  return {
    adapter: {
      back() {},
      openExternal(url: string) {
        external.push(url)
      },
      visit(url: string, action: VisitAction) {
        visits.push({ action, url })
      },
    },
    external,
    visits,
  }
}

class CatchingBoundary extends Component<
  Readonly<{ children?: ReactNode }>,
  Readonly<{ error?: Error }>
> {
  static caught: Error | undefined

  constructor(props: Readonly<{ children?: ReactNode }>) {
    super(props)
    this.state = {}
  }

  static getDerivedStateFromError(error: Error) {
    CatchingBoundary.caught = error
    return { error }
  }

  render(): ReactNode {
    if (this.state.error) return createElement("boundary-caught", null)
    return this.props.children
  }
}

async function mount(element: ReactElement): Promise<ReactTestRenderer> {
  let renderer: ReactTestRenderer | undefined
  await act(async () => {
    renderer = create(element)
  })
  await act(async () => {
    await nextTurn()
  })
  if (!renderer) throw new Error("renderer was not created")
  return renderer
}

describe("ExpoTurbo navigation forwarding", () => {
  test("delegates an external-scheme document link to the navigation prop", async () => {
    activations.clear()
    const navigation = recordingNavigation()
    const transport = documentFetch(`<HostDoc><HostDocLink href="${MAILTO_HREF}" /></HostDoc>`)
    const errors: Error[] = []

    const renderer = await mount(
      createElement(ExpoTurbo, {
        fetch: transport.fetch,
        navigation: navigation.adapter,
        onError: (error: Error) => errors.push(error),
        registry,
        renderError: (error: Error) => createElement("render-error", { message: error.message }),
        url: DOCUMENT_URL,
      }),
    )

    const activate = activations.get(MAILTO_HREF)
    if (!activate) throw new Error("the fixture link never mounted")
    let result: unknown
    await act(async () => {
      result = await activate()
    })

    // The adapter was reached, and specifically through the external-scheme
    // branch rather than a same-origin visit or a top-level classification.
    expect(navigation.external).toEqual([MAILTO_HREF])
    expect(navigation.visits).toEqual([])
    expect(result).toMatchObject({ kind: "external", reason: "scheme", status: "delegated" })
    expect(errors).toEqual([])

    await act(async () => {
      renderer.unmount()
    })
  })

  test("has no second route to the navigation adapter when the prop is absent", async () => {
    activations.clear()
    const navigation = recordingNavigation()
    const transport = documentFetch(`<HostDoc><HostDocLink href="${MAILTO_HREF}" /></HostDoc>`)

    // Identical tree and identical fixture component, with the navigation prop
    // removed. If the recorded call in the test above could arrive by any route
    // other than the `navigation` prop, this activation would also record one.
    const renderer = await mount(
      createElement(ExpoTurbo, {
        fetch: transport.fetch,
        registry,
        renderError: (error: Error) => createElement("render-error", { message: error.message }),
        url: DOCUMENT_URL,
      }),
    )

    const activate = activations.get(MAILTO_HREF)
    if (!activate) throw new Error("the fixture link never mounted")
    await expect(activate()).rejects.toBeInstanceOf(TargetError)
    expect(navigation.external).toEqual([])

    await act(async () => {
      renderer.unmount()
    })
  })
})

describe("ExpoTurbo runtime service forwarding", () => {
  test("wires actions and both shared preloaders without duplicate destination fetches", async () => {
    activations.clear()
    actionExecutions.clear()
    prefetches.clear()
    const requests: Readonly<{
      headers: Readonly<Record<string, string>>
      url: string
    }>[] = []
    const fetch = {
      fetch: async (
        request: Readonly<{ headers: Readonly<Record<string, string>>; url: string }>,
      ) => {
        requests.push(request)
        if (request.url === "https://example.test/frame") {
          return xmlResponse('<turbo-frame id="details" />', request.url)
        }
        if (request.url === "https://example.test/next") {
          return xmlResponse("<HostDoc />", request.url)
        }
        return xmlResponse(
          '<HostDoc><HostDocLink href="/next" /><HostDocLink href="/frame" data-turbo-frame="details" data-turbo-preload="" /><HostActionTrigger /><turbo-frame id="details" /></HostDoc>',
          request.url,
        )
      },
    }

    const renderer = await mount(
      createElement(ExpoTurbo, {
        actions,
        fetch,
        registry,
        renderError: (error: Error) => createElement("render-error", { message: error.message }),
        url: DOCUMENT_URL,
      }),
    )

    const prefetch = prefetches.get("/next")
    const activateFrame = activations.get("/frame")
    const activateDocument = activations.get("/next")
    const executeAction = actionExecutions.get("record")
    if (!prefetch || !activateFrame || !activateDocument || !executeAction) {
      throw new Error("runtime service fixtures did not mount")
    }
    prefetch()
    prefetch.commit()
    await act(async () => {
      await nextTurn()
      await executeAction()
    })
    expect(
      renderer.root.find((node) => String(node.type) === "action-trigger").props.recorded,
    ).toBe("from-high-level-runtime")

    await act(async () => {
      await activateFrame()
      await activateDocument()
    })

    expect(requests.map(({ url }) => url)).toEqual([
      DOCUMENT_URL,
      "https://example.test/frame",
      "https://example.test/next",
    ])
    expect(requests.filter(({ url }) => url === "https://example.test/frame")).toHaveLength(1)
    expect(requests.filter(({ url }) => url === "https://example.test/next")).toHaveLength(1)
    expect(requests.find(({ url }) => url.endsWith("/frame"))?.headers["Turbo-Frame"]).toBe(
      "details",
    )
    expect(requests.find(({ url }) => url.endsWith("/next"))?.headers["X-Sec-Purpose"]).toBe(
      "prefetch",
    )
    await act(async () => {
      renderer.unmount()
    })
  })

  test("forwards renderError to the provider and recovers through its retry", async () => {
    recoverableFailure = true
    const surfaced: Error[] = []
    let retry: (() => void) | undefined
    const renderer = await mount(
      createElement(ExpoTurbo, {
        fetch: {
          fetch: async (request) =>
            xmlResponse("<HostDoc><HostRecoverableFailure /></HostDoc>", request.url),
        },
        registry,
        renderError: (error: Error, next: () => void) => {
          surfaced.push(error)
          retry = next
          return createElement("render-error", { message: error.message })
        },
        url: DOCUMENT_URL,
      }),
    )

    expect(renderer.toJSON()).toMatchObject({
      props: { message: "recoverable component failure" },
      type: "render-error",
    })
    // The provider boundary renders before the high-level full-document
    // surface. React can render that boundary more than once while it settles,
    // so the invariant is two routes, not an exact render count. Before issue
    // #440 only the high-level route called this function.
    expect(surfaced.length).toBeGreaterThan(1)
    expect(new Set(surfaced.map((error) => error.message))).toEqual(
      new Set(["recoverable component failure"]),
    )
    if (!retry) throw new Error("renderError did not receive a retry callback")

    recoverableFailure = false
    await act(async () => {
      retry?.()
      await nextTurn()
    })

    expect(renderer.root.findAll((node) => String(node.type) === "render-error")).toHaveLength(0)
    expect(
      renderer.root.findAll((node) => String(node.type) === "recovered-component"),
    ).toHaveLength(1)
    await act(async () => {
      renderer.unmount()
    })
  })
})

describe("useExpoTurboDisposable", () => {
  function Claim({ resource }: Readonly<{ resource: { dispose(): void } }>): ReactNode {
    useExpoTurboDisposable(resource)
    return createElement("claim", null)
  }

  test("disposes only after the last claim is released", async () => {
    let disposals = 0
    const resource = {
      dispose() {
        disposals += 1
      },
    }

    const renderer = await mount(
      createElement(
        "root",
        null,
        createElement(Claim, { resource }),
        createElement(Claim, { resource }),
      ),
    )

    await act(async () => {
      renderer.update(createElement("root", null, createElement(Claim, { resource })))
      await nextTurn()
    })
    // One claim remains, so a naive per-mount cleanup would already have
    // disposed a resource the surviving screen is still using.
    expect(disposals).toBe(0)

    await act(async () => {
      renderer.unmount()
      await nextTurn()
    })
    expect(disposals).toBe(1)
  })

  test("hands the resource over across a same-commit remount", async () => {
    let disposals = 0
    const resource = {
      dispose() {
        disposals += 1
      },
    }

    const renderer = await mount(
      createElement(StrictMode, null, createElement(Claim, { resource })),
    )

    // StrictMode mounts, unmounts, and remounts in one commit. The microtask
    // deferral is what keeps that from tearing the resource down; without it
    // this reads 1 and the remounted tree owns a disposed runtime.
    expect(disposals).toBe(0)

    await act(async () => {
      renderer.unmount()
      await nextTurn()
    })
    expect(disposals).toBe(1)
  })
})

describe("ExpoTurbo failure surface", () => {
  const failingTransport = {
    fetch: async () => {
      throw new Error("document transport refused")
    },
  }

  test("renders the host surface with no error boundary anywhere above it", async () => {
    // No boundary in this tree at all. React Native turns an unhandled render
    // throw into a fatal (JavascriptException on Android, RCTFatal on iOS), so
    // this is the configuration a released app actually runs and the one that
    // must never escalate.
    const renderer = await mount(
      createElement(ExpoTurbo, {
        fetch: failingTransport,
        registry,
        renderError: (error: Error) => createElement("render-error", { message: error.message }),
        url: DOCUMENT_URL,
      }),
    )

    // The transport redacts the original cause, so the surface receives the
    // package's own message.
    expect(renderer.toJSON()).toMatchObject({
      props: { message: "Document request failed" },
      type: "render-error",
    })

    await act(async () => {
      renderer.unmount()
    })
  })

  test("does not escalate to a fatal when a JavaScript host omits renderError", async () => {
    // `renderError` is a required prop, so TypeScript rejects this call. An
    // untyped host can still reach it, and reaching it must stay survivable:
    // render nothing, say so once, and never throw. Again with no boundary.
    const errors: unknown[][] = []
    const console = globalThis.console
    const originalError = console.error
    console.error = (...args: unknown[]) => {
      errors.push(args)
    }

    try {
      const renderer = await mount(
        createElement(ExpoTurbo, {
          fetch: failingTransport,
          registry,
          url: DOCUMENT_URL,
        } as never),
      )

      // Survived: the tree is still mounted and rendering, not torn down.
      expect(renderer.toJSON()).toBeNull()
      // Exactly one diagnostic of ours; React logs its own warnings through the
      // same channel, so count only the message this package emits.
      const ours = errors.filter((args) => String(args[0]).includes("[expo-turbo]"))
      expect(ours).toHaveLength(1)
      expect(String(ours[0]?.[0])).toContain("renderError")

      await act(async () => {
        renderer.unmount()
      })
    } finally {
      console.error = originalError
    }
  })

  test("reports the failure to onError even when it renders nothing", async () => {
    const reported: Error[] = []
    const console = globalThis.console
    const originalError = console.error
    console.error = () => undefined

    try {
      const renderer = await mount(
        createElement(ExpoTurbo, {
          fetch: failingTransport,
          onError: (error: Error) => reported.push(error),
          registry,
          url: DOCUMENT_URL,
        } as never),
      )

      // The diagnostic path stays open regardless of what was rendered.
      expect(reported).toHaveLength(1)
      expect(reported[0]?.name).toBe("RequestError")

      await act(async () => {
        renderer.unmount()
      })
    } finally {
      console.error = originalError
    }
  })

  test("never reaches a boundary that is present", async () => {
    CatchingBoundary.caught = undefined

    const renderer = await mount(
      createElement(
        CatchingBoundary,
        null,
        createElement(ExpoTurbo, {
          fetch: failingTransport,
          registry,
          renderError: (error: Error) => createElement("render-error", { message: error.message }),
          url: DOCUMENT_URL,
        }),
      ),
    )

    // Asserts the absence of the escalation route: a host that supplies a
    // surface owns presentation, and nothing may throw past it.
    expect(CatchingBoundary.caught).toBeUndefined()
    expect(renderer.toJSON()).toMatchObject({ type: "render-error" })

    await act(async () => {
      renderer.unmount()
    })
  })
})
