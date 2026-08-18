import { mock } from "bun:test"
import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import type { FileHandle } from "node:fs/promises"
import { lstat, open, readFile, rename, rm } from "node:fs/promises"
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
  /** Test-only synchronization point. The process lock is already durable, but no source was read. */
  afterLockAcquired?: () => Promise<void> | void
  lockfilePath?: string
  manifestJSON: string
  manifestPath?: string
  mode: Mode
  processLockPath?: string
  publishOptions?: PublishCapabilityArtifactsOptions
  repositoryRoot?: string
}

export async function syncCapabilityManifest({
  afterLockAcquired,
  lockfilePath = defaultLockfilePath,
  manifestJSON,
  manifestPath = defaultManifestPath,
  mode,
  processLockPath = `${lockfilePath}.capabilities.lock`,
  publishOptions,
  repositoryRoot = defaultRepositoryRoot,
}: SyncCapabilityManifestOptions): Promise<{ digest: string }> {
  if (mode !== "check" && mode !== "write")
    throw new Error(`Unsupported mode ${JSON.stringify(mode)}`)

  const transactionToken = publishOptions?.transactionToken ?? randomUUID()
  assertSafeToken(transactionToken)
  const processLock = await acquireProcessLock(processLockPath, transactionToken, [
    manifestPath,
    lockfilePath,
  ])
  let recoveryRequired = false
  try {
    await afterLockAcquired?.()
    return await syncCapabilityManifestUnderLock({
      lockfilePath,
      manifestJSON,
      manifestPath,
      mode,
      processLock,
      publishOptions: { ...publishOptions, transactionToken },
      repositoryRoot,
    })
  } catch (error) {
    recoveryRequired = error instanceof RecoveryRequiredError
    throw error
  } finally {
    if (recoveryRequired) await closeProcessLockWithoutRemoval(processLock)
    else await releaseProcessLock(processLock)
  }
}

interface SyncCapabilityManifestUnderLockOptions {
  lockfilePath: string
  manifestJSON: string
  manifestPath: string
  mode: Mode
  processLock: ProcessLock
  publishOptions: PublishCapabilityArtifactsOptions
  repositoryRoot: string
}

async function syncCapabilityManifestUnderLock({
  lockfilePath,
  manifestJSON,
  manifestPath,
  mode,
  processLock,
  publishOptions,
  repositoryRoot,
}: SyncCapabilityManifestUnderLockOptions): Promise<{ digest: string }> {
  const generatedManifest = parseObject(manifestJSON, "generated capability manifest")
  const storedDigest = requireString(generatedManifest.hash, "generated capability manifest hash")
  const digest = canonicalManifestDigest(generatedManifest)
  if (storedDigest !== digest) {
    throw new Error(
      `Generated capability manifest hash ${JSON.stringify(storedDigest)} does not match its canonical content digest ${JSON.stringify(digest)}`,
    )
  }
  const modules = generatedManifest.modules
  if (!Array.isArray(modules))
    throw new Error("Generated capability manifest modules must be an array")

  const [lockfileSnapshot, manifestSnapshot] = await Promise.all([
    captureRegularFile(lockfilePath),
    captureArtifactSource(manifestPath),
  ])
  if (manifestSnapshot.exists) {
    assertManifestStoredHashMatchesContent(
      manifestSnapshot.contents.toString("utf8"),
      `committed capability manifest ${manifestPath}`,
    )
  }
  const lockfileSource = lockfileSnapshot.contents.toString("utf8")
  const lock = parseObject(
    lockfileSource,
    `compatibility lock ${lockfilePath}`,
  ) as CompatibilityLock
  const current = requireString(lock.current, "compatibility lock current digest")
  if (!Array.isArray(lock.history)) throw new Error("Compatibility lock history must be an array")

  const currentRecords = lock.history.filter(
    (record): record is LockRecord => isObject(record) && record.digest === current,
  )
  if (currentRecords.length === 0) {
    throw new Error(
      `Compatibility lock has no history record for current digest ${JSON.stringify(current)}`,
    )
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
    if (!isObject(module))
      throw new Error(`Generated capability manifest modules[${index}] must be an object`)
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
    const committedManifest = manifestSnapshot.exists
      ? manifestSnapshot.contents.toString("utf8")
      : undefined
    if (committedManifest !== manifestJSON) stale.push(manifestPath)
    if (lockfileSource !== expectedLockSource) stale.push(lockfilePath)
    if (stale.length > 0) {
      throw new Error(
        `Stale Expo capability artifact${stale.length === 1 ? "" : "s"}:\n${stale.map((path) => `- ${path}`).join("\n")}\nExpected registry digest: ${digest}\nRepair: ${repairCommand}`,
      )
    }
    return { digest }
  }

  await publishCapabilityArtifacts(
    [
      { contents: manifestJSON, original: manifestSnapshot, path: manifestPath },
      { contents: expectedLockSource, original: lockfileSnapshot, path: lockfilePath },
    ],
    {
      ...publishOptions,
      recordPhase: (phase) => updateProcessLockPhase(processLock, phase),
    },
  )
  return { digest }
}

export interface CapabilityArtifactWrite {
  contents: string
  /** Captured while the process lock is held. Omit only when using this low-level test helper. */
  original?: CapturedArtifactSource
  path: string
}

export interface PublishCapabilityArtifactsOptions {
  /** Runs immediately before each target is replaced, so a test can fail one exact publication. */
  beforePublish?: (path: string) => Promise<void> | void
  /** A safe fixed value lets tests prove that an existing temp name is never overwritten. */
  transactionToken?: string
  /** The process lock uses this to record durable recovery state. */
  recordPhase?: (phase: string) => Promise<void> | void
}

interface StagedArtifact {
  backupPath: string
  backupCreated: boolean
  contents: string
  original: CapturedArtifactSource
  path: string
  restore: boolean
  temporaryPath: string
  temporaryCreated: boolean
}

/**
 * Replaces every target or restores every original after a handled failure. The caller must hold
 * the process lock. Each original is captured before staging and is checked again immediately
 * before its rename. Temp and backup names are exclusive and cannot replace existing files.
 *
 * POSIX has no multi-file rename, so the publication loop is atomic per file but not across files:
 * a crash between two renames can leave one target published, with the other original still in its
 * backup file. A process crash still has this window. The durable process lock fails closed until
 * an operator uses its PID and token evidence to finish recovery. Every error observed by this
 * process is rolled back and cleaned up before the process lock is removed.
 */
export async function publishCapabilityArtifacts(
  writes: readonly CapabilityArtifactWrite[],
  {
    beforePublish,
    recordPhase,
    transactionToken = randomUUID(),
  }: PublishCapabilityArtifactsOptions = {},
): Promise<void> {
  assertSafeToken(transactionToken)
  const staged: StagedArtifact[] = []
  for (const write of writes) {
    const original = write.original ?? (await captureArtifactSource(write.path))
    staged.push({
      backupPath: `${write.path}.${transactionToken}.backup`,
      backupCreated: false,
      contents: write.contents,
      original,
      path: write.path,
      restore: false,
      temporaryPath: `${write.path}.${transactionToken}.staged`,
      temporaryCreated: false,
    })
  }
  const published: StagedArtifact[] = []
  let publicationError: unknown

  try {
    await recordPhase?.("staging")
    for (const artifact of staged) {
      await writeExclusiveFileDurably(
        artifact.temporaryPath,
        Buffer.from(artifact.contents),
        artifact.original.exists ? artifact.original.metadata : undefined,
      )
      artifact.temporaryCreated = true
      if ((await readFile(artifact.temporaryPath, "utf8")) !== artifact.contents) {
        throw new Error(
          `Staged Expo capability artifact for ${artifact.path} does not match the generated content`,
        )
      }
    }
    await recordPhase?.("backing-up")
    for (const artifact of staged) {
      if (!artifact.original.exists) continue
      await writeExclusiveFileDurably(
        artifact.backupPath,
        artifact.original.contents,
        artifact.original.metadata,
      )
      artifact.backupCreated = true
      artifact.restore = true
    }
    for (const [index, artifact] of staged.entries()) {
      await recordPhase?.(`publishing:${index}`)
      await beforePublish?.(artifact.path)
      await assertOriginalUnchanged(artifact.original)
      await rename(artifact.temporaryPath, artifact.path)
      artifact.temporaryCreated = false
      published.push(artifact)
      await syncRegularFileAndParent(artifact.path)
    }
    await recordPhase?.("published")
  } catch (error) {
    publicationError = error
    try {
      await recordPhase?.("rolling-back")
      await restorePublishedArtifacts(published, error)
    } catch (recoveryError) {
      await Promise.resolve(recordPhase?.("recovery-required:restore")).catch(() => undefined)
      throw new RecoveryRequiredError(
        `Manual recovery is required after Expo capability rollback failed: ${describeError(recoveryError)}`,
      )
    }
  }

  try {
    await recordPhase?.("cleaning-up")
    const cleanupFailures: string[] = []
    for (const artifact of staged) {
      if (artifact.temporaryCreated) {
        try {
          await removeOwnedRegularFileDurably(artifact.temporaryPath)
          artifact.temporaryCreated = false
        } catch (error) {
          cleanupFailures.push(`- ${artifact.temporaryPath}: ${describeError(error)}`)
        }
      }
      if (artifact.backupCreated) {
        try {
          await removeOwnedRegularFileDurably(artifact.backupPath)
          artifact.backupCreated = false
        } catch (error) {
          cleanupFailures.push(`- ${artifact.backupPath}: ${describeError(error)}`)
        }
      }
    }
    if (cleanupFailures.length > 0) {
      throw new Error(cleanupFailures.join("\n"))
    }
    await recordPhase?.("clean")
  } catch (error) {
    await Promise.resolve(recordPhase?.("recovery-required:cleanup")).catch(() => undefined)
    throw new RecoveryRequiredError(
      `Manual recovery is required after Expo capability cleanup failed: ${describeError(error)}`,
    )
  }

  if (publicationError !== undefined) throw publicationError
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
    throw new Error(
      `${label} lockVersion must be ${lockVersion}, not ${JSON.stringify(lock.lockVersion)}; Rails refuses every other value`,
    )
  }
  const history = lock.history
  if (!Array.isArray(history)) throw new Error(`${label} history must be an array`)

  const digestOwners = new Map<string, number>()
  const revisionOwners = new Map<number, number>()
  history.forEach((record, index) => {
    if (!isObject(record)) throw new Error(`${label} history[${index}] must be an object`)

    const { digest, manifest, revision } = record
    if (typeof digest !== "string" || !digestPattern.test(digest)) {
      throw new Error(
        `${label} history[${index}].digest must be sha256-128: and 32 lowercase hexadecimal characters, not ${JSON.stringify(digest)}`,
      )
    }
    if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision <= 0) {
      throw new Error(
        `${label} history[${index}].revision must be a positive integer, not ${JSON.stringify(revision)}`,
      )
    }
    if (typeof manifest !== "string" || manifest.length === 0) {
      throw new Error(
        `${label} history[${index}].manifest must be a string; Rails reads a manifest file for every history record`,
      )
    }

    const digestOwner = digestOwners.get(digest)
    if (digestOwner !== undefined) {
      throw new Error(
        `${label} history[${index}].digest ${JSON.stringify(digest)} repeats history[${digestOwner}].digest; Rails requires unique digests`,
      )
    }
    const revisionOwner = revisionOwners.get(revision)
    if (revisionOwner !== undefined) {
      throw new Error(
        `${label} history[${index}].revision ${revision} repeats history[${revisionOwner}].revision; Rails requires unique revisions`,
      )
    }
    digestOwners.set(digest, index)
    revisionOwners.set(revision, index)
  })

  if (typeof lock.current !== "string" || !digestOwners.has(lock.current)) {
    throw new Error(
      `${label} has no history record for current digest ${JSON.stringify(lock.current)}`,
    )
  }
}

async function restorePublishedArtifacts(
  published: readonly StagedArtifact[],
  cause: unknown,
): Promise<void> {
  const failures: string[] = []
  for (const artifact of [...published].reverse()) {
    try {
      if (artifact.restore) {
        await rename(artifact.backupPath, artifact.path)
        artifact.backupCreated = false
        await syncRegularFileAndParent(artifact.path)
      } else {
        await removeOwnedRegularFileDurably(artifact.path)
      }
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

interface RegularFileMetadata {
  ctimeNs: bigint
  dev: bigint
  gid: bigint
  ino: bigint
  mode: bigint
  mtimeNs: bigint
  nlink: bigint
  size: bigint
  uid: bigint
}

export interface CapturedRegularFile {
  contents: Buffer
  exists: true
  metadata: RegularFileMetadata
  path: string
}

interface MissingArtifactSource {
  exists: false
  path: string
}

type CapturedArtifactSource = CapturedRegularFile | MissingArtifactSource

interface ProcessLockEvidence {
  artifacts: readonly string[]
  phase: string
  pid: number
  startedAt: string
  token: string
  version: 1
}

interface ProcessLock {
  evidence: ProcessLockEvidence
  handle: FileHandle
  metadata: RegularFileMetadata
  path: string
}

class RecoveryRequiredError extends Error {}

function canonicalManifestDigest(manifest: Record<string, unknown>): string {
  if (!Array.isArray(manifest.components)) {
    throw new Error("Generated capability manifest components must be an array")
  }
  if (!Array.isArray(manifest.modules)) {
    throw new Error("Generated capability manifest modules must be an array")
  }
  const protocolVersion = requireString(
    manifest.protocolVersion,
    "generated capability manifest protocolVersion",
  )
  const canonicalBytes = JSON.stringify({
    components: manifest.components,
    modules: manifest.modules,
    protocolVersion,
  })
  return `sha256-128:${createHash("sha256").update(canonicalBytes).digest("hex").slice(0, 32)}`
}

function assertManifestStoredHashMatchesContent(source: string, label: string): string {
  const manifest = parseObject(source, label)
  const storedDigest = requireString(manifest.hash, `${label} hash`)
  const computedDigest = canonicalManifestDigest(manifest)
  if (storedDigest !== computedDigest) {
    throw new Error(
      `${label} hash ${JSON.stringify(storedDigest)} does not match its canonical content digest ${JSON.stringify(computedDigest)}`,
    )
  }
  return computedDigest
}

async function captureRegularFile(path: string): Promise<CapturedRegularFile> {
  await rejectSymlink(path, "source")
  const handle = await openNoFollow(path, constants.O_RDONLY, 0)
  try {
    const before = metadataFromStat(await handle.stat({ bigint: true }))
    if (!isRegularMode(before.mode))
      throw new Error(`Expo capability source path is not a regular file: ${path}`)
    const contents = await handle.readFile()
    const after = metadataFromStat(await handle.stat({ bigint: true }))
    if (!sameMetadata(before, after)) {
      throw new Error(`Expo capability source changed while it was read: ${path}`)
    }
    return { contents, exists: true, metadata: after, path }
  } finally {
    await handle.close()
  }
}

async function captureArtifactSource(path: string): Promise<CapturedArtifactSource> {
  try {
    return await captureRegularFile(path)
  } catch (error) {
    if (hasCode(error, "ENOENT")) return { exists: false, path }
    throw error
  }
}

async function assertOriginalUnchanged(original: CapturedArtifactSource): Promise<void> {
  const current = await captureArtifactSource(original.path)
  const changed =
    current.exists !== original.exists ||
    (current.exists &&
      original.exists &&
      (!sameMetadata(current.metadata, original.metadata) ||
        !current.contents.equals(original.contents)))
  if (changed) {
    throw new Error(
      `Expo capability source changed after the transaction started; publication was stopped: ${original.path}`,
    )
  }
}

async function writeExclusiveFileDurably(
  path: string,
  contents: Buffer,
  sourceMetadata?: RegularFileMetadata,
): Promise<void> {
  await rejectSymlink(path, "temporary or backup", true)
  const mode = sourceMetadata ? Number(sourceMetadata.mode & 0o7777n) : 0o666
  let handle: FileHandle
  try {
    handle = await openNoFollow(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      mode,
    )
  } catch (error) {
    if (hasCode(error, "EEXIST")) {
      throw new Error(
        `Refusing to replace an existing Expo capability temp or backup path: ${path}`,
      )
    }
    throw error
  }
  try {
    await handle.writeFile(contents)
    const created = await handle.stat({ bigint: true })
    if (!isRegularMode(created.mode))
      throw new Error(`Expo capability temp or backup is not a regular file: ${path}`)
    if (
      sourceMetadata &&
      (created.uid !== sourceMetadata.uid || created.gid !== sourceMetadata.gid)
    ) {
      await handle.chown(Number(sourceMetadata.uid), Number(sourceMetadata.gid))
    }
    if (sourceMetadata) await handle.chmod(mode)
    await handle.sync()
  } catch (error) {
    await handle.close().catch(() => undefined)
    await rm(path, { force: true }).catch(() => undefined)
    await syncDirectory(dirname(path)).catch(() => undefined)
    throw error
  }
  await handle.close()
  await syncDirectory(dirname(path))
}

async function syncRegularFileAndParent(path: string): Promise<void> {
  await rejectSymlink(path, "published")
  const handle = await openNoFollow(path, constants.O_RDONLY, 0)
  try {
    const metadata = await handle.stat({ bigint: true })
    if (!isRegularMode(metadata.mode))
      throw new Error(`Published Expo capability path is not a regular file: ${path}`)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await syncDirectory(dirname(path))
}

async function removeOwnedRegularFileDurably(path: string): Promise<void> {
  await rejectSymlink(path, "cleanup")
  const handle = await openNoFollow(path, constants.O_RDONLY, 0)
  try {
    const metadata = await handle.stat({ bigint: true })
    if (!isRegularMode(metadata.mode))
      throw new Error(`Refusing to remove a non-file Expo capability path: ${path}`)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rm(path)
  await syncDirectory(dirname(path))
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function acquireProcessLock(
  path: string,
  token: string,
  artifacts: readonly string[],
): Promise<ProcessLock> {
  await rejectSymlink(path, "process lock", true)
  let handle: FileHandle
  try {
    handle = await openNoFollow(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR,
      0o600,
    )
  } catch (error) {
    if (!hasCode(error, "EEXIST")) throw error
    const evidence = await readExistingLockEvidence(path)
    const recovery = evidence
      ? `For manual recovery, first prove that PID ${evidence.pid} is dead, then inspect the ${evidence.token}-named .staged and .backup files.`
      : `The lock evidence has no usable PID or token. For manual recovery, first identify whether the lock owner is live, then inspect and list every *.staged and *.backup file beside both artifact paths:\n${artifacts.map((artifact) => `- ${artifact}`).join("\n")}`
    throw new Error(
      `Another Expo capability sync owns ${path}${evidence ? ` (PID ${evidence.pid}, token ${evidence.token}, phase ${evidence.phase})` : " (evidence is unreadable)"}. No file was changed. Do not delete a live process lock. ${recovery} Remove this exact lock only after both artifacts are consistent.`,
    )
  }
  const evidence: ProcessLockEvidence = {
    artifacts,
    phase: "locked-before-source-read",
    pid: process.pid,
    startedAt: new Date().toISOString(),
    token,
    version: 1,
  }
  try {
    await writeProcessLockEvidence(handle, evidence)
    const metadata = metadataFromStat(await handle.stat({ bigint: true }))
    await syncDirectory(dirname(path))
    return { evidence, handle, metadata, path }
  } catch (error) {
    await handle.close().catch(() => undefined)
    await rm(path, { force: true }).catch(() => undefined)
    await syncDirectory(dirname(path)).catch(() => undefined)
    throw error
  }
}

async function updateProcessLockPhase(lock: ProcessLock, phase: string): Promise<void> {
  lock.evidence = { ...lock.evidence, phase }
  await writeProcessLockEvidence(lock.handle, lock.evidence)
}

export async function writeProcessLockEvidence(
  handle: Pick<FileHandle, "sync" | "truncate" | "write">,
  evidence: ProcessLockEvidence,
): Promise<void> {
  const source = Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`)
  let offset = 0
  while (offset < source.byteLength) {
    const { bytesWritten } = await handle.write(
      source,
      offset,
      source.byteLength - offset,
      offset,
    )
    if (bytesWritten === 0) throw new Error("Cannot write Expo capability process lock evidence")
    offset += bytesWritten
  }
  await handle.truncate(source.byteLength)
  await handle.sync()
}

async function releaseProcessLock(lock: ProcessLock): Promise<void> {
  await rejectSymlink(lock.path, "process lock")
  const current = await captureRegularFile(lock.path)
  const evidence = parseObject(current.contents.toString("utf8"), `process lock ${lock.path}`)
  if (
    current.metadata.dev !== lock.metadata.dev ||
    current.metadata.ino !== lock.metadata.ino ||
    evidence.token !== lock.evidence.token
  ) {
    await lock.handle.close()
    throw new Error(
      `Refusing to remove an Expo capability process lock that changed owner: ${lock.path}`,
    )
  }
  await lock.handle.sync()
  await lock.handle.close()
  await rm(lock.path)
  await syncDirectory(dirname(lock.path))
}

async function closeProcessLockWithoutRemoval(lock: ProcessLock): Promise<void> {
  await lock.handle.sync().catch(() => undefined)
  await lock.handle.close()
}

async function readExistingLockEvidence(path: string): Promise<ProcessLockEvidence | undefined> {
  try {
    const captured = await captureRegularFile(path)
    const parsed = parseObject(captured.contents.toString("utf8"), `process lock ${path}`)
    if (
      parsed.version === 1 &&
      typeof parsed.pid === "number" &&
      typeof parsed.token === "string" &&
      typeof parsed.phase === "string"
    ) {
      return parsed as unknown as ProcessLockEvidence
    }
  } catch {
    // An unreadable lock still fails closed and requires manual inspection.
  }
  return undefined
}

async function rejectSymlink(path: string, label: string, allowMissing = false): Promise<void> {
  try {
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink())
      throw new Error(`Expo capability ${label} path must not be a symlink: ${path}`)
  } catch (error) {
    if (allowMissing && hasCode(error, "ENOENT")) return
    throw error
  }
}

function openNoFollow(path: string, flags: number, mode: number): Promise<FileHandle> {
  return open(path, flags | constants.O_NOFOLLOW, mode)
}

function metadataFromStat(stat: unknown): RegularFileMetadata {
  const value = stat as RegularFileMetadata
  return {
    ctimeNs: value.ctimeNs,
    dev: value.dev,
    gid: value.gid,
    ino: value.ino,
    mode: value.mode,
    mtimeNs: value.mtimeNs,
    nlink: value.nlink,
    size: value.size,
    uid: value.uid,
  }
}

function sameMetadata(left: RegularFileMetadata, right: RegularFileMetadata): boolean {
  return (
    left.ctimeNs === right.ctimeNs &&
    left.dev === right.dev &&
    left.gid === right.gid &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.mtimeNs === right.mtimeNs &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.uid === right.uid
  )
}

function isRegularMode(mode: bigint): boolean {
  return (mode & BigInt(constants.S_IFMT)) === BigInt(constants.S_IFREG)
}

function hasCode(error: unknown, code: string): boolean {
  return isObject(error) && error.code === code
}

function assertSafeToken(token: string): void {
  if (!/^[0-9A-Za-z-]+$/.test(token)) {
    throw new Error(
      "Expo capability transaction token must contain only letters, numbers, and hyphens",
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
  const mode = argument === "--check" ? "check" : "write"
  const transactionToken = randomUUID()
  const processLock = await acquireProcessLock(
    `${defaultLockfilePath}.capabilities.lock`,
    transactionToken,
    [defaultManifestPath, defaultLockfilePath],
  )
  let recoveryRequired = false
  let result: { digest: string }
  try {
    await verifyInstalledPackage()
    const manifestJSON = await loadDemoRegistryManifestJSON()
    result = await syncCapabilityManifestUnderLock({
      lockfilePath: defaultLockfilePath,
      manifestJSON,
      manifestPath: defaultManifestPath,
      mode,
      processLock,
      publishOptions: { transactionToken },
      repositoryRoot: defaultRepositoryRoot,
    })
  } catch (error) {
    recoveryRequired = error instanceof RecoveryRequiredError
    throw error
  } finally {
    if (recoveryRequired) await closeProcessLockWithoutRemoval(processLock)
    else await releaseProcessLock(processLock)
  }
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
