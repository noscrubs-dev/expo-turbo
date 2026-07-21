import { describe, expect, test } from "bun:test"

import { SubscriptionError } from "../core/errors"
import { resolveActionCableEndpoint } from "./action-cable-endpoint"
import { ActionCableV1WebSocketAdapter } from "./action-cable-websocket"

describe("resolveActionCableEndpoint", () => {
  test("maps credential-free HTTP(S) origins and absolute mount paths to WebSocket endpoints", () => {
    expect(resolveActionCableEndpoint("http://example.test", "/cable")).toBe(
      "ws://example.test/cable",
    )
    expect(resolveActionCableEndpoint("https://example.test:8443", "/api/v1/cable")).toBe(
      "wss://example.test:8443/api/v1/cable",
    )
    expect(resolveActionCableEndpoint("https://example.test/", "/cable/stream")).toBe(
      "wss://example.test/cable/stream",
    )
  })

  test("returns an endpoint accepted by the bounded WebSocket adapter without creating a socket", () => {
    let socketCalls = 0
    const url = resolveActionCableEndpoint("https://example.test:8443", "/cable")

    expect(
      () =>
        new ActionCableV1WebSocketAdapter({
          createSocket: () => {
            socketCalls += 1
            throw new Error("socket should not be created")
          },
          onError: () => undefined,
          url,
        }),
    ).not.toThrow()
    expect(socketCalls).toBe(0)
  })

  test("fails closed for unsafe, malformed, or cross-origin endpoint inputs", () => {
    const invalid = [
      ["https://user:password@example.test", "/cable"],
      ["https://example.test?ticket=signed-secret", "/cable"],
      ["https://example.test?", "/cable"],
      ["https://example.test#fragment", "/cable"],
      ["https://example.test#", "/cable"],
      ["https://example.test/api", "/cable"],
      ["https://example.test/.", "/cable"],
      ["https://example.test/%2e", "/cable"],
      ["https://example.test/foo/..", "/cable"],
      ["wss://example.test", "/cable"],
      ["https://example.test", "cable"],
      ["https://example.test", "//outside.test/cable"],
      ["https://example.test", "/\\\\outside.test/cable"],
      ["https://example.test", "/./cable"],
      ["https://example.test", "/%2e%2e/cable"],
      ["https://example.test", "/cable?ticket=signed-secret"],
      ["https://example.test", "/cable?"],
      ["https://example.test", "/cable#fragment"],
      ["https://example.test", "/cable#"],
      ["https://example.test", " /cable"],
      ["https://example.test", "/cable\\nnext"],
      ["https://example.test", "/cable\nnext"],
    ] as const

    for (const [origin, mountPath] of invalid) {
      expect(() => resolveActionCableEndpoint(origin, mountPath)).toThrow(
        new SubscriptionError("Action Cable endpoint is invalid"),
      )
    }
  })
})
