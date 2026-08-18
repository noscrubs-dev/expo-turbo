import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, relative, sep } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "../..")
const debugDirectories = [
  "maestro-debug-bootstrap-attempt-1",
  "maestro-debug-bootstrap-attempt-1-retry",
  "maestro-debug-attempt-1",
  "maestro-debug-bootstrap-attempt-2",
  "maestro-debug-bootstrap-attempt-2-retry",
  "maestro-debug-attempt-2",
]

function isHidden(relativePath: string): boolean {
  return relativePath.split(sep).some((part) => part.startsWith("."))
}

async function uploadArtifactFiles(directory: string): Promise<string[]> {
  const files: string[] = []
  async function visit(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      const relativePath = relative(directory, path)
      if (isHidden(relativePath)) continue
      if (entry.isDirectory()) await visit(path)
      else files.push(relativePath)
    }
  }
  await visit(directory)
  return files.sort()
}

async function assertArtifactContract(
  runner: string,
  workflow: string,
  version: string,
): Promise<void> {
  const requiredRunnerPaths = [
    "adb-fixture-push-attempt-$attempt.log",
    "adb-media-scan-attempt-$attempt.log",
    "emulator-attempt-$attempt.log",
    "environment-attempt-$attempt.txt",
    "logcat-attempt-$attempt.txt",
    "rails-attempt-$attempt.log",
    "maestro-bootstrap-attempt-$attempt.log",
    "maestro-bootstrap-attempt-$attempt-retry.log",
    "maestro-transport-trigger-attempt-$attempt.txt",
    "maestro-tests-bootstrap-attempt-$attempt",
    "maestro-debug-bootstrap-attempt-$attempt",
    "maestro-tests-bootstrap-attempt-$attempt-retry",
    "maestro-debug-bootstrap-attempt-$attempt-retry",
    "maestro-tests-attempt-$attempt",
    "maestro-debug-attempt-$attempt",
  ]
  for (const path of requiredRunnerPaths) {
    if (!runner.includes(path)) throw new Error(`missing unique Maestro artifact path: ${path}`)
  }
  if ((runner.match(/--test-output-dir/g) ?? []).length !== 3) {
    throw new Error("bootstrap, bootstrap retry, and suite need test output directories")
  }
  if ((runner.match(/--debug-output/g) ?? []).length !== 3) {
    throw new Error("bootstrap, bootstrap retry, and suite need debug output directories")
  }
  if ((runner.match(/--flatten-debug-output/g) ?? []).length !== 3) {
    throw new Error("every Maestro 2.7.0 debug path must use flat output")
  }
  if ((runner.match(/--debug-output "[^"]+" \\\n\s+--flatten-debug-output/g) ?? []).length !== 3) {
    throw new Error("flat debug output must apply to each explicit debug directory")
  }
  if (
    !runner.includes("start_and_prepare_emulator 1") ||
    !runner.includes("start_and_prepare_emulator 2")
  ) {
    throw new Error("the emulator bootstrap artifact paths must use the suite attempt number")
  }
  if (
    !runner.includes('capture_attempt_evidence 1 "$first_status"') ||
    !runner.includes('capture_attempt_evidence 2 "$second_status"') ||
    !runner.includes(': >"$rails_log"')
  ) {
    throw new Error("suite retries must preserve and separate both attempts")
  }
  if (!version.includes('readonly expected_version="2.7.0"')) {
    throw new Error("the flat-output contract must stay pinned to Maestro 2.7.0")
  }
  if (
    !workflow.includes("if: always()") ||
    !workflow.includes("path: artifacts/android-device") ||
    !workflow.includes("uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a") ||
    !workflow.includes("include-hidden-files: false")
  ) {
    throw new Error("the pinned upload action must always upload only the visible evidence tree")
  }

  const fixture = await mkdtemp(join(tmpdir(), "maestro-artifact-contract-"))
  const flattened = runner.includes("--flatten-debug-output")
  for (const directory of debugDirectories) {
    const logDirectory = flattened
      ? join(fixture, directory)
      : join(fixture, directory, ".maestro", "tests", "2026-08-18_000000")
    await mkdir(logDirectory, { recursive: true })
    await writeFile(join(logDirectory, "maestro.log"), directory)
  }
  const uploaded = await uploadArtifactFiles(fixture)
  const expectedLogs = debugDirectories.map((directory) => join(directory, "maestro.log")).sort()
  if (JSON.stringify(uploaded) !== JSON.stringify(expectedLogs)) {
    throw new Error("the upload would silently lose one or more per-attempt maestro.log files")
  }
}

describe("Android Maestro artifacts", () => {
  test("uploads every unique flat Maestro log with hidden-file upload disabled", async () => {
    const [runner, workflow, version] = await Promise.all([
      readFile(join(root, "scripts/ci/run-android-maestro.sh"), "utf8"),
      readFile(join(root, ".github/workflows/android-device.yml"), "utf8"),
      readFile(join(root, "scripts/ci/check-maestro-version.sh"), "utf8"),
    ])

    await expect(assertArtifactContract(runner, workflow, version)).resolves.toBeUndefined()
    await expect(
      assertArtifactContract(
        runner.replace(
          "maestro-debug-bootstrap-attempt-$attempt-retry",
          "maestro-debug-bootstrap-attempt-$attempt",
        ),
        workflow,
        version,
      ),
    ).rejects.toThrow(/bootstrap-attempt-\$attempt-retry/)
    await expect(
      assertArtifactContract(
        runner.replaceAll("    --flatten-debug-output \\\n", ""),
        workflow,
        version,
      ),
    ).rejects.toThrow(/flat output|silently lose/)
    await expect(
      assertArtifactContract(runner, workflow.replace("if: always()", "if: success()"), version),
    ).rejects.toThrow(/pinned upload action/)
    await expect(
      assertArtifactContract(
        runner.replace('capture_attempt_evidence 2 "$second_status"', "true"),
        workflow,
        version,
      ),
    ).rejects.toThrow(/preserve and separate/)
  })
})
