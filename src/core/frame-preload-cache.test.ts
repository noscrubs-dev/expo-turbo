import { describe, expect, test } from "bun:test"

import { PropsError, TargetError } from "./errors"
import { FramePreloadCache, type FramePreloadEntry } from "./frame-preload-cache"

function entry(frameId: string, url: string, label: string): FramePreloadEntry {
  return Object.freeze({
    body: `<turbo-frame id="${frameId}"><Loaded label="${label}" /></turbo-frame>`,
    frameId,
    redirected: false,
    requestId: `request-${label}`,
    responseStatus: 200,
    responseUrl: url,
    url,
  })
}

describe("Frame preload cache", () => {
  test("keys one-use responses by both destination Frame and URL", () => {
    const cache = new FramePreloadCache()
    cache.put(entry("first", "https://example.test/shared", "first"))
    cache.put(entry("second", "https://example.test/shared", "second"))

    expect(cache.take("first", "https://example.test/shared")?.requestId).toBe("request-first")
    expect(cache.take("first", "https://example.test/shared")).toBeUndefined()
    expect(cache.take("second", "https://example.test/shared")?.requestId).toBe("request-second")
    expect(cache.size).toBe(0)
  })

  test("evicts the oldest response and validates cache identity", () => {
    const cache = new FramePreloadCache(1)
    cache.put(entry("frame", "https://example.test/first", "first"))
    cache.put(entry("frame", "https://example.test/second", "second"))

    expect(cache.has("frame", "https://example.test/first")).toBe(false)
    expect(cache.has("frame", "https://example.test/second")).toBe(true)
    expect(() => new FramePreloadCache(0)).toThrow(PropsError)
    expect(() => cache.has("frame", "https://example.test/fragment#target")).toThrow(TargetError)
  })
})
