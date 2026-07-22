import { describe, expect, test } from "bun:test"

import { DocumentPrefetchCache } from "./document-prefetch-cache"
import { parseExpoTurboDocument } from "./parser"

function tree(url: string, id: string) {
  return parseExpoTurboDocument(`<Gallery><DemoText id="${id}" /></Gallery>`, { url })
}

describe("DocumentPrefetchCache", () => {
  test("consumes one exact response once within the configured TTL", async () => {
    let now = 100
    const cache = new DocumentPrefetchCache(10_000, () => now)
    const url = "https://example.test/next"

    cache.put(url, tree(url, "cached"))
    now = 10_099

    expect((await cache.take(url))?.getElementById("cached")).toBeDefined()
    expect(cache.take(url)).toBeUndefined()
  })

  test("expires and evicts the prior destination", async () => {
    let now = 100
    const cache = new DocumentPrefetchCache(10_000, () => now)
    cache.put("https://example.test/first", tree("https://example.test/first", "first"))
    cache.put("https://example.test/second", tree("https://example.test/second", "second"))

    expect(cache.take("https://example.test/first")).toBeUndefined()
    cache.put("https://example.test/second", tree("https://example.test/second", "second"))
    now = 10_100
    expect(cache.take("https://example.test/second")).toBeUndefined()
  })
})
