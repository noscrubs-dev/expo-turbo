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
      "src/index.ts":
        'import { z } from "zod"\nimport { local } from "./local"\nvoid z\nvoid local',
      "src/local.ts": "export const local = true",
    })

    expect(await scanSourceBoundaries(root)).toEqual([])
  })

  test("rejects forbidden imports, app aliases, and source-root escapes", async () => {
    const root = await fixture({
      "package.json": "{}",
      "src/core/index.ts": [
        'import "@hotwired/turbo"',
        'export type { Router } from "expo-router"',
        'void import("@tanstack/react-query")',
        'void import("@tanstack/react-query-devtools")',
        'require("@expo-shared/components")',
        'import "@acme/expo-shared/lib/sdui/registry"',
        'import "@/app"',
        'import "~/app"',
        'import "/private/path"',
        'import "file:///private/path"',
        'import "../../private"',
      ].join("\n"),
    })

    expect(await scanSourceBoundaries(root)).toMatchObject([
      { specifier: "@hotwired/turbo" },
      { specifier: "expo-router" },
      { specifier: "@tanstack/react-query" },
      { specifier: "@tanstack/react-query-devtools" },
      { specifier: "@expo-shared/components" },
      { specifier: "@acme/expo-shared/lib/sdui/registry" },
      { specifier: "@/app" },
      { specifier: "~/app" },
      {
        specifier: "/private/path",
        reason: "absolute filesystem and file URL imports are not allowed",
      },
      {
        specifier: "file:///private/path",
        reason: "absolute filesystem and file URL imports are not allowed",
      },
      {
        specifier: "../../private",
        reason: "relative import resolves outside the package source root",
      },
    ])
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
