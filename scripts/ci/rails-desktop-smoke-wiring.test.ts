import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const workflowPath = join(repositoryRoot, ".github/workflows/ci.yml")
const canonicalCommand = "scripts/ci/run-rails-desktop-smoke.sh"
const canonicalRedisInstall = `sudo apt-get update
sudo apt-get install --yes redis-server redis-tools
sudo systemctl stop redis-server.service
sudo systemctl disable redis-server.service
! sudo systemctl is-active --quiet redis-server.service
if (echo > /dev/tcp/127.0.0.1/6379) 2>/dev/null; then
  echo "Redis port 6379 is already in use after installation." >&2
  exit 1
fi`

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
  services?: unknown
  steps?: WorkflowStep[]
}

interface Workflow {
  jobs?: Record<string, WorkflowJob>
}

function smokeJob(workflowSource: string): WorkflowJob {
  const workflow = Bun.YAML.parse(workflowSource) as Workflow
  const job = workflow.jobs?.["rails-action-cable-smoke"]
  if (!job) throw new Error("Rails desktop smoke job is missing")
  rejectBypassFields(job, "job")
  if (Object.hasOwn(job, "services")) {
    throw new Error("Rails desktop smoke job must not use service containers")
  }
  return job
}

function normalizedSmokeRun(workflowSource: string): string {
  const job = smokeJob(workflowSource)

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

function normalizedRedisInstall(workflowSource: string): string {
  const job = smokeJob(workflowSource)
  const steps = job.steps
  if (!Array.isArray(steps)) throw new Error("Rails desktop smoke job is missing")

  const installSteps = steps.filter((step) => step.name === "Install Redis")
  if (installSteps.length !== 1) {
    throw new Error(
      `Rails desktop smoke must have exactly one Redis install step, found ${installSteps.length}`,
    )
  }
  const installStep = installSteps[0]
  if (!installStep) throw new Error("Redis install step is missing")
  rejectBypassFields(installStep, "step")

  const smokeIndex = steps.findIndex((step) => step.name === "Smoke Rails desktop integration")
  const installIndex = steps.findIndex((step) => step.name === "Install Redis")
  if (smokeIndex < 0 || installIndex >= smokeIndex) {
    throw new Error("Redis must be installed before the Rails desktop smoke step")
  }

  if (typeof installStep.run !== "string") throw new Error("Redis install run value is missing")
  return installStep.run.replaceAll("\r\n", "\n").trim()
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

function expectCanonicalRedisInstall(workflowSource: string): void {
  expect(normalizedRedisInstall(workflowSource)).toBe(canonicalRedisInstall)
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
  const workflow = await readFile(workflowPath, "utf8")
  expectCanonicalSmokeRun(workflow)
  expectCanonicalRedisInstall(workflow)
})

test("Rails desktop smoke requires the exact Redis installation before smoke", async () => {
  const workflow = await readFile(workflowPath, "utf8")
  const installBlock = `      - name: Install Redis\n${canonicalRedisInstall
    .split("\n")
    .map((line, index) => `${index === 0 ? "        run: |\n" : ""}          ${line}`)
    .join("\n")}`
  expect(workflow).toContain(installBlock)

  const missing = workflow.replace(installBlock, "")
  const afterSmoke = workflow.replace(
    `${installBlock}\n      - name: Smoke Rails desktop integration\n        run: ${canonicalCommand}`,
    `      - name: Smoke Rails desktop integration\n        run: ${canonicalCommand}\n${installBlock}`,
  )
  expect(afterSmoke).not.toBe(workflow)
  expect(() => expectCanonicalRedisInstall(missing)).toThrow("Redis install step")
  expect(() => expectCanonicalRedisInstall(afterSmoke)).toThrow("before")
})

test("Rails desktop smoke rejects incomplete or bypassable Redis setup", async () => {
  const workflow = await readFile(workflowPath, "utf8")
  for (const source of [
    workflow.replace("redis-server redis-tools", "redis-tools"),
    workflow.replace("sudo systemctl stop redis-server.service\n", ""),
    workflow.replace("sudo systemctl disable redis-server.service\n", ""),
    workflow.replace("! sudo systemctl is-active --quiet redis-server.service\n", ""),
    workflow.replace("if (echo > /dev/tcp/127.0.0.1/6379) 2>/dev/null; then", "if false; then"),
  ]) {
    expect(source).not.toBe(workflow)
    expect(() => expectCanonicalRedisInstall(source)).toThrow()
  }

  for (const field of [
    "continue-on-error: true",
    "continue-on-error: false",
    "if: always()",
  ] as const) {
    const mutation = workflow.replace(
      "      - name: Install Redis\n",
      `      - name: Install Redis\n        ${field}\n`,
    )
    expect(mutation).not.toBe(workflow)
    expect(() => expectCanonicalRedisInstall(mutation)).toThrow("must not set")
  }
})

test("Rails desktop smoke rejects a restored Redis service container", async () => {
  const workflow = await readFile(workflowPath, "utf8")
  const mutation = workflow.replace(
    "    runs-on: ubuntu-latest\n    env:\n      BUNDLE_GEMFILE:",
    "    runs-on: ubuntu-latest\n    services:\n      redis:\n        image: redis:7\n    env:\n      BUNDLE_GEMFILE:",
  )
  expect(mutation).not.toBe(workflow)
  expect(() => expectCanonicalRedisInstall(mutation)).toThrow("must not use service containers")
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
