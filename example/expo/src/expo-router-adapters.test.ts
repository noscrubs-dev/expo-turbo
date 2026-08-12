/// <reference types="bun" />

import { describe, expect, mock, test } from "bun:test"
import type { DocumentHistoryHostAdapter, NavigationAdapter, TurboResponse } from "expo-turbo/adapters"
import { EXPO_TURBO_MIME_TYPE } from "expo-turbo/core"
import { ExpoTurbo } from "expo-turbo/react"
import {
  createRegistry,
  defineComponent,
  defineComponentModule,
} from "expo-turbo/registry"
import { createElement, type ReactNode, useState } from "react"
import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { z } from "zod"

const globalWithAct = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean
}
globalWithAct.IS_REACT_ACT_ENVIRONMENT = true

type RouterCall = Readonly<{ href: unknown; method: string }>

const routerCalls: RouterCall[] = []
const router = {
  back() {
    routerCalls.push({ href: undefined, method: "back" })
  },
  canGoBack: () => true,
  push(href: unknown) {
    routerCalls.push({ href, method: "push" })
  },
  replace(href: unknown) {
    routerCalls.push({ href, method: "replace" })
  },
}

// The bridge module imports both hooks, so the mock must cover both or the
// named import fails to link.
mock.module("expo-router", () => ({
  usePathname: () => "/document",
  useRouter: () => router,
}))

const { useExpoRouterAdapters } = await import("expo-turbo/expo-router")

const DOCUMENT_URL = "https://example.test/document"
const nextTurn = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

const registry = createRegistry(
  defineComponentModule({
    components: [
      defineComponent({
        attributes: {},
        children: "nodes",
        component: (props: Readonly<{ children?: ReactNode }>) =>
          createElement("doc", null, props.children),
        schema: z.object({}),
        tag: "RouterDoc",
      }),
    ],
    name: "expo-router-adapter-fixtures",
    version: "1.0.0",
  }),
)

function xmlResponse(url: string): TurboResponse {
  return {
    headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
    redirected: false,
    status: 200,
    text: async () => "<RouterDoc />",
    url,
  }
}

interface RenderSample {
  readonly history: DocumentHistoryHostAdapter
  readonly navigation: NavigationAdapter
  /** The caller's inline closure, captured as it was on that exact render. */
  readonly suppliedOpenExternal: (url: string) => unknown
}

describe("useExpoRouterAdapters identity", () => {
  test("survives the documented inline-arrow options across re-renders", async () => {
    const samples: RenderSample[] = []
    const external: string[] = []
    let rerender: (() => void) | undefined

    function Host(): ReactNode {
      const [, setTick] = useState(0)
      rerender = () => setTick((value) => value + 1)
      // Exactly the snippet the getting-started guide documents: a fresh
      // closure on every render.
      const suppliedOpenExternal = (url: string) => {
        external.push(url)
        return undefined
      }
      const { history, navigation } = useExpoRouterAdapters({
        openExternal: suppliedOpenExternal,
      })
      samples.push({ history, navigation, suppliedOpenExternal })
      return createElement("host", null)
    }

    let renderer: ReactTestRenderer | undefined
    await act(async () => {
      renderer = create(createElement(Host, null))
    })
    for (let index = 0; index < 3; index += 1) {
      await act(async () => {
        rerender?.()
      })
    }

    expect(samples.length).toBeGreaterThanOrEqual(4)
    const [first, ...rest] = samples
    if (!first) throw new Error("the fixture never rendered")

    // Assert the absence of the second route that would make this test pass for
    // the wrong reason: if the React Compiler (the example app enables it) or
    // any other memoization had hoisted the caller's closure, the adapters
    // would be stable no matter what the hook does. They must NOT be stable.
    for (const sample of rest) {
      expect(sample.suppliedOpenExternal).not.toBe(first.suppliedOpenExternal)
    }

    // With unstable caller closures, the adapters must still be one identity.
    for (const sample of rest) {
      expect(sample.navigation).toBe(first.navigation)
      expect(sample.history).toBe(first.history)
    }

    await act(async () => {
      renderer?.unmount()
    })
  })

  test("routes external navigation through the newest inline handler", async () => {
    const calls: string[] = []
    let rerender: (() => void) | undefined
    let navigation: NavigationAdapter | undefined

    function Host({ generation }: Readonly<{ generation: number }>): ReactNode {
      const adapters = useExpoRouterAdapters({
        openExternal: (url: string) => {
          calls.push(`${generation}:${url}`)
          return undefined
        },
      })
      navigation = adapters.navigation
      return createElement("host", null)
    }

    function Wrapper(): ReactNode {
      const [generation, setGeneration] = useState(0)
      rerender = () => setGeneration((value) => value + 1)
      return createElement(Host, { generation })
    }

    let renderer: ReactTestRenderer | undefined
    await act(async () => {
      renderer = create(createElement(Wrapper, null))
    })
    await act(async () => {
      await navigation?.openExternal("mailto:first@example.test")
    })
    await act(async () => {
      rerender?.()
    })
    await act(async () => {
      await navigation?.openExternal("mailto:second@example.test")
    })

    // A stale-closure regression would record "0:mailto:second@example.test".
    expect(calls).toEqual(["0:mailto:first@example.test", "1:mailto:second@example.test"])

    await act(async () => {
      renderer?.unmount()
    })
  })

  test("keeps the router-push fallback when openExternal is omitted", async () => {
    routerCalls.length = 0
    let navigation: NavigationAdapter | undefined

    function Host(): ReactNode {
      navigation = useExpoRouterAdapters().navigation
      return createElement("host", null)
    }

    let renderer: ReactTestRenderer | undefined
    await act(async () => {
      renderer = create(createElement(Host, null))
    })
    await act(async () => {
      await navigation?.openExternal("https://elsewhere.test/page")
    })

    // Omitting the handler must still mean "push the absolute URL", not "call a
    // handler that is not there".
    expect(routerCalls).toEqual([{ href: "https://elsewhere.test/page", method: "push" }])

    await act(async () => {
      renderer?.unmount()
    })
  })
})

describe("ExpoTurbo with Expo Router adapters", () => {
  test("loads the document once across re-renders of the documented snippet", async () => {
    let documentRequests = 0
    let rerender: (() => void) | undefined
    // Hoisted so adapter identity is the only variable under test: `fetch`,
    // `registry`, and `url` are runtime-defining inputs too, and an inline one
    // would rebuild the runtime for a reason that has nothing to do with #403.
    const documentFetch = {
      fetch: async (request: Readonly<{ url: string }>) => {
        documentRequests += 1
        return xmlResponse(request.url)
      },
    }

    function DocumentScreen(): ReactNode {
      const [, setTick] = useState(0)
      rerender = () => setTick((value) => value + 1)
      const { history, navigation } = useExpoRouterAdapters({
        openExternal: (url: string) => {
          void url
          return undefined
        },
      })

      return createElement(ExpoTurbo, {
        fetch: documentFetch,
        history,
        navigation,
        registry,
        renderError: (error: Error) => createElement("render-error", { message: error.message }),
        url: DOCUMENT_URL,
      })
    }

    let renderer: ReactTestRenderer | undefined
    await act(async () => {
      renderer = create(createElement(DocumentScreen, null))
    })
    await act(async () => {
      await nextTurn()
    })
    const afterLoad = documentRequests

    for (let index = 0; index < 4; index += 1) {
      await act(async () => {
        rerender?.()
      })
      await act(async () => {
        await nextTurn()
      })
    }

    // Unstable adapter identity replaces the runtime on every render, which
    // refetches without bound and leaves a permanently blank screen.
    expect(afterLoad).toBe(1)
    expect(documentRequests).toBe(1)
    expect(renderer?.toJSON()).toMatchObject({ type: "doc" })

    await act(async () => {
      renderer?.unmount()
    })
  })
})
