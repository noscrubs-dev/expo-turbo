import { describe, expect, test } from "bun:test"

import { DocumentPrefetchCache } from "./document-prefetch-cache"

function response(url: string, id: string) {
  return Object.freeze({
    body: `<Gallery><DemoText id="${id}" /></Gallery>`,
    contentType: "application/vnd.expo-turbo+xml",
    redirected: false,
    requestId: `prefetch-${id}`,
    responseStatus: 200,
    url,
  })
}

describe("DocumentPrefetchCache", () => {
  test("consumes one exact response once within the configured TTL", async () => {
    let now = 100
    const cache = new DocumentPrefetchCache(10_000, () => now)
    const url = "https://example.test/next"

    cache.put(url, response(url, "cached"))
    now = 10_099

    expect((await cache.take(url)?.promise)?.body).toContain('id="cached"')
    expect(cache.take(url)).toBeUndefined()
  })

  test("expires and evicts the prior destination", async () => {
    let now = 100
    const cache = new DocumentPrefetchCache(10_000, () => now)
    cache.put("https://example.test/first", response("https://example.test/first", "first"))
    cache.put("https://example.test/second", response("https://example.test/second", "second"))

    expect(cache.take("https://example.test/first")).toBeUndefined()
    cache.put("https://example.test/second", response("https://example.test/second", "second"))
    now = 10_100
    expect(cache.take("https://example.test/second")).toBeUndefined()
  })
})
