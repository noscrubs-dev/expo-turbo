import { describe, expect, test } from "bun:test"

import { documentCachePolicy } from "./document-metadata"
import { parseExpoTurboDocument } from "./parser"

function policy(xml: string) {
  return documentCachePolicy(parseExpoTurboDocument(xml, { url: "https://example.test/document" }))
}

describe("document cache metadata", () => {
  test("admits exact root-level no-cache and no-preview policies", () => {
    const noCache = policy('<Gallery data-turbo-cache-control="no-cache" />')
    const noPreview = policy('<Gallery data-turbo-cache-control="no-preview" />')

    expect(noCache).toEqual({ cacheable: false, previewable: true })
    expect(noPreview).toEqual({ cacheable: true, previewable: false })
    expect(Object.isFrozen(noCache)).toBe(true)
    expect(Object.isFrozen(noPreview)).toBe(true)
  })

  test("defaults absent, blank, invalid, differently cased, and nested values", () => {
    for (const xml of [
      "<Gallery />",
      '<Gallery data-turbo-cache-control="" />',
      '<Gallery data-turbo-cache-control="no-store" />',
      '<Gallery data-turbo-cache-control="NO-CACHE" />',
      '<Gallery data-turbo-cache-control=" no-cache " />',
      '<Gallery><Nested data-turbo-cache-control="no-cache" /></Gallery>',
    ]) {
      const admitted = policy(xml)
      expect(admitted).toEqual({ cacheable: true, previewable: true })
      expect(Object.isFrozen(admitted)).toBe(true)
    }
  })
})
