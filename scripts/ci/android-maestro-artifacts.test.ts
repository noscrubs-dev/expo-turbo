import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "../..")

function assertArtifactContract(runner: string, workflow: string): void {
  const requiredRunnerPaths = [
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
  if (
    !runner.includes("start_and_prepare_emulator 1") ||
    !runner.includes("start_and_prepare_emulator 2")
  ) {
    throw new Error("the emulator bootstrap artifact paths must use the suite attempt number")
  }
  if (!workflow.includes("if: always()") || !workflow.includes("path: artifacts/android-device")) {
    throw new Error("the workflow must upload the full Android evidence tree on failure")
  }
}

describe("Android Maestro artifacts", () => {
  test("uses collision-free bootstrap and suite paths that the workflow always uploads", async () => {
    const [runner, workflow] = await Promise.all([
      readFile(join(root, "scripts/ci/run-android-maestro.sh"), "utf8"),
      readFile(join(root, ".github/workflows/android-device.yml"), "utf8"),
    ])

    expect(() => assertArtifactContract(runner, workflow)).not.toThrow()
    expect(() =>
      assertArtifactContract(
        runner.replace(
          "maestro-debug-bootstrap-attempt-$attempt-retry",
          "maestro-debug-bootstrap-attempt-$attempt",
        ),
        workflow,
      ),
    ).toThrow(/bootstrap-attempt-\$attempt-retry/)
    expect(() =>
      assertArtifactContract(runner, workflow.replace("if: always()", "if: success()")),
    ).toThrow(/upload the full Android evidence tree/)
  })
})
