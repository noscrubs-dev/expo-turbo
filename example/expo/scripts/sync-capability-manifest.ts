import { mock } from "bun:test"
import { randomUUID } from "node:crypto"
import { copyFile, open, readFile, rename, rm } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { verifyInstalledPackage } from "./verify-installed-expo-turbo.mjs"

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const defaultRepositoryRoot = resolve(scriptDirectory, "../../..")
const defaultLockfilePath = resolve(defaultRepositoryRoot, "expo-turbo.lock.json")
const defaultManifestPath = resolve(
  defaultRepositoryRoot,
  "example/rails/config/expo_turbo_manifest.json",
)
const repairCommand = "cd example/expo && bun run capabilities:write"

// ExpoTurbo::Rails::CompatibilityRegistry refuses to load a lock that breaks any of these, so a
// lock this script accepts but Rails rejects would only fail after it reached a host.
const lockVersion = 1
const digestPattern = /^sha256-128:[0-9a-f]{32}$/

type Mode = "check" | "write"

interface LockRecord {
  digest?: unknown
  manifest?: unknown
  package?: unknown
  published?: unknown
  readonly [key: string]: unknown
}

interface CompatibilityLock {
  current?: unknown
  history?: unknown
  readonly [key: string]: unknown
}

interface SyncCapabilityManifestOptions {
  lockfilePath?: string
  manifestJSON: string
  manifestPath?: string
  mode: Mode
  repositoryRoot?: string
}

export async function syncCapabilityManifest({
  lockfilePath = defaultLockfilePath,
  manifestJSON,
  manifestPath = defaultManifestPath,
  mode,
  repositoryRoot = defaultRepositoryRoot,
}: SyncCapabilityManifestOptions): Promise<{ digest: string }> {
  if (mode !== "check" && mode !== "write") throw new Error(`Unsupported mode ${JSON.stringify(mode)}`)

  const generatedManifest = parseObject(manifestJSON, "generated capability manifest")
  const digest = requireString(generatedManifest.hash, "generated capability manifest hash")
  const modules = generatedManifest.modules
  if (!Array.isArray(modules)) throw new Error("Generated capability manifest modules must be an array")

  const lockfileSource = await readFile(lockfilePath, "utf8")
  const lock = parseObject(lockfileSource, `compatibility lock ${lockfilePath}`) as CompatibilityLock
  const current = requireString(lock.current, "compatibility lock current digest")
  if (!Array.isArray(lock.history)) throw new Error("Compatibility lock history must be an array")

  const currentRecords = lock.history.filter(
    (record): record is LockRecord => isObject(record) && record.digest === current,
  )
  if (currentRecords.length === 0) {
    throw new Error(`Compatibility lock has no history record for current digest ${JSON.stringify(current)}`)
  }
  if (currentRecords.length !== 1) {
    throw new Error(
      `Compatibility lock has ${currentRecords.length} history records for current digest ${JSON.stringify(current)}; expected exactly one`,
    )
  }

  const target = currentRecords[0]
  if (target.published !== false) {
    throw new Error(
      `Compatibility lock current record ${JSON.stringify(current)} is published or immutable; add a new unpublished current record instead`,
    )
  }

  const manifestRelativePath = requireString(target.manifest, "current lock record manifest")
  const lockedManifestPath = resolve(repositoryRoot, manifestRelativePath)
  if (lockedManifestPath !== resolve(manifestPath)) {
    throw new Error(
      `Compatibility lock current record points to ${JSON.stringify(manifestRelativePath)}, not ${JSON.stringify(relativePath(repositoryRoot, manifestPath))}`,
    )
  }

  const packageName = requireString(target.package, "current lock record package")
  const moduleNames = modules.map((module, index) => {
    if (!isObject(module)) throw new Error(`Generated capability manifest modules[${index}] must be an object`)
    return requireString(module.name, `generated capability manifest modules[${index}].name`)
  })
  if (!moduleNames.includes(packageName)) {
    throw new Error(
      `Compatibility lock package ${JSON.stringify(packageName)} is not in generated manifest modules ${JSON.stringify(moduleNames)}`,
    )
  }

  assertRailsLockInvariants(lock, "Compatibility lock")

  const targetIndex = lock.history.indexOf(target)
  const conflictIndex = lock.history.findIndex(
    (record, index) => index !== targetIndex && isObject(record) && record.digest === digest,
  )
  if (conflictIndex !== -1) {
    throw new Error(
      `Generated registry digest ${JSON.stringify(digest)} already belongs to compatibility lock history record ${conflictIndex}; record ${targetIndex} cannot take it because Rails requires unique digests.\nThe registry reverted to an earlier capability set: restore the intended registry change, or retire the stale history record before you record this one.`,
    )
  }

  const expectedLock = structuredClone(lock)
  const expectedHistory = expectedLock.history as LockRecord[]
  expectedLock.current = digest
  expectedHistory[targetIndex] = { ...expectedHistory[targetIndex], digest }
  assertRailsLockInvariants(expectedLock, "Updated compatibility lock")
  const expectedLockSource = `${JSON.stringify(expectedLock, null, 2)}\n`

  if (mode === "check") {
    const stale: string[] = []
    const committedManifest = await readFile(manifestPath, "utf8").catch(() => undefined)
    if (committedManifest !== manifestJSON) stale.push(manifestPath)
    if (lockfileSource !== expectedLockSource) stale.push(lockfilePath)
    if (stale.length > 0) {
      throw new Error(
        `Stale Expo capability artifact${stale.length === 1 ? "" : "s"}:\n${stale.map((path) => `- ${path}`).join("\n")}\nExpected registry digest: ${digest}\nRepair: ${repairCommand}`,
      )
    }
    return { digest }
  }

  await publishCapabilityArtifacts([
    { contents: manifestJSON, path: manifestPath },
    { contents: expectedLockSource, path: lockfilePath },
  ])
  return { digest }
}

export interface CapabilityArtifactWrite {
  contents: string
  path: string
}

export interface PublishCapabilityArtifactsOptions {
  /** Runs immediately before each target is replaced, so a test can fail one exact publication. */
  beforePublish?: (path: string) => Promise<void> | void
}

interface StagedArtifact {
  backupPath: string
  contents: string
  path: string
  restore: boolean
  temporaryPath: string
}

/**
 * Replaces every target or none of them. Each artifact is staged and read back beside its target,
 * every replaced original is copied aside, and any failure restores the targets already published.
 * Temporary and backup files never outlive the call.
 *
 * POSIX has no multi-file rename, so the publication loop is atomic per file but not across files:
 * a crash between two renames can leave one target published, with the other original still in its
 * backup file. Only a crash can do this; every error this process observes is rolled back.
 */
export async function publishCapabilityArtifacts(
  writes: readonly CapabilityArtifactWrite[],
  { beforePublish }: PublishCapabilityArtifactsOptions = {},
): Promise<void> {
  const suffix = randomUUID()
  const staged: StagedArtifact[] = writes.map((write) => ({
    backupPath: `${write.path}.${suffix}.backup`,
    contents: write.contents,
    path: write.path,
    restore: false,
    temporaryPath: `${write.path}.${suffix}.staged`,
  }))
  const published: StagedArtifact[] = []

  try {
    for (const artifact of staged) {
      await writeFileDurably(artifact.temporaryPath, artifact.contents)
      if ((await readFile(artifact.temporaryPath, "utf8")) !== artifact.contents) {
        throw new Error(`Staged Expo capability artifact for ${artifact.path} does not match the generated content`)
      }
    }
    for (const artifact of staged) {
      artifact.restore = await backUpFile(artifact.path, artifact.backupPath)
    }
    for (const artifact of staged) {
      await beforePublish?.(artifact.path)
      await rename(artifact.temporaryPath, artifact.path)
      published.push(artifact)
    }
  } catch (error) {
    await restorePublishedArtifacts(published, error)
    throw error
  } finally {
    await Promise.all(
      staged.flatMap((artifact) => [
        rm(artifact.temporaryPath, { force: true }),
        rm(artifact.backupPath, { force: true }),
      ]),
    )
  }
}

export async function loadDemoRegistryManifestJSON(): Promise<string> {
  const nativeComponent = () => null
  mock.module("react-native", () => ({
    AccessibilityInfo: { announceForAccessibility: () => undefined },
    Alert: { alert: () => undefined },
    AppState: { addEventListener: () => ({ remove: () => undefined }), currentState: "active" },
    FlatList: nativeComponent,
    InteractionManager: {
      runAfterInteractions(callback: () => void) {
        callback()
        return { cancel: () => undefined }
      },
    },
    Keyboard: { addListener: () => ({ remove: () => undefined }), dismiss: () => undefined },
    Linking: { openURL: async () => undefined },
    Platform: { OS: "web" },
    Pressable: nativeComponent,
    ScrollView: nativeComponent,
    Switch: nativeComponent,
    Text: nativeComponent,
    TextInput: nativeComponent,
    useWindowDimensions: () => ({ height: 844, width: 390 }),
    View: nativeComponent,
  }))
  const { DEMO_REGISTRY } = await import("../src/demo-registry")
  return DEMO_REGISTRY.capabilityManifestJSON()
}

/**
 * Rejects every lock ExpoTurbo::Rails::CompatibilityRegistry rejects. The two runtimes read one
 * file, so an invariant enforced only in Rails turns a mechanical repair into a host failure.
 */
function assertRailsLockInvariants(lock: CompatibilityLock, label: string): void {
  if (lock.lockVersion !== lockVersion) {
    throw new Error(`${label} lockVersion must be ${lockVersion}, not ${JSON.stringify(lock.lockVersion)}; Rails refuses every other value`)
  }
  const history = lock.history
  if (!Array.isArray(history)) throw new Error(`${label} history must be an array`)

  const digestOwners = new Map<string, number>()
  const revisionOwners = new Map<number, number>()
  history.forEach((record, index) => {
    if (!isObject(record)) throw new Error(`${label} history[${index}] must be an object`)

    const { digest, manifest, revision } = record
    if (typeof digest !== "string" || !digestPattern.test(digest)) {
      throw new Error(`${label} history[${index}].digest must be sha256-128: and 32 lowercase hexadecimal characters, not ${JSON.stringify(digest)}`)
    }
    if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision <= 0) {
      throw new Error(`${label} history[${index}].revision must be a positive integer, not ${JSON.stringify(revision)}`)
    }
    if (typeof manifest !== "string" || manifest.length === 0) {
      throw new Error(`${label} history[${index}].manifest must be a string; Rails reads a manifest file for every history record`)
    }

    const digestOwner = digestOwners.get(digest)
    if (digestOwner !== undefined) {
      throw new Error(`${label} history[${index}].digest ${JSON.stringify(digest)} repeats history[${digestOwner}].digest; Rails requires unique digests`)
    }
    const revisionOwner = revisionOwners.get(revision)
    if (revisionOwner !== undefined) {
      throw new Error(`${label} history[${index}].revision ${revision} repeats history[${revisionOwner}].revision; Rails requires unique revisions`)
    }
    digestOwners.set(digest, index)
    revisionOwners.set(revision, index)
  })

  if (typeof lock.current !== "string" || !digestOwners.has(lock.current)) {
    throw new Error(`${label} has no history record for current digest ${JSON.stringify(lock.current)}`)
  }
}

async function writeFileDurably(path: string, contents: string): Promise<void> {
  const handle = await open(path, "w")
  try {
    await handle.writeFile(contents)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function backUpFile(path: string, backupPath: string): Promise<boolean> {
  try {
    await copyFile(path, backupPath)
    return true
  } catch (error) {
    if (isObject(error) && error.code === "ENOENT") return false
    throw error
  }
}

async function restorePublishedArtifacts(published: readonly StagedArtifact[], cause: unknown): Promise<void> {
  const failures: string[] = []
  for (const artifact of [...published].reverse()) {
    try {
      if (artifact.restore) await rename(artifact.backupPath, artifact.path)
      else await rm(artifact.path, { force: true })
    } catch (error) {
      failures.push(`- ${artifact.path}: ${describeError(error)}`)
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `Cannot restore Expo capability artifacts after a failed publication (${describeError(cause)}):\n${failures.join("\n")}`,
    )
  }
}

function parseObject(source: string, label: string): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(source)
  } catch (error) {
    throw new Error(`Cannot parse ${label}: ${describeError(error)}`)
  }
  if (!isObject(value)) throw new Error(`${label} must be a JSON object`)
  return value
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a string`)
  return value
}

function relativePath(root: string, path: string): string {
  const normalizedRoot = resolve(root)
  const normalizedPath = resolve(path)
  return normalizedPath.startsWith(`${normalizedRoot}/`)
    ? normalizedPath.slice(normalizedRoot.length + 1)
    : normalizedPath
}

async function main(): Promise<void> {
  const argument = process.argv[2]
  if ((argument !== "--check" && argument !== "--write") || process.argv.length !== 3) {
    throw new Error("Usage: bun scripts/sync-capability-manifest.ts --check|--write")
  }
  await verifyInstalledPackage()
  const manifestJSON = await loadDemoRegistryManifestJSON()
  const result = await syncCapabilityManifest({
    manifestJSON,
    mode: argument === "--check" ? "check" : "write",
  })
  process.stdout.write(
    argument === "--check"
      ? `Expo capability artifacts are current (${result.digest}).\n`
      : `Wrote Expo capability artifacts (${result.digest}).\n`,
  )
}

if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(`${describeError(error)}\n`)
    process.exitCode = 1
  })
}
