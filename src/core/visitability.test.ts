import { describe, expect, test } from "bun:test"

import { TargetError } from "./errors"
import { parseExpoTurboDocument } from "./parser"
import {
  classifyTopLevelLocation,
  documentRootLocation,
  locationIsVisitable,
  TURBO_UNVISITABLE_EXTENSIONS,
} from "./visitability"

const EXPECTED_UNVISITABLE_EXTENSIONS = [
  ".7z",
  ".aac",
  ".apk",
  ".avi",
  ".bmp",
  ".bz2",
  ".css",
  ".csv",
  ".deb",
  ".dmg",
  ".doc",
  ".docx",
  ".exe",
  ".gif",
  ".gz",
  ".heic",
  ".heif",
  ".ico",
  ".iso",
  ".jpeg",
  ".jpg",
  ".js",
  ".json",
  ".m4a",
  ".mkv",
  ".mov",
  ".mp3",
  ".mp4",
  ".mpeg",
  ".mpg",
  ".msi",
  ".ogg",
  ".ogv",
  ".pdf",
  ".pkg",
  ".png",
  ".ppt",
  ".pptx",
  ".rar",
  ".rtf",
  ".svg",
  ".tar",
  ".tif",
  ".tiff",
  ".txt",
  ".wav",
  ".webm",
  ".webp",
  ".wma",
  ".wmv",
  ".xls",
  ".xlsx",
  ".xml",
  ".zip",
] as const

function document(xml = '<Gallery data-turbo-root="/app" />', url = "https://example.test/app") {
  return parseExpoTurboDocument(xml, { url })
}

describe("Turbo root visitability", () => {
  test("matches Turbo 8.0.23 root-prefix behavior exactly", () => {
    const root = new URL("https://example.test/app")

    expect(locationIsVisitable(new URL("https://example.test/app"), root)).toBe(true)
    expect(locationIsVisitable(new URL("https://example.test/app/"), root)).toBe(true)
    expect(locationIsVisitable(new URL("https://example.test/app/page"), root)).toBe(true)
    expect(locationIsVisitable(new URL("https://example.test/application"), root)).toBe(false)
    expect(locationIsVisitable(new URL("https://example.test/app?tab=one"), root)).toBe(false)
    expect(locationIsVisitable(new URL("https://example.test/app#section"), root)).toBe(false)
    expect(locationIsVisitable(new URL("https://example.test/app/?tab=one"), root)).toBe(true)
    expect(locationIsVisitable(new URL("https://outside.test/app/page"), root)).toBe(false)
  })

  test("uses Turbo 8.0.23's fixed case-sensitive unvisitable extension set", () => {
    expect(TURBO_UNVISITABLE_EXTENSIONS).toEqual(EXPECTED_UNVISITABLE_EXTENSIONS)
    for (const extension of EXPECTED_UNVISITABLE_EXTENSIONS) {
      expect(
        locationIsVisitable(
          new URL(`https://example.test/app/file${extension}`),
          new URL("https://example.test/app"),
        ),
      ).toBe(false)
    }
    expect(
      locationIsVisitable(
        new URL("https://example.test/app/file.PDF"),
        new URL("https://example.test/app"),
      ),
    ).toBe(true)
  })

  test("reads data-turbo-root only from the sole XML root and defaults to slash", () => {
    expect(documentRootLocation(document("<Gallery />", "https://example.test/app/page"))).toBe(
      "https://example.test/",
    )
    expect(
      documentRootLocation(
        document(
          '<Gallery data-turbo-root="scope"><Nested data-turbo-root="/ignored" /></Gallery>',
          "https://example.test/app/page",
        ),
      ),
    ).toBe("https://example.test/app/scope")
    expect(
      documentRootLocation(
        document('<Gallery data-turbo-root="" />', "https://example.test/app/page"),
      ),
    ).toBe("https://example.test/app/page")
  })

  test("classifies normalized top-level URLs without conflating root and extension failures", () => {
    const tree = document()

    const root = classifyTopLevelLocation(tree, "/app")
    const inside = classifyTopLevelLocation(tree, "/app/page?tab=one")
    const prefixCollision = classifyTopLevelLocation(tree, "/application")
    const outsideExtension = classifyTopLevelLocation(tree, "/outside/file.pdf")
    const insideExtension = classifyTopLevelLocation(tree, "/app/file.pdf")
    const external = classifyTopLevelLocation(tree, "https://outside.test/app/page")

    expect(root).toEqual({
      classification: "visitable",
      rootLocation: "https://example.test/app",
      url: "https://example.test/app",
    })
    expect(inside).toMatchObject({
      classification: "visitable",
      url: "https://example.test/app/page?tab=one",
    })
    expect(prefixCollision.classification).toBe("outside-root")
    expect(outsideExtension.classification).toBe("outside-root")
    expect(insideExtension.classification).toBe("unvisitable-extension")
    expect(external).toMatchObject({
      classification: "external",
      url: "https://outside.test/app/page",
    })
    expect(Object.isFrozen(root)).toBe(true)
  })

  test("fails closed without an active document URL", () => {
    const tree = parseExpoTurboDocument('<Gallery data-turbo-root="/app" />')

    expect(() => documentRootLocation(tree)).toThrow(TargetError)
    expect(() => classifyTopLevelLocation(tree, "/app/page")).toThrow(TargetError)
  })

  test("rejects unsafe root metadata without retaining credentials", () => {
    for (const root of [
      "mailto:support@example.test",
      "data:text/plain,private-root",
      "https://user:secret-token@example.test/app",
    ]) {
      try {
        documentRootLocation(document(`<Gallery data-turbo-root="${root}" />`))
        throw new Error("expected root admission to fail")
      } catch (error) {
        expect(error).toBeInstanceOf(TargetError)
        if (!(error instanceof TargetError)) throw error
        expect(String(error)).not.toContain("secret-token")
        expect(String(error)).not.toContain("private-root")
        expect(JSON.stringify(error.context)).not.toContain("secret-token")
        expect(JSON.stringify(error.context)).not.toContain("private-root")
      }
    }
  })
})
