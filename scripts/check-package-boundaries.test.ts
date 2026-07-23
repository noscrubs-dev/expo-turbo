import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { scanArtifactBoundaries, scanSourceBoundaries } from "./check-package-boundaries"

const fixtures: string[] = []

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  )
})

describe("package boundary checks", () => {
  test("allows public dependencies and source-local imports", async () => {
    const root = await fixture({
      "package.json": JSON.stringify({ dependencies: { zod: "4.4.3" } }),
      "src/index.ts": [
        'import { z } from "zod"',
        'import { local } from "./local"',
        'const loaded = require("./local")',
        "void z",
        "void local",
        "void loaded",
      ].join("\n"),
      "src/local.ts": "export const local = true",
    })

    expect(await scanSourceBoundaries(root)).toEqual([])
  })

  test("allows official Turbo only in the dedicated differential test", async () => {
    const root = await fixture({
      "package.json": JSON.stringify({
        devDependencies: { "@hotwired/turbo": "8.0.23" },
      }),
      "src/core/browser-stream-differential.test.ts": 'import "@hotwired/turbo"',
      "src/index.ts": "export {}",
    })

    expect(await scanSourceBoundaries(root)).toEqual([])
  })

  test("rejects official Turbo from runtime and unrelated test sources", async () => {
    const root = await fixture({
      "package.json": JSON.stringify({
        devDependencies: { "@hotwired/turbo": "8.0.23" },
      }),
      "src/core/other.test.ts": 'import "@hotwired/turbo"',
      "src/index.ts": 'import "@hotwired/turbo"',
    })

    expect(await scanSourceBoundaries(root)).toMatchObject([
      { file: "src/core/other.test.ts", specifier: "@hotwired/turbo" },
      { file: "src/index.ts", specifier: "@hotwired/turbo" },
    ])
  })

  test("allows prose in strings and regular expressions", async () => {
    const root = await fixture({
      "package.json": "{}",
      "src/index.ts": [
        'const copy = "Expo Turbo documents require one root element"',
        "const matcher = /method overrides require URL-encoded or multipart/",
        "export { copy, matcher }",
      ].join("\n"),
    })

    expect(await scanSourceBoundaries(root)).toEqual([])
  })

  test("rejects forbidden imports, app aliases, and source-root escapes", async () => {
    const root = await fixture({
      "package.json": "{}",
      "src/core/index.ts": [
        'import "@hotwired/turbo"',
        'export type { Router } from "expo-router"',
        'import type { QueryClient } from "@tanstack/react-query-persist-client"',
        'type PrivateApi = import("@acme\\u002fapi").Client',
        'void import("@tanstack/react-query")',
        'void import("@tanstack/react-query-devtools")',
        'require("@expo-shared/components")',
        'import "@acme/expo-shared/lib/sdui/registry"',
        'import "@/app"',
        'import "~/app"',
        'import "/private/path"',
        'import "file:///private/path"',
        'import "../../private"',
      ].join(";\n"),
    })

    const violations = await scanSourceBoundaries(root)
    expect(violations.map(({ specifier }) => specifier).sort()).toEqual(
      [
        "@hotwired/turbo",
        "expo-router",
        "@tanstack/react-query-persist-client",
        "@acme/api",
        "@tanstack/react-query",
        "@tanstack/react-query-devtools",
        "@expo-shared/components",
        "@acme/expo-shared/lib/sdui/registry",
        "@/app",
        "~/app",
        "/private/path",
        "file:///private/path",
        "../../private",
      ].sort(),
    )
    expect(violations.find(({ specifier }) => specifier === "/private/path")).toMatchObject({
      reason: "absolute filesystem and file URL imports are not allowed",
    })
    expect(violations.find(({ specifier }) => specifier === "../../private")).toMatchObject({
      reason: "relative import resolves outside the package source root",
    })
  })

  test("rejects nonliteral imports and indirect require calls", async () => {
    const interpolatedImport = "void import(`@acme/$" + "{privateSpecifier}`)"
    const root = await fixture({
      "package.json": "{}",
      "src/index.ts": [
        'const privateSpecifier = "@acme/api"',
        "void import(privateSpecifier)",
        interpolatedImport,
        "require?.(privateSpecifier)",
        "(require)(privateSpecifier)",
        "(0, require)(privateSpecifier)",
      ].join(";\n"),
    })

    const violations = await scanSourceBoundaries(root)
    expect(violations.map(({ specifier }) => specifier).sort()).toEqual([
      "<dynamic import>",
      "<dynamic import>",
      "<dynamic require>",
      "<dynamic require>",
      "<dynamic require>",
    ])
    expect(violations.filter(({ specifier }) => specifier === "<dynamic import>")).toMatchObject([
      { reason: "import must use a string-literal module specifier" },
      { reason: "import must use a string-literal module specifier" },
    ])
    expect(violations.filter(({ specifier }) => specifier === "<dynamic require>")).toMatchObject([
      { reason: "require must be a direct call with a string-literal module specifier" },
      { reason: "require must be a direct call with a string-literal module specifier" },
      { reason: "require must be a direct call with a string-literal module specifier" },
    ])
  })

  test("rejects nonliteral module calls inside template substitutions", async () => {
    const template = [
      "`",
      "$",
      "{import /* loader comment */ (privateSpecifier)} ",
      "$",
      "{(require)(privateSpecifier)}",
      "`",
    ].join("")
    const root = await fixture({
      "package.json": "{}",
      "src/index.ts": ['const privateSpecifier = "@acme/api"', `const value = ${template}`].join(
        "\n",
      ),
    })

    const violations = await scanSourceBoundaries(root)
    expect(violations.map(({ specifier }) => specifier).sort()).toEqual([
      "<dynamic import>",
      "<dynamic require>",
    ])
  })

  test("allows static template imports without mistaking prose for code", async () => {
    const lazy = ["const lazy = `", "$", '{import("./lazy")}`'].join("")
    const root = await fixture({
      "package.json": "{}",
      "src/index.ts": [lazy, "const prose = `docs: use import(foo) later`"].join("\n"),
    })

    expect(await scanSourceBoundaries(root)).toEqual([])
  })

  test("rejects bare require aliases, escaped loader names, and concatenated specifiers", async () => {
    const root = await fixture({
      "package.json": "{}",
      "src/index.ts": [
        'const privateSpecifier = "@acme/api"',
        "const loader = require",
        "loader(privateSpecifier)",
        "requ\\u0069re(privateSpecifier)",
        'void import("@hotwired" + "/turbo")',
        'require("@hotwired" + "/turbo")',
      ].join(";\n"),
    })

    expect(await scanSourceBoundaries(root)).toMatchObject([
      { specifier: "<dynamic require>" },
      { specifier: "<dynamic require>" },
      { specifier: "<dynamic import>" },
      { specifier: "<dynamic require>" },
    ])
  })

  test("keeps a type-only import after postfix division visible", async () => {
    const root = await fixture({
      "package.json": "{}",
      "src/index.ts": 'let value = 1; value++ / 2; type PrivateApi = import("@acme/api").Client',
    })

    expect(await scanSourceBoundaries(root)).toMatchObject([{ specifier: "@acme/api" }])
  })

  test("rejects forbidden manifest dependencies", async () => {
    const root = await fixture({
      "package.json": JSON.stringify({
        dependencies: { "@hotwired/turbo": "8.0.23" },
        devDependencies: {
          "@noscrubs/internal": "workspace:*",
          "@tanstack/react-query-persist-client": "*",
        },
        peerDependencies: { "@acme/api": "*" },
      }),
      "src/index.ts": "export {}",
    })

    expect(await scanSourceBoundaries(root)).toMatchObject([
      { file: "package.json", specifier: "@hotwired/turbo" },
      { file: "package.json", specifier: "@noscrubs/internal" },
      { file: "package.json", specifier: "@tanstack/react-query-persist-client" },
      { file: "package.json", specifier: "@acme/api" },
    ])
  })

  test("checks compiled imports, declarations, and source-map contents", async () => {
    const root = await fixture({
      "package.json": "{}",
      "dist/index.js": 'void import("@hotwired/turbo")',
      "dist/index.d.ts": 'export type { Router } from "expo-router"',
      "dist/index.js.map": JSON.stringify({
        sources: ["../src/index.ts"],
        sourcesContent: ['import "@acme/expo-shared/lib/sdui/registry"'],
      }),
      "src/index.ts": "export {}",
    })

    expect((await scanArtifactBoundaries(root)).map(({ specifier }) => specifier).sort()).toEqual([
      "@acme/expo-shared/lib/sdui/registry",
      "@hotwired/turbo",
      "expo-router",
    ])
  })

  test("requires built artifacts for artifact inspection", async () => {
    const root = await fixture({
      "package.json": "{}",
      "src/index.ts": "export {}",
    })

    await expect(scanArtifactBoundaries(root)).rejects.toThrow(
      "Built artifacts are missing; run bun run build before artifact:boundaries:check",
    )
  })
})

async function fixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "expo-turbo-boundaries-"))
  fixtures.push(root)

  await Promise.all(
    Object.entries(files).map(async ([file, content]) => {
      const path = join(root, file)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, content)
    }),
  )

  return root
}
