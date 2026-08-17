import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  loadDemoRegistryManifestJSON,
  syncCapabilityManifest,
} from "./sync-capability-manifest"

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe("Expo capability artifact synchronization", () => {
  test("generates the current registry manifest deterministically", async () => {
    const first = await loadDemoRegistryManifestJSON()
    const second = await loadDemoRegistryManifestJSON()

    expect(first).toBe(second)
    expect(first).toEndWith("\n")
  })

  test("check mode accepts current artifacts without writing them", async () => {
    const fixture = await makeFixture()
    const before = await snapshot(fixture)

    await syncCapabilityManifest({ ...fixture, mode: "check" })

    expect(await snapshot(fixture)).toEqual(before)
  })

  test("check mode rejects a stale committed manifest", async () => {
    const fixture = await makeFixture()
    await writeFile(fixture.manifestPath, "{}\n")

    await expect(syncCapabilityManifest({ ...fixture, mode: "check" })).rejects.toThrow(
      /Stale Expo capability artifact/,
    )
    await expect(syncCapabilityManifest({ ...fixture, mode: "check" })).rejects.toThrow(
      /bun run capabilities:write/,
    )
  })

  test("rejects a coordinated manifest and lock edit that disagrees with DEMO_REGISTRY", async () => {
    const registryManifestJSON = await loadDemoRegistryManifestJSON()
    const edited = JSON.parse(registryManifestJSON)
    edited.components[0].aliases.push("coordinated-stale-alias")
    edited.hash = manifestDigest(edited)
    const editedManifestJSON = `${JSON.stringify(edited, null, 2)}\n`
    const fixture = await makeFixture({
      committedManifestJSON: editedManifestJSON,
      lockDigest: edited.hash,
      manifestJSON: registryManifestJSON,
    })

    await expect(syncCapabilityManifest({ ...fixture, mode: "check" })).rejects.toThrow(
      `Expected registry digest: ${JSON.parse(registryManifestJSON).hash}`,
    )
  })

  test("fails before writing when the current lock record is missing", async () => {
    const fixture = await makeFixture({ current: "sha256-128:missing", lockDigest: "sha256-128:other" })
    const before = await snapshot(fixture)

    await expect(syncCapabilityManifest({ ...fixture, mode: "write" })).rejects.toThrow(
      /no history record for current digest/,
    )
    expect(await snapshot(fixture)).toEqual(before)
  })

  test("fails before writing when the current lock record is duplicated", async () => {
    const fixture = await makeFixture({ duplicateCurrent: true })
    const before = await snapshot(fixture)

    await expect(syncCapabilityManifest({ ...fixture, mode: "write" })).rejects.toThrow(
      /2 history records.*expected exactly one/,
    )
    expect(await snapshot(fixture)).toEqual(before)
  })

  for (const [name, options] of [
    ["published", { published: true }],
    ["not explicitly mutable", { omitPublished: true }],
  ] as const) {
    test(`fails before writing when the current lock record is ${name}`, async () => {
      const fixture = await makeFixture(options)
      const before = await snapshot(fixture)

      await expect(syncCapabilityManifest({ ...fixture, mode: "write" })).rejects.toThrow(
        /published or immutable/,
      )
      expect(await snapshot(fixture)).toEqual(before)
    })
  }

  test("write mode changes only the current unpublished identity and generated manifest", async () => {
    const oldDigest = "sha256-128:old-unpublished"
    const fixture = await makeFixture({ current: oldDigest, lockDigest: oldDigest })
    const beforeLock = JSON.parse(await readFile(fixture.lockfilePath, "utf8"))
    const generatedDigest = JSON.parse(fixture.manifestJSON).hash

    await syncCapabilityManifest({ ...fixture, mode: "write" })

    const afterLock = JSON.parse(await readFile(fixture.lockfilePath, "utf8"))
    expect(await readFile(fixture.manifestPath, "utf8")).toBe(fixture.manifestJSON)
    expect(afterLock.current).toBe(generatedDigest)
    expect(afterLock.history).toHaveLength(beforeLock.history.length)
    expect(afterLock.history[0]).toEqual(beforeLock.history[0])
    expect(afterLock.history[1]).toEqual({ ...beforeLock.history[1], digest: generatedDigest })
  })
})

interface FixtureOptions {
  committedManifestJSON?: string
  current?: string
  duplicateCurrent?: boolean
  lockDigest?: string
  manifestJSON?: string
  omitPublished?: boolean
  published?: boolean
}

async function makeFixture(options: FixtureOptions = {}) {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "expo-capability-artifacts-"))
  temporaryRoots.push(repositoryRoot)
  const manifestPath = join(repositoryRoot, "manifest.json")
  const lockfilePath = join(repositoryRoot, "expo-turbo.lock.json")
  const manifestJSON = options.manifestJSON ?? (await loadDemoRegistryManifestJSON())
  const generatedDigest = JSON.parse(manifestJSON).hash
  const lockDigest = options.lockDigest ?? generatedDigest
  const current = options.current ?? lockDigest
  const currentRecord = {
    revision: 2,
    digest: lockDigest,
    ...(!options.omitPublished ? { published: options.published ?? false } : {}),
    package: "expo-turbo-example",
    manifest: "manifest.json",
  }
  const lock = {
    lockVersion: 1,
    current,
    history: [
      {
        revision: 1,
        digest: "sha256-128:released",
        published: true,
        package: "expo-turbo-example",
        manifest: "released.json",
      },
      currentRecord,
      ...(options.duplicateCurrent ? [{ ...currentRecord, revision: 3 }] : []),
    ],
  }
  await Promise.all([
    writeFile(manifestPath, options.committedManifestJSON ?? manifestJSON),
    writeFile(lockfilePath, `${JSON.stringify(lock, null, 2)}\n`),
  ])
  return { lockfilePath, manifestJSON, manifestPath, repositoryRoot }
}

async function snapshot(fixture: { lockfilePath: string; manifestPath: string }) {
  const [lockSource, manifestSource, lockStat, manifestStat] = await Promise.all([
    readFile(fixture.lockfilePath, "utf8"),
    readFile(fixture.manifestPath, "utf8"),
    stat(fixture.lockfilePath),
    stat(fixture.manifestPath),
  ])
  return {
    lockMtime: lockStat.mtimeMs,
    lockSource,
    manifestMtime: manifestStat.mtimeMs,
    manifestSource,
  }
}

function manifestDigest(manifest: {
  components: unknown
  modules: unknown
  protocolVersion: unknown
}): string {
  const canonical = JSON.stringify({
    components: manifest.components,
    modules: manifest.modules,
    protocolVersion: manifest.protocolVersion,
  })
  return `sha256-128:${createHash("sha256").update(canonical).digest("hex").slice(0, 32)}`
}
