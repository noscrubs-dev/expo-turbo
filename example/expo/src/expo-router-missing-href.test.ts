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

function transport(urls: string[]) {
  return {
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
  }
}

function findByTestID(node: unknown, testID: string): Record<string, unknown> | undefined {
  if (!node || typeof node !== "object") return undefined
  const candidate = node as Record<string, unknown>
  if ((candidate.props as Record<string, unknown> | undefined)?.testID === testID) return candidate
  const children = candidate.children
  if (!Array.isArray(children)) return undefined
  for (const child of children) {
    const found = findByTestID(child, testID)
    if (found) return found
  }
  return undefined
}

test("refuses to infer a path rather than silently requesting the wrong document", async () => {
  const urls: string[] = []
  const reported: Error[] = []

  const renderer = await mount(
    createElement(ExpoTurboApp, {
      adapters: { fetch: transport(urls) },
      onError: (error: Error) => reported.push(error),
      origin: ORIGIN,
      registry,
    }),
  )

  // `/catalog/shoes?customer=42` and `/catalog/shoes` are different documents,
  // and without the private hook nothing here can tell a route that has no
  // query from one whose query it cannot see. Guessing would quietly serve the
  // wrong content, so no request is made at all.
  expect(urls).toEqual([])
  expect(findByTestID(renderer.toJSON(), "expo-turbo-error")).toBeDefined()
  expect(reported).toHaveLength(1)
  expect(reported[0]?.message).toContain("Pass an explicit `path`")

  await act(async () => {
    renderer.unmount()
  })
})

test("works normally on this same Expo Router once an explicit path is supplied", async () => {
  const urls: string[] = []
  const reported: Error[] = []

  const renderer = await mount(
    createElement(ExpoTurboApp, {
      adapters: { fetch: transport(urls) },
      onError: (error: Error) => reported.push(error),
      origin: ORIGIN,
      path: "/catalog/shoes?customer=42",
      registry,
    }),
  )

  // The documented remedy, and the proof that the refusal above is about the
  // missing hook rather than anything else being broken in this environment.
  expect(urls).toEqual([`${ORIGIN}/catalog/shoes?customer=42`])
  expect(renderer.toJSON()).toMatchObject({ type: "doc" })
  expect(reported).toEqual([])

  await act(async () => {
    renderer.unmount()
  })
})
