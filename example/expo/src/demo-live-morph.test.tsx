/// <reference types="bun" />

import { expect, mock, test } from "bun:test"
import { EXPO_TURBO_MIME_TYPE, nodeTextContent } from "expo-turbo/core"
import { createElement } from "react"
import { act, create, type ReactTestRenderer } from "react-test-renderer"

import type { DemoLiveFetchRequest, DemoLiveFetchResponse } from "./demo-live-transport"

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

const globalWithAct = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean
}
globalWithAct.IS_REACT_ACT_ENVIRONMENT = true

const OUTER_FRAME_ID = "morph-outer"
const INNER_FRAME_ID = "morph-inner"
const OUTER_PATH = "/api/expo_turbo/demo/morph/outer"
const INNER_PATH = "/api/expo_turbo/demo/morph/inner"

type PendingFetch = Readonly<{
  readonly request: DemoLiveFetchRequest
  readonly resolve: (response: DemoLiveFetchResponse) => void
  readonly url: string
}>

function response(body: string, url: string): DemoLiveFetchResponse {
  return Object.freeze({
    headers: Object.freeze({
      forEach(callback: (value: string, name: string) => void): void {
        callback(EXPO_TURBO_MIME_TYPE, "Content-Type")
      },
    }),
    redirected: false,
    status: 200,
    text: async () => body,
    url,
  })
}

function takePending(pending: PendingFetch[], message: string): PendingFetch {
  const next = pending.shift()
  if (!next) throw new Error(message)
  return next
}

const nextTurn = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

test("renders the standalone Rails nested Frame morph proof", async () => {
  const origin = "http://demo.example:3001"
  const outerUrl = new URL(OUTER_PATH, origin).toString()
  const innerUrl = new URL(INNER_PATH, origin).toString()
  const pending: PendingFetch[] = []
  const proof = createDemoLiveMorphRuntime({
    fetch: (url, request) =>
      new Promise<DemoLiveFetchResponse>((resolve) => {
        pending.push(Object.freeze({ request, resolve, url }))
      }),
    origin,
  })
  let renderer: ReactTestRenderer | undefined

  try {
    act(() => {
      renderer = create(createElement(DemoLiveMorphPanel, { proof }))
    })
    expect(JSON.stringify(renderer?.toJSON())).toContain("Nested Frame refresh morph")
    expect(pending).toHaveLength(0)

    const innerBefore = proof.session.tree.getElementById(INNER_FRAME_ID)
    if (innerBefore?.kind !== "frame") throw new Error("The mounted nested Frame is missing")
    const outerBefore = proof.session.tree.getElementById(OUTER_FRAME_ID)
    if (outerBefore?.kind !== "frame") throw new Error("The mounted outer Frame is missing")
    expect(proof.frames.findMounted(outerBefore)).toBeDefined()
    expect(proof.frames.findMounted(innerBefore)).toBeDefined()
    expect(nodeTextContent(innerBefore)).toContain("Waiting for the nested Frame reload")

    act(() => {
      const button = renderer?.root.findByProps({ accessibilityLabel: "Reload outer morph Frame" })
      if (!button?.props.onPress) throw new Error("The outer morph reload button did not render")
      ;(button.props as PressableProps).onPress?.()
    })
    await act(async () => {
      await Promise.resolve()
    })

    const outer = takePending(pending, "The outer Frame did not request the Rails morph endpoint")
    expect(outer).toMatchObject({
      request: {
        headers: { Accept: EXPO_TURBO_MIME_TYPE, "Turbo-Frame": OUTER_FRAME_ID },
        method: "GET",
      },
      url: outerUrl,
    })

    await act(async () => {
      outer.resolve(
        response(
          `<turbo-frame id="${OUTER_FRAME_ID}" src="${OUTER_PATH}" refresh="morph"><Gallery id="morph-shell"><DemoText id="morph-outer-version">Outer Frame response</DemoText><turbo-frame id="${INNER_FRAME_ID}" loading="lazy" refresh="morph" src="${INNER_PATH}"><DemoText id="morph-inner-stale">This nested response is intentionally ignored before its own reload</DemoText></turbo-frame></Gallery></turbo-frame>`,
          outerUrl,
        ),
      )
      await Promise.resolve()
      await Promise.resolve()
    })
    await nextTurn()

    expect(proof.frames.get(OUTER_FRAME_ID).state.status).toBe("completed")
    expect(proof.session.tree.getElementById(INNER_FRAME_ID)).toBe(innerBefore)
    expect(nodeTextContent(innerBefore)).toContain("Waiting for the nested Frame reload")
    expect(nodeTextContent(innerBefore)).not.toContain("intentionally ignored")

    const inner = takePending(pending, "The nested Frame did not request its Rails morph endpoint")
    expect(inner).toMatchObject({
      request: {
        headers: { Accept: EXPO_TURBO_MIME_TYPE, "Turbo-Frame": INNER_FRAME_ID },
        method: "GET",
      },
      url: innerUrl,
    })

    await act(async () => {
      inner.resolve(
        response(
          `<turbo-frame id="${INNER_FRAME_ID}" src="${INNER_PATH}" refresh="morph"><DemoText id="morph-inner-version">Inner Frame response</DemoText></turbo-frame>`,
          innerUrl,
        ),
      )
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(nodeTextContent(innerBefore)).toContain("Inner Frame response")
    expect(JSON.stringify(renderer?.toJSON())).toContain("Inner Frame response")

    const outerVersion = proof.session.tree.getElementById("morph-outer-version")
    if (!outerVersion) throw new Error("The first outer Frame response is missing")
    act(() => {
      const button = renderer?.root.findByProps({
        accessibilityLabel: "Visit outer Frame with morph renderer",
      })
      if (!button?.props.onPress) throw new Error("The controlled morph visit button did not render")
      ;(button.props as PressableProps).onPress?.()
    })
    await act(async () => {
      await Promise.resolve()
    })

    const visitedOuter = takePending(
      pending,
      "The ordinary outer Frame visit did not request the Rails morph endpoint",
    )
    expect(visitedOuter).toMatchObject({
      request: {
        headers: { Accept: EXPO_TURBO_MIME_TYPE, "Turbo-Frame": OUTER_FRAME_ID },
        method: "GET",
      },
      url: outerUrl,
    })
    await act(async () => {
      visitedOuter.resolve(
        response(
          `<turbo-frame id="${OUTER_FRAME_ID}" src="${OUTER_PATH}" refresh="morph"><Gallery id="morph-shell"><DemoText id="morph-outer-version">Outer Frame controlled visit response</DemoText><turbo-frame id="${INNER_FRAME_ID}" loading="lazy" refresh="morph" src="${INNER_PATH}"><DemoText id="morph-inner-stale">This nested response is intentionally ignored before its own reload</DemoText></turbo-frame></Gallery></turbo-frame>`,
          outerUrl,
        ),
      )
      await Promise.resolve()
      await Promise.resolve()
    })
    await nextTurn()

    expect(proof.session.tree.getElementById("morph-outer-version")).toBe(outerVersion)
    expect(nodeTextContent(outerVersion)).toContain("controlled visit response")
    expect(proof.session.tree.getElementById(INNER_FRAME_ID)).toBe(innerBefore)
    expect(nodeTextContent(innerBefore)).toContain("Inner Frame response")

    const visitedInner = takePending(
      pending,
      "The controlled outer morph visit did not cascade to the nested Frame",
    )
    await act(async () => {
      visitedInner.resolve(
        response(
          `<turbo-frame id="${INNER_FRAME_ID}" src="${INNER_PATH}" refresh="morph"><DemoText id="morph-inner-version">Inner Frame controlled visit cascade</DemoText></turbo-frame>`,
          innerUrl,
        ),
      )
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(nodeTextContent(innerBefore)).toContain("controlled visit cascade")
  } finally {
    await act(async () => {
      renderer?.unmount()
      await Promise.resolve()
    })
    await nextTurn()
    proof.dispose()
  }
})
