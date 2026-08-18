import { afterAll, afterEach, describe, expect, test } from "bun:test"
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const runner = join(repositoryRoot, "scripts/ci/run-rails-desktop-smoke.sh")
const smokeDirectory = join(repositoryRoot, "example/expo/src")
const processGroupStopChecks = 40
const processGroupStopInterval = 25
const settleDeadline = 1_000
const operationDeadline = 8_000
const deadlineRegressionDeadline = 500
const worstCaseCleanup = processGroupStopChecks * processGroupStopInterval * 2 + settleDeadline * 2
const outerTestDeadline = 30_000
const delayedTrapSeconds = "0.25"
const serviceTemplateExpression = "$" + "{service}"
const exactStartBarrierSource =
  `wait_for_exact_start "$FIXTURE/${serviceTemplateExpression}-started" ` +
  `"$FIXTURE/${serviceTemplateExpression}-pid"`
const internalDeadlineSource =
  "    const outcome = await promiseWithDeadline(\n" +
  "      operationResult,\n      deadlineMilliseconds,"
const serialDeclarationSource = ["test", ".serial("].join("")
const ownedGroupWaitSource = [
  "await waitForOwned",
  "ProcessGroupExit(scope, owned, controls)",
].join("")
const ownedGroupWaitSiteCount = 1
const groupPermissionExistsSource = ["    if (code === ", '"EPERM"', ") return true"].join("")
const groupPermissionExistsSiteCount = 1
const harnessTemporaryPrefixes = [
  "rails-desktop-smoke-",
  "expo-turbo-service-failure.",
  "expo-turbo-rails-smoke.",
  "expo-turbo-redis-smoke.",
]
const fallbackScopes = new Set<TestScope>()
let activeTestScope: TestScope | undefined

afterEach(async () => {
  const scope = activeTestScope
  if (scope === undefined) return
  try {
    await cleanupTestScope(scope)
  } catch (cleanupError) {
    console.error("Emergency test cleanup also failed:", cleanupError)
  } finally {
    if (activeTestScope === scope) activeTestScope = undefined
  }
})

afterAll(async () => {
  const cleanupErrors: unknown[] = []
  for (const scope of Array.from(fallbackScopes)) {
    try {
      await cleanupTestScope(scope)
    } catch (error) {
      cleanupErrors.push(error)
    }
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, "Command-exit cleanup failed")
  }
  if (fallbackScopes.size > 0) throw new Error("A test still owns smoke resources")
  await assertPortsFree()
  const residue = (await readdir(tmpdir())).filter((entry) =>
    harnessTemporaryPrefixes.some((prefix) => entry.startsWith(prefix)),
  )
  if (residue.length > 0) throw new Error(`Smoke temporary residue remains: ${residue.join(", ")}`)
})

describe("Rails desktop smoke runner", () => {
  scopedTest("waits for delayed services and runs one isolated Bun command", async (scope) => {
    const fixture = await createCommands(scope)
    const result = await runRunner(scope, runner, fixture, {
      BUN_PRE_TRAP_DELAY: delayedTrapSeconds,
      RAILS_PRE_TRAP_DELAY: delayedTrapSeconds,
      REDIS_PRE_TRAP_DELAY: delayedTrapSeconds,
    })
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
    for (const service of ["redis", "rails", "bun"] as const) {
      expect(Number.parseInt(await readFile(join(fixture, `${service}-started`), "utf8"), 10)).toBe(
        Number.parseInt(await readFile(join(fixture, `${service}-pid`), "utf8"), 10),
      )
    }
  })

  scopedTest("propagates Bun failure and stops both services", async (scope) => {
    const fixture = await createCommands(scope)
    const result = await runRunner(scope, runner, fixture, { BUN_EXIT: "17" })
    const events = await readFile(join(fixture, "events"), "utf8")

    expect(result.status).toBe(17)
    expect(events).toContain("rails-term")
    expect(events).toContain("redis-term")
  })

  for (const [signal, status] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const) {
    scopedTest(
      `stops Bun and both services on ${signal} and preserves signal status`,
      async (scope) => {
        const fixture = await createCommands(scope)
        await withOwnedRunner(
          scope,
          runner,
          fixture,
          { BUN_HANG: "1", BUN_PRE_TRAP_DELAY: delayedTrapSeconds },
          async (child, operationSignal) => {
            await waitForStartMarker(fixture, "bun", operationSignal)
            process.kill(child.pid, signal)
            expect(await child.exited).toBe(status)
            const events = await readFile(join(fixture, "events"), "utf8")
            expect(events).toContain("bun-term")
            expect(events).toContain("rails-term")
            expect(events).toContain("redis-term")
          },
        )
      },
    )
  }

  scopedTest("Rails readiness timeout fails and stops both services", async (scope) => {
    const fixture = await createCommands(scope, { railsReadinessTimeout: true })
    const result = await runRunner(scope, runner, fixture)

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("Rails did not become ready within 1 seconds.")
    const events = await readFile(join(fixture, "events"), "utf8")
    expect(events).toContain("rails-term")
    expect(events).toContain("redis-term")
    expect(Bun.file(join(fixture, "bun-call")).exists()).resolves.toBe(false)
  })

  scopedTest("Redis readiness timeout fails and stops Redis before Rails starts", async (scope) => {
    const fixture = await createCommands(scope, { redisReadinessTimeout: true })
    const result = await runRunner(scope, runner, fixture)

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("Redis did not become ready within 1 seconds.")
    expect(await readFile(join(fixture, "events"), "utf8")).toContain("redis-term")
    expect(Bun.file(join(fixture, "rails-environment")).exists()).resolves.toBe(false)
  })

  scopedTest(
    "rejects occupied Rails and Redis ports before either service starts",
    async (scope) => {
      for (const port of ["3001", "6379"]) {
        const fixture = await createCommands(scope)
        const result = await runRunner(scope, runner, fixture, { OCCUPIED_PORT: port })

        expect(result.status).not.toBe(0)
        expect(result.stderr).toContain(`requires free port ${port}`)
        expect(Bun.file(join(fixture, "redis-call")).exists()).resolves.toBe(false)
        expect(Bun.file(join(fixture, "rails-environment")).exists()).resolves.toBe(false)
      }
    },
  )

  scopedTest("fails if Rails exits before readiness", async (scope) => {
    const fixture = await createCommands(scope)
    const result = await runRunner(scope, runner, fixture, { RAILS_EXIT_BEFORE_READY: "1" })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/Rails exited (immediately after start|before readiness)/)
    expect(Bun.file(join(fixture, "bun-call")).exists()).resolves.toBe(false)
    expect(await readFile(join(fixture, "events"), "utf8")).toContain("redis-term")
  })

  scopedTest("fails if Rails exits immediately after readiness", async (scope) => {
    const fixture = await createCommands(scope)
    const result = await runRunner(scope, runner, fixture, { RAILS_EXIT_AFTER_READY: "1" })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("Rails exited immediately after readiness.")
    expect(Bun.file(join(fixture, "bun-call")).exists()).resolves.toBe(false)
  })

  scopedTest("stops Bun and fails if Rails exits during tests", async (scope) => {
    const fixture = await createCommands(scope)
    const result = await runRunner(scope, runner, fixture, { RAILS_EXIT_DURING_TESTS: "1" })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("Rails exited while Bun smoke tests were running.")
    expect(await readFile(join(fixture, "events"), "utf8")).toContain("bun-term")
  })

  scopedTest("stops Bun and fails if Redis exits during tests", async (scope) => {
    const fixture = await createCommands(scope)
    const result = await runRunner(scope, runner, fixture, { REDIS_EXIT_DURING_TESTS: "1" })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("Redis exited while Bun smoke tests were running.")
    expect(await readFile(join(fixture, "events"), "utf8")).toContain("bun-term")
  })

  scopedTest("bounds shutdown when Bun ignores TERM", async (scope) => {
    const fixture = await createCommands(scope)
    await withOwnedRunner(
      scope,
      runner,
      fixture,
      { BUN_HANG: "1", BUN_IGNORE_TERM: "1" },
      async (child, signal) => {
        await waitForStartMarker(fixture, "bun", signal)
        const deadlineStartedAt = performance.now()
        process.kill(child.pid, "SIGTERM")
        const status = await child.exited
        const elapsed = performance.now() - deadlineStartedAt
        const bunPid = Number.parseInt(await readFile(join(fixture, "bun-pid"), "utf8"), 10)

        expect(status).toBe(143)
        expect(elapsed).toBeLessThan(5_000)
        expect(isProcessAlive(bunPid)).toBe(false)
        expect(await readFile(join(fixture, "events"), "utf8")).toContain("bun-term")
      },
    )
  })

  scopedTest("cleans the full process group after body and deadline errors", async (scope) => {
    for (const failure of ["assertion", "read", "spawn", "deadline"] as const) {
      const fixture = await createCommands(scope)
      const startedAt = performance.now()
      let descendantPids: number[] = []
      let processGroup = 0

      try {
        await withOwnedRunner(
          scope,
          runner,
          fixture,
          { BUN_HANG: "1", BUN_IGNORE_TERM: "1" },
          async (child, signal) => {
            processGroup = child.pid
            await waitForStartMarker(fixture, "bun", signal)
            descendantPids = await readFixturePids(fixture)
            if (failure === "assertion") expect("actual smoke result").toBe("expected smoke result")
            if (failure === "read") await readFile(join(fixture, "missing-output"), "utf8")
            if (failure === "spawn") throw new Error("simulated spawn error after registration")
            if (failure === "deadline") {
              await new Promise<never>((_, reject) => {
                signal.addEventListener("abort", () => reject(signal.reason), { once: true })
              })
            }
          },
          failure === "deadline" ? deadlineRegressionDeadline : operationDeadline,
        )
        throw new Error(`Expected ${failure} failure`)
      } catch (error) {
        expect(String(error)).toContain(
          {
            assertion: "expected smoke result",
            read: "ENOENT",
            spawn: "simulated spawn error",
            deadline: `internal ${deadlineRegressionDeadline} ms deadline`,
          }[failure],
        )
      }

      if (failure === "deadline") {
        const elapsed = performance.now() - startedAt
        expect(elapsed).toBeLessThan(deadlineRegressionDeadline + worstCaseCleanup + 1_000)
        expect(elapsed).toBeLessThan(outerTestDeadline)
      }
      expect(processGroupExists(processGroup)).toBe(false)
      expect(descendantPids.every((pid) => !isProcessAlive(pid))).toBe(true)
      await removeFixture(scope, fixture)
      expect(await Bun.file(fixture).exists()).toBe(false)
      await assertPortsFree()
    }
  })

  scopedTest(
    "KILLs an owned descendant when its runner leader exits before cleanup",
    async (scope) => {
      const fixture = await createCommands(scope)
      const runnerPath = join(fixture, "leader-exits-with-descendant")
      await executable(
        runnerPath,
        `#!/usr/bin/env bash
(
  trap '' TERM
  printf '%s\\n' "$BASHPID" >"$FIXTURE/leader-exited-descendant-pid"
  while true; do /bin/sleep 0.05; done
) &
exit 0
`,
      )
      let descendantPid = 0
      let processGroup = 0
      let cleanupStartedAt = 0

      await withOwnedRunner(scope, runnerPath, fixture, {}, async (child, signal) => {
        processGroup = child.pid
        descendantPid = await waitForFixturePid(fixture, "leader-exited-descendant-pid", signal)
        expect(await child.exited).toBe(0)
        expect(isProcessAlive(descendantPid)).toBe(true)
        cleanupStartedAt = performance.now()
      })

      const cleanupElapsed = performance.now() - cleanupStartedAt
      expect(cleanupElapsed).toBeGreaterThanOrEqual(
        processGroupStopChecks * processGroupStopInterval - processGroupStopInterval,
      )
      expect(cleanupElapsed).toBeLessThan(
        processGroupStopChecks * processGroupStopInterval + settleDeadline,
      )
      expect(processGroupExists(processGroup)).toBe(false)
      expect(isProcessAlive(descendantPid)).toBe(false)
      expect(scope.runners.size).toBe(0)
      await removeFixture(scope, fixture)
      expect(await Bun.file(fixture).exists()).toBe(false)
      expect(scope.fixtures.size).toBe(0)
      await assertPortsFree()
    },
  )

  scopedTest("detects barrier, deadline, cleanup, and busy-loop mutations", async () => {
    const source = await readFile(fileURLToPath(import.meta.url), "utf8")
    expect(() => assertHarnessCleanupContract(source)).not.toThrow()

    for (const mutation of [
      source.replace("\n    detached: true,", "\n    detached: false,"),
      source.replace("} finally {\n    controller.abort()", "} if (false) {"),
      source.replace(exactStartBarrierSource, ": # removed exact start barrier"),
      source.replace(serialDeclarationSource, "test.parallel("),
      source.replace(internalDeadlineSource, "    const outcome = await operationResult"),
      source.replace("    /bin/sleep 0.05\n    continue", "    :\n    continue"),
    ]) {
      expect(mutation).not.toBe(source)
      expect(() => assertHarnessCleanupContract(mutation)).toThrow()
    }

    const groupWaitSites = sourceIndices(source, ownedGroupWaitSource)
    expect(groupWaitSites).toHaveLength(ownedGroupWaitSiteCount)
    for (const site of groupWaitSites) {
      const mutation = `${source.slice(0, site)}false${source.slice(site + ownedGroupWaitSource.length)}`
      expect(() => assertHarnessCleanupContract(mutation)).toThrow()
    }

    for (const replacement of [
      ["    if (code === ", '"EPERM"', ") return false"].join(""),
      ["    if (code === ", '"EPERM"', ') throw new Error("permission denied")'].join(""),
    ]) {
      const mutation = source.replace(groupPermissionExistsSource, replacement)
      expect(mutation).not.toBe(source)
      expect(() => assertHarnessCleanupContract(mutation)).toThrow()
    }
  })

  scopedTest("maps exact signal-zero outcomes without hiding inspection failures", async () => {
    const permissionError = Object.assign(new Error("operation not permitted"), { code: "EPERM" })
    expect(
      processGroupExists(123_456, () => {
        throw permissionError
      }),
    ).toBe(true)
    const missingError = Object.assign(new Error("no such process"), { code: "ESRCH" })
    expect(
      processGroupExists(123_456, () => {
        throw missingError
      }),
    ).toBe(false)
    const unknownError = Object.assign(new Error("unexpected probe failure"), { code: "EINVAL" })
    expect(() =>
      processGroupExists(123_456, () => {
        throw unknownError
      }),
    ).toThrow("Could not inspect owned process group 123456")
  })

  scopedTest("continues after one post-TERM EPERM until the group is absent", async (scope) => {
    const owned = registerSyntheticOwnedRunner(scope)
    const signals: NodeJS.Signals[] = []
    const controls = deterministicProcessGroupControls(
      ["exists", "EPERM", "ESRCH", "ESRCH"],
      signals,
    )

    await stopOwnedRunnerOnce(scope, owned, controls)

    expect(signals).toEqual(["SIGTERM"])
    expect(scope.runners.has(owned.processGroup)).toBe(false)
  })

  scopedTest("continues after one post-KILL EPERM until the group is absent", async (scope) => {
    const owned = registerSyntheticOwnedRunner(scope)
    const signals: NodeJS.Signals[] = []
    const controls = deterministicProcessGroupControls(
      [
        "exists",
        ...Array.from({ length: processGroupStopChecks + 1 }, () => "exists" as const),
        "EPERM",
        "ESRCH",
        "ESRCH",
      ],
      signals,
    )

    await stopOwnedRunnerOnce(scope, owned, controls)

    expect(signals).toEqual(["SIGTERM", "SIGKILL"])
    expect(scope.runners.has(owned.processGroup)).toBe(false)
  })

  scopedTest("keeps persistent probe EPERM fail-closed", async (scope) => {
    const owned = registerSyntheticOwnedRunner(scope)
    const signals: NodeJS.Signals[] = []
    const controls = deterministicProcessGroupControls(
      [
        "exists",
        ...Array.from({ length: (processGroupStopChecks + 1) * 2 }, () => "EPERM" as const),
      ],
      signals,
    )

    try {
      await expect(stopOwnedRunnerOnce(scope, owned, controls)).rejects.toThrow(
        `Owned process group ${owned.processGroup} survived SIGKILL`,
      )
      expect(signals).toEqual(["SIGTERM", "SIGKILL"])
      expect(scope.runners.has(owned.processGroup)).toBe(true)
    } finally {
      scope.runners.delete(owned.processGroup)
    }
  })

  scopedTest("keeps nonzero signal EPERM fail-closed", async (scope) => {
    const owned = registerSyntheticOwnedRunner(scope)
    const permissionError = Object.assign(new Error("operation not permitted"), { code: "EPERM" })

    try {
      expect(() =>
        signalOwnedProcessGroup(scope, owned, "SIGKILL", () => {
          throw permissionError
        }),
      ).toThrow("exists but cannot be signalled safely (EPERM)")
    } finally {
      scope.runners.delete(owned.processGroup)
    }
  })

  scopedTest(
    "empty, duplicate, and symbolic-link discovery fail before services start",
    async (scope) => {
      for (const mode of ["empty", "duplicate", "link"] as const) {
        const repository = await createFixtureRepository(scope, mode)
        const commands = await createCommands(scope)
        const result = await runRunner(
          scope,
          join(repository, "scripts/ci/run-rails-desktop-smoke.sh"),
          commands,
        )

        expect(result.status).not.toBe(0)
        expect(result.stderr).toMatch(/found no live smoke files|discovery is ambiguous/)
        expect(Bun.file(join(commands, "redis-call")).exists()).resolves.toBe(false)
        expect(Bun.file(join(commands, "rails-environment")).exists()).resolves.toBe(false)
      }
    },
  )
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

async function createCommands(scope: TestScope, options: CommandOptions = {}): Promise<string> {
  const fixture = await mkdtemp(join(tmpdir(), "rails-desktop-smoke-"))
  registerFixture(scope, fixture)
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
[ -z "\${REDIS_PRE_TRAP_DELAY:-}" ] || /bin/sleep "$REDIS_PRE_TRAP_DELAY"
trap 'printf "redis-term\\n" >>"$FIXTURE/events"; exit 0' TERM INT
while true; do
  if [ ! -e "$FIXTURE/redis-started" ]; then
    printf '%s\n' "$$" >"$FIXTURE/redis-started"
  fi
  if [ "\${REDIS_EXIT_DURING_TESTS:-}" = 1 ] \
    && [ -s "$FIXTURE/bun-started" ] \
    && [ "$(<"$FIXTURE/bun-started")" = "$(<"$FIXTURE/bun-pid")" ]; then
    exit 32
  fi
  /bin/sleep 0.05
done
`,
  )
  await executable(
    join(bin, "redis-cli"),
    readinessShim("redis", 1, options.redisReadinessTimeout ? "exit 1" : "printf 'PONG\\n'"),
  )
  await executable(
    join(bin, "bundle"),
    `#!/usr/bin/env bash
printf '%s %s %s %s\n' "$PORT" "$RAILS_ENV" "$REDIS_URL" "$BUNDLE_GEMFILE" >"$FIXTURE/rails-environment"
printf '%s\n' "$$" >"$FIXTURE/rails-pid"
[ "\${RAILS_EXIT_BEFORE_READY:-}" != 1 ] || exit 31
[ -z "\${RAILS_PRE_TRAP_DELAY:-}" ] || /bin/sleep "$RAILS_PRE_TRAP_DELAY"
trap 'printf "rails-term\\n" >>"$FIXTURE/events"; exit 0' TERM INT
while true; do
  if [ ! -e "$FIXTURE/rails-started" ]; then
    printf '%s\n' "$$" >"$FIXTURE/rails-started"
  fi
  if [ "\${RAILS_EXIT_DURING_TESTS:-}" = 1 ] \
    && [ -s "$FIXTURE/bun-started" ] \
    && [ "$(<"$FIXTURE/bun-started")" = "$(<"$FIXTURE/bun-pid")" ]; then
    exit 33
  fi
  /bin/sleep 0.05
done
`,
  )
  await executable(
    join(bin, "curl"),
    readinessShim(
      "rails",
      22,
      options.railsReadinessTimeout
        ? "exit 22"
        : `
if [ "\${RAILS_EXIT_BEFORE_READY:-}" = 1 ]; then
  exit 22
fi
if [ "\${RAILS_EXIT_AFTER_READY:-}" = 1 ]; then
  kill -TERM "$(<"$FIXTURE/rails-pid")"
  while kill -0 "$(<"$FIXTURE/rails-pid")" 2>/dev/null; do /bin/sleep 0.01; done
fi
exit 0
`,
    ),
  )
  await executable(
    join(bin, "bun"),
    `#!/usr/bin/env bash
printf '%s\n' "$@" >"$FIXTURE/bun-call"
printf '%s\n' "$$" >"$FIXTURE/bun-pid"
printf '%s\n' "$EXPO_TURBO_DEMO_ORIGIN" >"$FIXTURE/bun-origin"
printf '%s\n' "$REDIS_URL" >"$FIXTURE/bun-redis-url"
[ -z "\${BUN_PRE_TRAP_DELAY:-}" ] || /bin/sleep "$BUN_PRE_TRAP_DELAY"
if [ "\${BUN_IGNORE_TERM:-}" = 1 ]; then
  trap 'printf "bun-term\\n" >>"$FIXTURE/events"' TERM INT
else
  trap 'printf "bun-term\\n" >>"$FIXTURE/events"; exit 0' TERM INT
fi
while true; do
  if [ ! -e "$FIXTURE/bun-started" ]; then
    printf '%s\n' "$$" >"$FIXTURE/bun-started"
  fi
  if [ "\${BUN_HANG:-}" = 1 ] || [ "\${RAILS_EXIT_DURING_TESTS:-}" = 1 ] || [ "\${REDIS_EXIT_DURING_TESTS:-}" = 1 ]; then
    /bin/sleep 0.05
    continue
  fi
  break
done
exit "\${BUN_EXIT:-0}"
`,
  )
  return fixture
}

function readinessShim(
  service: "rails" | "redis",
  unavailableStatus: number,
  result: string,
): string {
  return `#!/usr/bin/env bash
wait_for_exact_start() {
  local marker="$1"
  local pid_file="$2"
  while true; do
    if [ -s "$marker" ] && [ -s "$pid_file" ] && [ "$(<"$marker")" = "$(<"$pid_file")" ]; then
      return 0
    fi
    if [ -s "$pid_file" ] && ! kill -0 "$(<"$pid_file")" 2>/dev/null; then
      return 1
    fi
    /bin/sleep 0.01
  done
}
wait_for_exact_start "$FIXTURE/${service}-started" "$FIXTURE/${service}-pid" || exit ${unavailableStatus}
${result}
`
}

async function createFixtureRepository(
  scope: TestScope,
  mode: "empty" | "duplicate" | "link",
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rails-desktop-smoke-repository-"))
  registerFixture(scope, root)
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

interface OwnedRunner {
  child: ReturnType<typeof Bun.spawn>
  cleanupPromise?: Promise<void>
  processGroup: number
}

interface TestScope {
  cleanupPromise?: Promise<void>
  fixtures: Set<string>
  runners: Map<number, OwnedRunner>
}

type ProcessProbe = (pid: number, signal: 0) => unknown
type ProcessGroupSignal = (processGroup: number, signal: NodeJS.Signals) => unknown

interface ProcessGroupControls {
  probe: ProcessProbe
  signal: ProcessGroupSignal
  sleep: (milliseconds: number) => Promise<unknown>
}

const defaultProcessGroupControls: ProcessGroupControls = {
  probe: (pid, signal) => process.kill(pid, signal),
  signal: (processGroup, signal) => process.kill(-processGroup, signal),
  sleep: (milliseconds) => Bun.sleep(milliseconds),
}

function scopedTest(label: string, body: (scope: TestScope) => Promise<unknown> | unknown): void {
  test.serial(
    label,
    async () => {
      if (activeTestScope !== undefined) throw new Error("The prior test still owns resources")
      const scope: TestScope = { fixtures: new Set(), runners: new Map() }
      activeTestScope = scope
      fallbackScopes.add(scope)
      let bodyFailed = false
      let bodyError: unknown
      let cleanupFailed = false
      let cleanupError: unknown
      try {
        await body(scope)
      } catch (error) {
        bodyFailed = true
        bodyError = error
      } finally {
        try {
          await cleanupTestScope(scope)
        } catch (error) {
          cleanupFailed = true
          cleanupError = error
        }
        if (!fallbackScopes.has(scope) && activeTestScope === scope) activeTestScope = undefined
      }
      if (bodyFailed) {
        if (cleanupFailed)
          console.error("Test cleanup also failed after the primary error:", cleanupError)
        throw bodyError
      }
      if (cleanupFailed) throw cleanupError
    },
    outerTestDeadline,
  )
}

function registerFixture(scope: TestScope, fixture: string): void {
  if (!fallbackScopes.has(scope))
    throw new Error("Cannot register a fixture in a closed test scope")
  scope.fixtures.add(fixture)
}

function spawnRunner(
  scope: TestScope,
  path: string,
  fixture: string,
  environment: Record<string, string> = {},
  outputPaths?: { stderr: string; stdout: string },
): OwnedRunner {
  const child = Bun.spawn([path], {
    detached: true,
    env: testEnvironment(fixture, environment),
    stdout: outputPaths === undefined ? "pipe" : Bun.file(outputPaths.stdout),
    stderr: outputPaths === undefined ? "pipe" : Bun.file(outputPaths.stderr),
  })
  const owned: OwnedRunner = { child, processGroup: child.pid }
  scope.runners.set(owned.processGroup, owned)
  return owned
}

async function withOwnedRunner<T>(
  scope: TestScope,
  path: string,
  fixture: string,
  environment: Record<string, string>,
  operation: (child: ReturnType<typeof Bun.spawn>, signal: AbortSignal) => Promise<T>,
  deadlineMilliseconds = operationDeadline,
): Promise<T> {
  const owned = spawnRunner(scope, path, fixture, environment)
  return runOwnedOperation(scope, owned, operation, deadlineMilliseconds)
}

async function runRunner(
  scope: TestScope,
  path: string,
  fixture: string,
  environment: Record<string, string> = {},
): Promise<{ status: number; stdout: string; stderr: string }> {
  const stdoutPath = join(fixture, "runner-stdout")
  const stderrPath = join(fixture, "runner-stderr")
  const owned = spawnRunner(scope, path, fixture, environment, {
    stdout: stdoutPath,
    stderr: stderrPath,
  })
  return runOwnedOperation(scope, owned, async () => {
    const status = await owned.child.exited
    const [stdout, stderr] = await Promise.all([
      readFile(stdoutPath, "utf8"),
      readFile(stderrPath, "utf8"),
    ])
    return { status, stdout, stderr }
  })
}

async function runOwnedOperation<T>(
  scope: TestScope,
  owned: OwnedRunner,
  operation: (child: ReturnType<typeof Bun.spawn>, signal: AbortSignal) => Promise<T>,
  deadlineMilliseconds = operationDeadline,
): Promise<T> {
  const controller = new AbortController()
  const operationResult = Promise.resolve().then(() => operation(owned.child, controller.signal))
  let operationSucceeded = false
  let operationValue!: T
  let primaryFailed = false
  let primaryError: unknown
  let cleanupError: AggregateError | undefined
  try {
    const outcome = await promiseWithDeadline(
      operationResult,
      deadlineMilliseconds,
      `Runner group ${owned.processGroup} exceeded its internal ${deadlineMilliseconds} ms deadline`,
      (error) => controller.abort(error),
    )
    operationValue = outcome
    operationSucceeded = true
  } catch (error) {
    primaryFailed = true
    primaryError = error
  } finally {
    controller.abort()
    const cleanupErrors: unknown[] = []
    try {
      await stopOwnedRunner(scope, owned)
    } catch (error) {
      cleanupErrors.push(error)
    }
    try {
      await promiseWithDeadline(
        operationResult.then(
          () => undefined,
          () => undefined,
        ),
        settleDeadline,
        `Runner group ${owned.processGroup} operation did not settle after cleanup`,
      )
    } catch (error) {
      cleanupErrors.push(error)
    }
    if (cleanupErrors.length > 0)
      cleanupError = new AggregateError(cleanupErrors, "Runner cleanup failed")
  }
  if (primaryFailed) {
    if (cleanupError !== undefined)
      console.error("Runner cleanup also failed after the primary error:", cleanupError)
    throw primaryError
  }
  if (cleanupError !== undefined) throw cleanupError
  if (!operationSucceeded) throw new Error("Runner operation did not complete")
  return operationValue
}

async function stopOwnedRunner(scope: TestScope, owned: OwnedRunner): Promise<void> {
  assertOwnedRunner(scope, owned)
  if (owned.cleanupPromise !== undefined) return owned.cleanupPromise
  owned.cleanupPromise = stopOwnedRunnerOnce(scope, owned).catch((error) => {
    delete owned.cleanupPromise
    throw error
  })
  return owned.cleanupPromise
}

async function stopOwnedRunnerOnce(
  scope: TestScope,
  owned: OwnedRunner,
  controls: ProcessGroupControls = defaultProcessGroupControls,
): Promise<void> {
  const groupExists = processGroupExists(owned.processGroup, controls.probe)
  if (groupExists) {
    for (const signal of ["SIGTERM", "SIGKILL"] as const) {
      signalOwnedProcessGroup(scope, owned, signal, controls.signal)
      if (await waitForOwnedProcessGroupExit(scope, owned, controls)) break
      if (signal === "SIGKILL")
        throw new Error(`Owned process group ${owned.processGroup} survived SIGKILL`)
    }
  }

  await promiseWithDeadline(
    owned.child.exited,
    settleDeadline,
    `Owned leader ${owned.processGroup} did not report exit after its process group stopped`,
  )
  if (processGroupExists(owned.processGroup, controls.probe)) {
    throw new Error(`Owned process group ${owned.processGroup} still exists after child exit`)
  }
  assertOwnedRunner(scope, owned)
  scope.runners.delete(owned.processGroup)
}

function signalOwnedProcessGroup(
  scope: TestScope,
  owned: OwnedRunner,
  signal: NodeJS.Signals,
  send: ProcessGroupSignal = defaultProcessGroupControls.signal,
): void {
  assertOwnedRunner(scope, owned)
  try {
    send(owned.processGroup, signal)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ESRCH") return
    if (code === "EPERM") {
      throw new Error(
        `Owned process group ${owned.processGroup} exists but cannot be signalled safely (EPERM)`,
        { cause: error },
      )
    }
    throw new Error(`Could not send ${signal} to owned process group ${owned.processGroup}`, {
      cause: error,
    })
  }
}

async function waitForOwnedProcessGroupExit(
  scope: TestScope,
  owned: OwnedRunner,
  controls: ProcessGroupControls = defaultProcessGroupControls,
): Promise<boolean> {
  for (let attempt = 0; attempt < processGroupStopChecks; attempt += 1) {
    assertOwnedRunner(scope, owned)
    if (!processGroupExists(owned.processGroup, controls.probe)) return true
    await controls.sleep(processGroupStopInterval)
  }
  return !processGroupExists(owned.processGroup, controls.probe)
}

function processGroupExists(
  processGroup: number,
  probe: ProcessProbe = defaultProcessGroupControls.probe,
): boolean {
  if (processGroup <= 1) throw new Error(`Invalid owned process group ${processGroup}`)
  try {
    probe(-processGroup, 0)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ESRCH") return false
    if (code === "EPERM") return true
    throw new Error(`Could not inspect owned process group ${processGroup}`, { cause: error })
  }
}

function registerSyntheticOwnedRunner(scope: TestScope): OwnedRunner {
  const processGroup = 123_456
  const child = { pid: processGroup, exited: Promise.resolve(0) } as unknown as ReturnType<
    typeof Bun.spawn
  >
  const owned: OwnedRunner = { child, processGroup }
  scope.runners.set(processGroup, owned)
  return owned
}

function deterministicProcessGroupControls(
  outcomes: Array<"exists" | "EPERM" | "ESRCH">,
  signals: NodeJS.Signals[],
): ProcessGroupControls {
  let probeIndex = 0
  return {
    probe: () => {
      const outcome = outcomes[probeIndex]
      probeIndex += 1
      if (outcome === "exists") return
      if (outcome === undefined) throw new Error("Deterministic process probe was exhausted")
      throw Object.assign(new Error(`deterministic ${outcome}`), { code: outcome })
    },
    signal: (_processGroup, signal) => {
      signals.push(signal)
    },
    sleep: async () => {},
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ESRCH") return false
    if (code === "EPERM") {
      throw new Error(`Process ${pid} exists but cannot be inspected safely (EPERM)`, {
        cause: error,
      })
    }
    throw new Error(`Could not inspect process ${pid}`, { cause: error })
  }
}

function assertOwnedRunner(scope: TestScope, owned: OwnedRunner): void {
  if (
    owned.processGroup <= 1 ||
    owned.child.pid !== owned.processGroup ||
    scope.runners.get(owned.processGroup) !== owned
  ) {
    throw new Error(`This test does not own process group ${owned.processGroup}`)
  }
}

async function readFixturePids(fixture: string): Promise<number[]> {
  return Promise.all(
    ["redis-pid", "rails-pid", "bun-pid"].map(async (file) =>
      Number.parseInt(await readFile(join(fixture, file), "utf8"), 10),
    ),
  )
}

async function removeFixture(scope: TestScope, fixture: string): Promise<void> {
  if (!scope.fixtures.has(fixture)) {
    throw new Error(`This test does not own fixture ${fixture}`)
  }
  await rm(fixture, { recursive: true, force: true })
  scope.fixtures.delete(fixture)
}

async function cleanupTestScope(scope: TestScope): Promise<void> {
  if (!fallbackScopes.has(scope)) return
  if (scope.cleanupPromise !== undefined) return scope.cleanupPromise
  scope.cleanupPromise = cleanupTestScopeOnce(scope).catch((error) => {
    delete scope.cleanupPromise
    throw error
  })
  return scope.cleanupPromise
}

async function cleanupTestScopeOnce(scope: TestScope): Promise<void> {
  const cleanupErrors: unknown[] = []
  for (const owned of Array.from(scope.runners.values())) {
    try {
      await stopOwnedRunner(scope, owned)
    } catch (error) {
      cleanupErrors.push(error)
    }
  }
  if (scope.runners.size === 0) {
    for (const fixture of Array.from(scope.fixtures)) {
      try {
        await removeFixture(scope, fixture)
      } catch (error) {
        cleanupErrors.push(error)
      }
    }
  }
  if (scope.runners.size + scope.fixtures.size > 0)
    cleanupErrors.push(new Error("The test still owns processes or fixtures"))
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, "Test cleanup failed")
  }
  await assertPortsFree()
  fallbackScopes.delete(scope)
}

async function assertPortsFree(): Promise<void> {
  for (const port of [3001, 6379]) {
    const result = Bun.spawnSync(["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], {
      stdout: "pipe",
      stderr: "pipe",
    })
    if (result.exitCode !== 1) {
      throw new Error(
        `Port ${port} still has a listener:\n${result.stdout.toString()}${result.stderr.toString()}`,
      )
    }
  }
}

function assertHarnessCleanupContract(source: string): void {
  if (source.match(/\n {4}detached: true,/g)?.length !== 1) {
    throw new Error("the shared runner path must own a process group")
  }
  if (!source.includes(serialDeclarationSource))
    throw new Error("each test must have an exact ownership scope")
  if (!source.includes("} finally {\n    controller.abort()"))
    throw new Error("runner cleanup must be in finally")
  if (!source.includes(exactStartBarrierSource)) {
    throw new Error("readiness must wait for the exact service start marker")
  }
  for (const service of ["redis", "rails", "bun"]) {
    if (!source.includes(`printf '%s\\n' "$$" >"$FIXTURE/${service}-started"`)) {
      throw new Error(`${service} must publish its start marker inside its service loop`)
    }
  }
  if (sourceIndices(source, ownedGroupWaitSource).length !== ownedGroupWaitSiteCount) {
    throw new Error("runner cleanup must await process-group absence after signals")
  }
  if (
    sourceIndices(source, groupPermissionExistsSource).length !== groupPermissionExistsSiteCount
  ) {
    throw new Error("signal-zero EPERM must keep the process group present")
  }
  if (!source.includes(internalDeadlineSource)) {
    throw new Error("runner operations must have an internal deadline")
  }
  if (outerTestDeadline <= operationDeadline + worstCaseCleanup) {
    throw new Error("outer test deadline must exceed operation and cleanup deadlines")
  }
  if (!source.includes("    /bin/sleep 0.05\n    continue")) {
    throw new Error("hanging Bun fixture must yield instead of busy loop")
  }
  if (/\n\s+while true; do :; done\n/.test(source)) throw new Error("fixture must not busy loop")
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
    TMPDIR: fixture,
  }
}

async function waitForStartMarker(
  fixture: string,
  service: "bun" | "rails" | "redis",
  signal: AbortSignal,
): Promise<void> {
  const markerPath = join(fixture, `${service}-started`)
  const pidPath = join(fixture, `${service}-pid`)
  while (true) {
    if (signal.aborted) throw signal.reason
    try {
      const [marker, pid] = await Promise.all([
        readFile(markerPath, "utf8"),
        readFile(pidPath, "utf8"),
      ])
      if (marker.trim() === pid.trim() && Number.parseInt(marker, 10) > 1) return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    await Bun.sleep(10)
  }
}

async function waitForFixturePid(
  fixture: string,
  file: string,
  signal: AbortSignal,
): Promise<number> {
  while (true) {
    if (signal.aborted) throw signal.reason
    try {
      const pid = Number.parseInt(await readFile(join(fixture, file), "utf8"), 10)
      if (pid > 1) return pid
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    await Bun.sleep(10)
  }
}

function sourceIndices(source: string, needle: string): number[] {
  const indices: number[] = []
  let index = source.indexOf(needle)
  while (index !== -1) {
    indices.push(index)
    index = source.indexOf(needle, index + needle.length)
  }
  return indices
}

async function promiseWithDeadline<T>(
  promise: Promise<T>,
  milliseconds: number,
  message: string,
  onTimeout?: (error: Error) => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const error = new Error(message)
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout?.(error)
      reject(error)
    }, milliseconds)
  })
  try {
    return await Promise.race([promise, deadline])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
