import { describe, expect, test } from "bun:test"

import { documentCachePolicy } from "./document-metadata"
import { DOCUMENT_SNAPSHOT_CACHE_SIZE, DocumentSnapshotCache } from "./document-snapshot-cache"
import { PropsError, TargetError } from "./errors"
import { parseExpoTurboDocument } from "./parser"
import { attributeValue, type DocumentTree, nodeTextContent } from "./tree"

function snapshot(label: string, url: string = `https://example.test/${label}`) {
  return parseExpoTurboDocument(
    `<Gallery>
      <DemoText id="kept" data-label="${label}">${label}</DemoText>
      <DemoCard id="temporary" data-turbo-temporary="false">
        <DemoText id="temporary-child">Discarded</DemoText>
      </DemoCard>
    </Gallery>`,
    { url },
  )
}

describe("document snapshot cache", () => {
  test("stores and restores independent trees while pruning temporary subtrees", () => {
    const cache = new DocumentSnapshotCache()
    const source = snapshot("first", "https://example.test/gallery?filter=active#source")
    const sourceKept = source.getElementById("kept")
    if (!sourceKept) throw new Error("fixture lost its retained node")

    cache.put("https://example.test/gallery?filter=active#first", source)
    source.setAttribute(sourceKept, "data-label", "source-mutated")

    const first = cache.get("https://example.test/gallery?filter=active#second")
    const firstKept = first?.getElementById("kept")
    if (!first || !firstKept) throw new Error("cache lost its retained node")
    expect(first.document).not.toBe(source.document)
    expect(first.getElementById("temporary")).toBeUndefined()
    expect(first.getElementById("temporary-child")).toBeUndefined()
    expect(source.getElementById("temporary")).toBeDefined()
    expect(attributeValue(firstKept, "data-label")).toBe("first")

    first.setAttribute(firstKept, "data-label", "restored-mutated")
    const second = cache.get("https://example.test/gallery?filter=active")
    const secondKept = second?.getElementById("kept")
    if (!second || !secondKept) throw new Error("cache lost its second restored node")
    expect(second.document).not.toBe(first.document)
    expect(attributeValue(secondKept, "data-label")).toBe("first")
  })

  test("uses normalized fragment-free keys while retaining query identity", () => {
    const cache = new DocumentSnapshotCache()
    cache.put(
      "https://example.test:443/gallery?filter=one#first",
      snapshot("one", "https://example.test/gallery?filter=one#source"),
    )

    expect(cache.has("https://example.test/gallery?filter=one#second")).toBe(true)
    expect(cache.has("https://example.test/gallery?filter=two#first")).toBe(false)
    expect(cache.get("https://example.test/gallery?filter=one#")?.document.url).toBe(
      "https://example.test/gallery?filter=one#source",
    )
  })

  test("replaces matching keys and refreshes recency on get and put", () => {
    const cache = new DocumentSnapshotCache(2)
    cache.put("https://example.test/a", snapshot("a"))
    cache.put("https://example.test/b", snapshot("b"))
    expect(cache.get("https://example.test/a")).toBeDefined()

    cache.put("https://example.test/c", snapshot("c"))
    expect(cache.has("https://example.test/a")).toBe(true)
    expect(cache.has("https://example.test/b")).toBe(false)
    expect(cache.has("https://example.test/c")).toBe(true)

    cache.put(
      "https://example.test/a#replacement",
      snapshot("replacement", "https://example.test/a#source"),
    )
    cache.put("https://example.test/d", snapshot("d"))
    expect(cache.has("https://example.test/a")).toBe(true)
    expect(cache.has("https://example.test/c")).toBe(false)
    expect(cache.has("https://example.test/d")).toBe(true)
    const restored = cache.get("https://example.test/a")?.getElementById("kept")
    expect(restored ? nodeTextContent(restored) : undefined).toBe("replacement")
  })

  test("does not refresh recency when checking membership", () => {
    const cache = new DocumentSnapshotCache(2)
    cache.put("https://example.test/a", snapshot("a"))
    cache.put("https://example.test/b", snapshot("b"))

    expect(cache.has("https://example.test/a")).toBe(true)
    cache.put("https://example.test/c", snapshot("c"))

    expect(cache.has("https://example.test/a")).toBe(false)
    expect(cache.has("https://example.test/b")).toBe(true)
    expect(cache.has("https://example.test/c")).toBe(true)
  })

  test("defaults to ten entries and clears every retained snapshot", () => {
    const cache = new DocumentSnapshotCache()
    expect(cache.capacity).toBe(DOCUMENT_SNAPSHOT_CACHE_SIZE)
    for (let index = 0; index <= DOCUMENT_SNAPSHOT_CACHE_SIZE; index += 1) {
      cache.put(`https://example.test/${index}`, snapshot(String(index)))
    }

    expect(cache.size).toBe(DOCUMENT_SNAPSHOT_CACHE_SIZE)
    expect(cache.has("https://example.test/0")).toBe(false)
    expect(cache.has(`https://example.test/${DOCUMENT_SNAPSHOT_CACHE_SIZE}`)).toBe(true)
    cache.clear()
    expect(cache.size).toBe(0)
  })

  test("keeps the admitted snapshot when a mismatched replacement is rejected", () => {
    const cache = new DocumentSnapshotCache()
    cache.put("https://example.test/key", snapshot("original", "https://example.test/key"))

    expect(() =>
      cache.put("https://example.test/key", snapshot("replacement", "https://example.test/other")),
    ).toThrow(TargetError)

    const restored = cache.get("https://example.test/key")?.getElementById("kept")
    expect(restored ? nodeTextContent(restored) : undefined).toBe("original")
  })

  test("skips no-cache writes without evicting an older matching snapshot", () => {
    const cache = new DocumentSnapshotCache()
    cache.put("https://example.test/key", snapshot("original", "https://example.test/key"))
    cache.put(
      "https://example.test/key",
      parseExpoTurboDocument(
        '<Gallery data-turbo-cache-control="no-cache"><DemoText id="kept">replacement</DemoText></Gallery>',
        { url: "https://example.test/key" },
      ),
    )
    cache.put(
      "https://example.test/uncached",
      parseExpoTurboDocument('<Gallery data-turbo-cache-control="no-cache" />', {
        url: "https://example.test/uncached",
      }),
    )

    expect(cache.size).toBe(1)
    expect(cache.has("https://example.test/uncached")).toBe(false)
    const restored = cache.get("https://example.test/key")?.getElementById("kept")
    expect(restored ? nodeTextContent(restored) : undefined).toBe("original")
  })

  test("does not refresh LRU recency when a no-cache write is skipped", () => {
    const cache = new DocumentSnapshotCache(2)
    cache.put("https://example.test/a", snapshot("a"))
    cache.put("https://example.test/b", snapshot("b"))
    cache.put(
      "https://example.test/a",
      parseExpoTurboDocument('<Gallery data-turbo-cache-control="no-cache" />', {
        url: "https://example.test/a",
      }),
    )
    cache.put("https://example.test/c", snapshot("c"))

    expect(cache.has("https://example.test/a")).toBe(false)
    expect(cache.has("https://example.test/b")).toBe(true)
    expect(cache.has("https://example.test/c")).toBe(true)
  })

  test("retains no-preview metadata while pruning temporary content", () => {
    const cache = new DocumentSnapshotCache()
    cache.put(
      "https://example.test/no-preview",
      parseExpoTurboDocument(
        '<Gallery data-turbo-cache-control="no-preview"><DemoText id="kept" /><DemoText id="temporary" data-turbo-temporary="" /></Gallery>',
        { url: "https://example.test/no-preview" },
      ),
    )

    const restored = cache.get("https://example.test/no-preview")
    if (!restored) throw new Error("cache lost its no-preview snapshot")
    expect(documentCachePolicy(restored)).toEqual({ cacheable: true, previewable: false })
    expect(restored.getElementById("kept")).toBeDefined()
    expect(restored.getElementById("temporary")).toBeUndefined()
  })

  test("returns fresh preview clones under fragment-free keys", () => {
    const cache = new DocumentSnapshotCache()
    cache.put(
      "https://example.test/gallery?filter=active#source",
      snapshot("preview", "https://example.test/gallery?filter=active#document"),
    )

    const first = cache.getPreview("https://example.test/gallery?filter=active#first")
    const firstKept = first?.getElementById("kept")
    if (!first || !firstKept) throw new Error("cache lost its preview node")
    first.setAttribute(firstKept, "data-label", "preview-mutated")

    const second = cache.getPreview("https://example.test/gallery?filter=active#second")
    const secondKept = second?.getElementById("kept")
    expect(second).toBeDefined()
    expect(second).not.toBe(first)
    expect(secondKept ? attributeValue(secondKept, "data-label") : undefined).toBe("preview")
  })

  test("suppresses no-preview lookups while retaining restoration access", () => {
    const cache = new DocumentSnapshotCache()
    cache.put(
      "https://example.test/no-preview",
      parseExpoTurboDocument(
        '<Gallery data-turbo-cache-control="no-preview"><DemoText id="kept" /></Gallery>',
        { url: "https://example.test/no-preview" },
      ),
    )

    expect(cache.getPreview("https://example.test/no-preview#preview")).toBeUndefined()
    expect(cache.has("https://example.test/no-preview")).toBe(true)
    expect(
      cache.get("https://example.test/no-preview#restore")?.getElementById("kept"),
    ).toBeDefined()
  })

  test("refreshes LRU recency before suppressing a no-preview lookup", () => {
    const cache = new DocumentSnapshotCache(2)
    cache.put(
      "https://example.test/no-preview",
      parseExpoTurboDocument('<Gallery data-turbo-cache-control="no-preview" />', {
        url: "https://example.test/no-preview",
      }),
    )
    cache.put("https://example.test/ordinary", snapshot("ordinary"))

    expect(cache.getPreview("https://example.test/no-preview")).toBeUndefined()
    cache.put("https://example.test/newest", snapshot("newest"))

    expect(cache.has("https://example.test/no-preview")).toBe(true)
    expect(cache.has("https://example.test/ordinary")).toBe(false)
    expect(cache.has("https://example.test/newest")).toBe(true)
  })

  test("rejects invalid preview URLs and keeps no-cache as a miss", () => {
    const cache = new DocumentSnapshotCache()
    cache.put(
      "https://example.test/no-cache",
      parseExpoTurboDocument('<Gallery data-turbo-cache-control="no-cache" />', {
        url: "https://example.test/no-cache",
      }),
    )

    expect(cache.getPreview("https://example.test/no-cache")).toBeUndefined()
    for (const url of ["", "/relative", "https://user:secret@example.test/private"]) {
      expect(() => cache.getPreview(url)).toThrow(TargetError)
    }
  })

  test("rejects invalid capacities, URLs, credentials, entry forgeries, and URL mismatches", () => {
    for (const capacity of [0, -1, 1.5, Number.POSITIVE_INFINITY]) {
      expect(() => new DocumentSnapshotCache(capacity)).toThrow(PropsError)
    }

    const cache = new DocumentSnapshotCache()
    for (const url of [
      "",
      "/relative",
      "javascript:alert(1)",
      "https://user:secret@example.test/private",
    ]) {
      expect(() => cache.get(url)).toThrow(TargetError)
    }
    expect(() => cache.put("https://example.test/forged", {} as DocumentTree)).toThrow(PropsError)
    expect(() =>
      cache.put(
        "https://example.test/key",
        parseExpoTurboDocument("<Gallery />", { url: "https://example.test/other" }),
      ),
    ).toThrow(TargetError)
    expect(() =>
      cache.put("https://example.test/key", parseExpoTurboDocument("<Gallery />")),
    ).toThrow(TargetError)
    expect(cache.size).toBe(0)
  })
})
