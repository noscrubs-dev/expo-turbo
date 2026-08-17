import { afterEach, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { closeSync, openSync, readFileSync } from "node:fs"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import {
  githubCommandValue,
  githubSummaryValue,
  parseAdvice,
  renderDrift,
} from "./check-expo-health"

const script = join(dirname(fileURLToPath(import.meta.url)), "check-expo-health.ts")
const fixtures: string[] = []

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map((fixture) => rm(fixture, { recursive: true, force: true })),
  )
})

describe("Expo CI health wrapper behavior", () => {
  test("Doctor failure blocks before the live stage", async () => {
    const fixture = await createFixture({ doctorExit: 7, expoOutput: currentAdvice })
    const result = await run(script, fixture, "ci", pullRequestEnvironment)

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain("Locked Expo Doctor failed with exit status 7")
    expect(await calls(fixture)).toEqual(["doctor offline=1"])
  })

  test("clean live success uses local binaries and deletes inherited EXPO_OFFLINE", async () => {
    const fixture = await createFixture({ expoOutput: currentAdvice })
    const result = await run(script, fixture, "ci", {
      ...pullRequestEnvironment,
      EXPO_OFFLINE: "parent-leak",
    })

    expect(result).toMatchObject({
      exitCode: 0,
      stderr: "",
      stdout: "Locked Expo Doctor passed. Verified live fresh Expo SDK advice passed.\n",
    })
    expect(await calls(fixture)).toEqual([
      "doctor offline=1",
      "expo offline=absent ci=1 args=install --check --json",
    ])
  })

  test("fallback stderr blocks valid current JSON in every lane", async () => {
    for (const stderr of [
      "Network request failed; using bundled native module versions.\n",
      "API connection failed; falling back to bundled data.\n",
    ]) {
      for (const [argument, environment] of lanes) {
        const fixture = await createFixture({ expoOutput: currentAdvice, expoStderr: stderr })
        const result = await run(script, fixture, argument, environment)
        expect(result.exitCode).not.toBe(0)
        expect(result.stdout).not.toContain("passed")
        expect(result.stderr).toContain("stderr was not empty")
      }
    }
  }, 20_000)

  test("HTTP, protocol, non-JSON, and extra-key contracts block every lane", async () => {
    const cases = [
      { expoOutput: "Unexpected token < in JSON at position 0", expoExit: 2 },
      { expoOutput: "HTTP 503 Service Unavailable", expoExit: 1 },
      { expoOutput: JSON.stringify({ dependencies: [], upToDate: true, source: "live" }) },
    ]
    for (const options of cases) {
      for (const [argument, environment] of lanes) {
        const fixture = await createFixture(options)
        const result = await run(script, fixture, argument, environment)
        expect(result.exitCode).not.toBe(0)
        expect(result.stderr).toContain("JSON contract failed")
      }
    }
  }, 20_000)

  test("PR drift emits exactly one sanitized warning and never writes a summary", async () => {
    const hostile = "@team%\n\r`<!-- <b>& bell:\u0007 -->"
    const fixture = await createFixture({ expoExit: 1, expoOutput: hostileDrift(hostile) })
    const summary = join(fixture, "summary.md")
    const result = await run(script, fixture, "ci", {
      ...pullRequestEnvironment,
      GITHUB_STEP_SUMMARY: summary,
    })
    const warnings = result.stdout.split("\n").filter((line) => line.startsWith("::warning "))

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toStartWith("::warning title=Live Expo SDK advice changed::")
    expect(warnings[0]).not.toMatch(/[\r\n`<>%](?![0-9A-F]{2})/)
    expect(Bun.file(summary).exists()).resolves.toBe(false)
  })

  test("main and release drift block with bounded, HTML-safe summary bytes", async () => {
    const hostile = "@team%\n\r`<!-- <script>& alert -->"
    for (const [argument, environment] of lanes.slice(1)) {
      const fixture = await createFixture({ expoExit: 1, expoOutput: hostileDrift(hostile) })
      const summary = join(fixture, "summary.md")
      const result = await run(script, fixture, argument, {
        ...environment,
        GITHUB_STEP_SUMMARY: summary,
      })
      const bytes = await readFile(summary)
      const text = bytes.toString("utf8")

      expect(result.exitCode).not.toBe(0)
      expect(result.stdout).not.toContain("::warning")
      expect(result.stderr).toContain("Verified live Expo SDK advice found dependency drift")
      expect(bytes.byteLength).toBeLessThan(64 * 1024)
      expect(text).not.toContain("<script>")
      expect(text).not.toContain("<!--")
      expect(text).not.toContain("@team")
      expect(text).toContain("&#64;team")
    }
  })

  test("output over 64 KiB and more than 100 dependencies fail before evidence renders", async () => {
    const tooMany = Array.from({ length: 101 }, (_, index) => dependency(`expo-${index}`))
    for (const output of [
      "x".repeat(64 * 1024 + 1),
      JSON.stringify({ dependencies: tooMany, upToDate: false }),
    ]) {
      const fixture = await createFixture({ expoExit: 1, expoOutput: output })
      const result = await run(script, fixture, "ci", pullRequestEnvironment)
      expect(result.exitCode).not.toBe(0)
      expect(result.stdout).not.toContain("::warning")
    }
  })

  test("Doctor timeout terminates its child and never starts Expo", async () => {
    const fixture = await createFixture({ doctorHang: true, expoOutput: currentAdvice })
    const result = await run(script, fixture, "ci", pullRequestEnvironment, testTimeoutEnvironment)

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain("Doctor timed out and was terminated")
    expect(await calls(fixture)).toEqual(["doctor offline=1", "doctor terminated"])
  })

  test("live-stage timeout terminates its child and exits nonzero", async () => {
    const fixture = await createFixture({ expoHang: true, expoOutput: currentAdvice })
    const result = await run(script, fixture, "release", {}, testTimeoutEnvironment)

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain("Expo CLI timed out")
    expect(await calls(fixture)).toContain("expo terminated")
  })

  test("CI cannot use the short test timeout", async () => {
    const fixture = await createFixture({ expoOutput: currentAdvice })
    const result = await run(script, fixture, "ci", pullRequestEnvironment, {
      ...testTimeoutEnvironment,
      GITHUB_ACTIONS: "true",
    })
    expect(result.exitCode).toBe(0)
  })

  test("unknown lanes block before either binary", async () => {
    for (const [argument, environment] of [
      ["ci", { GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/heads/main" }],
      ["unknown", pullRequestEnvironment],
    ] as const) {
      const fixture = await createFixture({ expoOutput: currentAdvice })
      const result = await run(script, fixture, argument, environment)
      expect(result.exitCode).not.toBe(0)
      expect(await calls(fixture)).toEqual([])
    }
  })
})

describe("executed mutation proofs", () => {
  test("sanitizer wiring mutant leaks hostile output and is caught", async () => {
    const mutant = await mutation(
      "sanitizer",
      "safeValue(dependency.packageName)",
      "dependency.packageName",
    )
    const fixture = await createFixture({ expoExit: 1, expoOutput: driftWith("bad\n`<tag>") })
    const result = await run(mutant, fixture, "ci", pullRequestEnvironment)
    expect(result.stdout).toContain("`<tag>")
  })

  test("stream and field cap mutant accepts oversized evidence and is caught", async () => {
    let source = await readFile(script, "utf8")
    source = replaceRequired(
      source,
      "    if (bytes > outputLimit) {\n      overflow = true\n      stop()\n      continue\n    }",
      "    if (false) {\n      overflow = true\n      stop()\n      continue\n    }",
    )
    source = replaceRequired(source, "value.length <= outputLimit", "true")
    const mutant = await writeMutation("caps", source)
    const fixture = await createFixture({
      expoExit: 1,
      expoOutput: driftWith("x".repeat(64 * 1024 + 1)),
    })
    const result = await run(mutant, fixture, "ci", pullRequestEnvironment)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("::warning")
  })

  test("warning reachability mutant blocks PR drift and is caught", async () => {
    const mutant = await mutation("warning", 'if (lane === "pull_request")', "if (false)")
    const fixture = await createFixture({ expoExit: 1, expoOutput: driftAdvice })
    const result = await run(mutant, fixture, "ci", pullRequestEnvironment)
    expect(result.exitCode).not.toBe(0)
    expect(result.stdout).not.toContain("::warning")
  })

  test("PATH-binary mutant cannot reach the fixture local binary and is caught", async () => {
    const mutant = await mutation(
      "local-binary",
      'join(process.cwd(), "node_modules/.bin", binary)',
      "binary",
    )
    const fixture = await createFixture({ expoOutput: currentAdvice })
    const result = await run(mutant, fixture, "ci", pullRequestEnvironment)
    expect(result.exitCode).not.toBe(0)
    expect(await calls(fixture)).toEqual([])
  })

  test("fail-open exit mutant warns for an invalid exit-zero drift and is caught", async () => {
    const mutant = await mutation("fail-closed", "exitCode !== driftExitStatus", "false")
    const fixture = await createFixture({ expoOutput: driftAdvice })
    const result = await run(mutant, fixture, "ci", pullRequestEnvironment)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("::warning")
  })
})

test("pure render helpers retain command and summary escaping", () => {
  const value = "%\r\n<>&@`"
  expect(githubCommandValue(value)).toBe("%25%0D%0A<>&@`")
  expect(githubSummaryValue(value)).toBe("%\r\n&lt;&gt;&amp;&#64;`")
  expect(parseAdvice(currentAdvice, 0)).toEqual({ kind: "current" })
  expect(renderDrift([dependency("@expo/<bad>")])).not.toMatch(/[<>]/)
})

const currentAdvice = JSON.stringify({ dependencies: [], upToDate: true })
const driftAdvice = JSON.stringify({ dependencies: [dependency("expo-router")], upToDate: false })
const pullRequestEnvironment = {
  GITHUB_EVENT_NAME: "pull_request",
  GITHUB_REF: "refs/pull/441/merge",
}
const lanes = [
  ["ci", pullRequestEnvironment],
  ["ci", { GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/main" }],
  ["release", {}],
] as const
const testTimeoutEnvironment = {
  EXPO_HEALTH_ALLOW_TEST_TIMEOUT: "1",
  EXPO_HEALTH_TEST_TIMEOUT_MS: "1000",
}

function dependency(packageName: string) {
  return {
    packageName,
    packageType: "dependencies" as const,
    expectedVersionOrRange: "~57.0.14",
    actualVersion: "57.0.13",
  }
}

function driftWith(value: string): string {
  return JSON.stringify({ dependencies: [dependency(value)], upToDate: false })
}

function hostileDrift(value: string): string {
  return JSON.stringify({
    dependencies: [
      {
        packageName: value,
        packageType: "dependencies",
        expectedVersionOrRange: value,
        actualVersion: value,
      },
    ],
    upToDate: false,
  })
}

async function createFixture(options: {
  doctorExit?: number
  doctorHang?: boolean
  doctorStderr?: string
  expoExit?: number
  expoHang?: boolean
  expoOutput: string
  expoStderr?: string
}): Promise<string> {
  const fixture = await mkdtemp(join(tmpdir(), "expo-health-"))
  fixtures.push(fixture)
  const bin = join(fixture, "node_modules/.bin")
  await mkdir(bin, { recursive: true })
  const doctorHang = options.doctorHang
    ? `trap 'printf "doctor terminated\\n" >> calls; exit 143' TERM\nwhile :; do :; done\n`
    : `exit ${options.doctorExit ?? 0}\n`
  const expoHang = options.expoHang
    ? `trap 'printf "expo terminated\\n" >> calls; exit 143' TERM\nwhile :; do :; done\n`
    : `cat expo-output\nexit ${options.expoExit ?? 0}\n`
  await writeExecutable(
    join(bin, "expo-doctor"),
    `#!/bin/sh\nprintf 'doctor offline=%s\\n' "${"$"}{EXPO_OFFLINE:-absent}" >> calls\nprintf '%s' "${escapeShell(options.doctorStderr ?? "")}" >&2\n${doctorHang}`,
  )
  await writeExecutable(
    join(bin, "expo"),
    `#!/bin/sh\nif [ "${"$"}{EXPO_OFFLINE+x}" = x ]; then offline="${"$"}EXPO_OFFLINE"; else offline=absent; fi\nprintf 'expo offline=%s ci=%s args=%s\\n' "${"$"}offline" "${"$"}{CI:-}" "${"$"}*" >> calls\nprintf '%s' "${escapeShell(options.expoStderr ?? "")}" >&2\n${expoHang}`,
  )
  await writeFile(join(fixture, "expo-output"), options.expoOutput)
  return fixture
}

async function run(
  executable: string,
  fixture: string,
  argument: string,
  environment: Record<string, string>,
  extraEnvironment: Record<string, string> = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const stdoutPath = join(fixture, `stdout-${crypto.randomUUID()}`)
  const stderrPath = join(fixture, `stderr-${crypto.randomUUID()}`)
  closeSync(openSync(stdoutPath, "w"))
  closeSync(openSync(stderrPath, "w"))
  const subprocess = spawnSync(
    "/bin/sh",
    [
      "-c",
      'exec "$1" "$2" "$3" >"$4" 2>"$5"',
      "expo-health-runner",
      process.execPath,
      executable,
      argument,
      stdoutPath,
      stderrPath,
    ],
    {
      cwd: fixture,
      env: { PATH: process.env.PATH, ...environment, ...extraEnvironment },
      stdio: "ignore",
    },
  )
  return {
    exitCode: subprocess.status ?? 1,
    stdout: readFileSync(stdoutPath, "utf8"),
    stderr: readFileSync(stderrPath, "utf8"),
  }
}

async function calls(fixture: string): Promise<string[]> {
  const file = Bun.file(join(fixture, "calls"))
  if (!(await file.exists())) return []
  return (await file.text()).trim().split("\n")
}

async function mutation(name: string, from: string, to: string): Promise<string> {
  return writeMutation(name, replaceRequired(await readFile(script, "utf8"), from, to))
}

async function writeMutation(name: string, source: string): Promise<string> {
  const fixture = await mkdtemp(join(tmpdir(), `expo-health-mutant-${name}-`))
  fixtures.push(fixture)
  const path = join(fixture, "check-expo-health.ts")
  await writeFile(path, source)
  return path
}

function replaceRequired(source: string, from: string, to: string): string {
  const result = source.replace(from, to)
  if (result === source) throw new Error(`mutation target not found: ${from}`)
  return result
}

async function writeExecutable(path: string, source: string): Promise<void> {
  await writeFile(path, source)
  await chmod(path, 0o755)
}

function escapeShell(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("$", "\\$")
    .replaceAll("`", "\\`")
}
