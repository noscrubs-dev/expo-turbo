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
    expect(await readFile(join(fixture, "bun-redis-url"), "utf8")).toBe(
      "redis://127.0.0.1:6379/15\n",
    )
    expect(await readFile(join(fixture, "rails-environment"), "utf8")).toContain(
      "3001 development redis://127.0.0.1:6379/15",
    )
    expect(await readFile(join(fixture, "redis-call"), "utf8")).toContain(
      "--bind 127.0.0.1 --port 6379 --save  --appendonly no",
    )
    expect(await readFile(join(fixture, "events"), "utf8")).toContain("rails-term")
    expect(await readFile(join(fixture, "events"), "utf8")).toContain("redis-term")
  })

  test("propagates Bun failure and stops both services", async () => {
    const fixture = await createCommands()
    const result = await runRunner(runner, fixture, { BUN_EXIT: "17" })
    const events = await readFile(join(fixture, "events"), "utf8")

    expect(result.status).toBe(17)
    expect(events).toContain("rails-term")
    expect(events).toContain("redis-term")
  })

  for (const [signal, status] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const) {
    test(`stops Bun and both services on ${signal} and preserves signal status`, async () => {
      const fixture = await createCommands()
      const child = spawnRunner(runner, fixture, { BUN_HANG: "1" })

      await waitForFile(join(fixture, "bun-ready"))
      process.kill(child.pid, signal)
      expect(await child.exited).toBe(status)
      const events = await readFile(join(fixture, "events"), "utf8")
      expect(events).toContain("bun-term")
      expect(events).toContain("rails-term")
      expect(events).toContain("redis-term")
    })
  }

  test("Rails readiness timeout fails and stops both services", async () => {
    const fixture = await createCommands({ railsReadinessTimeout: true })
    const result = await runRunner(runner, fixture)

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("Rails did not become ready within 1 seconds.")
    const events = await readFile(join(fixture, "events"), "utf8")
    expect(events).toContain("rails-term")
    expect(events).toContain("redis-term")
    expect(Bun.file(join(fixture, "bun-call")).exists()).resolves.toBe(false)
  })

  test("Redis readiness timeout fails and stops Redis before Rails starts", async () => {
    const fixture = await createCommands({ redisReadinessTimeout: true })
    const result = await runRunner(runner, fixture)

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("Redis did not become ready within 1 seconds.")
    expect(await readFile(join(fixture, "events"), "utf8")).toContain("redis-term")
    expect(Bun.file(join(fixture, "rails-environment")).exists()).resolves.toBe(false)
  })

  test("rejects occupied Rails and Redis ports before either service starts", async () => {
    for (const port of ["3001", "6379"]) {
      const fixture = await createCommands()
      const result = await runRunner(runner, fixture, { OCCUPIED_PORT: port })

      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain(`requires free port ${port}`)
      expect(Bun.file(join(fixture, "redis-call")).exists()).resolves.toBe(false)
      expect(Bun.file(join(fixture, "rails-environment")).exists()).resolves.toBe(false)
    }
  })

  test("fails if Rails exits before readiness", async () => {
    const fixture = await createCommands()
    const result = await runRunner(runner, fixture, { RAILS_EXIT_BEFORE_READY: "1" })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/Rails exited (immediately after start|before readiness)/)
    expect(Bun.file(join(fixture, "bun-call")).exists()).resolves.toBe(false)
    expect(await readFile(join(fixture, "events"), "utf8")).toContain("redis-term")
  })

  test("fails if Rails exits immediately after readiness", async () => {
    const fixture = await createCommands()
    const result = await runRunner(runner, fixture, { RAILS_EXIT_AFTER_READY: "1" })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("Rails exited immediately after readiness.")
    expect(Bun.file(join(fixture, "bun-call")).exists()).resolves.toBe(false)
  })

  test("stops Bun and fails if Rails exits during tests", async () => {
    const fixture = await createCommands()
    const result = await runRunner(runner, fixture, { RAILS_EXIT_DURING_TESTS: "1" })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("Rails exited while Bun smoke tests were running.")
    expect(await readFile(join(fixture, "events"), "utf8")).toContain("bun-term")
  })

  test("stops Bun and fails if Redis exits during tests", async () => {
    const fixture = await createCommands()
    const result = await runRunner(runner, fixture, { REDIS_EXIT_DURING_TESTS: "1" })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("Redis exited while Bun smoke tests were running.")
    expect(await readFile(join(fixture, "events"), "utf8")).toContain("bun-term")
  })

  test("bounds shutdown when Bun ignores TERM", async () => {
    const fixture = await createCommands()
    const child = spawnRunner(runner, fixture, { BUN_HANG: "1", BUN_IGNORE_TERM: "1" })

    await waitForFile(join(fixture, "bun-ready"))
    const deadlineStartedAt = performance.now()
    process.kill(child.pid, "SIGTERM")
    const status = await child.exited
    const elapsed = performance.now() - deadlineStartedAt
    const bunPid = Number.parseInt(await readFile(join(fixture, "bun-pid"), "utf8"), 10)

    expect(status).toBe(143)
    expect(elapsed).toBeLessThan(5_000)
    expect(() => process.kill(bunPid, 0)).toThrow()
    expect(await readFile(join(fixture, "events"), "utf8")).toContain("bun-term")
  })

  test("empty, duplicate, and symbolic-link discovery fail before services start", async () => {
    for (const mode of ["empty", "duplicate", "link"] as const) {
      const repository = await createFixtureRepository(mode)
      const commands = await createCommands()
      const result = await runRunner(
        join(repository, "scripts/ci/run-rails-desktop-smoke.sh"),
        commands,
      )

      expect(result.status).not.toBe(0)
      expect(result.stderr).toMatch(/found no live smoke files|discovery is ambiguous/)
      expect(Bun.file(join(commands, "redis-call")).exists()).resolves.toBe(false)
      expect(Bun.file(join(commands, "rails-environment")).exists()).resolves.toBe(false)
    }
  })
})

async function liveSmokeFiles(directory: string): Promise<string[]> {
  const entries = await Array.fromAsync(
    new Bun.Glob("**/demo-live-*.{rails,redis}-smoke.test.{js,jsx,ts,tsx}").scan({
      cwd: directory,
      onlyFiles: true,
    }),
  )
  return entries.sort()
}

interface CommandOptions {
  railsReadinessTimeout?: boolean
  redisReadinessTimeout?: boolean
}

async function createCommands(options: CommandOptions = {}): Promise<string> {
  const fixture = await mkdtemp(join(tmpdir(), "rails-desktop-smoke-"))
  fixtures.push(fixture)
  const bin = join(fixture, "bin")
  await mkdir(bin)

  await executable(
    join(bin, "ruby"),
    `#!/usr/bin/env bash
for port in "$@"; do :; done
[ "\${OCCUPIED_PORT:-}" != "$port" ]
`,
  )
  await executable(
    join(bin, "redis-server"),
    `#!/usr/bin/env bash
printf '%s ' "$@" >"$FIXTURE/redis-call"
printf '\n' >>"$FIXTURE/redis-call"
printf '%s\n' "$$" >"$FIXTURE/redis-pid"
trap 'printf "redis-term\\n" >>"$FIXTURE/events"; exit 0' TERM INT
if [ "\${REDIS_EXIT_DURING_TESTS:-}" = 1 ]; then
  while [ ! -e "$FIXTURE/bun-ready" ]; do /bin/sleep 0.01; done
  exit 32
fi
while true; do /bin/sleep 0.05; done
`,
  )
  await executable(
    join(bin, "redis-cli"),
    options.redisReadinessTimeout
      ? "#!/usr/bin/env bash\nexit 1\n"
      : "#!/usr/bin/env bash\nprintf 'PONG\\n'\n",
  )
  await executable(
    join(bin, "bundle"),
    `#!/usr/bin/env bash
printf '%s %s %s %s\n' "$PORT" "$RAILS_ENV" "$REDIS_URL" "$BUNDLE_GEMFILE" >"$FIXTURE/rails-environment"
printf '%s\n' "$$" >"$FIXTURE/rails-pid"
[ "\${RAILS_EXIT_BEFORE_READY:-}" != 1 ] || exit 31
trap 'printf "rails-term\\n" >>"$FIXTURE/events"; exit 0' TERM INT
if [ "\${RAILS_EXIT_DURING_TESTS:-}" = 1 ]; then
  while [ ! -e "$FIXTURE/bun-ready" ]; do /bin/sleep 0.01; done
  exit 33
fi
while true; do /bin/sleep 0.05; done
`,
  )
  await executable(
    join(bin, "curl"),
    options.railsReadinessTimeout
      ? "#!/usr/bin/env bash\nexit 22\n"
      : `#!/usr/bin/env bash
if [ "\${RAILS_EXIT_BEFORE_READY:-}" = 1 ]; then
  while kill -0 "$(<"$FIXTURE/rails-pid")" 2>/dev/null; do /bin/sleep 0.01; done
  exit 22
fi
if [ "\${RAILS_EXIT_AFTER_READY:-}" = 1 ]; then
  kill -TERM "$(<"$FIXTURE/rails-pid")"
  while kill -0 "$(<"$FIXTURE/rails-pid")" 2>/dev/null; do /bin/sleep 0.01; done
fi
exit 0
`,
  )
  await executable(
    join(bin, "bun"),
    `#!/usr/bin/env bash
printf '%s\n' "$@" >"$FIXTURE/bun-call"
printf '%s\n' "$$" >"$FIXTURE/bun-pid"
printf '%s\n' "$EXPO_TURBO_DEMO_ORIGIN" >"$FIXTURE/bun-origin"
printf '%s\n' "$REDIS_URL" >"$FIXTURE/bun-redis-url"
if [ "\${BUN_HANG:-}" = 1 ] || [ "\${RAILS_EXIT_DURING_TESTS:-}" = 1 ] || [ "\${REDIS_EXIT_DURING_TESTS:-}" = 1 ]; then
  if [ "\${BUN_IGNORE_TERM:-}" = 1 ]; then
    trap 'printf "bun-term\\n" >>"$FIXTURE/events"' TERM INT
  else
  trap 'printf "bun-term\\n" >>"$FIXTURE/events"; exit 0' TERM INT
  fi
  printf 'ready\n' >"$FIXTURE/bun-ready"
  if [ "\${BUN_IGNORE_TERM:-}" = 1 ]; then
    while true; do :; done
  fi
  while true; do /bin/sleep 0.05; done
fi
exit "\${BUN_EXIT:-0}"
`,
  )
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

function spawnRunner(
  path: string,
  fixture: string,
  environment: Record<string, string> = {},
): ReturnType<typeof Bun.spawn> {
  return Bun.spawn([path], {
    env: testEnvironment(fixture, environment),
    stdout: "pipe",
    stderr: "pipe",
  })
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
    EXPO_TURBO_SMOKE_READINESS_ATTEMPTS: "1",
    EXPO_TURBO_SMOKE_READINESS_INTERVAL: "0.01",
    FIXTURE: fixture,
    PATH: `${join(fixture, "bin")}:${process.env.PATH ?? ""}`,
  }
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (await Bun.file(path).exists()) return
    await Bun.sleep(10)
  }
  throw new Error(`Timed out while waiting for ${path}`)
}
