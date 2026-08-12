/// <reference types="bun" />

import { expect, mock, test } from "bun:test"
import { EXPO_TURBO_MIME_TYPE } from "expo-turbo/core"
import {
  createRegistry,
  defineComponent,
  defineComponentModule,
} from "expo-turbo/registry"
import { createElement, type ReactElement, type ReactNode } from "react"
import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { z } from "zod"

const globalWithAct = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean
}
globalWithAct.IS_REACT_ACT_ENVIRONMENT = true

/**
 * An Expo Router build with no `useUnstableGlobalHref` at all — the private
 * export renamed or removed. A static named import of it makes the whole
 * module a `SyntaxError`, which takes `expo-turbo/expo` down at import time and
 * never gives any runtime fallback a chance to run.
 *
 * Note what is absent here: no `useUnstableGlobalHref` key, of any value.
 */
mock.module("expo-router", () => ({
  usePathname: () => "/catalog/shoes",
  useRouter: () => ({
    back: () => undefined,
    canGoBack: () => true,
    push: () => undefined,
    replace: () => undefined,
  }),
}))

mock.module("react-native", () => ({
  AccessibilityInfo: { announceForAccessibility: () => undefined },
  ActivityIndicator: (props: Readonly<Record<string, unknown>>) =>
    createElement("activity-indicator", props),
  I18nManager: { isRTL: false },
  Linking: { openURL: async () => undefined },
  Pressable: (props: Readonly<Record<string, unknown>>) => createElement("pressable", props),
  Text: (props: Readonly<Record<string, unknown>>) => createElement("native-text", props),
  View: (props: Readonly<Record<string, unknown>>) => createElement("view", props),
}))

// Importing at all is half the assertion: this throws if the package binds the
// private hook statically.
const { ExpoTurboApp } = await import("expo-turbo/expo")

const ORIGIN = "https://shop.example.test"
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
        tag: "AppDoc",
      }),
    ],
    name: "expo-router-missing-href-fixtures",
    version: "1.0.0",
  }),
)

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

test("loads and falls back to the pathname when the private href hook is absent", async () => {
  const urls: string[] = []

  const renderer = await mount(
    createElement(ExpoTurboApp, {
      adapters: {
        fetch: {
          fetch: async (request: Readonly<{ url: string }>) => {
            urls.push(request.url)
            return {
              headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
              redirected: false,
              status: 200,
              text: async () => "<AppDoc />",
              url: request.url,
            }
          },
        },
      },
      origin: ORIGIN,
      registry,
    }),
  )

  // The app still works. It loses only the query the private hook would have
  // carried, which is the documented degradation.
  expect(urls).toEqual([`${ORIGIN}/catalog/shoes`])
  expect(renderer.toJSON()).toMatchObject({ type: "doc" })

  await act(async () => {
    renderer.unmount()
  })
})
