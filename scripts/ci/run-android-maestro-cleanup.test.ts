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

  test("fails the bounded-wait proof when the final live guard becomes an unconditional wait", async () => {
    const source = await readFile(stopProcessScript, "utf8")
    const guardedWait = `  if kill -0 "$pid" 2>/dev/null; then
    echo "$name still exists after KILL; cleanup will not wait for it." >&2
    return
  fi
  wait "$pid" 2>/dev/null || true`
    const mutation = source.replace(guardedWait, '  wait "$pid" 2>/dev/null || true')

    expect(mutation).not.toBe(source)
    expect(() => assertFinalWaitIsGuarded(source)).not.toThrow()
    expect(() => assertFinalWaitIsGuarded(mutation)).toThrow("final wait")
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

function assertNoBareWait(body: string): void {
  if (/^\s*wait(?:\s|$)/m.test(body)) {
    throw new Error("real lane functions must not contain a bare wait")
  }
}

function assertFinalWaitIsGuarded(source: string): void {
  if (
    !source.includes('if kill -0 "$pid" 2>/dev/null; then\n    echo "$name still exists after KILL')
  ) {
    throw new Error("the final wait must have a still-alive guard")
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
