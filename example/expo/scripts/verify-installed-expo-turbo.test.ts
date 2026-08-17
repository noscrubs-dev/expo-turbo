import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import { verifyInstalledPackage } from "./verify-installed-expo-turbo.mjs"

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe("installed expo-turbo verification", () => {
  test("accepts identical export maps and file bytes", async () => {
    const fixture = await makeFixture({ ".": "./dist/index.js", "./package.json": "./package.json" })

    const result = await verifyInstalledPackage(fixture)

    expect(result.targets).toEqual(["./dist/index.js", "./package.json"])
    expect(result.rootManifestPath).not.toBe(result.installedManifestPath)
  })

  for (const [name, mutate] of [
    ["added key", (exports: Record<string, unknown>) => void (exports["./extra"] = "./dist/index.js")],
    ["missing key", (exports: Record<string, unknown>) => void delete exports["."]],
    [
      "condition",
      (exports: Record<string, unknown>) =>
        void (exports["."] = { import: "./dist/index.js", browser: "./dist/index.js" }),
    ],
    ["target", (exports: Record<string, unknown>) => void (exports["."] = "./dist/other.js")],
  ] as const) {
    test(`rejects a different export ${name} and reports both manifest paths`, async () => {
      const fixture = await makeFixture({ ".": { import: "./dist/index.js" } })
      const installedManifest = await readJson(join(fixture.installedRoot, "package.json"))
      mutate(installedManifest.exports)
      await writeJson(join(fixture.installedRoot, "package.json"), installedManifest)

      await expect(verifyInstalledPackage(fixture)).rejects.toThrow("Installed expo-turbo exports differ")
      await expect(verifyInstalledPackage(fixture)).rejects.toThrow(join(fixture.repositoryRoot, "package.json"))
      await expect(verifyInstalledPackage(fixture)).rejects.toThrow(join(fixture.installedRoot, "package.json"))
    })
  }

  for (const [name, rootExport, installedExport] of [
    ["array", ["./dist/index.js", "./dist/fallback.js"], ["./dist/index.js"]],
    ["null", { import: "./dist/index.js", default: null }, { import: "./dist/index.js" }],
  ] as const) {
    test(`rejects a changed ${name} value`, async () => {
      const fixture = await makeFixture({ ".": rootExport })
      const installedManifest = await readJson(join(fixture.installedRoot, "package.json"))
      installedManifest.exports["."] = installedExport
      await writeJson(join(fixture.installedRoot, "package.json"), installedManifest)

      await expect(verifyInstalledPackage(fixture)).rejects.toThrow("Installed expo-turbo exports differ")
    })
  }

  test("rejects a missing installed target", async () => {
    const fixture = await makeFixture({ ".": "./dist/index.js" })
    await rm(join(fixture.installedRoot, "dist/index.js"))

    await expect(verifyInstalledPackage(fixture)).rejects.toThrow("Missing installed export target")
    await expect(verifyInstalledPackage(fixture)).rejects.toThrow(
      join(fixture.repositoryRoot, "dist/index.js"),
    )
    await expect(verifyInstalledPackage(fixture)).rejects.toThrow(
      join(fixture.installedRoot, "dist/index.js"),
    )
  })

  test("mutation proof: byte comparison catches stale equal-size, equal-mtime files", async () => {
    const fixture = await makeFixture({ ".": "./dist/index.js" })
    const rootTarget = join(fixture.repositoryRoot, "dist/index.js")
    const installedTarget = join(fixture.installedRoot, "dist/index.js")
    const fixedTime = new Date("2026-01-01T00:00:00.000Z")
    await writeFile(rootTarget, "root")
    await writeFile(installedTarget, "copy")
    await Promise.all([utimes(rootTarget, fixedTime, fixedTime), utimes(installedTarget, fixedTime, fixedTime)])

    await expect(verifyInstalledPackage(fixture)).rejects.toThrow("export bytes differ")
  })

  test("rejects malformed root and installed package JSON", async () => {
    for (const location of ["repositoryRoot", "installedRoot"] as const) {
      const fixture = await makeFixture({ ".": "./dist/index.js" })
      await writeFile(join(fixture[location], "package.json"), "{")

      await expect(verifyInstalledPackage(fixture)).rejects.toThrow("Malformed")
    }
  })

  test("rejects a parent target escape", async () => {
    const fixture = await makeFixture({ ".": "../outside.js" }, { writeTargets: false })

    await expect(verifyInstalledPackage(fixture)).rejects.toThrow("Unsafe repository-root export target")
  })

  test("rejects an absolute export target", async () => {
    const fixture = await makeFixture({ ".": "/tmp/outside.js" }, { writeTargets: false })

    await expect(verifyInstalledPackage(fixture)).rejects.toThrow("Unsafe repository-root export target")
  })

  test("rejects a symlink target that escapes the package root", async () => {
    const fixture = await makeFixture({ ".": "./dist/index.js" }, { writeTargets: false })
    const outside = join(dirname(fixture.repositoryRoot), "outside.js")
    await writeFile(outside, "outside")
    await Promise.all([
      mkdir(join(fixture.repositoryRoot, "dist"), { recursive: true }),
      mkdir(join(fixture.installedRoot, "dist"), { recursive: true }),
    ])
    await Promise.all([
      symlink(outside, join(fixture.repositoryRoot, "dist/index.js")),
      symlink(outside, join(fixture.installedRoot, "dist/index.js")),
    ])

    await expect(verifyInstalledPackage(fixture)).rejects.toThrow("escapes its package root")
  })

  test("traverses nested conditions and arrays while accepting null", async () => {
    const exports = {
      ".": {
        types: "./dist/index.d.ts",
        import: ["./dist/index.js", { development: "./dist/development.js", production: null }],
        default: null,
      },
    }
    const fixture = await makeFixture(exports)

    const result = await verifyInstalledPackage(fixture)

    expect(result.targets).toEqual([
      "./dist/index.d.ts",
      "./dist/index.js",
      "./dist/development.js",
    ])
  })

  test("rejects malformed values in an otherwise equal exports graph", async () => {
    const fixture = await makeFixture({ ".": 42 }, { writeTargets: false })

    await expect(verifyInstalledPackage(fixture)).rejects.toThrow("Malformed exports graph")
  })

  test("mutation proof: changing a root file after install fails even when exports still match", async () => {
    const fixture = await makeFixture({ ".": "./dist/index.js" })
    await writeFile(join(fixture.repositoryRoot, "dist/index.js"), "new root build")

    await expect(verifyInstalledPackage(fixture)).rejects.toThrow("export bytes differ")
  })

  test("mutation proof: separate manifest paths catch a stale installed map", async () => {
    const fixture = await makeFixture({ ".": "./dist/index.js" })
    const installedManifest = await readJson(join(fixture.installedRoot, "package.json"))
    installedManifest.exports["."] = "./dist/old.js"
    await writeJson(join(fixture.installedRoot, "package.json"), installedManifest)

    await expect(verifyInstalledPackage(fixture)).rejects.toThrow("exports.. changed")
  })

  test("the current repository install passes", async () => {
    await expect(verifyInstalledPackage()).resolves.toMatchObject({
      rootManifestPath: join(import.meta.dir, "../../../package.json"),
      installedManifestPath: join(import.meta.dir, "../node_modules/expo-turbo/package.json"),
    })
  })
})

async function makeFixture(
  exports: Record<string, unknown>,
  options: { writeTargets?: boolean } = {},
) {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "expo-turbo-installed-check-"))
  temporaryRoots.push(fixtureRoot)
  const repositoryRoot = join(fixtureRoot, "repository")
  const installedRoot = join(fixtureRoot, "example/node_modules/expo-turbo")
  await Promise.all([mkdir(repositoryRoot, { recursive: true }), mkdir(installedRoot, { recursive: true })])
  const manifest = { name: "expo-turbo", version: "0.0.0", exports }
  await Promise.all([
    writeJson(join(repositoryRoot, "package.json"), manifest),
    writeJson(join(installedRoot, "package.json"), manifest),
  ])

  if (options.writeTargets !== false) {
    for (const target of collectStrings(exports)) {
      if (!target.startsWith("./") || target.includes("..") || target === "./package.json") continue
      const rootTarget = join(repositoryRoot, target)
      const installedTarget = join(installedRoot, target)
      await Promise.all([
        mkdir(dirname(rootTarget), { recursive: true }),
        mkdir(dirname(installedTarget), { recursive: true }),
      ])
      await Promise.all([writeFile(rootTarget, target), writeFile(installedTarget, target)])
      await Promise.all([chmod(rootTarget, 0o644), chmod(installedTarget, 0o644)])
    }
  }

  return { repositoryRoot, installedRoot }
}

function collectStrings(value: unknown): string[] {
  if (typeof value === "string") return [value]
  if (Array.isArray(value)) return value.flatMap(collectStrings)
  if (value && typeof value === "object") return Object.values(value).flatMap(collectStrings)
  return []
}

async function readJson(path: string): Promise<any> {
  return JSON.parse(await readFile(path, "utf8"))
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
}
