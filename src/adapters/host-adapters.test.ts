import { describe, expect, test } from "bun:test"

import type { ExpoTurboAdapters, FrameAutoscrollRequest } from "./index.js"

/**
 * `ScrollAdapter`, `StorageAdapter`, and `ObservabilityAdapter` were required
 * members of `ExpoTurboAdapters` with no consumer anywhere in the repository.
 * They were removed in 0.3.0.
 *
 * These are type-level pins, so the gate that fails when the removal is
 * reverted is `bun run typecheck` (part of `bun run check`), not `bun test`:
 * each `@ts-expect-error` below becomes an unused directive the moment the
 * member reappears, and the literal below stops satisfying the interface the
 * moment the fields become required again.
 */
const adapters: ExpoTurboAdapters<Readonly<Record<string, string>>> = {
  cable: {
    subscribe() {
      return { unsubscribe() {} }
    },
  },
  clock: {
    clearTimeout() {},
    now: () => 0,
    setTimeout: () => 1,
  },
  fetch: {
    async fetch(request) {
      return {
        headers: { "content-type": "application/vnd.expo-turbo+xml" },
        redirected: false,
        status: 200,
        text: async () => '<DemoText id="root" />',
        url: request.url,
      }
    },
  },
  focus: {
    blur() {},
    focus() {},
    getFocusedId: () => undefined,
  },
  lifecycle: {
    getState: () => "active",
    subscribe: () => () => {},
  },
  navigation: {
    back() {},
    openExternal() {},
    visit() {},
  },
  requestIds: { next: () => "request-1" },
  styles: {
    compose: (styles) => Object.assign({}, ...styles),
    maxTokens: 1,
    resolve: (tokens) => Object.fromEntries(tokens.map((token) => [token, token])),
    tokens: ["tone:info"],
  },
  visibility: {
    isVisible: () => true,
    subscribe: () => () => {},
  },
}

describe("host adapter surface", () => {
  test("is satisfiable without a scroll, storage, or observability adapter", () => {
    expect(Object.keys(adapters).sort()).toEqual([
      "cable",
      "clock",
      "fetch",
      "focus",
      "lifecycle",
      "navigation",
      "requestIds",
      "styles",
      "visibility",
    ])
  })

  test("no longer declares the three removed members", () => {
    // @ts-expect-error `scroll` was removed from ExpoTurboAdapters in 0.3.0.
    type RemovedScroll = ExpoTurboAdapters["scroll"]
    // @ts-expect-error `storage` was removed from ExpoTurboAdapters in 0.3.0.
    type RemovedStorage = ExpoTurboAdapters["storage"]
    // @ts-expect-error `observability` was removed from ExpoTurboAdapters in 0.3.0.
    type RemovedObservability = ExpoTurboAdapters["observability"]

    const removed: readonly (RemovedScroll | RemovedStorage | RemovedObservability)[] = []
    expect(removed).toEqual([])
  })

  test("keeps ScrollAlignment, which Frame autoscroll still uses", () => {
    // Deleting ScrollAdapter must not take its alignment vocabulary with it.
    const request: FrameAutoscrollRequest = {
      behavior: "auto",
      block: "nearest",
      frameId: "cart",
    }

    expect(request.block).toBe("nearest")
  })
})
