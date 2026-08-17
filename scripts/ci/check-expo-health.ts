#!/usr/bin/env bun

import { writeSync } from "node:fs"
import { appendFile } from "node:fs/promises"
import { join } from "node:path"

const outputLimit = 64 * 1024
const dependencyLimit = 100
const renderedValueLimit = 160
const driftExitStatus = 1
const productionChildTimeoutMs = 3 * 60 * 1000
const terminationGraceMs = 250

type Lane = "pull_request" | "main" | "release"
type CommandResult = {
  exitCode: number
  stdout: string
  stderr: string
  overflow: boolean
  timedOut: boolean
}
type DriftDependency = {
  packageName: string
  packageType: "dependencies" | "devDependencies"
  expectedVersionOrRange: string
  actualVersion: string
}
type Advice =
  | { kind: "current" }
  | { kind: "drift"; dependencies: DriftDependency[] }
  | { kind: "invalid" }

async function main(): Promise<number> {
  const lane = resolveLane(process.argv[2], process.env)
  if (lane === null) return fail("Expo CI policy could not identify a trusted lane.")

  const doctor = await runLocal("expo-doctor", [], { EXPO_OFFLINE: "1" })
  if (doctor.timedOut) return fail("Locked Expo Doctor timed out and was terminated.")
  if (doctor.overflow) return fail("Locked Expo Doctor output exceeded the safety limit.")
  if (doctor.exitCode !== 0) {
    return fail(`Locked Expo Doctor failed with exit status ${doctor.exitCode}.`)
  }

  const sdkAdvice = await runLocal("expo", ["install", "--check", "--json"], {
    CI: "1",
    EXPO_OFFLINE: undefined,
  })
  if (sdkAdvice.timedOut) {
    return fail("Live fresh Expo SDK advice was unavailable: the Expo CLI timed out.")
  }
  if (sdkAdvice.overflow) {
    return fail("Live fresh Expo SDK advice was unavailable: output exceeded the safety limit.")
  }
  if (sdkAdvice.stderr.length > 0) {
    return fail("Live fresh Expo SDK advice was unavailable: Expo CLI stderr was not empty.")
  }

  const advice = parseAdvice(sdkAdvice.stdout, sdkAdvice.exitCode)
  if (advice.kind === "current") {
    writeSync(1, "Locked Expo Doctor passed. Verified live fresh Expo SDK advice passed.\n")
    return 0
  }
  if (advice.kind === "invalid") {
    return fail(
      `Live fresh Expo SDK advice was unavailable: JSON contract failed (exit status ${sdkAdvice.exitCode}).`,
    )
  }

  const evidence = renderDrift(advice.dependencies)
  if (lane === "pull_request") {
    writeSync(1, `::warning title=Live Expo SDK advice changed::${githubCommandValue(evidence)}\n`)
    return 0
  }

  const summary = process.env.GITHUB_STEP_SUMMARY
  if (summary) {
    await appendFile(
      summary,
      `\n## Live Expo SDK advice changed\n\nThe verified live Expo SDK package map does not match this lockfile.\n\n${githubSummaryValue(evidence)}\n`,
    )
  }
  return fail(`Verified live Expo SDK advice found dependency drift in the ${lane} lane.`)
}

function resolveLane(argument: string | undefined, env: NodeJS.ProcessEnv): Lane | null {
  if (argument === "release") return "release"
  if (argument !== "ci") return null
  if (env.GITHUB_EVENT_NAME === "pull_request") return "pull_request"
  if (env.GITHUB_EVENT_NAME === "push" && env.GITHUB_REF === "refs/heads/main") return "main"
  return null
}

async function runLocal(
  binary: "expo-doctor" | "expo",
  arguments_: string[],
  overrides: Record<string, string | undefined>,
): Promise<CommandResult> {
  const env = { ...process.env }
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[name]
    else env[name] = value
  }

  const subprocess = Bun.spawn([join(process.cwd(), "node_modules/.bin", binary), ...arguments_], {
    cwd: process.cwd(),
    env,
    stdout: "pipe",
    stderr: "pipe",
  })
  let timedOut = false
  let forceKill: ReturnType<typeof setTimeout> | undefined
  const terminate = () => {
    subprocess.kill("SIGTERM")
    forceKill ??= setTimeout(() => subprocess.kill("SIGKILL"), terminationGraceMs)
  }
  const timeout = setTimeout(() => {
    timedOut = true
    terminate()
  }, childTimeoutMs(process.env))

  const [stdout, stderr, exitCode] = await Promise.all([
    readBounded(subprocess.stdout, terminate),
    readBounded(subprocess.stderr, terminate),
    subprocess.exited,
  ])
  clearTimeout(timeout)
  if (forceKill) clearTimeout(forceKill)
  return {
    exitCode,
    stdout: stdout.text,
    stderr: stderr.text,
    overflow: stdout.overflow || stderr.overflow,
    timedOut,
  }
}

function childTimeoutMs(env: NodeJS.ProcessEnv): number {
  if (env.GITHUB_ACTIONS !== "true" && env.EXPO_HEALTH_ALLOW_TEST_TIMEOUT === "1") {
    const candidate = Number(env.EXPO_HEALTH_TEST_TIMEOUT_MS)
    if (Number.isInteger(candidate) && candidate >= 25 && candidate <= 5_000) return candidate
  }
  return productionChildTimeoutMs
}

async function readBounded(
  stream: ReadableStream<Uint8Array>,
  stop: () => void,
): Promise<{ text: string; overflow: boolean }> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let text = ""
  let bytes = 0
  let overflow = false
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    bytes += value.byteLength
    if (bytes > outputLimit) {
      overflow = true
      stop()
      continue
    }
    text += decoder.decode(value, { stream: true })
  }
  text += decoder.decode()
  return { text, overflow }
}

export function parseAdvice(stdout: string, exitCode: number): Advice {
  let value: unknown
  try {
    value = JSON.parse(stdout)
  } catch {
    return { kind: "invalid" }
  }
  if (!isRecord(value) || !hasExactKeys(value, ["dependencies", "upToDate"])) {
    return { kind: "invalid" }
  }
  if (!Array.isArray(value.dependencies) || value.dependencies.length > dependencyLimit) {
    return { kind: "invalid" }
  }
  if (value.upToDate === true && exitCode === 0 && value.dependencies.length === 0) {
    return { kind: "current" }
  }
  if (value.upToDate !== false || exitCode !== driftExitStatus || value.dependencies.length === 0) {
    return { kind: "invalid" }
  }

  const dependencies: DriftDependency[] = []
  for (const dependency of value.dependencies) {
    if (
      !isRecord(dependency) ||
      !hasExactKeys(dependency, [
        "actualVersion",
        "expectedVersionOrRange",
        "packageName",
        "packageType",
      ]) ||
      !isBoundedString(dependency.packageName) ||
      !isBoundedString(dependency.expectedVersionOrRange) ||
      !isBoundedString(dependency.actualVersion) ||
      (dependency.packageType !== "dependencies" && dependency.packageType !== "devDependencies")
    ) {
      return { kind: "invalid" }
    }
    dependencies.push({
      packageName: dependency.packageName,
      packageType: dependency.packageType,
      expectedVersionOrRange: dependency.expectedVersionOrRange,
      actualVersion: dependency.actualVersion,
    })
  }
  return { kind: "drift", dependencies }
}

export function renderDrift(dependencies: DriftDependency[]): string {
  return dependencies
    .map(
      (dependency) =>
        `- ${safeValue(dependency.packageName)} (${safeValue(dependency.packageType)}): ${safeValue(dependency.actualVersion)}; expected ${safeValue(dependency.expectedVersionOrRange)}`,
    )
    .join("\n")
}

function safeValue(value: string): string {
  return value.replace(/[^A-Za-z0-9@/._+*^~=:, -]/g, "?").slice(0, renderedValueLimit)
}

export function githubCommandValue(value: string): string {
  return value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A")
}

export function githubSummaryValue(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("@", "&#64;")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort()
  return actual.length === keys.length && actual.every((key, index) => key === keys[index])
}

function isBoundedString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= outputLimit
}

function fail(message: string): number {
  writeSync(2, `ERROR: ${message}\n`)
  return 1
}

if (import.meta.main) process.exitCode = await main()
