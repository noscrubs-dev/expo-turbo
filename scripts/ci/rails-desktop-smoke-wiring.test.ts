import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const workflowPath = join(repositoryRoot, ".github/workflows/ci.yml")
const canonicalCommand = "scripts/ci/run-rails-desktop-smoke.sh"

interface WorkflowStep {
  name?: string
  run?: string
}

interface Workflow {
  jobs?: Record<string, { steps?: WorkflowStep[] }>
}

function normalizedSmokeRun(workflowSource: string): string {
  const workflow = Bun.YAML.parse(workflowSource) as Workflow
  const steps = workflow.jobs?.["rails-action-cable-smoke"]?.steps
  if (!Array.isArray(steps)) throw new Error("Rails desktop smoke job is missing")

  const smokeSteps = steps.filter((step) => step.name === "Smoke Rails desktop integration")
  if (smokeSteps.length !== 1) {
    throw new Error(
      `Rails desktop smoke must have exactly one smoke step, found ${smokeSteps.length}`,
    )
  }

  const run = smokeSteps[0]?.run
  if (typeof run !== "string") throw new Error("Rails desktop smoke run value is missing")
  return run.replaceAll("\r\n", "\n").trim()
}

function expectCanonicalSmokeRun(workflowSource: string): void {
  expect(normalizedSmokeRun(workflowSource)).toBe(canonicalCommand)
}

function replaceRun(workflowSource: string, run: string): string {
  const indentedRun = run
    .split("\n")
    .map((line) => `          ${line}`)
    .join("\n")
  return workflowSource.replace(
    `        run: ${canonicalCommand}`,
    `        run: |\n${indentedRun}`,
  )
}

test("Rails desktop smoke workflow uses only the exact repository runner", async () => {
  expectCanonicalSmokeRun(await readFile(workflowPath, "utf8"))
})

test("Rails desktop smoke wiring rejects prefixes and wrappers", async () => {
  const workflow = await readFile(workflowPath, "utf8")
  for (const run of [
    `exit 0\n${canonicalCommand}`,
    `true\n${canonicalCommand}`,
    `echo ready\n${canonicalCommand}`,
    `printf ready\n${canonicalCommand}`,
    `true && ${canonicalCommand}`,
    `env CI=1 ${canonicalCommand}`,
    `bash -c '${canonicalCommand}'`,
  ]) {
    expect(() => expectCanonicalSmokeRun(replaceRun(workflow, run))).toThrow()
  }
})

test("Rails desktop smoke wiring rejects suffixes and conditional bypasses", async () => {
  const workflow = await readFile(workflowPath, "utf8")
  for (const run of [
    `${canonicalCommand}\nexit 0`,
    `${canonicalCommand}\ntrue`,
    `${canonicalCommand}; true`,
    `${canonicalCommand} || true`,
    `${canonicalCommand} && echo done`,
    `${canonicalCommand} &`,
  ]) {
    expect(() => expectCanonicalSmokeRun(replaceRun(workflow, run))).toThrow()
  }
})

test("Rails desktop smoke wiring rejects missing and duplicate smoke steps", async () => {
  const workflow = await readFile(workflowPath, "utf8")
  const missing = workflow.replace("name: Smoke Rails desktop integration", "name: Hidden smoke")
  const duplicate = workflow.replace(
    `      - name: Smoke Rails desktop integration\n        run: ${canonicalCommand}`,
    `      - name: Smoke Rails desktop integration\n        run: ${canonicalCommand}\n` +
      `      - name: Smoke Rails desktop integration\n        run: ${canonicalCommand}`,
  )

  expect(() => expectCanonicalSmokeRun(missing)).toThrow()
  expect(() => expectCanonicalSmokeRun(duplicate)).toThrow()
})
