import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const stopProcessScript = join(scriptDirectory, "stop-process.sh")
const laneScript = join(scriptDirectory, "run-android-maestro.sh")
const fixtures: string[] = []
const survivingChildren: Array<ReturnType<typeof Bun.spawn>> = []

afterEach(async () => {
  await Promise.all(
    survivingChildren.splice(0).map(async (child) => {
      if (child.exitCode === null) child.kill(9)
      await child.exited
    }),
  )
  await Promise.all(fixtures.splice(0).map(cleanFixture))
})

describe("Android lane cleanup", () => {
  test("uses a sleeping fixture that ignores TERM and always kills it in test cleanup", async () => {
    const fixture = await createFixture()
    const started = performance.now()
    const target = await startFixture(fixture)
    target.kill("SIGTERM")
    const exitedAfterTerm = await Promise.race([
      target.exited.then(() => true),
      Bun.sleep(100).then(() => false),
    ])

    expect(performance.now() - started).toBeLessThan(2_000)
    expect(exitedAfterTerm).toBe(false)

    target.kill(9)
    await target.exited
    const targetIndex = survivingChildren.indexOf(target)
    if (targetIndex >= 0) survivingChildren.splice(targetIndex, 1)
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

  test("executes the real cleanup body, preserves status 37, and finishes evidence without free", async () => {
    const fixture = await createFixture()
    const lane = await readFile(laneScript, "utf8")
    const result = await runRealCleanup(fixture, extractFunction(lane, "cleanup"), 37)
    const environment = await readFile(join(fixture, "artifacts/environment.txt"), "utf8")
    const events = await readFile(join(fixture, "events.txt"), "utf8")

    expect(result.status).toBe(37)
    expect(environment).toContain("exit_status=37")
    expect(environment).toContain("memory=(free is not installed)")
    expect(environment).toContain("evidence_complete=true")
    expect(events.indexOf("stop:Rails")).toBeLessThan(events.indexOf("emulator:kill"))
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
    '#!/usr/bin/env ruby\nSignal.trap("TERM", "IGNORE")\nFile.write(ARGV.fetch(0), Process.pid)\nloop { sleep 0.1 }\n',
  )
  await chmod(child, 0o755)
  return directory
}

async function startFixture(fixture: string): Promise<ReturnType<typeof Bun.spawn>> {
  const target = Bun.spawn(["ruby", join(fixture, "ignore-term.sh"), join(fixture, "ready")], {
    stdout: "ignore",
    stderr: "ignore",
  })
  survivingChildren.push(target)
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await Bun.file(join(fixture, "ready")).exists()) return target
    await Bun.sleep(10)
  }
  throw new Error(`TERM-ignoring fixture exited with ${await target.exited} before readiness`)
}

async function runRealCleanup(
  fixture: string,
  cleanup: string,
  suiteStatus: number,
): Promise<{ status: number }> {
  await mkdir(join(fixture, "artifacts"), { recursive: true })
  await mkdir(join(fixture, "android/emulator"), { recursive: true })
  await writeFile(join(fixture, "android/emulator/source.properties"), "Pkg.Revision=1\n")
  const harness = `
set -euo pipefail
source "$STOP_PROCESS_SCRIPT"
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
git() { echo deadbeef; }
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
set +e
(exit "$SUITE_STATUS")
cleanup
`
  const child = Bun.spawn(["bash", "-c", harness], {
    env: {
      ...process.env,
      FIXTURE: fixture,
      STOP_PROCESS_SCRIPT: stopProcessScript,
      SUITE_STATUS: String(suiteStatus),
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
