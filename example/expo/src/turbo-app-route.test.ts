/// <reference types="bun" />

import { expect, mock, test } from "bun:test"
import { EXPO_TURBO_MIME_TYPE } from "expo-turbo/core"
import { createElement, type ReactNode } from "react"
import { act, create, type ReactTestRenderer } from "react-test-renderer"

const globalWithAct = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean
}
globalWithAct.IS_REACT_ACT_ENVIRONMENT = true

const DOCUMENT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<DemoText>Rendered by the zero-configuration host.</DemoText>`

const requestedUrls: string[] = []
const originalFetch = globalThis.fetch

process.env.EXPO_PUBLIC_EXPO_TURBO_DEMO_ORIGIN = "https://rails.example.test"

mock.module("expo-router", () => ({
  usePathname: () => "/turbo-app",
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
  Alert: { alert: () => undefined },
  AppState: { addEventListener: () => ({ remove: () => undefined }), currentState: "active" },
  FlatList: (props: Readonly<Record<string, unknown>>) => createElement("flat-list", props),
  I18nManager: { isRTL: false },
  Linking: { openURL: async () => undefined },
  Platform: { OS: "web" },
  Pressable: (props: Readonly<Record<string, unknown>>) => createElement("pressable", props),
  ScrollView: (props: Readonly<Record<string, unknown>>) => createElement("scroll-view", props),
  Switch: (props: Readonly<Record<string, unknown>>) => createElement("switch", props),
  Text: (props: Readonly<Record<string, unknown>>) => createElement("native-text", props),
  TextInput: (props: Readonly<Record<string, unknown>>) => createElement("text-input", props),
  View: (props: Readonly<Record<string, unknown>>) => createElement("view", props),
}))

globalThis.fetch = (async (url: string | URL) => {
  const requested = String(url)
  requestedUrls.push(requested)
  const response = new Response(DOCUMENT_XML, {
    headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
    status: 200,
  })
  // A constructed Response reports an empty `url`; the document loader needs
  // the resolved one to match the visit it started.
  Object.defineProperty(response, "url", { value: requested })
  return response
}) as typeof globalThis.fetch

const { default: TurboAppRoute } = await import("./app/turbo-app")

const nextTurn = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

function containsText(node: unknown, text: string): boolean {
  if (typeof node === "string") return node.includes(text)
  if (!node || typeof node !== "object") return false
  const children = (node as Record<string, unknown>).children
  if (!Array.isArray(children)) return false
  return children.some((child) => containsText(child, text))
}

test("the example route renders a real document through ExpoTurboApp", async () => {
  requestedUrls.length = 0

  let renderer: ReactTestRenderer | undefined
  await act(async () => {
    renderer = create(createElement(TurboAppRoute as () => ReactNode, null))
  })
  await act(async () => {
    await nextTurn()
  })

  // The shipped route, its shipped registry, and the packaged default fetch
  // adapter — no test-only transport substituted anywhere in the path.
  expect(requestedUrls).toEqual(["https://rails.example.test/api/expo_turbo/demo/document"])
  expect(containsText(renderer?.toJSON(), "Rendered by the zero-configuration host.")).toBe(true)

  await act(async () => {
    renderer?.unmount()
  })

  globalThis.fetch = originalFetch
})
