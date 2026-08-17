import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

// The Android lane asserts its Maestro pin before it touches a device, so the
// assertion itself is provable the same way: a fake maestro on PATH, no
// emulator, no KVM. Only bash, grep, head, and tr are needed from the system
// directories below, and no maestro installer puts a CLI there.
const checkScript = join(dirname(fileURLToPath(import.meta.url)), "check-maestro-version.sh")
const systemPath = "/usr/bin:/bin"
const fixtures: string[] = []

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  )
})

describe("the Android lane's Maestro pin", () => {
  test("accepts the pinned version and reports it for the run evidence", async () => {
    const result = await runCheck(await fakeMaestro("echo 2.7.0"))

    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe("2.7.0")
  })

  test("accepts the pinned version reported with a trailing CLI notice", async () => {
    const result = await runCheck(
      await fakeMaestro('echo 2.7.0\necho "Maestro 9.9.9 is available"'),
    )

    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe("2.7.0")
  })

  test("rejects a runner with no maestro at all", async () => {
    const result = await runCheck(systemPath)

    expect(result.status).not.toBe(0)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain("no maestro on PATH")
    expect(result.stderr).toContain("Expected: 2.7.0")
  })

  test("rejects a maestro that is not the pinned version", async () => {
    const result = await runCheck(await fakeMaestro("echo 2.6.0"))

    expect(result.status).not.toBe(0)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain("Expected: 2.7.0")
    expect(result.stderr).toContain("Actual:   2.6.0")
  })

  test("rejects a maestro that cannot report a version", async () => {
    const result = await runCheck(await fakeMaestro('echo "broken install" >&2\nexit 3'))

    expect(result.status).not.toBe(0)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain("exit status 3")
    expect(result.stderr).toContain("broken install")
  })
})

describe("the Android lane's use of the Maestro pin", () => {
  // A guard that runs after the emulator is up costs a suite instead of
  // seconds, and a second reading taken at cleanup can report a version the
  // run was never proven against. Both are what this issue was about, so the
  // order and the single measurement are held here rather than only in review.
  test("asserts the pin before every protected lane command", async () => {
    assertLaneGuard(await readLane())
  })

  test("rejects every protected command category when it moves above the guard", async () => {
    const lane = await readLane()

    for (const protectedCommand of protectedCommands) {
      const mutation = lane.replace(maestroGuard, `${protectedCommand.mutation}\n${maestroGuard}`)
      expect(() => assertLaneGuard(mutation)).toThrow(protectedCommand.name)
    }
  })

  test("rejects a second Maestro version measurement", async () => {
    const lane = await readLane()
    const mutation = lane.replace(maestroGuard, `${maestroGuard}\nmaestro --version`)

    expect(() => assertLaneGuard(mutation)).toThrow("maestro --version")
  })

  test("rejects a second environment record of the asserted value", async () => {
    const lane = await readLane()
    const mutation = lane.replace(maestroEvidence, `${maestroEvidence}\n    ${maestroEvidence}`)

    expect(() => assertLaneGuard(mutation)).toThrow("exactly once")
  })
})

const maestroGuard = 'maestro_version="$("$script_dir/check-maestro-version.sh")"'
const maestroEvidence = 'echo "maestro=$maestro_version"'
const protectedCommands = [
  {
    name: "package install",
    pattern: /\bbun install\b|\bgem install\b|\bbundle install\b/g,
    mutation: "bun install --frozen-lockfile",
  },
  { name: "package build", pattern: /\bbun run build\b/g, mutation: "bun run build" },
  {
    name: "native build",
    pattern: /\bbun x expo prebuild\b|\.\/gradlew\b/g,
    mutation: "./gradlew app:assembleRelease",
  },
  {
    name: "emulator or ADB",
    pattern: /\badb(?:\s|$)|\$ANDROID_HOME\/emulator\/emulator/g,
    mutation: "adb kill-server",
  },
  { name: "Rails", pattern: /\bbundle exec rails server\b/g, mutation: "bundle exec rails server" },
  {
    name: "Maestro suite",
    pattern: /\bmaestro --device\b/g,
    mutation: "maestro --device emulator-5580 test .maestro",
  },
]

function assertLaneGuard(lane: string): void {
  const executableLane = lane
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n")
  const guardIndex = executableLane.indexOf(maestroGuard)

  expect(guardIndex).toBeGreaterThan(0)
  expect(executableLane.split(maestroGuard)).toHaveLength(2)

  for (const protectedCommand of protectedCommands) {
    const matches = [...executableLane.matchAll(protectedCommand.pattern)]
    if (matches.length === 0) {
      throw new Error(`${protectedCommand.name}: no current command matched`)
    }
    for (const match of matches) {
      if ((match.index ?? -1) < guardIndex) {
        throw new Error(`${protectedCommand.name}: protected command precedes version guard`)
      }
    }
  }

  if (/\bmaestro\s+--version\b/.test(executableLane)) {
    throw new Error("maestro --version must not measure the lane version again")
  }
  if (executableLane.split(maestroEvidence).length !== 2) {
    throw new Error("the asserted Maestro value must be recorded exactly once")
  }
}

async function readLane(): Promise<string> {
  return readFile(join(dirname(checkScript), "run-android-maestro.sh"), "utf8")
}

async function fakeMaestro(body: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "expo-turbo-maestro-pin-"))
  fixtures.push(directory)

  const executable = join(directory, "maestro")
  await writeFile(executable, `#!/bin/sh\n${body}\n`)
  await chmod(executable, 0o755)

  return `${directory}:${systemPath}`
}

async function runCheck(path: string): Promise<{ status: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([checkScript], {
    env: { PATH: path },
    stdout: "pipe",
    stderr: "pipe",
  })

  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])

  return { status, stdout, stderr }
}
