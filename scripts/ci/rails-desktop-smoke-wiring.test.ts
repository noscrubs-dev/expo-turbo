import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const workflowPath = join(repositoryRoot, ".github/workflows/ci.yml")
const canonicalCommand = "scripts/ci/run-rails-desktop-smoke.sh"

interface WorkflowStep {
  "continue-on-error"?: unknown
  if?: unknown
  name?: string
  run?: string
}

interface WorkflowJob {
  "continue-on-error"?: unknown
  if?: unknown
  needs?: unknown
  steps?: WorkflowStep[]
}

interface Workflow {
  jobs?: Record<string, WorkflowJob>
}

function normalizedSmokeRun(workflowSource: string): string {
  const workflow = Bun.YAML.parse(workflowSource) as Workflow
  const job = workflow.jobs?.["rails-action-cable-smoke"]
  if (!job) throw new Error("Rails desktop smoke job is missing")
  rejectBypassFields(job, "job")

  const steps = job.steps
  if (!Array.isArray(steps)) throw new Error("Rails desktop smoke job is missing")

  const smokeSteps = steps.filter((step) => step.name === "Smoke Rails desktop integration")
  if (smokeSteps.length !== 1) {
    throw new Error(
      `Rails desktop smoke must have exactly one smoke step, found ${smokeSteps.length}`,
    )
  }

  const smokeStep = smokeSteps[0]
  if (!smokeStep) throw new Error("Rails desktop smoke step is missing")
  rejectBypassFields(smokeStep, "step")

  const run = smokeStep.run
  if (typeof run !== "string") throw new Error("Rails desktop smoke run value is missing")
  return run.replaceAll("\r\n", "\n").trim()
}

function rejectBypassFields(value: WorkflowJob | WorkflowStep, scope: "job" | "step"): void {
  for (const field of ["continue-on-error", "if"] as const) {
    if (Object.hasOwn(value, field)) {
      throw new Error(`Rails desktop smoke ${scope} must not set ${field}`)
    }
  }
  if (scope === "job" && Object.hasOwn(value, "needs")) {
    throw new Error("Rails desktop smoke job must not depend on another job")
  }
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

test("Rails desktop smoke wiring rejects step-level skip and fail-open fields", async () => {
  const workflow = await readFile(workflowPath, "utf8")
  for (const field of [
    "continue-on-error: true",
    "continue-on-error: false",
    "if: always()",
    `if: \${{ false }}`,
  ]) {
    const mutation = workflow.replace(
      `      - name: Smoke Rails desktop integration\n        run: ${canonicalCommand}`,
      `      - name: Smoke Rails desktop integration\n        run: ${canonicalCommand}\n        ${field}`,
    )
    expect(mutation).not.toBe(workflow)
    expect(() => expectCanonicalSmokeRun(mutation)).toThrow("Rails desktop smoke step must not set")
  }
})

test("Rails desktop smoke wiring rejects job-level skip, fail-open, and dependency fields", async () => {
  const workflow = await readFile(workflowPath, "utf8")
  for (const field of [
    "continue-on-error: true",
    "continue-on-error: false",
    "if: always()",
    `if: \${{ false }}`,
    "needs: rails",
    "needs: [rails]",
  ]) {
    const mutation = workflow.replace(
      "  rails-action-cable-smoke:\n",
      `  rails-action-cable-smoke:\n    ${field}\n`,
    )
    expect(mutation).not.toBe(workflow)
    expect(() => expectCanonicalSmokeRun(mutation)).toThrow(
      field.startsWith("needs:")
        ? "Rails desktop smoke job must not depend on another job"
        : "Rails desktop smoke job must not set",
    )
  }
})
