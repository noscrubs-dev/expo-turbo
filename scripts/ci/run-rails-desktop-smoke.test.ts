import { afterEach, describe, expect, test } from "bun:test"
import { chmod, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const runner = join(repositoryRoot, "scripts/ci/run-rails-desktop-smoke.sh")
const smokeDirectory = join(repositoryRoot, "example/expo/src")
const fixtures: string[] = []

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map((fixture) => rm(fixture, { recursive: true, force: true })),
  )
})

describe("Rails desktop smoke runner", () => {
  test("discovers every live smoke file and runs one isolated Bun command", async () => {
    const fixture = await createCommands()
    const result = await runRunner(runner, fixture)
    const discovered = await liveSmokeFiles(smokeDirectory)
    const call = (await readFile(join(fixture, "bun-call"), "utf8")).trim().split("\n")

    expect(result.status).toBe(0)
    expect(call.slice(0, 2)).toEqual(["test", "--isolate"])
    expect(call.slice(2).sort()).toEqual(discovered.map((file) => `src/${file}`).sort())
    expect(await readFile(join(fixture, "bun-origin"), "utf8")).toBe("http://127.0.0.1:3001\n")
    expect(await readFile(join(fixture, "rails-environment"), "utf8")).toContain("3001 development")
    expect(await readFile(join(fixture, "events"), "utf8")).toContain("rails-term")
  })

  test("propagates Bun failure and stops Rails", async () => {
    const fixture = await createCommands()
    const result = await runRunner(runner, fixture, { BUN_EXIT: "17" })

    expect(result.status).toBe(17)
    expect(await readFile(join(fixture, "events"), "utf8")).toContain("rails-term")
  })

  test("stops Bun and Rails on SIGTERM and preserves signal status", async () => {
    const fixture = await createCommands()
    const child = Bun.spawn([runner], {
      env: testEnvironment(fixture, { BUN_HANG: "1" }),
      stdout: "pipe",
      stderr: "pipe",
    })

    await waitForFile(join(fixture, "bun-ready"))
    process.kill(child.pid, "SIGTERM")
    const status = await child.exited
    const events = await readFile(join(fixture, "events"), "utf8")

    expect(status).toBe(143)
    expect(events).toContain("bun-term")
    expect(events).toContain("rails-term")
  })

  test("readiness timeout fails and stops Rails", async () => {
    const fixture = await createCommands({ readinessTimeout: true })
    const result = await runRunner(runner, fixture)

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("Rails did not become ready within 30 seconds.")
    expect(await readFile(join(fixture, "events"), "utf8")).toContain("rails-term")
    expect(Bun.file(join(fixture, "bun-call")).exists()).resolves.toBe(false)
  })

  test("empty, duplicate, and symbolic-link discovery fail before Rails starts", async () => {
    for (const mode of ["empty", "duplicate", "link"] as const) {
      const repository = await createFixtureRepository(mode)
      const commands = await createCommands()
      const result = await runRunner(
        join(repository, "scripts/ci/run-rails-desktop-smoke.sh"),
        commands,
      )

      expect(result.status).not.toBe(0)
      expect(result.stderr).toMatch(/found no live smoke files|discovery is ambiguous/)
      expect(Bun.file(join(commands, "rails-environment")).exists()).resolves.toBe(false)
    }
  })
})

async function liveSmokeFiles(directory: string, prefix = ""): Promise<string[]> {
  const entries = await Array.fromAsync(
    new Bun.Glob("**/demo-live-*.{rails,redis}-smoke.test.{js,jsx,ts,tsx}").scan({
      cwd: directory,
      onlyFiles: true,
    }),
  )
  return entries.map((entry) => join(prefix, entry)).sort()
}

async function createCommands(options: { readinessTimeout?: boolean } = {}): Promise<string> {
  const fixture = await mkdtemp(join(tmpdir(), "rails-desktop-smoke-"))
  fixtures.push(fixture)
  const bin = join(fixture, "bin")
  await mkdir(bin)

  await executable(
    join(bin, "bundle"),
    `#!/usr/bin/env bash
printf '%s %s %s\\n' "$PORT" "$RAILS_ENV" "$BUNDLE_GEMFILE" >"$FIXTURE/rails-environment"
trap 'printf "rails-term\\n" >>"$FIXTURE/events"; exit 0' TERM INT
while true; do /bin/sleep 0.05; done
`,
  )
  await executable(
    join(bin, "curl"),
    options.readinessTimeout ? "#!/usr/bin/env bash\nexit 22\n" : "#!/usr/bin/env bash\nexit 0\n",
  )
  await executable(
    join(bin, "bun"),
    `#!/usr/bin/env bash
printf '%s\\n' "$@" >"$FIXTURE/bun-call"
printf '%s\\n' "$EXPO_TURBO_DEMO_ORIGIN" >"$FIXTURE/bun-origin"
if [ "\${BUN_HANG:-}" = 1 ]; then
  printf 'ready\\n' >"$FIXTURE/bun-ready"
  trap 'printf "bun-term\\n" >>"$FIXTURE/events"; exit 0' TERM INT
  while true; do /bin/sleep 0.05; done
fi
exit "\${BUN_EXIT:-0}"
`,
  )
  if (options.readinessTimeout) {
    await executable(join(bin, "seq"), "#!/usr/bin/env bash\nprintf '1\\n'\n")
    await executable(join(bin, "sleep"), "#!/usr/bin/env bash\nexit 0\n")
  }
  return fixture
}

async function createFixtureRepository(mode: "empty" | "duplicate" | "link"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rails-desktop-smoke-repository-"))
  fixtures.push(root)
  await mkdir(join(root, "scripts/ci"), { recursive: true })
  await mkdir(join(root, "example/rails"), { recursive: true })
  await mkdir(join(root, "example/expo/src/nested"), { recursive: true })
  await cp(runner, join(root, "scripts/ci/run-rails-desktop-smoke.sh"))
  await chmod(join(root, "scripts/ci/run-rails-desktop-smoke.sh"), 0o755)

  if (mode !== "empty") {
    const first = join(root, "example/expo/src/demo-live-one.rails-smoke.test.ts")
    await writeFile(first, "test('one', () => {})\n")
    if (mode === "duplicate") {
      await writeFile(
        join(root, "example/expo/src/nested", basename(first)),
        "test('two', () => {})\n",
      )
    } else {
      await symlink(first, join(root, "example/expo/src/nested/demo-live-link.rails-smoke.test.ts"))
    }
  }
  return root
}

async function executable(path: string, contents: string): Promise<void> {
  await writeFile(path, contents)
  await chmod(path, 0o755)
}

async function runRunner(
  path: string,
  fixture: string,
  environment: Record<string, string> = {},
): Promise<{ status: number; stdout: string; stderr: string }> {
  const stdoutPath = join(fixture, "runner-stdout")
  const stderrPath = join(fixture, "runner-stderr")
  const child = Bun.spawn([path], {
    env: testEnvironment(fixture, environment),
    stdout: Bun.file(stdoutPath),
    stderr: Bun.file(stderrPath),
  })
  const status = await child.exited
  const [stdout, stderr] = await Promise.all([
    readFile(stdoutPath, "utf8"),
    readFile(stderrPath, "utf8"),
  ])
  return { status, stdout, stderr }
}

function testEnvironment(
  fixture: string,
  values: Record<string, string> = {},
): Record<string, string> {
  return {
    ...process.env,
    ...values,
    FIXTURE: fixture,
    PATH: `${join(fixture, "bin")}:${process.env.PATH ?? ""}`,
  }
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await Bun.file(path).exists()) return
    await Bun.sleep(10)
  }
  throw new Error(`Timed out while waiting for ${path}`)
}
