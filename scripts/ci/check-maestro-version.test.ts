import { afterEach, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

// The Android lane asserts its Maestro pin before it touches a device, so the
// assertion itself is provable the same way: a fake maestro on PATH, no
// emulator, no KVM. Only bash, grep, head, and tr are needed from the system
// path below. Entries that contain a real Maestro are removed so the missing
// case is deterministic without also removing runner-specific command shims.
const checkScript = join(dirname(fileURLToPath(import.meta.url)), "check-maestro-version.sh")
const systemPath = (process.env.PATH ?? "/usr/bin:/bin")
  .split(":")
  .filter((entry) => !existsSync(join(entry, "maestro")))
  .join(":")
const fixtures: string[] = []

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  )
})

describe.serial("Android Maestro CI", () => {
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

    test("accepts a CR on the pinned first line", async () => {
      const result = await runCheck(await fakeMaestro("printf '2.7.0\\r\\nupdate available\\n'"))

      expect(result.status).toBe(0)
      expect(result.stdout.trim()).toBe("2.7.0")
    })

    test("rejects a wrong first line even when a later line has the pin", async () => {
      const result = await runCheck(await fakeMaestro("echo 2.6.0\necho 2.7.0"))

      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain("Actual:   2.6.0")
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
    test("asserts the pin before every current protected command category", async () => {
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

    test("rejects a second check-maestro-version invocation", async () => {
      const lane = await readLane()
      const mutation = lane.replace(
        maestroGuard,
        `${maestroGuard}\n"$script_dir/check-maestro-version.sh" >/dev/null`,
      )

      expect(() => assertLaneGuard(mutation)).toThrow("exactly once")
    })

    test("rejects command maestro -v as a second version measurement", async () => {
      const lane = await readLane()
      const mutation = lane.replace(maestroGuard, `${maestroGuard}\ncommand maestro -v`)

      expect(() => assertLaneGuard(mutation)).toThrow("maestro --version or -v")
    })

    test("rejects a line-continued Maestro version measurement", async () => {
      const lane = await readLane()
      const mutation = lane.replace(maestroGuard, `${maestroGuard}\nmaestro \\\n  --version`)

      expect(() => assertLaneGuard(mutation)).toThrow("maestro --version or -v")
    })

    test("does not let a comment backslash hide a package install above the guard", async () => {
      const lane = await readLane()
      const mutation = lane.replace(maestroGuard, `# note \\\nbun install\n${maestroGuard}`)

      expect(() => assertLaneGuard(mutation)).toThrow("package install")
    })

    test("does not let a comment backslash hide a Maestro version read", async () => {
      const lane = await readLane()
      const mutation = lane.replace(maestroGuard, `# note \\\nmaestro --version\n${maestroGuard}`)

      expect(() => assertLaneGuard(mutation)).toThrow("maestro --version or -v")
    })

    test("protects bunx expo prebuild", async () => {
      const lane = await readLane()
      const mutation = lane.replace(maestroGuard, `bunx expo prebuild\n${maestroGuard}`)

      expect(() => assertLaneGuard(mutation)).toThrow("native build")
    })

    test("rejects common protected command equivalents above the guard", async () => {
      const lane = await readLane()
      const equivalents = [
        ["package install", "npm ci"],
        ["Android SDK install", "sdkmanager 'platform-tools'"],
        ["native build", "gradle app:assembleRelease"],
      ] as const

      for (const [name, command] of equivalents) {
        const mutation = lane.replace(maestroGuard, `${command}\n${maestroGuard}`)
        expect(() => assertLaneGuard(mutation)).toThrow(name)
      }
    })

    test("rejects a unique guard moved into a function that runs late", async () => {
      const lane = await readLane()
      const mutation = lane.replace(
        `${maestroGuard}\nreadonly maestro_version`,
        `late_guard() {\n  ${maestroGuard}\n}\nreadonly maestro_version`,
      )

      expect(() => assertLaneGuard(mutation)).toThrow("top level before any function")
    })

    test("ignores protected words in comments, including trailing comments", async () => {
      const lane = await readLane()
      const mutation = lane.replace(
        maestroGuard,
        `# npm ci; sdkmanager; gradle; check-maestro-version.sh\necho preflight # command maestro -v\n${maestroGuard}`,
      )

      expect(() => assertLaneGuard(mutation)).not.toThrow()
    })

    test("rejects a second environment record of the asserted value", async () => {
      const lane = await readLane()
      const mutation = lane.replace(maestroEvidence, `${maestroEvidence}\n    ${maestroEvidence}`)

      expect(() => assertLaneGuard(mutation)).toThrow("exactly once")
    })
  })
})

const maestroGuard = 'maestro_version="$("$script_dir/check-maestro-version.sh")"'
const maestroEvidence = 'echo "maestro=$maestro_version"'
const protectedCommands: Array<{
  name: string
  pattern: RegExp
  mutation: string
  required?: boolean
}> = [
  {
    name: "package install",
    pattern: /\bbun\s+install\b|\bnpm\s+(?:ci|install)\b|\bgem\s+install\b|\bbundle\s+install\b/g,
    mutation: "bun install --frozen-lockfile",
  },
  { name: "package build", pattern: /\bbun run build\b/g, mutation: "bun run build" },
  {
    name: "native build",
    pattern: /\b(?:bun\s+x|bunx)\s+expo\s+prebuild\b|(?:^|[;&|()\s])(?:\.\/)?gradle(?:w)?(?=\s|$)/g,
    mutation: "./gradlew app:assembleRelease",
  },
  {
    name: "Android SDK install",
    pattern: /(?:^|[;&|()\s])sdkmanager(?=\s|$)/g,
    mutation: "sdkmanager platform-tools",
    required: false,
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
  const executableLane = normalizeShell(lane)
  const guardIndex = executableLane.indexOf(maestroGuard)
  const guardCalls = executableLane.match(/check-maestro-version\.sh/g) ?? []
  const firstFunction = executableLane.search(
    /^(?:function\s+[A-Za-z_][A-Za-z0-9_]*(?:\s*\(\s*\))?|[A-Za-z_][A-Za-z0-9_]*\s*\(\s*\))\s*\{/m,
  )

  expect(guardIndex).toBeGreaterThan(0)
  if (guardCalls.length !== 1) {
    throw new Error("check-maestro-version.sh must execute exactly once")
  }
  if (firstFunction >= 0 && guardIndex > firstFunction) {
    throw new Error("the unique version guard must execute at top level before any function")
  }

  for (const protectedCommand of protectedCommands) {
    const matches = [...executableLane.matchAll(protectedCommand.pattern)]
    if (matches.length === 0 && protectedCommand.required !== false) {
      throw new Error(`${protectedCommand.name}: no current command matched`)
    }
    for (const match of matches) {
      if ((match.index ?? -1) < guardIndex) {
        throw new Error(`${protectedCommand.name}: protected command precedes version guard`)
      }
    }
  }

  if (/\b(?:command\s+)?maestro\s+(?:--version|-v)(?=\s|$)/.test(executableLane)) {
    throw new Error("maestro --version or -v must not measure the lane version again")
  }
  if (executableLane.split(maestroEvidence).length !== 2) {
    throw new Error("the asserted Maestro value must be recorded exactly once")
  }
}

function normalizeShell(source: string): string {
  const logicalLines: string[] = []
  let pending = ""

  for (const physicalLine of source.split("\n")) {
    const uncommented = stripShellComment(physicalLine)
    if (/\\$/.test(uncommented)) {
      pending += `${uncommented.slice(0, -1)} `
      continue
    }

    const executable = `${pending}${uncommented}`.trimEnd()
    pending = ""
    if (executable.trim().length > 0) {
      logicalLines.push(executable)
    }
  }

  if (pending.trim().length > 0) {
    logicalLines.push(stripShellComment(pending).trimEnd())
  }
  return logicalLines.join("\n")
}

function stripShellComment(line: string): string {
  let quote: "'" | '"' | undefined
  let escaped = false

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (character === "\\" && quote !== "'") {
      escaped = true
      continue
    }
    if (quote) {
      if (character === quote) {
        quote = undefined
      }
      continue
    }
    if (character === "'" || character === '"') {
      quote = character
      continue
    }
    if (character === "#" && (index === 0 || /\s/.test(line[index - 1] ?? ""))) {
      return line.slice(0, index)
    }
  }
  return line
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
  const outputDirectory = await mkdtemp(join(tmpdir(), "expo-turbo-maestro-output-"))
  fixtures.push(outputDirectory)
  const stdoutPath = join(outputDirectory, "stdout.txt")
  const stderrPath = join(outputDirectory, "stderr.txt")
  const child = Bun.spawn(["/bin/bash", "-c", await readFile(checkScript, "utf8")], {
    env: { ...process.env, PATH: path },
    stdout: Bun.file(stdoutPath),
    stderr: Bun.file(stderrPath),
  })

  const status = await child.exited
  return {
    status,
    stdout: await readFile(stdoutPath, "utf8"),
    stderr: await readFile(stderrPath, "utf8"),
  }
}
