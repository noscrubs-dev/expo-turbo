/// <reference types="bun" />

import { describe, expect, mock, test } from "bun:test"
import type { DocumentLinkAdapter, TurboRequest, TurboResponse } from "expo-turbo/adapters"
import {
  CableStreamSourceRegistry,
  DocumentStateScopes,
  DocumentStateStore,
  EXPO_TURBO_MIME_TYPE,
  EXPO_TURBO_RUNTIME_VERSION,
  type ExpoTurboError,
  type FormLinkSubmissionController,
  TargetError,
} from "expo-turbo/core"
import type { ExpoTurboDocumentBoundaryProps, ExpoTurboErrorReport } from "expo-turbo/react"
import {
  createExpoTurboRuntime,
  ExpoTurboProvider,
  ExpoTurboRoot,
  useComponentAction,
  useDocumentState,
  useExpoTurboDocumentLink,
} from "expo-turbo/react"
import {
  createComponentActionRegistry,
  createRegistry,
  defineComponent,
  defineComponentAction,
  defineComponentActionModule,
  defineComponentModule,
  presenceCodec,
  stringCodec,
} from "expo-turbo/registry"
import {
  Component,
  createContext,
  createElement,
  type ReactElement,
  type ReactNode,
  StrictMode,
  useContext,
} from "react"
import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { z } from "zod"

const globalWithAct = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean
  __DEV__?: boolean
}
globalWithAct.IS_REACT_ACT_ENVIRONMENT = true

const openedUrls: string[] = []
const announcements: string[] = []
let routerPath = "/catalog/shoes"
/** Set to override what `useUnstableGlobalHref` reports; defaults to routerPath. */
let routerHref: string | undefined
/** Set to make the packaged accessibility adapter fail, then clear it. */
let announceFailure: Error | undefined

mock.module("expo-router", () => ({
  usePathname: () => routerPath,
  useRouter: () => ({
    back: () => undefined,
    canGoBack: () => true,
    push: () => undefined,
    replace: () => undefined,
  }),
  useUnstableGlobalHref: () => routerHref ?? routerPath,
}))

mock.module("react-native", () => ({
  AccessibilityInfo: {
    announceForAccessibility: (message: string) => {
      announcements.push(message)
      if (announceFailure) throw announceFailure
    },
  },
  ActivityIndicator: (props: Readonly<Record<string, unknown>>) =>
    createElement("activity-indicator", props),
  I18nManager: { isRTL: false },
  Linking: {
    openURL: async (url: string) => {
      openedUrls.push(url)
      return undefined
    },
  },
  Pressable: (props: Readonly<Record<string, unknown>>) => createElement("pressable", props),
  Text: (props: Readonly<Record<string, unknown>>) => createElement("native-text", props),
  View: (props: Readonly<Record<string, unknown>>) => createElement("view", props),
}))

const { ExpoTurboApp } = await import("expo-turbo/expo")

const ORIGIN = "https://shop.example.test"
const nextTurn = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

const activations = new Map<string, () => Promise<unknown>>()
const appActionExecutions = new Map<string, () => Promise<string>>()
const HostContext = createContext<string | undefined>(undefined)

function DocumentLink({ href }: Readonly<{ href: string; target?: string }>): ReactNode {
  activations.set(href, useExpoTurboDocumentLink(href))
  return createElement("link", { href })
}

const appRecordAction = defineComponentAction({
  action: "record-app-value",
  handler: ({ params, state }) => {
    state.set("app-record", params.value)
    return params.value
  },
  schema: z.object({ value: z.string() }),
})

const appActions = createComponentActionRegistry(
  defineComponentActionModule({
    actions: [appRecordAction],
    name: "expo-turbo-app-actions",
    version: "1.0.0",
  }),
)

function AppActionTrigger(): ReactNode {
  const execute = useComponentAction(appRecordAction)
  const recorded = useDocumentState<string>("app-record")
  appActionExecutions.set("record", () => execute({ value: "from-expo-turbo-app" }))
  return createElement("app-action-trigger", { recorded: recorded.value })
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
        tag: "AppDoc",
      }),
      defineComponent({
        attributes: {
          download: { codec: presenceCodec, prop: "download" },
          href: { codec: stringCodec, prop: "href" },
          target: { codec: stringCodec, prop: "target" },
        },
        children: "none",
        component: DocumentLink,
        schema: z.object({
          download: z.boolean().default(false),
          href: z.string().trim().min(1),
          target: z.string().optional(),
        }),
        tag: "AppDocLink",
      }),
      defineComponent({
        attributes: {},
        children: "none",
        component: AppActionTrigger,
        schema: z.object({}),
        tag: "AppActionTrigger",
      }),
    ],
    name: "expo-turbo-app-fixtures",
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

interface StubTransport {
  readonly fetch: { fetch: (request: Readonly<{ url: string }>) => Promise<TurboResponse> }
  readonly urls: string[]
}

function stubTransport(xml: string): StubTransport {
  const urls: string[] = []
  return {
    fetch: {
      fetch: async (request: Readonly<{ url: string }>) => {
        urls.push(request.url)
        return xmlResponse(xml, request.url)
      },
    },
    urls,
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

function findByTestID(node: unknown, testID: string): Record<string, unknown> | undefined {
  if (!node || typeof node !== "object") return undefined
  const candidate = node as Record<string, unknown>
  const props = candidate.props as Record<string, unknown> | undefined
  if (props?.testID === testID) return candidate
  const children = candidate.children
  if (!Array.isArray(children)) return undefined
  for (const child of children) {
    const found = findByTestID(child, testID)
    if (found) return found
  }
  return undefined
}

function textOf(node: unknown): string {
  if (typeof node === "string") return node
  if (!node || typeof node !== "object") return ""
  const children = (node as Record<string, unknown>).children
  if (!Array.isArray(children)) return ""
  return children.map(textOf).join("")
}

describe("ExpoTurboApp zero-configuration entrypoint", () => {
  test("passes optional component actions into the high-level runtime", async () => {
    routerPath = "/catalog/actions"
    appActionExecutions.clear()
    const transport = stubTransport("<AppDoc><AppActionTrigger /></AppDoc>")

    const renderer = await mount(
      createElement(ExpoTurboApp, {
        actions: appActions,
        adapters: { fetch: transport.fetch },
        origin: ORIGIN,
        registry,
      }),
    )

    const execute = appActionExecutions.get("record")
    if (!execute) throw new Error("app action trigger did not register")
    await act(async () => {
      await expect(execute()).resolves.toBe("from-expo-turbo-app")
    })

    expect(
      renderer.root.find((node) => String(node.type) === "app-action-trigger").props.recorded,
    ).toBe("from-expo-turbo-app")

    await act(async () => {
      renderer.unmount()
    })
  })

  test("builds the document URL from origin and the mounted router path", async () => {
    routerPath = "/catalog/shoes"
    const transport = stubTransport("<AppDoc />")

    const renderer = await mount(
      createElement(ExpoTurboApp, {
        adapters: { fetch: transport.fetch },
        origin: ORIGIN,
        registry,
      }),
    )

    expect(transport.urls).toEqual([`${ORIGIN}/catalog/shoes`])
    expect(renderer.toJSON()).toMatchObject({ type: "doc" })

    await act(async () => {
      renderer.unmount()
    })
  })

  test("carries router search parameters into the document request", async () => {
    routerPath = "/catalog/shoes"
    routerHref = "/catalog/shoes?size=44&color=red#reviews"
    const transport = stubTransport("<AppDoc />")

    const renderer = await mount(
      createElement(ExpoTurboApp, {
        adapters: { fetch: transport.fetch },
        origin: ORIGIN,
        registry,
      }),
    )

    // Inferring from the pathname alone drops the query and silently requests
    // a different document than the one the route addresses.
    expect(transport.urls).toEqual([`${ORIGIN}/catalog/shoes?size=44&color=red#reviews`])

    routerHref = undefined
    await act(async () => {
      renderer.unmount()
    })
  })

  test("never lets a router-supplied hostname move the document origin", async () => {
    routerPath = "/catalog/shoes"
    // Expo Router documents that this private hook may start returning an
    // absolute URL. If it ever does, the document must still be fetched from
    // the origin the host declared.
    routerHref = "https://attacker.example/catalog/shoes?size=44"
    const transport = stubTransport("<AppDoc />")

    const renderer = await mount(
      createElement(ExpoTurboApp, {
        adapters: { fetch: transport.fetch },
        origin: ORIGIN,
        registry,
      }),
    )

    expect(transport.urls).toEqual([`${ORIGIN}/catalog/shoes?size=44`])
    expect(transport.urls[0]).not.toContain("attacker.example")

    routerHref = undefined
    await act(async () => {
      renderer.unmount()
    })
  })

  test("refuses rather than falling back when the href hook yields nothing usable", async () => {
    routerPath = "/catalog/shoes"
    routerHref = ""
    const transport = stubTransport("<AppDoc />")
    const reported: Error[] = []

    const renderer = await mount(
      createElement(ExpoTurboApp, {
        adapters: { fetch: transport.fetch },
        onError: (error: Error) => reported.push(error),
        origin: ORIGIN,
        registry,
      }),
    )

    // An unreadable href is not a licence to use the bare pathname: that turns
    // "I cannot read the path" into a confident request for a different
    // document, which is the failure refusing to infer exists to prevent.
    expect(transport.urls).toEqual([])
    expect(findByTestID(renderer.toJSON(), "expo-turbo-error")).toBeDefined()
    expect(reported[0]?.message).toContain("Pass an explicit `path`")

    routerHref = undefined
    await act(async () => {
      renderer.unmount()
    })
  })

  test("reports a missing transport instead of only showing it", async () => {
    routerPath = "/catalog/shoes"
    const reported: Error[] = []

    const renderer = await mount(
      createElement(ExpoTurboApp, {
        adapters: { fetch: null },
        onError: (error: Error) => reported.push(error),
        origin: ORIGIN,
        registry,
      }),
    )

    // A visible error the host's telemetry never hears about is the blank
    // screen again, just better dressed.
    expect(findByTestID(renderer.toJSON(), "expo-turbo-error")).toBeDefined()
    expect(reported).toHaveLength(1)
    expect(reported[0]?.message).toContain("fetch adapter")

    await act(async () => {
      renderer.unmount()
    })
  })

  test("prefers an explicit path over the router pathname", async () => {
    routerPath = "/ignored"
    const transport = stubTransport("<AppDoc />")

    const renderer = await mount(
      createElement(ExpoTurboApp, {
        adapters: { fetch: transport.fetch },
        origin: ORIGIN,
        path: "/orders?page=2",
        registry,
      }),
    )

    expect(transport.urls).toEqual([`${ORIGIN}/orders?page=2`])

    await act(async () => {
      renderer.unmount()
    })
  })
})

describe("ExpoTurboApp default surfaces", () => {
  test("shows a spinner instead of a blank screen while the document loads", async () => {
    routerPath = "/slow"
    let release: (() => void) | undefined
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })

    let renderer: ReactTestRenderer | undefined
    await act(async () => {
      renderer = create(
        createElement(ExpoTurboApp, {
          adapters: {
            fetch: {
              fetch: async (request: Readonly<{ url: string }>) => {
                await pending
                return xmlResponse("<AppDoc />", request.url)
              },
            },
          },
          origin: ORIGIN,
          registry,
        }),
      )
    })

    // Reverting the default returns `null` here, which is the blank screen the
    // 0.3 work exists to remove.
    const tree = renderer?.toJSON()
    expect(findByTestID(tree, "expo-turbo-loading")).toBeDefined()
    expect(tree).not.toBeNull()

    await act(async () => {
      release?.()
      await nextTurn()
    })
    expect(findByTestID(renderer?.toJSON(), "expo-turbo-loading")).toBeUndefined()

    await act(async () => {
      renderer?.unmount()
    })
  })

  test("shows a retryable error surface instead of a blank screen on failure", async () => {
    routerPath = "/broken"
    globalWithAct.__DEV__ = true
    let attempts = 0

    const renderer = await mount(
      createElement(ExpoTurboApp, {
        adapters: {
          fetch: {
            fetch: async (request: Readonly<{ url: string }>) => {
              attempts += 1
              if (attempts === 1) throw new Error("transport refused")
              return xmlResponse("<AppDoc />", request.url)
            },
          },
        },
        origin: ORIGIN,
        registry,
      }),
    )

    const surface = findByTestID(renderer.toJSON(), "expo-turbo-error")
    expect(surface).toBeDefined()
    // Development builds name the real error, because that is the only reader
    // who can act on it.
    expect(textOf(findByTestID(renderer.toJSON(), "expo-turbo-error-detail"))).toContain(
      "RequestError",
    )

    const retry = findByTestID(renderer.toJSON(), "expo-turbo-error-retry")
    const onPress = (retry?.props as Record<string, unknown> | undefined)?.onPress
    if (typeof onPress !== "function") throw new Error("the retry control has no press handler")
    await act(async () => {
      ;(onPress as () => void)()
      await nextTurn()
    })

    expect(attempts).toBe(2)
    expect(renderer.toJSON()).toMatchObject({ type: "doc" })

    globalWithAct.__DEV__ = undefined
    await act(async () => {
      renderer.unmount()
    })
  })

  test("keeps the text of a tag this build does not know inside the packaged primitive", async () => {
    // Issue #405: the version-skew case. The server knows `AppFutureText` and
    // ships it, this build does not, so tolerance unwraps it and its text
    // survives. Without a text primitive the renderer drops that run rather
    // than emit a bare string under a View, so the zero-configuration
    // entrypoint supplies one and the content stays on screen.
    routerPath = "/skew"
    const renderer = await mount(
      createElement(ExpoTurboApp, {
        adapters: { fetch: stubTransport("<AppDoc><AppFutureText>skewed</AppFutureText></AppDoc>").fetch },
        origin: ORIGIN,
        registry,
      }),
    )

    const wrapper = renderer.root.find((node) => String(node.type) === "native-text")
    expect(textOf(renderer.toJSON())).toBe("skewed")
    expect(wrapper.props.children).toBe("skewed")
    // Reverting the default drops the run: the text disappears entirely.
    expect(JSON.stringify(renderer.toJSON())).toContain("skewed")

    await act(async () => {
      renderer.unmount()
    })
  })

  test("lets a host replace the packaged text primitive", async () => {
    routerPath = "/skew-host"
    const renderer = await mount(
      createElement(ExpoTurboApp, {
        adapters: { fetch: stubTransport("<AppDoc><AppFutureText>skewed</AppFutureText></AppDoc>").fetch },
        boundaries: {
          text: ({ children }: Readonly<{ children?: ReactNode }>) =>
            createElement("host-text", null, children),
        },
        origin: ORIGIN,
        registry,
      }),
    )

    expect(renderer.root.findAll((node) => String(node.type) === "host-text")).toHaveLength(1)
    expect(renderer.root.findAll((node) => String(node.type) === "native-text")).toHaveLength(0)
    expect(textOf(renderer.toJSON())).toBe("skewed")

    await act(async () => {
      renderer.unmount()
    })
  })

  test("hides the raw error from release builds but still reports it", async () => {
    routerPath = "/broken"
    globalWithAct.__DEV__ = false
    const reported: Error[] = []

    const renderer = await mount(
      createElement(ExpoTurboApp, {
        adapters: {
          fetch: {
            fetch: async () => {
              throw new Error("transport refused")
            },
          },
        },
        onError: (error: Error) => reported.push(error),
        origin: ORIGIN,
        registry,
      }),
    )

    const detail = textOf(findByTestID(renderer.toJSON(), "expo-turbo-error-detail"))
    expect(detail).toBe("This screen could not be loaded.")
    expect(detail).not.toContain("RequestError")
    // The surface is quiet, but the host still receives the real error, so the
    // release path is not a silent one.
    expect(reported).toHaveLength(1)
    expect(reported[0]?.name).toBe("RequestError")

    globalWithAct.__DEV__ = undefined
    await act(async () => {
      renderer.unmount()
    })
  })
})

describe("ExpoTurboApp adapters escape hatch", () => {
  const LINK_XML = '<AppDoc><AppDocLink href="/promo" target="_blank" /></AppDoc>'

  test("absent uses the packaged default", async () => {
    routerPath = "/links"
    activations.clear()
    openedUrls.length = 0
    const transport = stubTransport(LINK_XML)

    const renderer = await mount(
      createElement(ExpoTurboApp, {
        adapters: { fetch: transport.fetch },
        origin: ORIGIN,
        registry,
      }),
    )

    const activate = activations.get("/promo")
    if (!activate) throw new Error("the fixture link never mounted")
    await act(async () => {
      await activate()
    })

    expect(openedUrls).toEqual([`${ORIGIN}/promo`])

    await act(async () => {
      renderer.unmount()
    })
  })

  test("an object overrides the packaged default", async () => {
    routerPath = "/links"
    activations.clear()
    openedUrls.length = 0
    const overridden: string[] = []
    const documentLinks: DocumentLinkAdapter = {
      download() {},
      openBrowsingContext(request: Readonly<{ url: string }>) {
        overridden.push(request.url)
      },
    }
    const transport = stubTransport(LINK_XML)

    const renderer = await mount(
      createElement(ExpoTurboApp, {
        adapters: { documentLinks, fetch: transport.fetch },
        origin: ORIGIN,
        registry,
      }),
    )

    const activate = activations.get("/promo")
    if (!activate) throw new Error("the fixture link never mounted")
    await act(async () => {
      await activate()
    })

    expect(overridden).toEqual([`${ORIGIN}/promo`])
    // Asserts the absence of a second route: the default must not also fire.
    expect(openedUrls).toEqual([])

    await act(async () => {
      renderer.unmount()
    })
  })

  test("null turns the key off and the default does not creep back", async () => {
    routerPath = "/links"
    activations.clear()
    openedUrls.length = 0
    const transport = stubTransport(LINK_XML)

    const renderer = await mount(
      createElement(ExpoTurboApp, {
        adapters: { documentLinks: null, fetch: transport.fetch },
        origin: ORIGIN,
        registry,
      }),
    )

    const activate = activations.get("/promo")
    if (!activate) throw new Error("the fixture link never mounted")
    await expect(activate()).rejects.toBeInstanceOf(TargetError)
    expect(openedUrls).toEqual([])

    await act(async () => {
      renderer.unmount()
    })
  })
})

describe("ExpoTurboApp cable adapter", () => {
  const CABLE_XML =
    '<AppDoc><turbo-cable-stream-source channel="ClientChannel" signed-stream-name="cart" /></AppDoc>'

  function recordingCable() {
    const identifiers: string[] = []
    let unsubscribes = 0
    return {
      adapter: {
        subscribe(identifier: string) {
          identifiers.push(identifier)
          return {
            unsubscribe() {
              unsubscribes += 1
            },
          }
        },
      },
      identifiers,
      get unsubscribes() {
        return unsubscribes
      },
    }
  }

  test("subscribes a Stream source and disposes the registry on unmount", async () => {
    routerPath = "/cable"
    const cable = recordingCable()
    const transport = stubTransport(CABLE_XML)

    // Unsubscribing alone does not prove the runtime disposed the registry:
    // releasing the mounted source node unsubscribes by itself, so that
    // assertion stays green even with `streamSources?.dispose()` deleted.
    // Count the registry's own disposal instead.
    const disposals = new Map<object, number>()
    const originalDispose = CableStreamSourceRegistry.prototype.dispose
    CableStreamSourceRegistry.prototype.dispose = function patched(this: object) {
      disposals.set(this, (disposals.get(this) ?? 0) + 1)
      return originalDispose.call(this)
    }

    try {
      const renderer = await mount(
        createElement(ExpoTurboApp, {
          adapters: { cable: cable.adapter, fetch: transport.fetch },
          origin: ORIGIN,
          registry,
        }),
      )

      expect(cable.identifiers).toHaveLength(1)
      expect(cable.identifiers[0]).toContain("ClientChannel")
      expect([...disposals.values()]).toEqual([])

      await act(async () => {
        renderer.unmount()
        await nextTurn()
      })

      expect([...disposals.values()]).toEqual([1])
      expect(cable.unsubscribes).toBe(1)
    } finally {
      CableStreamSourceRegistry.prototype.dispose = originalDispose
    }
  })

  test("does not subscribe when the key is absent or null", async () => {
    routerPath = "/cable"
    const absent = recordingCable()
    const off = recordingCable()

    const withoutKey = await mount(
      createElement(ExpoTurboApp, {
        adapters: { fetch: stubTransport(CABLE_XML).fetch },
        origin: ORIGIN,
        registry,
      }),
    )
    await act(async () => {
      withoutKey.unmount()
    })

    const withNull = await mount(
      createElement(ExpoTurboApp, {
        adapters: { cable: null, fetch: stubTransport(CABLE_XML).fetch },
        origin: ORIGIN,
        registry,
      }),
    )
    await act(async () => {
      withNull.unmount()
    })

    // Asserts the absence of a second route: no packaged default quietly
    // supplies a socket, in either state.
    expect(absent.identifiers).toEqual([])
    expect(off.identifiers).toEqual([])
  })
})

describe("ExpoTurboApp runtime disposal", () => {
  /**
   * Counts `dispose()` per instance on the two objects the runtime creates and
   * the provider also used to claim. `ExpoTurboApp` builds its runtime
   * internally, so instrumenting the prototypes is the only way to observe the
   * real path rather than a stand-in.
   */
  async function withDisposalCounts(
    run: () => Promise<void>,
  ): Promise<{ scopes: number[]; state: number[] }> {
    const scopeCounts = new Map<object, number>()
    const stateCounts = new Map<object, number>()
    const originalScopes = DocumentStateScopes.prototype.dispose
    const originalState = DocumentStateStore.prototype.dispose

    DocumentStateScopes.prototype.dispose = function patched(this: object) {
      scopeCounts.set(this, (scopeCounts.get(this) ?? 0) + 1)
      return originalScopes.call(this)
    }
    DocumentStateStore.prototype.dispose = function patched(this: object) {
      stateCounts.set(this, (stateCounts.get(this) ?? 0) + 1)
      return originalState.call(this)
    }

    try {
      await run()
    } finally {
      DocumentStateScopes.prototype.dispose = originalScopes
      DocumentStateStore.prototype.dispose = originalState
    }

    return { scopes: [...scopeCounts.values()], state: [...stateCounts.values()] }
  }

  test("disposes a real runtime's scopes and state exactly once", async () => {
    routerPath = "/disposal"
    const transport = stubTransport("<AppDoc />")

    const counts = await withDisposalCounts(async () => {
      const renderer = await mount(
        createElement(ExpoTurboApp, {
          adapters: { fetch: transport.fetch },
          origin: ORIGIN,
          registry,
        }),
      )
      await act(async () => {
        renderer.unmount()
        await nextTurn()
      })
    })

    // Two owners were calling dispose() on one object. That is harmless only
    // while both stay idempotent, which is not a property to depend on.
    expect(counts.scopes).toEqual([1])
    expect(counts.state).toEqual([1])
  })

  test("keeps two apps in one tree independent", async () => {
    routerPath = "/disposal"
    const first = stubTransport('<AppDoc><AppDocLink href="/first" /></AppDoc>')
    const second = stubTransport('<AppDoc><AppDocLink href="/second" /></AppDoc>')

    const counts = await withDisposalCounts(async () => {
      let renderer: ReactTestRenderer | undefined
      await act(async () => {
        renderer = create(
          createElement(
            "tree",
            null,
            createElement(ExpoTurboApp, {
              adapters: { fetch: first.fetch },
              key: "first",
              origin: ORIGIN,
              registry,
            }),
            createElement(ExpoTurboApp, {
              adapters: { fetch: second.fetch },
              key: "second",
              origin: ORIGIN,
              registry,
            }),
          ),
        )
      })
      await act(async () => {
        await nextTurn()
      })

      // Same registry, two runtimes, two documents.
      expect(first.urls).toHaveLength(1)
      expect(second.urls).toHaveLength(1)

      // Drop the first; the second must keep working, not inherit a disposed
      // store through the shared registry.
      await act(async () => {
        renderer?.update(
          createElement(
            "tree",
            null,
            createElement(ExpoTurboApp, {
              adapters: { fetch: second.fetch },
              key: "second",
              origin: ORIGIN,
              registry,
            }),
          ),
        )
        await nextTurn()
      })
      expect(JSON.stringify(renderer?.toJSON() ?? null)).toContain("/second")

      await act(async () => {
        renderer?.unmount()
        await nextTurn()
      })
    })

    expect(counts.scopes).toEqual([1, 1])
    expect(counts.state).toEqual([1, 1])
  })

  test("survives repeated mount and unmount cycles against one registry", async () => {
    routerPath = "/disposal"
    const transport = stubTransport("<AppDoc />")

    const counts = await withDisposalCounts(async () => {
      for (let cycle = 0; cycle < 3; cycle += 1) {
        const renderer = await mount(
          createElement(ExpoTurboApp, {
            adapters: { fetch: transport.fetch },
            origin: ORIGIN,
            registry,
          }),
        )
        expect(renderer.toJSON()).toMatchObject({ type: "doc" })
        await act(async () => {
          renderer.unmount()
          await nextTurn()
        })
      }
    })

    // One runtime per cycle, each disposed exactly once. These are separate
    // commits, not a same-commit refresh; that window is covered below.
    expect(counts.scopes).toEqual([1, 1, 1])
    expect(counts.state).toEqual([1, 1, 1])
  })

  test("survives a StrictMode double mount", async () => {
    routerPath = "/disposal"
    const transport = stubTransport("<AppDoc />")

    const counts = await withDisposalCounts(async () => {
      const renderer = await mount(
        createElement(
          StrictMode,
          null,
          createElement(ExpoTurboApp, {
            adapters: { fetch: transport.fetch },
            origin: ORIGIN,
            registry,
          }),
        ),
      )
      expect(renderer.toJSON()).toMatchObject({ type: "doc" })
      await act(async () => {
        renderer.unmount()
        await nextTurn()
      })
    })

    // StrictMode's double invocation builds two runtimes. Assert the exact
    // shape: `every()` alone is satisfied by an empty array, so it would pass
    // even if the instrumentation observed nothing at all.
    expect(counts.scopes).toEqual([1, 1])
    expect(counts.state).toEqual([1, 1])
  })

  test("hands over rather than tearing down across a same-commit remount", async () => {
    routerPath = "/disposal"
    const transport = stubTransport("<AppDoc />")

    const counts = await withDisposalCounts(async () => {
      const app = (generation: number) =>
        createElement(ExpoTurboApp, {
          adapters: { fetch: transport.fetch },
          // A changed key unmounts and remounts within a single commit, which
          // is the window Fast Refresh and a route swap both go through.
          key: `generation-${generation}`,
          origin: ORIGIN,
          registry,
        })

      const renderer = await mount(app(0))
      expect(renderer.toJSON()).toMatchObject({ type: "doc" })

      await act(async () => {
        renderer.update(app(1))
      })
      await act(async () => {
        await nextTurn()
      })

      // The replacement is live, not holding a disposed store.
      expect(renderer.toJSON()).toMatchObject({ type: "doc" })
      expect(transport.urls).toHaveLength(2)

      await act(async () => {
        renderer.unmount()
        await nextTurn()
      })
    })

    expect(counts.scopes).toEqual([1, 1])
    expect(counts.state).toEqual([1, 1])
  })
})

describe("ExpoTurboApp boundary containment", () => {
  function HostAwareDocumentBoundary({ children }: ExpoTurboDocumentBoundaryProps): ReactNode {
    const hostValue = useContext(HostContext)
    if (!hostValue) {
      throw new Error("the host context was not an ancestor of the document boundary")
    }
    return createElement("doc-boundary", { hostValue }, children)
  }

  test("keeps host contexts above boundary components mounted inside the document", async () => {
    routerPath = "/contained"
    CatchingBoundary.caught = undefined
    const transport = stubTransport("<AppDoc />")

    const renderer = await mount(
      createElement(
        CatchingBoundary,
        null,
        createElement(
          HostContext.Provider,
          { value: "host-owned" },
          createElement(ExpoTurboApp, {
            adapters: { fetch: transport.fetch },
            boundaries: { document: HostAwareDocumentBoundary },
            origin: ORIGIN,
            registry,
          }),
        ),
      ),
    )

    // Boundary components are props, so they render below the renderer's
    // provider while reading contexts the host mounted above it. The library
    // must not insert a provider that breaks that containment.
    expect(CatchingBoundary.caught).toBeUndefined()
    expect(renderer.toJSON()).toMatchObject({
      props: { hostValue: "host-owned" },
      type: "doc-boundary",
    })

    await act(async () => {
      renderer.unmount()
    })
  })

  test("has no second route to the host value when the provider is absent", async () => {
    routerPath = "/contained"
    const reported: Error[] = []
    const transport = stubTransport("<AppDoc />")

    // The identical tree without the host provider. If the boundary could read
    // "host-owned" from anywhere else, the test above would not be pinning
    // containment at all. The renderer contains node-level throws in its own
    // boundary and republishes them through onError, so that is where the
    // failure lands.
    const renderer = await mount(
      createElement(ExpoTurboApp, {
        adapters: { fetch: transport.fetch },
        boundaries: { document: HostAwareDocumentBoundary },
        onError: (error: Error) => reported.push(error),
        origin: ORIGIN,
        registry,
      }),
    )

    expect(reported.map((error) => error.message)).toContain(
      "the host context was not an ancestor of the document boundary",
    )
    expect(JSON.stringify(renderer.toJSON() ?? null)).not.toContain("host-owned")

    await act(async () => {
      renderer.unmount()
    })
  })
})

describe("ExpoTurboApp generated form links", () => {
  // What `link_to "Delete", path, data: { turbo_method: :delete }` renders.
  const DELETE_XML =
    '<AppDoc><AppDocLink href="/danger?field=A" data-turbo-method="delete" /></AppDoc>'

  interface SubmittingTransport {
    readonly fetch: { fetch: (request: TurboRequest) => Promise<TurboResponse> }
    readonly requests: TurboRequest[]
  }

  /**
   * Records whole requests, not just URLs, and answers unsafe methods with a
   * redirect the way Turbo requires of a document-level form response.
   */
  function submittingTransport(xml: string): SubmittingTransport {
    const requests: TurboRequest[] = []
    return {
      fetch: {
        fetch: async (request: TurboRequest) => {
          requests.push(request)
          return {
            headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
            redirected: request.method !== "GET",
            status: 200,
            text: async () => xml,
            url: request.url,
          }
        },
      },
      requests,
    }
  }

  test("activates a data-turbo-method link the host never configured", async () => {
    routerPath = "/catalog"
    activations.clear()
    openedUrls.length = 0
    const reported: Error[] = []
    const surfaced: Error[] = []
    const transport = submittingTransport(DELETE_XML)

    const renderer = await mount(
      createElement(ExpoTurboApp, {
        adapters: { fetch: transport.fetch },
        onError: (error: Error) => reported.push(error),
        origin: ORIGIN,
        registry,
        renderError: (error: Error) => {
          surfaced.push(error)
          return null
        },
      }),
    )

    const activate = activations.get("/danger?field=A")
    if (!activate) throw new Error("the fixture link never mounted")
    await act(async () => {
      await activate()
      await nextTurn()
    })

    // Issue #428: before the runtime built and handed over a form-link
    // controller this threw TargetError("Generated form links require provider
    // form-link submissions"), reached neither error channel, and sent nothing.
    expect(transport.requests).toHaveLength(2)
    const submission = transport.requests[1]
    // The Rails delete button sends DELETE directly, not a POST carrying
    // `_method`: a generated form link uses the exact declared method.
    expect(submission?.method).toBe("DELETE")
    expect(submission?.url).toBe(`${ORIGIN}/danger`)
    expect(submission?.body?.value).toBe("field=A")
    expect(reported).toEqual([])
    expect(surfaced).toEqual([])
    // The link is a submission, not a browsing-context hand-off.
    expect(openedUrls).toEqual([])

    await act(async () => {
      renderer.unmount()
    })
  })

  test("keeps a hand-composed provider on the form-link controller it supplied", async () => {
    routerPath = "/catalog"
    activations.clear()
    const transport = submittingTransport(DELETE_XML)
    const hostSubmissions: Readonly<{ href: string; nodeKey: string }>[] = []
    const hostFormLinks = {
      shouldInterceptSubmission: () => true,
      submissionInterception: () => ({ intercept: true }),
      submit: async (nodeKey: string, href: string) => {
        hostSubmissions.push({ href, nodeKey })
        return { status: "applied" }
      },
    } as unknown as FormLinkSubmissionController
    const runtime = createExpoTurboRuntime({
      fetch: transport.fetch,
      registry,
      url: `${ORIGIN}/catalog`,
    })
    await runtime.load()

    const renderer = await mount(
      createElement(
        ExpoTurboProvider,
        {
          documentController: runtime.controller,
          formLinks: hostFormLinks,
          forms: runtime.forms,
          frames: runtime.frames,
          ownsStateDisposal: false,
          registry,
          scopes: runtime.scopes,
          session: runtime.session,
          state: runtime.state,
        },
        createElement(ExpoTurboRoot),
      ),
    )

    const activate = activations.get("/danger?field=A")
    if (!activate) throw new Error("the fixture link never mounted")
    await act(async () => {
      await activate()
      await nextTurn()
    })

    // The advanced path is unchanged: the host's controller is the one that
    // runs, and the runtime's own controller never shadows it.
    expect(hostSubmissions).toHaveLength(1)
    expect(hostSubmissions[0]?.href).toBe("/danger?field=A")
    expect(hostSubmissions[0]?.nodeKey).toBeTruthy()
    expect(transport.requests.map((request) => request.method)).toEqual(["GET"])

    await act(async () => {
      renderer.unmount()
    })
    runtime.dispose()
  })

  test("does not slip a form-link controller into a hand-composed provider", async () => {
    routerPath = "/catalog"
    activations.clear()
    const transport = submittingTransport(DELETE_XML)
    const runtime = createExpoTurboRuntime({
      fetch: transport.fetch,
      registry,
      url: `${ORIGIN}/catalog`,
    })
    await runtime.load()

    const renderer = await mount(
      createElement(
        ExpoTurboProvider,
        {
          documentController: runtime.controller,
          forms: runtime.forms,
          frames: runtime.frames,
          ownsStateDisposal: false,
          registry,
          scopes: runtime.scopes,
          session: runtime.session,
          state: runtime.state,
        },
        createElement(ExpoTurboRoot),
      ),
    )

    const activate = activations.get("/danger?field=A")
    if (!activate) throw new Error("the fixture link never mounted")

    // A host that composed the provider by hand and passed no `formLinks` keeps
    // exactly today's behaviour. Quietly gaining a controller here would change
    // what an existing host's link does without that host asking for it.
    await expect(activate()).rejects.toBeInstanceOf(TargetError)
    expect(transport.requests.map((request) => request.method)).toEqual(["GET"])

    await act(async () => {
      renderer.unmount()
    })
    runtime.dispose()
  })

  test("never disposes a form-link controller the host supplied itself", async () => {
    routerPath = "/catalog"
    activations.clear()
    const transport = submittingTransport(DELETE_XML)
    let hostDisposals = 0
    let hostSubmissions = 0
    const hostFormLinks = {
      dispose: () => {
        hostDisposals += 1
      },
      shouldInterceptSubmission: () => true,
      submissionInterception: () => ({ intercept: true }),
      submit: async () => {
        hostSubmissions += 1
        return { status: "applied" }
      },
    } as unknown as FormLinkSubmissionController
    const runtime = createExpoTurboRuntime({
      fetch: transport.fetch,
      registry,
      url: `${ORIGIN}/catalog`,
    })
    await runtime.load()

    const renderer = await mount(
      createElement(
        ExpoTurboProvider,
        {
          documentController: runtime.controller,
          formLinks: hostFormLinks,
          forms: runtime.forms,
          frames: runtime.frames,
          ownsStateDisposal: false,
          registry,
          scopes: runtime.scopes,
          session: runtime.session,
          state: runtime.state,
        },
        createElement(ExpoTurboRoot),
      ),
    )

    const activate = activations.get("/danger?field=A")
    if (!activate) throw new Error("the fixture link never mounted")
    await act(async () => {
      await activate()
      await nextTurn()
    })
    // The host's object is live inside the provider, not an unreachable stub.
    // That is what gives the disposal count below its teeth.
    expect(hostSubmissions).toBe(1)

    await act(async () => {
      renderer.unmount()
    })
    runtime.dispose()

    // The runtime disposes only what the runtime constructed. Disposing a
    // caller's object is worse than leaking your own: the host may still be
    // using it on another screen.
    expect(hostDisposals).toBe(0)
    expect(runtime.formLinks.isDisposed).toBe(true)
    expect(runtime.formLinks).not.toBe(hostFormLinks)
  })
})

describe("ExpoTurboApp failure severity", () => {
  const LINKED_XML = '<AppDoc><AppDocLink href="/catalog/boots" /></AppDoc>'

  /** Per-subscription state, because a document swap legitimately retires one. */
  function trackingCable() {
    const subscriptions: { identifier: string; live: boolean }[] = []
    return {
      adapter: {
        subscribe(identifier: string) {
          const record = { identifier, live: true }
          subscriptions.push(record)
          return {
            unsubscribe() {
              record.live = false
            },
          }
        },
      },
      get live() {
        return subscriptions.filter((entry) => entry.live).length
      },
      subscriptions,
    }
  }

  /**
   * Drives a real navigation whose accessibility announcement fails. The visit
   * itself succeeds: the failure is an accessory to a render that worked, which
   * is exactly the case issue #435 says must not replace the screen.
   */
  async function navigateWithFailingAnnouncement(
    adapters: Record<string, unknown>,
    reported: [Error, ExpoTurboErrorReport][],
  ) {
    routerPath = "/catalog"
    announcements.length = 0
    activations.clear()
    const renderer = await mount(
      createElement(ExpoTurboApp, {
        adapters,
        onError: (error: Error, report: ExpoTurboErrorReport) => reported.push([error, report]),
        origin: ORIGIN,
        registry,
      }),
    )
    expect(findByTestID(renderer.toJSON(), "expo-turbo-error")).toBeUndefined()
    const activate = activations.get("/catalog/boots")
    if (!activate) throw new Error("the fixture link never mounted")
    announceFailure = new Error("private announcement failure")
    let result: unknown
    await act(async () => {
      result = await activate()
    })
    await act(async () => {
      await nextTurn()
    })
    announceFailure = undefined
    return { renderer, result }
  }

  test("reports a failed announcement without replacing the healthy document", async () => {
    // Reverted, this navigation succeeds and the app shows "Something went
    // wrong" anyway, because every renderer error was escalated to fatal.
    const transport = stubTransport(LINKED_XML)
    const reported: [Error, ExpoTurboErrorReport][] = []
    const { renderer, result } = await navigateWithFailingAnnouncement(
      { fetch: transport.fetch },
      reported,
    )

    // The navigation the user asked for completed, and the adapter really was
    // called and really threw. Without these three the assertions below would
    // hold on a fixture where nothing happened at all.
    expect(result).toMatchObject({ status: "committed" })
    expect(transport.urls).toContain(`${ORIGIN}/catalog/boots`)
    expect(announcements.length).toBeGreaterThan(0)
    expect(reported.length).toBeGreaterThan(0)
    expect(reported[0]?.[0].message).toBe("private announcement failure")

    // Reported as background, and the document is still on screen.
    expect(new Set(reported.map(([, report]) => report.severity))).toEqual(new Set(["background"]))
    expect(reported[0]?.[1].nodeKey).toBeDefined()
    expect(findByTestID(renderer.toJSON(), "expo-turbo-error")).toBeUndefined()
    expect(JSON.stringify(renderer.toJSON())).toContain("doc")

    await act(async () => {
      renderer.unmount()
    })
  })

  test("keeps a live Cable subscription when a background failure is reported", async () => {
    // The severest part of #435: escalating a background failure unmounts the
    // provider, and that unmount releases every Stream-source subscription.
    // Reverted, `live` is 0 here and the screen is the error card.
    const cable = trackingCable()
    const transport = stubTransport(
      '<AppDoc><turbo-cable-stream-source channel="ClientChannel" signed-stream-name="cart" /><AppDocLink href="/catalog/boots" /></AppDoc>',
    )
    const reported: [Error, ExpoTurboErrorReport][] = []
    const { renderer } = await navigateWithFailingAnnouncement(
      { cable: cable.adapter, fetch: transport.fetch },
      reported,
    )

    // The transport really served a Stream source, and the failure really
    // happened: neither half of the claim below rests on nothing.
    expect(cable.subscriptions.length).toBeGreaterThan(0)
    expect(cable.subscriptions[0]?.identifier).toContain("ClientChannel")
    expect(reported.length).toBeGreaterThan(0)
    expect(reported[0]?.[1].severity).toBe("background")
    // A subscription is still live and the document is still on screen.
    expect(cable.live).toBeGreaterThan(0)
    expect(findByTestID(renderer.toJSON(), "expo-turbo-error")).toBeUndefined()

    await act(async () => {
      renderer.unmount()
      await nextTurn()
    })
    // Unmounting the host still releases them, so `live` above is not a
    // subscription the runtime simply never lets go of.
    expect(cable.live).toBe(0)
  })

  test("still replaces the document when the document itself fails", async () => {
    // The control for the two tests above: without it they would both pass on a
    // host that had simply stopped escalating everything.
    routerPath = "/catalog"
    const reported: [Error, ExpoTurboErrorReport][] = []
    const renderer = await mount(
      createElement(ExpoTurboApp, {
        adapters: {
          fetch: {
            fetch: async () => {
              throw new TargetError("private transport failure")
            },
          },
        },
        onError: (error: Error, report: ExpoTurboErrorReport) => reported.push([error, report]),
        origin: ORIGIN,
        registry,
      }),
    )

    expect(reported).toHaveLength(1)
    expect(reported[0]?.[1].severity).toBe("document")
    expect(findByTestID(renderer.toJSON(), "expo-turbo-error")).toBeDefined()

    await act(async () => {
      renderer.unmount()
    })
  })

  test("hands the adopter the node key, the severity and the blank interval", async () => {
    // Issue #436, item 5. Reverted, this handler is called with one argument
    // and the tracker receives a fixed string and nothing else.
    routerPath = "/catalog"
    const reported: [Error, ExpoTurboErrorReport][] = []
    const renderer = await mount(
      createElement(ExpoTurboApp, {
        adapters: { fetch: stubTransport("<FutureRoot><FutureThing /></FutureRoot>").fetch },
        onError: (error: Error, report: ExpoTurboErrorReport) => reported.push([error, report]),
        origin: ORIGIN,
        registry,
      }),
    )

    // The document really did go blank, which the surface proves.
    expect(findByTestID(renderer.toJSON(), "expo-turbo-error")).toBeDefined()
    expect(reported).toHaveLength(1)
    const [error, report] = reported[0] ?? []
    expect(error?.message).toBe("Expo Turbo document root has no renderable fallback")
    expect(report?.severity).toBe("document")
    expect(report?.nodeKey).toBeDefined()
    expect(report?.blank).toMatchObject({
      attempt: 1,
      documentUrl: `${ORIGIN}/catalog`,
      runtimeVersion: EXPO_TURBO_RUNTIME_VERSION,
    })
    // The same two facts ride on the bare error, for a host that forwards only
    // the first argument.
    expect((error as ExpoTurboError | undefined)?.context).toMatchObject({
      documentUrl: `${ORIGIN}/catalog`,
      runtimeVersion: EXPO_TURBO_RUNTIME_VERSION,
    })

    await act(async () => {
      renderer.unmount()
    })
  })
})
