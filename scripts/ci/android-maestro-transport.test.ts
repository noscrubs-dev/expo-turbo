import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const laneScript = join(scriptDirectory, "run-android-maestro.sh")
const stopProcessScript = join(scriptDirectory, "stop-process.sh")
const fixtures: string[] = []

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((path) => rm(path, { force: true, recursive: true })))
})

function extractFunction(source: string, name: string): string {
  const start = source.indexOf(`${name}() {`)
  if (start < 0) throw new Error(`missing ${name}`)

  let depth = 0
  for (let index = start; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1
    if (source[index] !== "}") continue
    depth -= 1
    if (depth === 0) return source.slice(start, index + 1)
  }
  throw new Error(`unterminated ${name}`)
}

async function fixtureFile(name: string, contents: string): Promise<string> {
  const fixture = await mkdtemp(join(tmpdir(), "android-maestro-transport-"))
  fixtures.push(fixture)
  const path = join(fixture, name)
  await writeFile(path, contents)
  return path
}

async function runFunction(
  source: string,
  names: string[],
  invocation: string,
  args: string[],
): Promise<{ status: number; stdout: string; stderr: string }> {
  const body = names.map((name) => extractFunction(source, name)).join("\n")
  const child = Bun.spawn(
    [
      "bash",
      "-c",
      `set -euo pipefail\nadb_transport_pattern="DeviceServerDiedException|device offline|host:transport:[^)]*offline|device '[^']+' not found"\n${body}\n${invocation}`,
      "test",
      ...args,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const [status, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { status, stdout, stderr }
}

async function runTransportMonitor(
  source: string,
  log: string,
  trigger: string,
  duration: string,
): Promise<{ elapsed: number; status: number; stderr: string }> {
  const stopProcess = await readFile(stopProcessScript, "utf8")
  const functions = ["is_adb_transport_failure", "monitor_maestro_transport"]
    .map((name) => extractFunction(source, name))
    .join("\n")
  const stderrPath = `${trigger}.stderr`
  const script = `#!/usr/bin/env bash
set -uo pipefail
exec 2>"$4"
adb_transport_pattern="DeviceServerDiedException|device offline|host:transport:[^)]*offline|device '[^']+' not found"
${stopProcess}
${functions}
date() { printf '2026-08-18T00:00:00+00:00\\n'; }
ps() {
  if [[ " $* " == *" -o ppid= "* ]]; then
    printf '%s\\n' "$$"
    return 0
  fi
  command ps "$@"
}
sleep "$3" &
target_pid=$!
monitor_maestro_transport 1 "$target_pid" "$$" "$1" "$2" &
monitor_pid=$!
wait "$target_pid"
target_status=$?
wait "$monitor_pid"
exit "$target_status"
`
  const started = performance.now()
  const child = Bun.spawn(["bash", "-c", script, "test", log, trigger, duration, stderrPath], {
    stdout: "pipe",
    stderr: "ignore",
  })
  const status = await child.exited
  const stderr = await readFile(stderrPath, "utf8")
  return { elapsed: performance.now() - started, status, stderr }
}

describe("Android Maestro transport recovery", () => {
  test("retries a first-attempt device-server loss without a zero-second failure", async () => {
    const source = await readFile(laneScript, "utf8")
    const log = await fixtureFile(
      "offline.log",
      "DeviceServerDiedException: device offline\n[Failed] Rails flow (5s)\n",
    )

    const result = await runFunction(
      source,
      ["is_adb_transport_failure", "should_retry_transport_failure"],
      'should_retry_transport_failure "$1" "$2"',
      ["1", log],
    )
    expect(result.status).toBe(0)

    const oldGate = source.replace(
      '[ "$attempt" -eq 1 ] && is_adb_transport_failure "$log"',
      '[ "$attempt" -eq 1 ] && grep -Eq \'\\[Failed\\].*\\(0s\\)\' "$log" && is_adb_transport_failure "$log"',
    )
    expect(oldGate).not.toBe(source)
    expect(
      (
        await runFunction(
          oldGate,
          ["is_adb_transport_failure", "should_retry_transport_failure"],
          'should_retry_transport_failure "$1" "$2"',
          ["1", log],
        )
      ).status,
    ).not.toBe(0)
  })

  test("does not retry assertions, application crashes, or selector timeouts", async () => {
    const source = await readFile(laneScript, "utf8")
    const productFailures: Array<[string, string]> = [
      ["assertion.log", "Assertion failed: expected Welcome to be visible\n"],
      ["app-crash.log", "The application dev.expoturbo.example has crashed\n"],
      ["selector.log", "Element not found: id: chrome_terms_accept after 30 seconds\n"],
    ]
    for (const [name, contents] of productFailures) {
      const log = await fixtureFile(name, contents)
      const result = await runFunction(
        source,
        ["is_adb_transport_failure"],
        'is_adb_transport_failure "$1"',
        [log],
      )
      expect(result.status, `${name}: ${result.stderr}`).not.toBe(0)
    }

    expect(source).toContain('if ! is_adb_transport_failure "$bootstrap_log"; then')
    expect(source).not.toContain("Chrome bootstrap lost its first device session")
  })

  test("never permits an infrastructure retry after attempt one", async () => {
    const source = await readFile(laneScript, "utf8")
    const log = await fixtureFile(
      "second-offline.log",
      "DeviceServerDiedException: device offline\n",
    )
    const result = await runFunction(
      source,
      ["is_adb_transport_failure", "should_retry_transport_failure"],
      'should_retry_transport_failure "$1" "$2"',
      ["2", log],
    )

    expect(result.status).not.toBe(0)
    expect(source.match(/start_and_prepare_emulator 2/g)).toHaveLength(1)
    expect(source).toContain('exit "$second_status"')
  })

  test("stops a live attempt early only after proven transport loss", async () => {
    const source = await readFile(laneScript, "utf8")
    const transportLog = await fixtureFile(
      "live-offline.log",
      "[Failed] first flow (5s)\nDeviceServerDiedException: device offline\n",
    )
    const transportTrigger = `${transportLog}.trigger`
    const transport = await runTransportMonitor(source, transportLog, transportTrigger, "3")

    expect(transport.status, transport.stderr).not.toBe(0)
    expect(transport.elapsed).toBeLessThan(1_500)
    expect(transport.stderr).toContain("stopping this attempt early")
    expect(await readFile(transportTrigger, "utf8")).toContain("DeviceServerDiedException")

    const assertionLog = await fixtureFile(
      "live-assertion.log",
      "Assertion failed: expected Welcome to be visible\n",
    )
    const assertionTrigger = `${assertionLog}.trigger`
    const assertion = await runTransportMonitor(source, assertionLog, assertionTrigger, "0.3")

    expect(assertion.status, assertion.stderr).toBe(0)
    expect(await Bun.file(assertionTrigger).exists()).toBe(false)
    expect(source).toContain(
      'monitor_maestro_transport "$attempt" "$maestro_pid" "$$" "$run_log" "$trigger_log" &',
    )
  })

  test("keeps device readiness waits condition-based and bounded", async () => {
    const source = await readFile(laneScript, "utf8")
    const stableDevice = extractFunction(source, "wait_for_stable_device")
    const emulatorStart = extractFunction(source, "start_and_prepare_emulator")

    expect(stableDevice).toContain("for _ in $(seq 1 60)")
    expect(stableDevice).toContain('timeout 5 adb -s "$adb_serial" get-state')
    expect(stableDevice).toContain('timeout 5 adb -s "$adb_serial" shell true')
    expect(emulatorStart).toContain('timeout 180 adb -s "$adb_serial" wait-for-device')
    expect(emulatorStart).toContain("for _ in $(seq 1 120)")
    expect(emulatorStart).toContain("Android emulator did not complete boot within")

    const unbounded = stableDevice.replace(
      'timeout 5 adb -s "$adb_serial" get-state',
      'adb -s "$adb_serial" get-state',
    )
    expect(unbounded).not.toBe(stableDevice)
    expect(unbounded).not.toContain('timeout 5 adb -s "$adb_serial" get-state')
  })

  test("names a failed bounded pre-suite ADB command and keeps its output", async () => {
    const source = await readFile(laneScript, "utf8")
    const fixture = await mkdtemp(join(tmpdir(), "android-maestro-adb-step-"))
    fixtures.push(fixture)
    const command = join(fixture, "fake-adb")
    const timeout = join(fixture, "timeout")
    const output = join(fixture, "fixture-push.log")
    const errorOutput = join(fixture, "fixture-push.stderr")
    await writeFile(
      command,
      "#!/usr/bin/env bash\necho 'fixture stdout'\necho 'fixture stderr' >&2\nexit 23\n",
    )
    await writeFile(timeout, '#!/usr/bin/env bash\nshift\nexec "$@"\n')
    await Promise.all([chmod(command, 0o755), chmod(timeout, 0o755)])

    const result = await runFunction(
      source,
      ["run_named_adb_command"],
      'if PATH="$3:$PATH" run_named_adb_command "$1" 5 "$2" push "fixture file" /sdcard/Download/file 2>"$4"; then exit 0; else exit $?; fi',
      [output, command, fixture, errorOutput],
    )
    const [savedOutput, savedError] = await Promise.all([
      readFile(output, "utf8"),
      readFile(errorOutput, "utf8"),
    ])

    expect(result.status, JSON.stringify({ ...result, savedOutput, savedError })).toBe(23)
    expect(savedError).toContain("Pre-suite ADB command failed (exit 23):")
    expect(savedError).toContain("push fixture\\ file /sdcard/Download/file")
    expect(savedError).toContain(`Saved command output: ${output}`)
    expect(savedOutput).toBe("fixture stdout\nfixture stderr\n")
  })
})
