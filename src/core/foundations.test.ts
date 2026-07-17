import { describe, expect, test } from "bun:test"

import type { ExpoTurboAdapters } from "../adapters"
import {
  ContentTypeError,
  createProtocolInspector,
  EXPO_TURBO_PROTOCOL_VERSION,
  RAILS_BASELINE_VERSION,
  TURBO_BASELINE_VERSION,
  TURBO_RAILS_BASELINE_VERSION,
  TURBO_RAILS_MINIMUM_VERSION,
} from "."

describe("version baselines", () => {
  test("pin the public compatibility matrix", () => {
    expect(TURBO_BASELINE_VERSION).toBe("8.0.23")
    expect(TURBO_RAILS_BASELINE_VERSION).toBe("2.0.23")
    expect(TURBO_RAILS_MINIMUM_VERSION).toBe("2.0.10")
    expect(RAILS_BASELINE_VERSION).toBe("8.1.3")
    expect(EXPO_TURBO_PROTOCOL_VERSION).toBe("0.1")
  })
})

describe("protocol errors", () => {
  test("carry only typed, immutable diagnostic context", () => {
    const error = new ContentTypeError("Expected Expo Turbo XML", {
      contentType: "application/json",
      location: { line: 2, column: 4 },
      payloadHash: "sha256:fixture",
    })

    expect(error.code).toBe("content_type")
    expect(error.name).toBe("ContentTypeError")
    expect(Object.isFrozen(error.context)).toBe(true)
    expect(Object.isFrozen(error.context.location)).toBe(true)
    expect(error.context).not.toHaveProperty("payload")
  })
})

describe("protocol inspector", () => {
  test("publishes immutable revisioned snapshots through its adapter", () => {
    const published: number[] = []
    const inspector = createProtocolInspector({
      publish(snapshot) {
        published.push(snapshot.revision)
      },
    })
    const initial = inspector.getSnapshot()
    const current = inspector.update({
      actions: [{ action: "append", source: "http", target: "cart" }],
      documentUrl: "https://example.test/demo",
      frameIds: ["cart"],
    })

    expect(initial.revision).toBe(0)
    expect(current.revision).toBe(1)
    expect(current.frameIds).toEqual(["cart"])
    expect(Object.isFrozen(current)).toBe(true)
    expect(Object.isFrozen(current.frameIds)).toBe(true)
    expect(Object.isFrozen(current.actions[0])).toBe(true)
    expect(published).toEqual([1])
    expect(inspector.getSnapshot()).toBe(current)
  })
})

describe("adapter boundary", () => {
  test("accepts host-neutral fake adapters", async () => {
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
            text: async () => `<DemoText id="root" />`,
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
      observability: { report() {} },
      requestIds: { next: () => "request-1" },
      scroll: { scrollTo() {} },
      storage: {
        delete: async () => {},
        get: async () => undefined,
        set: async () => {},
      },
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

    const response = await adapters.fetch.fetch({
      headers: {},
      method: "GET",
      url: "https://example.test/demo",
    })

    expect(response.status).toBe(200)
    expect(await response.text()).toContain("DemoText")
  })
})
