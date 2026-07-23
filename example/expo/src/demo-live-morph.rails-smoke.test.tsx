/// <reference types="bun" />

import { expect, mock, test } from "bun:test"
import { EXPO_TURBO_MIME_TYPE, nodeTextContent } from "expo-turbo/core"
import { createElement } from "react"
import { act, create, type ReactTestRenderer } from "react-test-renderer"

import { type DemoLiveFetchRequest, nativeDemoLiveFetch } from "./demo-live-transport"

interface PressableProps {
  readonly accessibilityLabel?: string
  readonly accessibilityRole?: string
  readonly onPress?: () => void
}

mock.module("react-native", () => ({
  AccessibilityInfo: { announceForAccessibility: () => undefined },
  Alert: { alert: () => undefined },
  FlatList: (props: Readonly<Record<string, unknown>>) => createElement("flat-list", props),
  Linking: { openURL: async () => undefined },
  Platform: { OS: "web" },
  Pressable: (props: PressableProps) => createElement("pressable", props),
  ScrollView: (props: Readonly<Record<string, unknown>>) => createElement("scroll-view", props),
  Text: (props: Readonly<Record<string, unknown>>) => createElement("native-text", props),
  TextInput: (props: Readonly<Record<string, unknown>>) => createElement("text-input", props),
  View: (props: Readonly<Record<string, unknown>>) => createElement("view", props),
}))

const { createDemoLiveMorphRuntime, DemoLiveMorphPanel } = await import("./demo-live-morph")
const origin = process.env.EXPO_TURBO_DEMO_ORIGIN
const liveTest = origin ? test : test.skip
const OUTER_FRAME_ID = "morph-outer"
const INNER_FRAME_ID = "morph-inner"
const OUTER_PATH = "/api/expo_turbo/demo/morph/outer"
const INNER_PATH = "/api/expo_turbo/demo/morph/inner"

const globalWithAct = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean
}
globalWithAct.IS_REACT_ACT_ENVIRONMENT = true

type RecordedRequest = Readonly<{ request: DemoLiveFetchRequest; url: string }>

liveTest("runs the Rails nested Frame morph cascade through the native renderer", async () => {
  if (!origin) throw new Error("EXPO_TURBO_DEMO_ORIGIN is required for the Rails morph smoke")

  const base = new URL(origin).origin
  const outerUrl = new URL(OUTER_PATH, base).toString()
  const innerUrl = new URL(INNER_PATH, base).toString()
  const requests: RecordedRequest[] = []
  const proof = createDemoLiveMorphRuntime({
    fetch: async (url, request) => {
      requests.push(Object.freeze({ request, url }))
      return nativeDemoLiveFetch(url, request)
    },
    origin,
  })
  const innerBefore = proof.session.tree.getElementById(INNER_FRAME_ID)
  if (innerBefore?.kind !== "frame") throw new Error("The nested morph Frame is missing")
  let renderer: ReactTestRenderer | undefined

  try {
    act(() => {
      renderer = create(createElement(DemoLiveMorphPanel, { proof }))
    })

    await act(async () => {
      await proof.reloadOuter()
      await proof.frames.get(INNER_FRAME_ID).loaded
    })

    expect(requests).toHaveLength(2)
    expect(requests[0]).toMatchObject({
      request: {
        headers: {
          Accept: EXPO_TURBO_MIME_TYPE,
          "Turbo-Frame": OUTER_FRAME_ID,
          "X-Turbo-Request-Id": "demo-live-morph-frame-1",
        },
        method: "GET",
      },
      url: outerUrl,
    })
    expect(requests[1]).toMatchObject({
      request: {
        headers: {
          Accept: EXPO_TURBO_MIME_TYPE,
          "Turbo-Frame": INNER_FRAME_ID,
          "X-Turbo-Request-Id": "demo-live-morph-frame-2",
        },
        method: "GET",
      },
      url: innerUrl,
    })
    expect(proof.session.tree.getElementById(INNER_FRAME_ID)).toBe(innerBefore)
    expect(nodeTextContent(innerBefore)).toContain("Inner Frame response")
    expect(JSON.stringify(renderer?.toJSON())).toContain("Outer Frame response")
    expect(JSON.stringify(renderer?.toJSON())).toContain("Inner Frame response")

    const outerVersion = proof.session.tree.getElementById("morph-outer-version")
    if (!outerVersion) throw new Error("The Rails outer morph response is missing")
    await act(async () => {
      await proof.visitOuterWithMorph()
      await proof.frames.get(INNER_FRAME_ID).loaded
    })

    expect(requests).toHaveLength(4)
    expect(requests[2]).toMatchObject({
      request: {
        headers: {
          Accept: EXPO_TURBO_MIME_TYPE,
          "Turbo-Frame": OUTER_FRAME_ID,
          "X-Turbo-Request-Id": "demo-live-morph-frame-3",
        },
        method: "GET",
      },
      url: outerUrl,
    })
    expect(requests[3]).toMatchObject({
      request: {
        headers: {
          Accept: EXPO_TURBO_MIME_TYPE,
          "Turbo-Frame": INNER_FRAME_ID,
          "X-Turbo-Request-Id": "demo-live-morph-frame-4",
        },
        method: "GET",
      },
      url: innerUrl,
    })
    expect(proof.session.tree.getElementById("morph-outer-version")).toBe(outerVersion)
    expect(proof.session.tree.getElementById(INNER_FRAME_ID)).toBe(innerBefore)
  } finally {
    await act(async () => {
      renderer?.unmount()
      await Promise.resolve()
    })
    proof.dispose()
  }
})
