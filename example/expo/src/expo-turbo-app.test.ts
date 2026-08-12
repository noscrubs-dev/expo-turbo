/// <reference types="bun" />

import { describe, expect, mock, test } from "bun:test"
import type { DocumentLinkAdapter, TurboResponse } from "expo-turbo/adapters"
import {
  DocumentStateScopes,
  DocumentStateStore,
  EXPO_TURBO_MIME_TYPE,
  TargetError,
} from "expo-turbo/core"
import type { ExpoTurboDocumentBoundaryProps } from "expo-turbo/react"
import { useExpoTurboDocumentLink } from "expo-turbo/react"
import {
  createRegistry,
  defineComponent,
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
const HostContext = createContext<string | undefined>(undefined)

function DocumentLink({ href }: Readonly<{ href: string; target?: string }>): ReactNode {
  activations.set(href, useExpoTurboDocumentLink(href))
  return createElement("link", { href })
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

  test("falls back to the pathname when the href hook yields nothing usable", async () => {
    routerPath = "/catalog/shoes"
    routerHref = ""
    const transport = stubTransport("<AppDoc />")

    const renderer = await mount(
      createElement(ExpoTurboApp, {
        adapters: { fetch: transport.fetch },
        origin: ORIGIN,
        registry,
      }),
    )

    expect(transport.urls).toEqual([`${ORIGIN}/catalog/shoes`])

    routerHref = undefined
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

  test("subscribes a Stream source and unsubscribes on unmount", async () => {
    routerPath = "/cable"
    const cable = recordingCable()
    const transport = stubTransport(CABLE_XML)

    const renderer = await mount(
      createElement(ExpoTurboApp, {
        adapters: { cable: cable.adapter, fetch: transport.fetch },
        origin: ORIGIN,
        registry,
      }),
    )

    expect(cable.identifiers).toHaveLength(1)
    expect(cable.identifiers[0]).toContain("ClientChannel")

    await act(async () => {
      renderer.unmount()
      await nextTurn()
    })
    // The runtime owns the registry, so its disposal releases the socket.
    expect(cable.unsubscribes).toBe(1)
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

  test("survives a same-registry remount the way Fast Refresh replays it", async () => {
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

    // One runtime per cycle, each disposed once, none disposed twice.
    expect(counts.scopes.length).toBeGreaterThanOrEqual(3)
    expect(counts.scopes.every((count) => count === 1)).toBe(true)
    expect(counts.state.every((count) => count === 1)).toBe(true)
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

    expect(counts.scopes.every((count) => count === 1)).toBe(true)
    expect(counts.state.every((count) => count === 1)).toBe(true)
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
