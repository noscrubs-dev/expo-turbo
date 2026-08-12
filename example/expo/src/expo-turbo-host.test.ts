/// <reference types="bun" />

import { describe, expect, test } from "bun:test"
import type { NavigationAdapter, TurboResponse, VisitAction } from "expo-turbo/adapters"
import { EXPO_TURBO_MIME_TYPE, TargetError } from "expo-turbo/core"
import { ExpoTurbo, useExpoTurboDisposable, useExpoTurboDocumentLink } from "expo-turbo/react"
import {
  createRegistry,
  defineComponent,
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

function DocumentLink({ href }: Readonly<{ href: string }>): ReactNode {
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
        tag: "HostDoc",
      }),
      defineComponent({
        attributes: { href: { codec: stringCodec, prop: "href" } },
        children: "none",
        component: DocumentLink,
        schema: z.object({ href: z.string().trim().min(1) }),
        tag: "HostDocLink",
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

describe("ExpoTurbo default error surface", () => {
  test("surfaces a load failure to the host error boundary when renderError is absent", async () => {
    CatchingBoundary.caught = undefined
    const failure = new Error("document transport refused")

    const renderer = await mount(
      createElement(
        CatchingBoundary,
        null,
        createElement(ExpoTurbo, {
          fetch: {
            fetch: async () => {
              throw failure
            },
          },
          registry,
          url: DOCUMENT_URL,
        }),
      ),
    )

    // Reverting the default makes this branch return `null`: the boundary never
    // renders, `caught` stays undefined, and the tree is an empty screen.
    expect(CatchingBoundary.caught).toBeInstanceOf(Error)
    expect(renderer.toJSON()).toMatchObject({ type: "boundary-caught" })

    await act(async () => {
      renderer.unmount()
    })
  })

  test("keeps an explicit renderError in charge and never reaches the boundary", async () => {
    CatchingBoundary.caught = undefined

    const renderer = await mount(
      createElement(
        CatchingBoundary,
        null,
        createElement(ExpoTurbo, {
          fetch: {
            fetch: async () => {
              throw new Error("document transport refused")
            },
          },
          registry,
          renderError: (error: Error) => createElement("render-error", { message: error.message }),
          url: DOCUMENT_URL,
        }),
      ),
    )

    // The opt-out path: a host that supplies a surface owns presentation, and
    // the throw must not fire behind its back. The transport redacts the
    // original cause, so the surface receives the package's own message.
    expect(CatchingBoundary.caught).toBeUndefined()
    expect(renderer.toJSON()).toMatchObject({
      props: { message: "Document request failed" },
      type: "render-error",
    })

    await act(async () => {
      renderer.unmount()
    })
  })
})
