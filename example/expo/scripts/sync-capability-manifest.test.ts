import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
  loadDemoRegistryManifestJSON,
  publishCapabilityArtifacts,
  syncCapabilityManifest,
  writeProcessLockEvidence,
} from "./sync-capability-manifest"

const temporaryRoots: string[] = []
const releasedDigest = seededDigest("released")
const revertedDigest = seededDigest("reverted")
const spareDigest = seededDigest("spare")
// Directory permissions do not stop the superuser, so a real permission failure cannot be staged.
const runsAsSuperuser = process.getuid?.() === 0

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  )
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
    const stale = JSON.parse(fixture.manifestJSON)
    stale.components[0].aliases.push("older-valid-alias")
    stale.hash = manifestDigest(stale)
    await writeFile(fixture.manifestPath, `${JSON.stringify(stale, null, 2)}\n`)

    await expect(syncCapabilityManifest({ ...fixture, mode: "check" })).rejects.toThrow(
      /Stale Expo capability artifact/,
    )
    await expect(syncCapabilityManifest({ ...fixture, mode: "check" })).rejects.toThrow(
      /bun run capabilities:write/,
    )
  })

  test("check mode reports an absent manifest as stale with the repair command", async () => {
    const fixture = await makeFixture({ manifestExists: false })
    const processLockPath = `${fixture.lockfilePath}.capabilities.lock`

    await expect(syncCapabilityManifest({ ...fixture, mode: "check" })).rejects.toThrow(
      new RegExp(
        `Stale Expo capability artifact:\\n- ${escapeRegExp(fixture.manifestPath)}[\\s\\S]*Repair: cd example/expo && bun run capabilities:write`,
      ),
    )
    expect(await pathExists(fixture.manifestPath)).toBe(false)
    expect(await pathExists(processLockPath)).toBe(false)
    expect((await readdir(fixture.repositoryRoot)).filter(isTransactionFile)).toEqual([])
  })

  test("write mode rebuilds an absent manifest with the process umask and cleans its files", async () => {
    const fixture = await makeFixture({ manifestExists: false })
    const processLockPath = `${fixture.lockfilePath}.capabilities.lock`
    const previousUmask = process.umask(0o022)
    try {
      await syncCapabilityManifest({ ...fixture, mode: "write" })
    } finally {
      process.umask(previousUmask)
    }

    expect(await readFile(fixture.manifestPath, "utf8")).toBe(fixture.manifestJSON)
    expect((await stat(fixture.manifestPath)).mode & 0o777).toBe(0o644)
    expect(await pathExists(processLockPath)).toBe(false)
    expect((await readdir(fixture.repositoryRoot)).filter(isTransactionFile)).toEqual([])
    await syncCapabilityManifest({ ...fixture, mode: "check" })
  })

  for (const mode of ["check", "write"] as const) {
    for (const [field, mutate] of [
      [
        "component",
        (manifest: ManifestFixture) => {
          manifest.components[0].tag = "StaleTag"
        },
      ],
      [
        "module",
        (manifest: ManifestFixture) => {
          manifest.modules[0].name = "stale-module"
        },
      ],
      [
        "protocol",
        (manifest: ManifestFixture) => {
          manifest.protocolVersion = "stale-protocol"
        },
      ],
    ] as const) {
      test(`${mode} mode recomputes the generated ${field} hash from canonical content`, async () => {
        const generated = JSON.parse(await loadDemoRegistryManifestJSON()) as ManifestFixture
        mutate(generated)
        const fixture = await makeFixture({
          manifestJSON: `${JSON.stringify(generated, null, 2)}\n`,
        })
        const before = await snapshot(fixture)

        await expect(syncCapabilityManifest({ ...fixture, mode })).rejects.toThrow(
          /does not match its canonical content digest/,
        )
        expect(await snapshot(fixture)).toEqual(before)
      })
    }

    test(`${mode} mode rejects a committed manifest with a valid-format stale hash`, async () => {
      const generated = JSON.parse(await loadDemoRegistryManifestJSON()) as ManifestFixture
      generated.components[0].tag = "TamperedTag"
      const fixture = await makeFixture({
        committedManifestJSON: `${JSON.stringify(generated, null, 2)}\n`,
      })
      const before = await snapshot(fixture)

      await expect(syncCapabilityManifest({ ...fixture, mode })).rejects.toThrow(
        /committed capability manifest .* hash .* does not match its canonical content digest/,
      )
      expect(await snapshot(fixture)).toEqual(before)
    })
  }

  test("uses the Rails top-level canonical key order instead of manifest source order", async () => {
    const generated = JSON.parse(await loadDemoRegistryManifestJSON()) as ManifestFixture
    const reordered = {
      protocolVersion: generated.protocolVersion,
      modules: generated.modules,
      components: generated.components,
      manifestVersion: generated.manifestVersion,
      hash: generated.hash,
    }
    const manifestJSON = `${JSON.stringify(reordered, null, 2)}\n`
    const fixture = await makeFixture({ committedManifestJSON: manifestJSON, manifestJSON })

    await syncCapabilityManifest({ ...fixture, mode: "check" })
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
      /^Generated capability manifest hash .* does not match its canonical content digest/,
    )
    expect(await snapshot(fixture)).toEqual(before)
  })
})

describe("Expo capability artifact publication", () => {
  test("preserves 0600 and 0640 modes and the source owners", async () => {
    const fixture = await makeFixture()
    await chmod(fixture.manifestPath, 0o600)
    await chmod(fixture.lockfilePath, 0o640)
    const beforeManifest = await stat(fixture.manifestPath)
    const beforeLock = await stat(fixture.lockfilePath)

    await syncCapabilityManifest({ ...fixture, mode: "write" })

    const afterManifest = await stat(fixture.manifestPath)
    const afterLock = await stat(fixture.lockfilePath)
    expect(afterManifest.mode & 0o777).toBe(0o600)
    expect(afterLock.mode & 0o777).toBe(0o640)
    expect([afterManifest.uid, afterManifest.gid]).toEqual([beforeManifest.uid, beforeManifest.gid])
    expect([afterLock.uid, afterLock.gid]).toEqual([beforeLock.uid, beforeLock.gid])
    expect((await readdir(fixture.repositoryRoot)).sort()).toEqual([
      "expo-turbo.lock.json",
      "manifest.json",
    ])
  })

  test("stops on changed source bytes and restores an artifact it already published", async () => {
    const directory = await makeTemporaryDirectory()
    const first = join(directory, "first.json")
    const second = join(directory, "second.json")
    await Promise.all([
      writeFile(first, "first original\n"),
      writeFile(second, "second original\n"),
    ])

    await expect(
      publishCapabilityArtifacts(
        [
          { contents: "first next\n", path: first },
          { contents: "second next\n", path: second },
        ],
        {
          beforePublish: async (path) => {
            if (path === second) await writeFile(second, "external change\n")
          },
          transactionToken: "changed-source",
        },
      ),
    ).rejects.toThrow(/source changed after the transaction started/)

    expect(await directoryState(directory)).toEqual([
      ["first.json", "first original\n"],
      ["second.json", "external change\n"],
    ])
  })

  test("stops on changed source metadata before a publish rename", async () => {
    const directory = await makeTemporaryDirectory()
    const target = join(directory, "target.json")
    await writeFile(target, "original\n", { mode: 0o640 })

    await expect(
      publishCapabilityArtifacts([{ contents: "next\n", path: target }], {
        beforePublish: async () => chmod(target, 0o600),
        transactionToken: "changed-metadata",
      }),
    ).rejects.toThrow(/source changed after the transaction started/)

    expect(await readFile(target, "utf8")).toBe("original\n")
    expect((await stat(target)).mode & 0o777).toBe(0o600)
    expect(await directoryState(directory)).toEqual([["target.json", "original\n"]])
  })

  for (const suffix of ["staged", "backup"] as const) {
    test(`refuses a symlinked ${suffix} path without changing a target`, async () => {
      const directory = await makeTemporaryDirectory()
      const target = join(directory, "target.json")
      const unrelated = join(directory, "unrelated.txt")
      const collision = `${target}.symlink-${suffix}.${suffix}`
      await Promise.all([writeFile(target, "original\n"), writeFile(unrelated, "unrelated\n")])
      await symlink(unrelated, collision)

      await expect(
        publishCapabilityArtifacts([{ contents: "next\n", path: target }], {
          transactionToken: `symlink-${suffix}`,
        }),
      ).rejects.toThrow(/must not be a symlink/)

      expect(await readFile(target, "utf8")).toBe("original\n")
      expect(await readFile(unrelated, "utf8")).toBe("unrelated\n")
      expect((await lstat(collision)).isSymbolicLink()).toBe(true)
    })
  }

  test("an existing temp name cannot be overwritten or removed", async () => {
    const directory = await makeTemporaryDirectory()
    const target = join(directory, "target.json")
    const collision = `${target}.collision.staged`
    await Promise.all([writeFile(target, "original\n"), writeFile(collision, "unrelated\n")])

    await expect(
      publishCapabilityArtifacts([{ contents: "next\n", path: target }], {
        transactionToken: "collision",
      }),
    ).rejects.toThrow(/Refusing to replace an existing.*temp or backup/)

    expect(await readFile(target, "utf8")).toBe("original\n")
    expect(await readFile(collision, "utf8")).toBe("unrelated\n")
  })

  for (const sourceName of ["manifest", "lock"] as const) {
    test(`rejects a symlinked ${sourceName} source and removes its own process lock`, async () => {
      const fixture = await makeFixture()
      const sourcePath = sourceName === "manifest" ? fixture.manifestPath : fixture.lockfilePath
      const unrelated = join(fixture.repositoryRoot, `${sourceName}-unrelated.json`)
      const original = await readFile(sourcePath)
      await writeFile(unrelated, original)
      await rm(sourcePath)
      await symlink(unrelated, sourcePath)

      await expect(syncCapabilityManifest({ ...fixture, mode: "write" })).rejects.toThrow(
        /source path must not be a symlink/,
      )

      expect((await lstat(sourcePath)).isSymbolicLink()).toBe(true)
      expect(await readFile(unrelated)).toEqual(original)
      expect(await pathExists(`${fixture.lockfilePath}.capabilities.lock`)).toBe(false)
    })
  }

  test("rejects a symlinked process lock before an artifact write", async () => {
    const fixture = await makeFixture()
    const processLockPath = join(fixture.repositoryRoot, "custom.lock")
    const unrelated = join(fixture.repositoryRoot, "unrelated.lock")
    await writeFile(unrelated, "unrelated\n")
    await symlink(unrelated, processLockPath)
    const before = await snapshot(fixture)

    await expect(
      syncCapabilityManifest({ ...fixture, mode: "write", processLockPath }),
    ).rejects.toThrow(/process lock path must not be a symlink/)

    expect(await snapshot(fixture)).toEqual(before)
    expect(await readFile(unrelated, "utf8")).toBe("unrelated\n")
    expect((await lstat(processLockPath)).isSymbolicLink()).toBe(true)
  })

  test("does not auto-delete a stale lock with PID and token evidence", async () => {
    const fixture = await makeFixture()
    const processLockPath = `${fixture.lockfilePath}.capabilities.lock`
    const evidence = `${JSON.stringify({ version: 1, pid: 999999, token: "manual-token", phase: "publishing:1" })}\n`
    await writeFile(processLockPath, evidence)
    const before = await snapshot(fixture)

    await expect(syncCapabilityManifest({ ...fixture, mode: "write" })).rejects.toThrow(
      /PID 999999, token manual-token, phase publishing:1.*manual recovery/,
    )

    expect(await snapshot(fixture)).toEqual(before)
    expect(await readFile(processLockPath, "utf8")).toBe(evidence)
  })

  test("replaces every target and leaves no temporary or backup file", async () => {
    const directory = await makeTemporaryDirectory()
    const first = join(directory, "first.json")
    const second = join(directory, "second.json")
    await Promise.all([
      writeFile(first, "first original\n"),
      writeFile(second, "second original\n"),
    ])

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
    const before = await Promise.all([directoryState(directory), directoryState(readOnlyDirectory)])

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

    expect(
      await Promise.all([directoryState(directory), directoryState(readOnlyDirectory)]),
    ).toEqual(before)
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

describe("Expo capability process locking", () => {
  test("does not empty existing evidence when a replacement write fails", async () => {
    const directory = await makeTemporaryDirectory()
    const processLockPath = join(directory, "process.lock")
    const previousEvidence = "previous readable evidence\n"
    await writeFile(processLockPath, previousEvidence)
    const handle = await open(processLockPath, "r+")
    const failingHandle = {
      sync: handle.sync.bind(handle),
      truncate: handle.truncate.bind(handle),
      write: async () => {
        throw new Error("simulated evidence write failure")
      },
    } as unknown as Parameters<typeof writeProcessLockEvidence>[0]

    try {
      await expect(
        writeProcessLockEvidence(failingHandle, {
          artifacts: ["manifest.json", "expo-turbo.lock.json"],
          phase: "publishing:1",
          pid: process.pid,
          startedAt: new Date(0).toISOString(),
          token: "evidence-failure",
          version: 1,
        }),
      ).rejects.toThrow("simulated evidence write failure")
    } finally {
      await handle.close()
    }

    expect(await readFile(processLockPath, "utf8")).toBe(previousEvidence)
  })

  test("writes 0600 PID, token, artifact, and phase evidence and removes its own lock", async () => {
    const fixture = await makeFixture()
    const processLockPath = `${fixture.lockfilePath}.capabilities.lock`
    let evidence: Record<string, unknown> | undefined
    let lockMode: number | undefined

    await syncCapabilityManifest({
      ...fixture,
      afterLockAcquired: async () => {
        evidence = JSON.parse(await readFile(processLockPath, "utf8"))
        lockMode = (await stat(processLockPath)).mode & 0o777
      },
      mode: "check",
      publishOptions: { transactionToken: "evidence-token" },
    })

    expect(lockMode).toBe(0o600)
    expect(evidence).toMatchObject({
      artifacts: [fixture.manifestPath, fixture.lockfilePath],
      phase: "locked-before-source-read",
      pid: process.pid,
      token: "evidence-token",
      version: 1,
    })
    expect(await pathExists(processLockPath)).toBe(false)
  })

  for (const [name, contents] of [
    ["unreadable", "not JSON\n"],
    ["empty", ""],
  ] as const) {
    test(`${name} process-lock evidence fails closed without claiming a token`, async () => {
      const fixture = await makeFixture()
      const processLockPath = `${fixture.lockfilePath}.capabilities.lock`
      await writeFile(processLockPath, contents)
      const before = await snapshot(fixture)

      let message = ""
      try {
        await syncCapabilityManifest({ ...fixture, mode: "write" })
      } catch (error) {
        message = error instanceof Error ? error.message : String(error)
      }

      expect(message).toContain("evidence is unreadable")
      expect(message).toContain("no usable PID or token")
      expect(message).toContain("inspect and list every *.staged and *.backup file")
      expect(message).toContain(fixture.manifestPath)
      expect(message).toContain(fixture.lockfilePath)
      expect(message).not.toMatch(/token-named|prove that the PID is dead/)
      expect(await readFile(processLockPath, "utf8")).toBe(contents)
      expect(await snapshot(fixture)).toEqual(before)
    })
  }

  test("lets one subprocess finish and makes an overlapping subprocess fail closed", async () => {
    const fixture = await makeFixture()
    const directory = fixture.repositoryRoot
    const workerPath = join(directory, "sync-worker.ts")
    const firstConfigPath = join(directory, "first-config.json")
    const secondConfigPath = join(directory, "second-config.json")
    const markerPath = join(directory, "first-holds-lock")
    const releasePath = join(directory, "release-first")
    const firstResultPath = join(directory, "first-result")
    const secondResultPath = join(directory, "second-result")
    const importURL = new URL("./sync-capability-manifest.ts", import.meta.url).href
    await writeFile(
      workerPath,
      `import { access, readFile, writeFile } from "node:fs/promises"\nimport { syncCapabilityManifest } from ${JSON.stringify(importURL)}\nconst config = JSON.parse(await readFile(process.argv[2], "utf8"))\ntry {\n  await syncCapabilityManifest({\n    ...config.fixture,\n    mode: "write",\n    afterLockAcquired: config.markerPath ? async () => {\n      await writeFile(config.markerPath, "held\\n")\n      for (;;) {\n        try { await access(config.releasePath); break } catch { await Bun.sleep(5) }\n      }\n    } : undefined,\n  })\n  await writeFile(config.resultPath, "success\\n")\n} catch (error) {\n  await writeFile(config.resultPath, (error instanceof Error ? error.message : String(error)) + "\\n")\n  process.exitCode = 1\n}\n`,
    )
    const serializedFixture = {
      lockfilePath: fixture.lockfilePath,
      manifestJSON: fixture.manifestJSON,
      manifestPath: fixture.manifestPath,
      repositoryRoot: fixture.repositoryRoot,
    }
    await Promise.all([
      writeFile(
        firstConfigPath,
        JSON.stringify({
          fixture: serializedFixture,
          markerPath,
          releasePath,
          resultPath: firstResultPath,
        }),
      ),
      writeFile(
        secondConfigPath,
        JSON.stringify({ fixture: serializedFixture, resultPath: secondResultPath }),
      ),
    ])
    const before = await snapshot(fixture)

    const first = Bun.spawn({
      cmd: [process.execPath, workerPath, firstConfigPath],
      stderr: "pipe",
      stdout: "pipe",
    })
    await waitForPath(markerPath)
    const second = Bun.spawn({
      cmd: [process.execPath, workerPath, secondConfigPath],
      stderr: "pipe",
      stdout: "pipe",
    })
    expect(await second.exited).toBe(1)
    expect(await readFile(secondResultPath, "utf8")).toMatch(
      /Another Expo capability sync owns.*No file was changed/,
    )
    expect(await snapshot(fixture)).toEqual(before)

    await writeFile(releasePath, "release\n")
    expect(await first.exited).toBe(0)
    expect(await readFile(firstResultPath, "utf8")).toBe("success\n")
    await syncCapabilityManifest({ ...fixture, mode: "check" })
    expect(await pathExists(`${fixture.lockfilePath}.capabilities.lock`)).toBe(false)
    expect((await readdir(directory)).filter((name) => /\.(?:staged|backup)$/.test(name))).toEqual(
      [],
    )
  })
})

interface ManifestFixture {
  components: Array<{ aliases: string[]; tag: string }>
  hash: string
  manifestVersion: number
  modules: Array<{ name: string }>
  protocolVersion: string
}

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
  manifestExists?: boolean
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
  const writes = [writeFile(lockfilePath, `${JSON.stringify(lock, null, 2)}\n`)]
  if (options.manifestExists !== false) {
    writes.push(writeFile(manifestPath, options.committedManifestJSON ?? manifestJSON))
  }
  await Promise.all(writes)
  return { lockfilePath, manifestJSON, manifestPath, repositoryRoot }
}

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "expo-capability-artifacts-"))
  temporaryRoots.push(directory)
  return directory
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function waitForPath(path: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!(await pathExists(path))) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for subprocess marker ${path}`)
    await Bun.sleep(5)
  }
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

function isTransactionFile(name: string): boolean {
  return /\.(?:staged|backup)$/.test(name)
}

function escapeRegExp(source: string): string {
  return source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
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
