import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const stopProcessScript = join(scriptDirectory, "stop-process.sh")
const laneScript = join(scriptDirectory, "run-android-maestro.sh")
const fixtures: string[] = []

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  )
})

describe("Android lane cleanup", () => {
  test("kills and reaps a child that ignores TERM within a fixed interval", async () => {
    const fixture = await createFixture()
    const started = performance.now()
    const result = await runHarness(fixture, 0)

    expect(performance.now() - started).toBeLessThan(2_000)
    expect(result.status).toBe(0)
    expect(result.stderr).toContain("Rails did not stop after TERM; sending KILL.")
    expect(await readFile(join(fixture, "environment.txt"), "utf8")).toBe("exit_status=0\n")
  })

  test("preserves a failing suite result and still writes environment evidence", async () => {
    const fixture = await createFixture()
    const started = performance.now()
    const result = await runHarness(fixture, 37)

    expect(performance.now() - started).toBeLessThan(2_000)
    expect(result.status).toBe(37)
    expect(await readFile(join(fixture, "environment.txt"), "utf8")).toBe("exit_status=37\n")
  })

  test("stops Rails before it asks the emulator to stop", async () => {
    const lane = await readFile(laneScript, "utf8")
    const cleanup = lane.slice(lane.indexOf("cleanup() {"), lane.indexOf("trap cleanup"))

    expect(cleanup.indexOf('stop_process "$rails_pid" "Rails" 50 50 0.1')).toBeGreaterThan(0)
    expect(cleanup.indexOf('timeout 15 adb -s "$adb_serial" emu kill')).toBeGreaterThan(
      cleanup.indexOf('stop_process "$rails_pid" "Rails" 50 50 0.1'),
    )
  })
})

async function createFixture(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "expo-turbo-cleanup-"))
  fixtures.push(directory)

  const child = join(directory, "ignore-term.sh")
  await writeFile(
    child,
    '#!/usr/bin/env bash\ntrap "" TERM\nprintf ready >"$1"\nwhile true; do :; done\n',
  )
  await chmod(child, 0o755)
  return directory
}

async function runHarness(
  fixture: string,
  suiteStatus: number,
): Promise<{ status: number; stderr: string }> {
  const harness = `
set -euo pipefail
source "$STOP_PROCESS_SCRIPT"
"$FIXTURE/ignore-term.sh" "$FIXTURE/ready" &
rails_pid=$!
for _ in $(seq 1 100); do
  [ -f "$FIXTURE/ready" ] && break
  sleep 0.01
done
cleanup() {
  status=$?
  trap - EXIT
  stop_process "$rails_pid" "Rails" 2 2 0.01
  printf 'exit_status=%s\\n' "$status" >"$FIXTURE/environment.txt"
  exit "$status"
}
trap cleanup EXIT
exit "$SUITE_STATUS"
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

  const [stderr, status] = await Promise.all([new Response(child.stderr).text(), child.exited])
  return { status, stderr }
}
