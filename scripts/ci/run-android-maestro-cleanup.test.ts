import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const stopProcessScript = join(scriptDirectory, "stop-process.sh")
const laneScript = join(scriptDirectory, "run-android-maestro.sh")
const fixtures: string[] = []
const survivingPids: number[] = []

afterEach(async () => {
  for (const pid of survivingPids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL")
    } catch {}
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        process.kill(pid, 0)
        await Bun.sleep(10)
      } catch {
        break
      }
    }
  }
  await Promise.all(fixtures.splice(0).map(cleanFixture))
})

describe("Android lane cleanup", () => {
  test("the real stop helper kills and reaps a sleeping child that ignores TERM", async () => {
    const fixture = await createFixture()
    const source = await readFile(stopProcessScript, "utf8")
    const started = performance.now()
    const result = await runStopProcess(fixture, source)

    expect(performance.now() - started).toBeLessThan(2_000)
    expect(result.timedOut).toBe(false)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("survivor=false")
    expect(result.stdout).toContain("reaped=true")
    expect(result.stderr).toContain("fixture did not stop after TERM; sending KILL.")
  })

  test("fails the real execution proof when SIGKILL is removed", async () => {
    const fixture = await createFixture()
    const source = await readFile(stopProcessScript, "utf8")
    const mutation = source.replace(
      '    kill -KILL "$pid" 2>/dev/null || true',
      "    : SIGKILL removed",
    )

    expect(mutation).not.toBe(source)
    const result = await runStopProcess(fixture, mutation)

    expect(result.timedOut).toBe(false)
    expect(result.status).not.toBe(0)
    expect(result.stdout).toContain("survivor=true")
  })

  test("times out when no KILL leaves the final wait unguarded", async () => {
    const fixture = await createFixture()
    const source = await readFile(stopProcessScript, "utf8")
    const finalLiveGuard = `  if kill -0 "$pid" 2>/dev/null; then
    echo "$name still exists after KILL; cleanup will not wait for it." >&2
    return
  fi
  wait "$pid" 2>/dev/null || true`
    const mutation = source
      .replace('    kill -KILL "$pid" 2>/dev/null || true', "    : SIGKILL removed")
      .replace(
        finalLiveGuard,
        `  if kill -0 "$pid" 2>/dev/null; then
    echo "$name still exists after KILL; cleanup will not wait for it." >&2
    : final live guard return removed
  fi
  wait "$pid" 2>/dev/null || true`,
      )

    expect(mutation).not.toBe(source)
    expect(source).toContain('    kill -KILL "$pid" 2>/dev/null || true')
    expect(source).toContain(finalLiveGuard)

    const result = await runStopProcess(fixture, mutation)

    expect(result.timedOut).toBe(true)
  })

  test("stops Rails before it asks the emulator to stop", async () => {
    const lane = await readFile(laneScript, "utf8")
    const cleanup = extractFunction(lane, "cleanup")

    assertRailsStopsBeforeEmulator(cleanup)
    expect(() =>
      assertRailsStopsBeforeEmulator(
        cleanup.replace(
          'stop_process "$rails_pid" "Rails" 50 50 0.1',
          'timeout 15 adb -s "$adb_serial" emu kill >/dev/null 2>&1 || true',
        ),
      ),
    ).toThrow("Rails must stop")
  })

  test("uses bounded process stops in the real cleanup and retry functions", async () => {
    const lane = await readFile(laneScript, "utf8")
    const cleanup = extractFunction(lane, "cleanup")
    const retry = extractFunction(lane, "stop_emulator_for_retry")

    assertNoBareWait(cleanup)
    assertNoBareWait(retry)
    expect(retry).toContain('stop_process "$emulator_pid" "Android emulator" 30 15 1')

    expect(() =>
      assertNoBareWait(
        cleanup.replace(
          'stop_process "$rails_pid" "Rails" 50 50 0.1',
          'wait "$rails_pid" 2>/dev/null || true',
        ),
      ),
    ).toThrow("bare wait")
    expect(() =>
      assertNoBareWait(
        retry.replace(
          'stop_process "$emulator_pid" "Android emulator" 30 15 1',
          'wait "$emulator_pid" 2>/dev/null || true',
        ),
      ),
    ).toThrow("bare wait")
  })

  test("runs cleanup as the EXIT trap, preserves status 37, and finishes evidence without free", async () => {
    const fixture = await createFixture()
    const lane = await readFile(laneScript, "utf8")
    const result = await runRealCleanup(fixture, extractFunction(lane, "cleanup"), "free-absent")
    const environment = await readFile(join(fixture, "artifacts/environment.txt"), "utf8")
    const events = await readFile(join(fixture, "events.txt"), "utf8")

    expect(result.status).toBe(37)
    expect(environment).toContain("exit_status=37")
    expect(environment).toContain("memory=(free is not installed)")
    expect(environment).toContain("evidence_complete=true")
    expect(events.indexOf("stop:Rails")).toBeLessThan(events.indexOf("emulator:kill"))
  })

  test("keeps the EXIT status and completes evidence when an evidence tool fails", async () => {
    const fixture = await createFixture()
    const lane = await readFile(laneScript, "utf8")
    const result = await runRealCleanup(fixture, extractFunction(lane, "cleanup"), "git-fails")
    const environment = await readFile(join(fixture, "artifacts/environment.txt"), "utf8")

    expect(result.status).toBe(37)
    expect(environment).toContain("exit_status=37")
    expect(environment).toContain("commit=")
    expect(environment).toContain("evidence_complete=true")
  })

  test("runs cleanup only from EXIT and maps INT and TERM to conventional statuses", async () => {
    const lane = await readFile(laneScript, "utf8")

    assertSignalTrapContract(lane)
    expect(() =>
      assertSignalTrapContract(lane.replace("trap cleanup EXIT", "trap cleanup EXIT INT TERM")),
    ).toThrow("cleanup must run only from EXIT")
  })

  for (const [signal, expectedStatus] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const) {
    test(`records ${signal} after a successful command as cancellation, not success`, async () => {
      const fixture = await createFixture()
      const lane = await readFile(laneScript, "utf8")
      const result = await runSignalCleanup(fixture, lane, signal, "after-success")
      const environment = await readFile(join(fixture, "artifacts/environment.txt"), "utf8")

      expect(result.timedOut).toBe(false)
      expect(result.status).toBe(expectedStatus)
      expect(environment).toContain(`exit_status=${expectedStatus}`)
      expect(await Bun.file(join(fixture, "artifacts/maestro-junit.xml")).exists()).toBe(false)
    })

    test(`stops an active child and records ${signal} as cancellation`, async () => {
      const fixture = await createFixture()
      const lane = await readFile(laneScript, "utf8")
      const result = await runSignalCleanup(fixture, lane, signal, "child-active")
      const environment = await readFile(join(fixture, "artifacts/environment.txt"), "utf8")
      const childPid = Number((await readFile(join(fixture, "child-pid"), "utf8")).trim())

      expect(result.timedOut).toBe(false)
      expect(result.status).toBe(expectedStatus)
      expect(environment).toContain(`exit_status=${expectedStatus}`)
      expect(Number.isInteger(childPid)).toBe(true)
      expect(isRunning(childPid)).toBe(false)
      expect(await Bun.file(join(fixture, "artifacts/maestro-junit.xml")).exists()).toBe(false)
    })
  }

  test("fails if the cleanup evidence strict-mode guard is deleted", async () => {
    const fixture = await createFixture()
    const lane = await readFile(laneScript, "utf8")
    const cleanup = extractFunction(lane, "cleanup")
    const mutation = cleanup
      .replace("  set +e", "  : set +e removed")
      .replace("  set -e", "  : set -e removed")

    expect(mutation).not.toBe(cleanup)
    const result = await runRealCleanup(fixture, mutation, "git-fails")
    const environmentPath = join(fixture, "artifacts/environment.txt")
    const environment = (await Bun.file(environmentPath).exists())
      ? await readFile(environmentPath, "utf8")
      : ""

    expect(result.status !== 37 || !environment.includes("evidence_complete=true")).toBe(true)
  })

  test("keeps rails_pid attached to Rails by execing the background server", async () => {
    const lane = await readFile(laneScript, "utf8")
    const railsStart = lane.slice(
      lane.indexOf("(\n  cd example/rails"),
      lane.indexOf("rails_pid=$!"),
    )

    expect(railsStart).toContain("exec bundle exec rails server")
    expect(() => assertRailsExec(railsStart.replace("exec bundle", "bundle"))).toThrow("exec Rails")
  })

  test("samples three large ps reports without SIGPIPE and keeps only the top 20 rows", async () => {
    const fixture = await createFixture()
    const sampler = extractFunction(await readFile(laneScript, "utf8"), "sample_top_processes")
    const result = await runResourceSampler(fixture, sampler, "success")

    expect(result.timedOut).toBe(false)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("iteration=1 rows=20")
    expect(result.stdout).toContain("iteration=2 rows=20")
    expect(result.stdout).toContain("iteration=3 rows=20")
    expect(result.stderr).toBe("")
    expect(await readFile(join(fixture, "ps-count"), "utf8")).toBe("3\n")
  })

  test("keeps the real resource sampler loop connected to the SIGPIPE-safe helper", async () => {
    const lane = await readFile(laneScript, "utf8")
    const samplerLoop = extractResourceSamplerLoop(lane)

    assertSamplerLoopUsesHelper(samplerLoop)

    const oldHeadLoop = samplerLoop.replace(
      "    sample_top_processes",
      "    ps -eo pid,ppid,rss,%cpu,comm,args --sort=-rss | head -20",
    )
    expect(oldHeadLoop).not.toBe(samplerLoop)
    expect(() => assertSamplerLoopUsesHelper(oldHeadLoop)).toThrow("sample_top_processes")

    const directPsLoop = samplerLoop.replace(
      "    sample_top_processes",
      "    sample_top_processes\n    ps -eo pid,ppid,rss,%cpu,comm,args --sort=-rss | head -20",
    )
    expect(directPsLoop).not.toBe(samplerLoop)
    expect(() => assertSamplerLoopUsesHelper(directPsLoop)).toThrow(
      "resource sampler loop must not use a direct ps to head pipeline",
    )
  })

  test("proves the old head consumer exits from SIGPIPE on a large ps report", async () => {
    const fixture = await createFixture()
    const sampler = extractFunction(await readFile(laneScript, "utf8"), "sample_top_processes")
    const bin = await setupFakePs(fixture)
    const oldHeadSampler = sampler.replace("awk 'NR <= 20'", "head -20")

    expect(oldHeadSampler).not.toBe(sampler)
    const oldPipeline = extractPsPipeline(oldHeadSampler)
    const result = await runBoundedBash(`set -euo pipefail\n${oldPipeline}\n`, {
      FIXTURE: fixture,
      PATH: `${bin}:${process.env.PATH}`,
      PS_MODE: "success",
    })

    expect(result.timedOut).toBe(false)
    if (result.status !== 141) {
      const pipeStatus = await runBoundedBash(
        `set -uo pipefail
set +e
${oldPipeline}
producer_status="${"$"}{PIPESTATUS[0]}"
set -e
printf 'producer_status=%s\\n' "$producer_status"
`,
        {
          FIXTURE: fixture,
          PATH: `${bin}:${process.env.PATH}`,
          PS_MODE: "success",
        },
      )

      expect(pipeStatus.status).toBe(0)
      expect(pipeStatus.stdout).toContain("producer_status=141")
    } else {
      expect(result.status).toBe(141)
    }
  })

  test("records a ps warning and continues three standalone sampler iterations", async () => {
    const fixture = await createFixture()
    const sampler = extractFunction(await readFile(laneScript, "utf8"), "sample_top_processes")
    const result = await runResourceSampler(fixture, sampler, "fail-once")

    expect(result.timedOut).toBe(false)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("iteration=1 rows=0")
    expect(result.stdout).toContain("iteration=2 rows=20")
    expect(result.stdout).toContain("iteration=3 rows=20")
    expect(result.stderr).toContain("WARNING: resource sampler: ps exited 23; continuing.")
    expect(await readFile(join(fixture, "ps-count"), "utf8")).toBe("3\n")
  })

  test("exits 23 on the first standalone sampler failure when its strict-mode guard is deleted", async () => {
    const fixture = await createFixture()
    const sampler = extractFunction(await readFile(laneScript, "utf8"), "sample_top_processes")
    const mutation = sampler.replace("  set +e\n", "").replace("  set -e\n", "")

    expect(mutation).not.toBe(sampler)
    const result = await runResourceSampler(fixture, mutation, "fail-once")

    expect(result.timedOut).toBe(false)
    expect(result.status).toBe(23)
    expect(result.stdout).toBe("")
    expect(await readFile(join(fixture, "ps-count"), "utf8")).toBe("1\n")
  })
})

async function createFixture(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "expo-turbo-cleanup-"))
  fixtures.push(directory)

  const child = join(directory, "ignore-term.sh")
  await writeFile(
    child,
    '#!/usr/bin/env bash\ntrap "" TERM\nprintf "%s\\n" "$$" >"$1"\nwhile true; do sleep 0.1; done\n',
  )
  await chmod(child, 0o755)
  return directory
}

async function runStopProcess(
  fixture: string,
  source: string,
): Promise<{ status: number; stdout: string; stderr: string; timedOut: boolean }> {
  const script = join(fixture, "stop-process-under-test.sh")
  await writeFile(script, source)
  const harness = `
set -euo pipefail
source "$STOP_PROCESS_UNDER_TEST"
/bin/bash "$FIXTURE/ignore-term.sh" "$FIXTURE/ready" </dev/null >/dev/null 2>&1 &
target_pid=$!
printf '%s\\n' "$target_pid" >"$FIXTURE/target-pid"
for _ in $(seq 1 100); do
  [ -e "$FIXTURE/ready" ] && break
  sleep 0.01
done
test -e "$FIXTURE/ready"
stop_process "$target_pid" fixture 3 20 0.01
if kill -0 "$target_pid" 2>/dev/null; then
  echo survivor=true
  exit 71
fi
echo survivor=false
if jobs -p | grep -qx "$target_pid"; then
  echo reaped=false
  exit 72
fi
echo reaped=true
`
  const result = await runBoundedBash(harness, {
    FIXTURE: fixture,
    STOP_PROCESS_UNDER_TEST: script,
  })
  if (await Bun.file(join(fixture, "target-pid")).exists()) {
    const pid = Number((await readFile(join(fixture, "target-pid"), "utf8")).trim())
    if (Number.isInteger(pid)) {
      try {
        process.kill(pid, 0)
        survivingPids.push(pid)
      } catch {}
    }
  }
  return result
}

async function runResourceSampler(
  fixture: string,
  sampler: string,
  mode: "success" | "fail-once",
): Promise<{ status: number; stdout: string; stderr: string; timedOut: boolean }> {
  const bin = await setupFakePs(fixture)

  const harness = `
set -euo pipefail
${sampler}
for iteration in 1 2 3; do
  sample_output="$FIXTURE/sampler-${"$"}{iteration}.txt"
  sample_top_processes >"$sample_output"
  rows="$(wc -l <"$sample_output" | tr -d '[:space:]')"
  printf 'iteration=%s rows=%s\\n' "$iteration" "$rows"
done
`
  return runBoundedBash(harness, {
    FIXTURE: fixture,
    PATH: `${bin}:${process.env.PATH}`,
    PS_MODE: mode,
  })
}

async function setupFakePs(fixture: string): Promise<string> {
  const bin = join(fixture, "bin")
  await mkdir(bin)
  await writeFile(
    join(bin, "ps"),
    `#!/usr/bin/env bash
set -euo pipefail
count=0
if [ -f "$FIXTURE/ps-count" ]; then count="$(cat "$FIXTURE/ps-count")"; fi
count=$((count + 1))
printf '%s\\n' "$count" >"$FIXTURE/ps-count"
if [ "$PS_MODE" = "fail-once" ] && [ "$count" -eq 1 ]; then
  echo 'fake ps failed' >&2
  exit 23
fi
/usr/bin/awk 'BEGIN { for (row = 1; row <= 10000; row += 1) printf "%s %s %s %s process arguments-that-make-the-fake-ps-output-larger-than-256-kibibytes\\n", row, row, row, row }'
`,
  )
  await chmod(join(bin, "ps"), 0o755)
  return bin
}

async function runBoundedBash(
  harness: string,
  environment: Record<string, string>,
  bound = 1_500,
): Promise<{ status: number; stdout: string; stderr: string; timedOut: boolean }> {
  const outputDirectory = environment.FIXTURE
  if (!outputDirectory) throw new Error("bounded Bash needs a fixture output directory")
  const stdoutPath = join(outputDirectory, "bounded-bash.stdout")
  const stderrPath = join(outputDirectory, "bounded-bash.stderr")
  const child = Bun.spawn(["/bin/bash", "-c", harness], {
    env: { ...process.env, ...environment },
    stdout: Bun.file(stdoutPath),
    stderr: Bun.file(stderrPath),
  })
  const timedOut = await Promise.race([
    child.exited.then(() => false),
    Bun.sleep(bound).then(() => true),
  ])
  if (timedOut && child.exitCode === null) child.kill(9)
  const status = await child.exited
  const [stdout, stderr] = await Promise.all([
    readFile(stdoutPath, "utf8"),
    readFile(stderrPath, "utf8"),
  ])
  return { status, stdout, stderr, timedOut }
}

async function runRealCleanup(
  fixture: string,
  cleanup: string,
  evidenceMode: "free-absent" | "git-fails",
): Promise<{ status: number }> {
  await mkdir(join(fixture, "artifacts"), { recursive: true })
  await mkdir(join(fixture, "android/emulator"), { recursive: true })
  await writeFile(join(fixture, "android/emulator/source.properties"), "Pkg.Revision=1\n")
  const harness = `
set -euo pipefail
artifacts="$FIXTURE/artifacts"
ANDROID_HOME="$FIXTURE/android"
adb_serial="emulator-5580"
rails_pid="101"
sampler_pid=""
emulator_pid="202"
maestro_version="2.7.0"
stop_process() {
  printf 'stop:%s\\n' "$2" >>"$FIXTURE/events.txt"
}
timeout() {
  case "$*" in
    *" emu kill"*) printf 'emulator:kill\\n' >>"$FIXTURE/events.txt" ;;
  esac
  return 0
}
git() {
  if [ "$EVIDENCE_MODE" = "git-fails" ]; then
    return 13
  fi
  echo deadbeef
}
hostname() { echo runner; }
id() { echo uid=1000; }
bun() { echo 1.3.14; }
ruby() { echo ruby; }
java() { echo java; }
command() {
  if [ "$1" = "-v" ] && [ "$2" = "free" ]; then
    return 1
  fi
  builtin command "$@"
}
${cleanup}
trap cleanup EXIT INT TERM
exit 37
`
  const child = Bun.spawn(["bash", "-c", harness], {
    env: {
      ...process.env,
      EVIDENCE_MODE: evidenceMode,
      FIXTURE: fixture,
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
  return { status: await child.exited }
}

async function runSignalCleanup(
  fixture: string,
  lane: string,
  signal: "SIGINT" | "SIGTERM",
  mode: "after-success" | "child-active",
): Promise<{ status: number; timedOut: boolean }> {
  await mkdir(join(fixture, "artifacts"), { recursive: true })
  await mkdir(join(fixture, "android/emulator"), { recursive: true })
  await writeFile(join(fixture, "android/emulator/source.properties"), "Pkg.Revision=1\n")
  const cleanup = extractFunction(lane, "cleanup")
  const interrupt = extractFunction(lane, "handle_interrupt")
  const terminate = extractFunction(lane, "handle_terminate")
  const stopProcess = await readFile(stopProcessScript, "utf8")
  const activeChild = mode === "child-active"
    ? [
        "sleep 30 &",
        "rails_pid=$!",
        "printf '%s\n' \"$rails_pid\" >\"$FIXTURE/child-pid\"",
      ].join("\n")
    : "true"
  const harness = `
set -euo pipefail
artifacts="$FIXTURE/artifacts"
ANDROID_HOME="$FIXTURE/android"
adb_serial="emulator-5580"
rails_pid=""
sampler_pid=""
emulator_pid=""
maestro_version="2.7.0"
timeout() { return 0; }
${stopProcess}
${cleanup}
${interrupt}
${terminate}
trap cleanup EXIT
trap handle_interrupt INT
trap handle_terminate TERM
${activeChild}
printf 'ready\n' >"$FIXTURE/ready"
while true; do sleep 0.1; done
`
  const child = Bun.spawn(["bash", "-c", harness], {
    env: { ...process.env, FIXTURE: fixture },
    stdout: "ignore",
    stderr: "ignore",
  })

  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await Bun.file(join(fixture, "ready")).exists()) break
    await Bun.sleep(10)
  }
  expect(await Bun.file(join(fixture, "ready")).exists()).toBe(true)
  process.kill(child.pid, signal)

  const timedOut = await Promise.race([
    child.exited.then(() => false),
    Bun.sleep(3_000).then(() => true),
  ])
  if (timedOut && child.exitCode === null) child.kill(9)
  return { status: await child.exited, timedOut }
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function assertSignalTrapContract(lane: string): void {
  if (!/^trap cleanup EXIT$/m.test(lane) || /^trap cleanup EXIT INT TERM$/m.test(lane)) {
    throw new Error("cleanup must run only from EXIT")
  }
  if (!/handle_interrupt\(\) \{\n  trap - INT TERM\n  exit 130\n\}/.test(lane)) {
    throw new Error("INT must exit 130")
  }
  if (!/handle_terminate\(\) \{\n  trap - INT TERM\n  exit 143\n\}/.test(lane)) {
    throw new Error("TERM must exit 143")
  }
  if (!/^trap handle_interrupt INT$/m.test(lane) || !/^trap handle_terminate TERM$/m.test(lane)) {
    throw new Error("signal handlers must be installed")
  }
}

function extractFunction(lane: string, name: string): string {
  const start = lane.indexOf(`${name}() {`)
  if (start < 0) {
    throw new Error(`${name}: function not found`)
  }

  const lines = lane.slice(start).split("\n")
  let depth = 0
  for (const [index, line] of lines.entries()) {
    depth += (line.match(/\{/g) ?? []).length
    depth -= (line.match(/\}/g) ?? []).length
    if (depth === 0) {
      return lines.slice(0, index + 1).join("\n")
    }
  }
  throw new Error(`${name}: function end not found`)
}

function extractResourceSamplerLoop(lane: string): string {
  const start = lane.indexOf("(\n  while true; do", lane.indexOf("sample_top_processes() {"))
  const end = lane.indexOf('\n) >>"$resource_log" 2>&1 &', start)
  if (start < 0 || end < 0) {
    throw new Error("resource sampler loop not found")
  }
  return lane.slice(start, end + 1)
}

function assertSamplerLoopUsesHelper(loop: string): void {
  if (!/^ {4}sample_top_processes$/m.test(loop)) {
    throw new Error(
      "resource sampler loop must invoke sample_top_processes as a standalone command",
    )
  }
  if (/^\s*ps\b[^\n]*\|\s*head(?:\s|$)/m.test(loop)) {
    throw new Error("resource sampler loop must not use a direct ps to head pipeline")
  }
}

function extractPsPipeline(sampler: string): string {
  const pipeline = sampler
    .split("\n")
    .find((line) => line.includes("ps -eo pid,ppid,rss,%cpu,comm,args"))
  if (!pipeline) {
    throw new Error("sampler ps pipeline not found")
  }
  return pipeline.trim()
}

function assertNoBareWait(body: string): void {
  if (/^\s*wait(?:\s|$)/m.test(body)) {
    throw new Error("real lane functions must not contain a bare wait")
  }
}

function assertRailsStopsBeforeEmulator(cleanup: string): void {
  const railsStop = cleanup.indexOf('stop_process "$rails_pid" "Rails" 50 50 0.1')
  const emulatorStop = cleanup.indexOf('timeout 15 adb -s "$adb_serial" emu kill')
  if (railsStop < 0 || emulatorStop < 0 || railsStop > emulatorStop) {
    throw new Error("Rails must stop before emulator shutdown")
  }
}

function assertRailsExec(railsStart: string): void {
  if (!railsStart.includes("exec bundle exec rails server")) {
    throw new Error("the background subshell must exec Rails")
  }
}

async function cleanFixture(directory: string): Promise<void> {
  await rm(directory, { force: true, recursive: true })
}
