import { describe, expect, test } from "bun:test"

import {
  documentCachePolicy,
  documentRefreshSettings,
  documentVisitControl,
} from "./document-metadata"
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

describe("document visit-control metadata", () => {
  test("admits only exact reload on the sole XML root", () => {
    expect(visitControl('<Gallery data-turbo-visit-control="reload" />')).toBe("reload")

    for (const xml of [
      "<Gallery />",
      '<Gallery data-turbo-visit-control="" />',
      '<Gallery data-turbo-visit-control="replace" />',
      '<Gallery data-turbo-visit-control="RELOAD" />',
      '<Gallery data-turbo-visit-control=" reload " />',
      '<Gallery><Nested data-turbo-visit-control="reload" /></Gallery>',
    ]) {
      expect(visitControl(xml)).toBeUndefined()
    }
  })
})

describe("document refresh metadata", () => {
  test("admits exact root-level morph and preserve settings independently", () => {
    const morphAndPreserve = refreshSettings(
      '<Gallery data-turbo-refresh-method="morph" data-turbo-refresh-scroll="preserve" />',
    )
    const morphAndReset = refreshSettings('<Gallery data-turbo-refresh-method="morph" />')
    const replaceAndPreserve = refreshSettings('<Gallery data-turbo-refresh-scroll="preserve" />')

    expect(morphAndPreserve).toEqual({ method: "morph", scroll: "preserve" })
    expect(morphAndReset).toEqual({ method: "morph", scroll: "reset" })
    expect(replaceAndPreserve).toEqual({ method: "replace", scroll: "preserve" })
    expect(Object.isFrozen(morphAndPreserve)).toBe(true)
    expect(Object.isFrozen(morphAndReset)).toBe(true)
    expect(Object.isFrozen(replaceAndPreserve)).toBe(true)
  })

  test("defaults absent, invalid, differently cased, and nested refresh settings", () => {
    for (const xml of [
      "<Gallery />",
      '<Gallery data-turbo-refresh-method="replace" data-turbo-refresh-scroll="reset" />',
      '<Gallery data-turbo-refresh-method="MORPH" data-turbo-refresh-scroll="PRESERVE" />',
      '<Gallery data-turbo-refresh-method=" morph " data-turbo-refresh-scroll=" preserve " />',
      '<Gallery><Nested data-turbo-refresh-method="morph" data-turbo-refresh-scroll="preserve" /></Gallery>',
    ]) {
      const settings = refreshSettings(xml)
      expect(settings).toEqual({ method: "replace", scroll: "reset" })
      expect(Object.isFrozen(settings)).toBe(true)
    }
  })
})

function visitControl(xml: string) {
  return documentVisitControl(parseExpoTurboDocument(xml, { url: "https://example.test/document" }))
}

function refreshSettings(xml: string) {
  return documentRefreshSettings(
    parseExpoTurboDocument(xml, { url: "https://example.test/document" }),
  )
}
