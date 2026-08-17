import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { githubCommandValue, parseAdvice, renderDrift } from "./check-expo-health"

const script = join(dirname(fileURLToPath(import.meta.url)), "check-expo-health.ts")
const fixtures: string[] = []

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map((fixture) => rm(fixture, { recursive: true, force: true })),
  )
})

describe("Expo CI health wrapper", () => {
  test("Doctor failure blocks before Expo starts", async () => {
    const fixture = await createFixture({ doctorExit: 7, expoOutput: currentAdvice })
    const result = await run(fixture, "ci", pullRequestEnvironment)

    expect(result.exitCode).not.toBe(0)
    expect(await calls(fixture)).toEqual(["doctor offline=1"])
  })

  test("both checks pass with local binaries and the required environments", async () => {
    const fixture = await createFixture({ expoOutput: currentAdvice })
    const result = await run(fixture, "ci", pullRequestEnvironment)

    expect(result.exitCode).toBe(0)
    expect(await calls(fixture)).toEqual([
      "doctor offline=1",
      "expo ci=1 args=install --check --json",
    ])
  })

  test("valid drift warns and passes only on pull requests", async () => {
    const fixture = await createFixture({ expoOutput: driftAdvice, expoExit: 1 })
    const result = await run(fixture, "ci", pullRequestEnvironment)

    expect(result.exitCode).toBe(0)
    expect(await calls(fixture)).toHaveLength(2)
  })

  test("valid drift blocks main and release and writes summary evidence", async () => {
    for (const [argument, environment] of [
      ["ci", { GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/main" }],
      ["release", {}],
    ] as const) {
      const fixture = await createFixture({ expoOutput: driftAdvice, expoExit: 1 })
      const summary = join(fixture, "summary.md")
      const result = await run(fixture, argument, { ...environment, GITHUB_STEP_SUMMARY: summary })

      expect(result.exitCode).not.toBe(0)
      expect(await readFile(summary, "utf8")).toContain("expo-router")
      expect(await readFile(summary, "utf8")).toContain("57.0.14")
    }
  })

  test("non-JSON and invalid JSON failures block every lane", async () => {
    const cases = ["not json", JSON.stringify({ dependencies: [], upToDate: false })]
    const lanes = [
      ["ci", pullRequestEnvironment],
      ["ci", { GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/main" }],
      ["release", {}],
    ] as const
    for (const output of cases) {
      for (const [argument, environment] of lanes) {
        const fixture = await createFixture({ expoOutput: output, expoExit: 2 })
        const result = await run(fixture, argument, environment)
        expect(result.exitCode).not.toBe(0)
      }
    }
  })

  test("exit-zero JSON fails closed unless it proves upToDate true", async () => {
    for (const output of [
      JSON.stringify({ dependencies: [], upToDate: false }),
      JSON.stringify({ dependencies: [{}], upToDate: true }),
      JSON.stringify({ dependencies: [], upToDate: true, note: "extra" }),
    ]) {
      const fixture = await createFixture({ expoOutput: output })
      const result = await run(fixture, "ci", pullRequestEnvironment)
      expect(result.exitCode).not.toBe(0)
    }
  })

  test("hostile JSON fields are sanitized and capped before a warning is rendered", async () => {
    const hostile = `bad\u0007\n\r\`name${"x".repeat(400)}`
    const fixture = await createFixture({
      expoExit: 1,
      expoOutput: JSON.stringify({
        dependencies: [
          {
            packageName: hostile,
            packageType: "dependencies",
            actualVersion: hostile,
            expectedVersionOrRange: hostile,
          },
          {
            packageName: "expo",
            packageType: "dependencies",
            actualVersion: "57.0.13",
            expectedVersionOrRange: "57.0.14",
          },
        ],
        upToDate: false,
      }),
    })
    const result = await run(fixture, "ci", pullRequestEnvironment)
    const parsed = parseAdvice(
      JSON.stringify({
        dependencies: [
          {
            packageName: hostile,
            packageType: "dependencies",
            actualVersion: hostile,
            expectedVersionOrRange: hostile,
          },
          {
            packageName: "expo",
            packageType: "dependencies",
            actualVersion: "57.0.13",
            expectedVersionOrRange: "57.0.14",
          },
        ],
        upToDate: false,
      }),
      1,
    )

    expect(result.exitCode).toBe(0)
    expect(parsed.kind).toBe("drift")
    if (parsed.kind !== "drift") throw new Error("expected valid drift")
    const warning = githubCommandValue(renderDrift(parsed.dependencies))
    expect(warning).not.toContain("\u0007")
    expect(warning).not.toContain("`")
    expect(warning.length).toBeLessThan(700)
    expect(warning).toContain("%0A")
  })

  test("unknown CI context and unknown policy arguments block before either binary", async () => {
    for (const [argument, environment] of [
      ["ci", { GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/heads/main" }],
      ["unknown", pullRequestEnvironment],
    ] as const) {
      const fixture = await createFixture({ expoOutput: currentAdvice })
      const result = await run(fixture, argument, environment)
      expect(result.exitCode).not.toBe(0)
      expect(await calls(fixture)).toEqual([])
    }
  })

  test("mutation proofs hold local binaries, offline Doctor, PR-only warning, and fail-closed rules", async () => {
    const source = await readFile(script, "utf8")
    assertWrapperContract(source)

    const mutations = [
      source.replace('join(process.cwd(), "node_modules/.bin", binary)', "binary"),
      source.replace('{ EXPO_OFFLINE: "1" }', "{}"),
      source.replace('if (lane === "pull_request")', 'if (lane !== "release")'),
      source.replace(
        "value.upToDate === true && exitCode === 0 && value.dependencies.length === 0",
        "exitCode === 0",
      ),
      source.replace("exitCode !== driftExitStatus", "false"),
    ]
    for (const mutation of mutations) {
      expect(mutation).not.toBe(source)
      expect(() => assertWrapperContract(mutation)).toThrow()
    }
  })
})

const currentAdvice = JSON.stringify({ dependencies: [], upToDate: true })
const driftAdvice = JSON.stringify({
  dependencies: [
    {
      packageName: "expo-router",
      packageType: "dependencies",
      expectedVersionOrRange: "~57.0.14",
      actualVersion: "57.0.13",
    },
  ],
  upToDate: false,
})
const pullRequestEnvironment = {
  GITHUB_EVENT_NAME: "pull_request",
  GITHUB_REF: "refs/pull/441/merge",
}

async function createFixture(options: {
  doctorExit?: number
  expoExit?: number
  expoOutput: string
}): Promise<string> {
  const fixture = await mkdtemp(join(tmpdir(), "expo-health-"))
  fixtures.push(fixture)
  const bin = join(fixture, "node_modules/.bin")
  await mkdir(bin, { recursive: true })
  await writeExecutable(
    join(bin, "expo-doctor"),
    `#!/bin/sh\nprintf 'doctor offline=%s\\n' "${"$"}{EXPO_OFFLINE:-}" >> calls\nexit ${options.doctorExit ?? 0}\n`,
  )
  await writeExecutable(
    join(bin, "expo"),
    `#!/bin/sh\nprintf 'expo ci=%s args=%s\\n' "${"$"}{CI:-}" "${"$"}*" >> calls\ncat expo-output\nprintf '\\n'\nexit ${options.expoExit ?? 0}\n`,
  )
  await writeFile(join(fixture, "expo-output"), options.expoOutput)
  return fixture
}

async function run(
  fixture: string,
  argument: string,
  environment: Record<string, string>,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const subprocess = Bun.spawn([process.execPath, script, argument], {
    cwd: fixture,
    env: {
      PATH: process.env.PATH,
      ...environment,
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
  ])
  return { exitCode, stdout, stderr }
}

async function calls(fixture: string): Promise<string[]> {
  const file = Bun.file(join(fixture, "calls"))
  if (!(await file.exists())) return []
  return (await file.text()).trim().split("\n")
}

async function writeExecutable(path: string, source: string): Promise<void> {
  await writeFile(path, source)
  await chmod(path, 0o755)
}

function assertWrapperContract(source: string): void {
  expect(source).toContain('join(process.cwd(), "node_modules/.bin", binary)')
  expect(source).toContain('runLocal("expo-doctor", [], { EXPO_OFFLINE: "1" })')
  expect(source).toContain('if (lane === "pull_request")')
  expect(source).toContain("console.log(`::warning title=Expo SDK advice changed::")
  expect(source).toContain(
    "value.upToDate === true && exitCode === 0 && value.dependencies.length === 0",
  )
  expect(source).toContain("exitCode !== driftExitStatus")
}
