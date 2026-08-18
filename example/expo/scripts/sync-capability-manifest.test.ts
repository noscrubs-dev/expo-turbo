import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
  loadDemoRegistryManifestJSON,
  publishCapabilityArtifacts,
  syncCapabilityManifest,
} from "./sync-capability-manifest"

const temporaryRoots: string[] = []
const releasedDigest = seededDigest("released")
const revertedDigest = seededDigest("reverted")
const spareDigest = seededDigest("spare")
// Directory permissions do not stop the superuser, so a real permission failure cannot be staged.
const runsAsSuperuser = process.getuid?.() === 0

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
    const fixture = await makeFixture({ current: seededDigest("missing"), lockDigest: spareDigest })
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
    const oldDigest = seededDigest("old-unpublished")
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

// A registry revert makes the generated digest equal a digest an older record already owns. Moving
// it onto the current record writes a lock with two identical digests, which Rails refuses to load.
describe("Expo capability digest ownership", () => {
  for (const mode of ["check", "write"] as const) {
    test(`${mode} mode refuses a generated digest another history record already owns`, async () => {
      const manifestJSON = await loadDemoRegistryManifestJSON()
      const fixture = await makeFixture({
        current: revertedDigest,
        lockDigest: revertedDigest,
        manifestJSON,
        releasedDigest: JSON.parse(manifestJSON).hash,
      })
      const before = await snapshot(fixture)

      await expect(syncCapabilityManifest({ ...fixture, mode })).rejects.toThrow(
        /already belongs to compatibility lock history record 0; record 1 cannot take it/,
      )
      expect(await snapshot(fixture)).toEqual(before)
    })
  }

  test("write mode still records a generated digest the current record already owns", async () => {
    const fixture = await makeFixture()

    await syncCapabilityManifest({ ...fixture, mode: "write" })

    const lock = JSON.parse(await readFile(fixture.lockfilePath, "utf8"))
    expect(lock.current).toBe(JSON.parse(fixture.manifestJSON).hash)
    expect(lock.history[1].digest).toBe(lock.current)
  })
})

// ExpoTurbo::Rails::CompatibilityRegistry rejects each of these. A lock this script accepts but
// Rails refuses to load would only fail after it reached a host.
describe("Expo capability cross-runtime lock invariants", () => {
  const violations: { expected: RegExp; mutate: (lock: LockFixture) => void; name: string }[] = [
    {
      expected: /^Compatibility lock lockVersion must be 1, not 2/,
      mutate: (lock) => {
        lock.lockVersion = 2
      },
      name: "a lock version other than 1",
    },
    {
      expected: /^Compatibility lock history\[2\]\.digest .* repeats history\[0\]\.digest/,
      mutate: (lock) => {
        lock.history.push({ ...lock.history[0], revision: 3 })
      },
      name: "a digest that repeats a non-current record",
    },
    {
      expected: /^Compatibility lock history\[2\]\.revision 1 repeats history\[0\]\.revision/,
      mutate: (lock) => {
        lock.history.push({ ...lock.history[0], digest: spareDigest, revision: 1 })
      },
      name: "a revision that repeats another record",
    },
    {
      expected: /^Compatibility lock history\[0\]\.digest must be sha256-128:/,
      mutate: (lock) => {
        lock.history[0].digest = "sha256-128:released"
      },
      name: "a digest Rails cannot match",
    },
    {
      expected: /^Compatibility lock history\[0\]\.revision must be a positive integer, not 0/,
      mutate: (lock) => {
        lock.history[0].revision = 0
      },
      name: "a revision Rails does not count as positive",
    },
    {
      expected: /^Compatibility lock history\[0\]\.manifest must be a string/,
      mutate: (lock) => {
        delete lock.history[0].manifest
      },
      name: "a record without a manifest Rails can read",
    },
  ]

  for (const { expected, mutate, name } of violations) {
    for (const mode of ["check", "write"] as const) {
      test(`${mode} mode rejects ${name}`, async () => {
        const fixture = await makeFixture({ mutateLock: mutate })
        const before = await snapshot(fixture)

        await expect(syncCapabilityManifest({ ...fixture, mode })).rejects.toThrow(expected)
        expect(await snapshot(fixture)).toEqual(before)
      })
    }
  }

  test("check mode accepts the same lock without the violation", async () => {
    const fixture = await makeFixture()

    await syncCapabilityManifest({ ...fixture, mode: "check" })
  })

  // The lock on disk obeys every invariant, but the digest the generator supplies does not. The
  // record it lands on must obey the invariants after the update, not only before it.
  test("write mode refuses to record a generated digest Rails cannot match", async () => {
    const generated = JSON.parse(await loadDemoRegistryManifestJSON())
    generated.hash = "sha256-128:NOT-HEXADECIMAL"
    const fixture = await makeFixture({
      lockDigest: revertedDigest,
      manifestJSON: `${JSON.stringify(generated, null, 2)}\n`,
    })
    const before = await snapshot(fixture)

    await expect(syncCapabilityManifest({ ...fixture, mode: "write" })).rejects.toThrow(
      /^Updated compatibility lock history\[1\]\.digest must be sha256-128:/,
    )
    expect(await snapshot(fixture)).toEqual(before)
  })
})

describe("Expo capability artifact publication", () => {
  test("replaces every target and leaves no temporary or backup file", async () => {
    const directory = await makeTemporaryDirectory()
    const first = join(directory, "first.json")
    const second = join(directory, "second.json")
    await Promise.all([writeFile(first, "first original\n"), writeFile(second, "second original\n")])

    await publishCapabilityArtifacts([
      { contents: "first next\n", path: first },
      { contents: "second next\n", path: second },
    ])

    expect(await directoryState(directory)).toEqual([
      ["first.json", "first next\n"],
      ["second.json", "second next\n"],
    ])
  })

  for (const failingTarget of [0, 1] as const) {
    test(`leaves both originals byte-identical when target ${failingTarget} cannot be published`, async () => {
      const directory = await makeTemporaryDirectory()
      const paths = [join(directory, "first.json"), join(directory, "second.json")]
      await Promise.all([
        writeFile(paths[0], "first original\n"),
        writeFile(paths[1], "second original\n"),
      ])
      const before = await directoryState(directory)

      await expect(
        publishCapabilityArtifacts(
          [
            { contents: "first next\n", path: paths[0] },
            { contents: "second next\n", path: paths[1] },
          ],
          {
            beforePublish: (path) => {
              if (path === paths[failingTarget]) throw new Error("simulated publication failure")
            },
          },
        ),
      ).rejects.toThrow("simulated publication failure")

      expect(await directoryState(directory)).toEqual(before)
    })
  }

  test("removes a target it created when a later publication fails", async () => {
    const directory = await makeTemporaryDirectory()
    const created = join(directory, "created.json")
    const existing = join(directory, "existing.json")
    await writeFile(existing, "existing original\n")
    const before = await directoryState(directory)

    await expect(
      publishCapabilityArtifacts(
        [
          { contents: "created next\n", path: created },
          { contents: "existing next\n", path: existing },
        ],
        {
          beforePublish: (path) => {
            if (path === existing) throw new Error("simulated publication failure")
          },
        },
      ),
    ).rejects.toThrow("simulated publication failure")

    expect(await directoryState(directory)).toEqual(before)
  })

  test.skipIf(runsAsSuperuser)("leaves both originals when a target cannot be staged", async () => {
    const directory = await makeTemporaryDirectory()
    const readOnlyDirectory = join(directory, "read-only")
    const writable = join(directory, "writable.json")
    const locked = join(readOnlyDirectory, "locked.json")
    await mkdir(readOnlyDirectory)
    await Promise.all([
      writeFile(writable, "writable original\n"),
      writeFile(locked, "locked original\n"),
    ])
    const before = await Promise.all([
      directoryState(directory),
      directoryState(readOnlyDirectory),
    ])

    await chmod(readOnlyDirectory, 0o500)
    try {
      await expect(
        publishCapabilityArtifacts([
          { contents: "writable next\n", path: writable },
          { contents: "locked next\n", path: locked },
        ]),
      ).rejects.toThrow(/EACCES|permission denied/i)
    } finally {
      await chmod(readOnlyDirectory, 0o700)
    }

    expect(await Promise.all([directoryState(directory), directoryState(readOnlyDirectory)])).toEqual(
      before,
    )
  })

  // The two artifacts sit in different directories, so exactly one target is unwritable in each
  // run. Two independent writes would change the other one; the transaction changes neither.
  for (const [name, blockedDirectory] of [
    ["the manifest", (fixture: Fixture) => dirname(fixture.manifestPath)],
    ["the lock", (fixture: Fixture) => fixture.repositoryRoot],
  ] as const) {
    test.skipIf(runsAsSuperuser)(
      `write mode leaves both artifacts byte-identical when ${name} cannot be written`,
      async () => {
        const fixture = await makeFixture({ manifestDirectory: "config" })
        const directories = [fixture.repositoryRoot, dirname(fixture.manifestPath)]
        const before = await Promise.all([snapshot(fixture), ...directories.map(directoryState)])
        const blocked = blockedDirectory(fixture)

        await chmod(blocked, 0o500)
        try {
          await expect(syncCapabilityManifest({ ...fixture, mode: "write" })).rejects.toThrow(
            /EACCES|permission denied/i,
          )
        } finally {
          await chmod(blocked, 0o700)
        }

        expect(await Promise.all([snapshot(fixture), ...directories.map(directoryState)])).toEqual(
          before,
        )
      },
    )
  }
})

interface LockFixtureRecord {
  digest?: string
  manifest?: string
  package?: string
  published?: boolean
  revision?: number
  [key: string]: unknown
}

interface LockFixture {
  current: string
  history: LockFixtureRecord[]
  lockVersion: number
  [key: string]: unknown
}

interface FixtureOptions {
  committedManifestJSON?: string
  current?: string
  duplicateCurrent?: boolean
  lockDigest?: string
  manifestJSON?: string
  manifestDirectory?: string
  mutateLock?: (lock: LockFixture) => void
  omitPublished?: boolean
  published?: boolean
  releasedDigest?: string
}

type Fixture = Awaited<ReturnType<typeof makeFixture>>

async function makeFixture(options: FixtureOptions = {}) {
  const repositoryRoot = await makeTemporaryDirectory()
  const manifestRelativePath = options.manifestDirectory
    ? `${options.manifestDirectory}/manifest.json`
    : "manifest.json"
  if (options.manifestDirectory) await mkdir(join(repositoryRoot, options.manifestDirectory))
  const manifestPath = join(repositoryRoot, manifestRelativePath)
  const lockfilePath = join(repositoryRoot, "expo-turbo.lock.json")
  const manifestJSON = options.manifestJSON ?? (await loadDemoRegistryManifestJSON())
  const generatedDigest = JSON.parse(manifestJSON).hash
  const lockDigest = options.lockDigest ?? generatedDigest
  const current = options.current ?? lockDigest
  const currentRecord: LockFixtureRecord = {
    revision: 2,
    digest: lockDigest,
    ...(!options.omitPublished ? { published: options.published ?? false } : {}),
    package: "expo-turbo-example",
    manifest: manifestRelativePath,
  }
  const lock: LockFixture = {
    lockVersion: 1,
    current,
    history: [
      {
        revision: 1,
        digest: options.releasedDigest ?? releasedDigest,
        published: true,
        package: "expo-turbo-example",
        manifest: "released.json",
      },
      currentRecord,
      ...(options.duplicateCurrent ? [{ ...currentRecord, revision: 3 }] : []),
    ],
  }
  options.mutateLock?.(lock)
  await Promise.all([
    writeFile(manifestPath, options.committedManifestJSON ?? manifestJSON),
    writeFile(lockfilePath, `${JSON.stringify(lock, null, 2)}\n`),
  ])
  return { lockfilePath, manifestJSON, manifestPath, repositoryRoot }
}

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "expo-capability-artifacts-"))
  temporaryRoots.push(directory)
  return directory
}

async function directoryState(directory: string): Promise<[string, string][]> {
  const names = (await readdir(directory)).sort()
  const contents = await Promise.all(
    names.map(async (name) => {
      const path = join(directory, name)
      return (await stat(path)).isDirectory() ? "<directory>" : readFile(path, "utf8")
    }),
  )
  return names.map((name, index) => [name, contents[index]])
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

function seededDigest(seed: string): string {
  return `sha256-128:${createHash("sha256").update(seed).digest("hex").slice(0, 32)}`
}
