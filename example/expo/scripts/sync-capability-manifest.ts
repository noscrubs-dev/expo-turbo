import { mock } from "bun:test"
import { readFile, writeFile } from "node:fs/promises"
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

  const expectedLock = structuredClone(lock)
  const expectedHistory = expectedLock.history as LockRecord[]
  const targetIndex = lock.history.indexOf(target)
  expectedLock.current = digest
  expectedHistory[targetIndex] = { ...expectedHistory[targetIndex], digest }
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

  await Promise.all([writeFile(manifestPath, manifestJSON), writeFile(lockfilePath, expectedLockSource)])
  return { digest }
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

function parseObject(source: string, label: string): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(source)
  } catch (error) {
    throw new Error(`Cannot parse ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!isObject(value)) throw new Error(`${label} must be a JSON object`)
  return value
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
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
