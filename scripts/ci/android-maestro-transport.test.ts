import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const laneScript = join(scriptDirectory, "run-android-maestro.sh")
const stopProcessScript = join(scriptDirectory, "stop-process.sh")
const activeStreamMarker = "EXPO_TURBO_MAESTRO_STREAM invocation=test-active"
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

function extractReadonly(source: string, name: string): string {
  const match = source.match(new RegExp(`^readonly ${name}="([^"]*)"$`, "m"))
  if (!match) throw new Error(`missing readonly ${name}`)
  return `readonly ${name}="${match[1]}"`
}

async function fixtureFile(name: string, contents: string): Promise<string> {
  const fixture = await mkdtemp(join(tmpdir(), "android-maestro-transport-"))
  fixtures.push(fixture)
  const path = join(fixture, name)
  await writeFile(path, contents)
  return path
}

async function availableCommands(names: string[]): Promise<string[]> {
  const available: string[] = []
  for (const name of names) {
    const child = Bun.spawn(["sh", "-c", 'command -v "$1" >/dev/null 2>&1', "test", name], {
      stdout: "ignore",
      stderr: "ignore",
    })
    if ((await child.exited) === 0) available.push(name)
  }
  return available
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
      `set -euo pipefail\n${extractReadonly(source, "adb_transport_pattern")}\n${body}\n${invocation}`,
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

function assertChromeBootstrapContract(source: string): void {
  const bootstrap = extractFunction(source, "run_chrome_bootstrap")
  const classification = extractFunction(source, "write_chrome_bootstrap_report")

  if ((bootstrap.match(/maestro --device/g) ?? []).length !== 2) {
    throw new Error("Chrome bootstrap must have exactly two bounded invocations")
  }
  if (!bootstrap.includes('capture_chrome_bootstrap_failure_evidence "$attempt" "first"')) {
    throw new Error("Chrome bootstrap must capture the first failure before recovery")
  }
  if (!bootstrap.includes('capture_attempt_evidence "$attempt" "$bootstrap_status" 1')) {
    throw new Error("a double Chrome bootstrap failure must preserve full attempt evidence")
  }
  if (bootstrap.includes("should_retry_transport_failure")) {
    throw new Error("the Chrome-only retry must not change the product retry gate")
  }
  if (!classification.includes("mCurrentFocus=") || classification.includes("pidof")) {
    throw new Error("Chrome bootstrap classification must use foreground focus, not pidof")
  }
  if (
    !source.includes('if ! should_retry_transport_failure 1 "$artifacts/maestro-attempt-1.log"')
  ) {
    throw new Error("product suite retries must remain transport-only")
  }
}

async function runTransportMonitor(
  source: string,
  log: string,
  trigger: string,
  duration: string,
  identityMatches = true,
  fileIdentityMatches = true,
  awkBinary = "awk",
): Promise<{ elapsed: number; status: number; stderr: string }> {
  const stopProcess = await readFile(stopProcessScript, "utf8")
  const functions = [
    "is_valid_process_identity",
    "is_valid_file_identity",
    "record_monitor_safety_failure",
    "is_adb_transport_failure",
    "monitor_maestro_transport",
  ]
    .map((name) => extractFunction(source, name))
    .join("\n")
  const stderrPath = `${trigger}.stderr`
  const script = `#!/usr/bin/env bash
set -uo pipefail
exec 2>"$4"
${extractReadonly(source, "adb_transport_pattern")}
${stopProcess}
${functions}
awk_binary="$5"
awk() { command "$awk_binary" "$@"; }
date() { printf '2026-08-18T00:00:00+00:00\\n'; }
process_identity() { printf '123 Mon Aug 18 00:00:00 2026\\n'; }
file_identity() { printf '4:22\\n'; }
sleep "$3" &
target_pid=$!
awk -v pid="$target_pid" '{ gsub(/pid=test-pid/, "pid=" pid); print }' "$1" >"$1.active"
mv "$1.active" "$1"
monitor_maestro_transport 1 "$target_pid" "${identityMatches ? "123 Mon Aug 18 00:00:00 2026" : "124 Mon Aug 18 00:00:00 2026"}" "$1" "${fileIdentityMatches ? "4:22" : "4:23"}" "test-active" "$2" &
monitor_pid=$!
wait "$target_pid"
target_status=$?
wait "$monitor_pid"
exit "$target_status"
`
  const started = performance.now()
  const child = Bun.spawn(
    ["bash", "-c", script, "test", log, trigger, duration, stderrPath, awkBinary],
    { stdout: "pipe", stderr: "ignore" },
  )
  const status = await child.exited
  const stderr = await readFile(stderrPath, "utf8")
  return { elapsed: performance.now() - started, status, stderr }
}

describe("Android Maestro transport recovery", () => {
  test("accepts real GNU process and file identities and rejects failure stubs", async () => {
    if (process.platform !== "linux") return

    const source = await readFile(laneScript, "utf8")
    const file = await fixtureFile("identity.log", "active\n")
    const result = await runFunction(
      source,
      ["process_identity", "file_identity", "is_valid_process_identity", "is_valid_file_identity"],
      'sleep 2 & pid=$!; process=$(process_identity "$pid"); file=$(file_identity "$1"); kill "$pid"; wait "$pid" 2>/dev/null || true; is_valid_process_identity "$process" && is_valid_file_identity "$file"; printf "%s\\n%s\\n" "$process" "$file"',
      [file],
    )
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toMatch(/^[0-9]+ .+ [0-9]{4}\n[0-9]+:[1-9][0-9]*\n$/)

    const invalidIdentities: Array<[string, string]> = [
      ["is_valid_process_identity", ""],
      ["is_valid_process_identity", "not-ps-output"],
      ["is_valid_file_identity", ""],
      ["is_valid_file_identity", "invalid-stat-output"],
    ]
    for (const [validator, value] of invalidIdentities) {
      expect(
        (await runFunction(source, [validator], `${validator} "$1"`, [value])).status,
      ).not.toBe(0)
    }
  })

  test("records named identity startup failures and fails closed", async () => {
    const source = await readFile(laneScript, "utf8")
    const failureStubs: Array<[string, string]> = [
      ["is_valid_process_identity", "invalid-ps"],
      ["is_valid_file_identity", "invalid-stat"],
    ]
    for (const [validator, value] of failureStubs) {
      const result = await runFunction(source, [validator], `${validator} "$1"`, [value])
      expect(result.status).not.toBe(0)
    }

    const failureWriter = extractFunction(source, "write_monitor_startup_failure")
    expect(failureWriter).toContain("state=monitor_startup_failed")
    expect(failureWriter).toContain("action=fail closed without signalling an unproven PID")
    expect(failureWriter).toContain('echo "unproven_pid=$unproven_pid"')
    expect(failureWriter).toContain("final_cleanup=trusted entry supervisor group sweep")
    expect(failureWriter).toContain(
      'echo "$diagnostic: live Maestro transport monitoring could not start; failing closed." >&2',
    )

    const suite = extractFunction(source, "run_maestro_suite")
    expect(suite.indexOf('initialize_maestro_run_log "$run_log" "$stream_marker"')).toBeLessThan(
      suite.indexOf('maestro --device "$adb_serial" test'),
    )
    for (const required of [
      'is_valid_process_identity "$maestro_process_identity"',
      'is_valid_file_identity "$run_log_identity"',
      "MAESTRO_MONITOR_PROCESS_IDENTITY_INVALID",
      "MAESTRO_MONITOR_FILE_IDENTITY_INVALID",
      "return 70",
    ]) {
      expect(suite).toContain(required)
      expect(suite.replaceAll(required, "removed identity contract")).not.toContain(required)
    }
    expect(suite).toContain(
      "grep -Eq '^state=(stream_marker_validation_failed|identity_validation_failed)$'",
    )
    expect(suite).toContain("status=70")

    expect(suite.match(/write_monitor_startup_failure[\s\S]*?"\$maestro_pid"/g)).toHaveLength(2)
    expect(suite).toContain('maestro_pid=""\n    set -e\n    return 70')
  })

  test("fully drains 302 fast log lines before bounded cleanup", async () => {
    if (process.platform !== "linux") return

    const source = await readFile(laneScript, "utf8")
    const log = await fixtureFile("fast-maestro.log", "")
    const streamed = `${log}.streamed`
    const script = `${extractFunction(source, "drain_log_stream")}
: >"$1"
( for line in $(seq 1 302); do printf 'line-%03d\\n' "$line"; done ) >>"$1" &
producer_pid=$!
tail --pid="$producer_pid" --sleep-interval=0.01 -n +1 -f "$1" >"$2" &
stream_pid=$!
wait "$producer_pid"
drain_log_stream "$stream_pid" 200 0.01
wc -l <"$2"
`
    const child = Bun.spawn(["bash", "-c", script, "test", log, streamed], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const [status, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(status, stderr).toBe(0)
    expect(Number(stdout.trim())).toBe(302)
    expect((await readFile(streamed, "utf8")).split("\n").filter(Boolean)).toHaveLength(302)
  })

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
      [
        "product-output.log",
        'Element not found: text: "DeviceServerDiedException: device offline"\n',
      ],
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

    assertChromeBootstrapContract(source)
  })

  test("retries one non-transport Chrome bootstrap assertion and can pass", async () => {
    const source = await readFile(laneScript, "utf8")
    const bootstrap = extractFunction(source, "run_chrome_bootstrap")
    const maestroCalls = [...bootstrap.matchAll(/maestro --device/g)].map((match) => match.index)
    const firstEvidence = bootstrap.indexOf(
      'capture_chrome_bootstrap_failure_evidence "$attempt" "first"',
    )
    const reset = bootstrap.indexOf('reset_chrome_bootstrap "$attempt"')
    const secondSuccess = bootstrap.lastIndexOf(
      'if [ "$bootstrap_status" -eq 0 ]; then\n    return 0',
    )

    expect(maestroCalls).toHaveLength(2)
    expect(maestroCalls[0]).toBeLessThan(firstEvidence)
    expect(firstEvidence).toBeLessThan(reset)
    expect(reset).toBeLessThan(maestroCalls[1] ?? -1)
    expect(maestroCalls[1] ?? -1).toBeLessThan(secondSuccess)
  })

  test("fails after exactly two Chrome bootstrap invocations and keeps full evidence", async () => {
    const source = await readFile(laneScript, "utf8")
    const bootstrap = extractFunction(source, "run_chrome_bootstrap")
    const secondEvidence = bootstrap.indexOf(
      'capture_chrome_bootstrap_failure_evidence "$attempt" "second"',
    )
    const fullEvidence = bootstrap.lastIndexOf(
      'capture_attempt_evidence "$attempt" "$bootstrap_status" 1',
    )
    const failedReturn = bootstrap.lastIndexOf('return "$bootstrap_status"')

    expect(bootstrap.match(/maestro --device/g)).toHaveLength(2)
    expect(secondEvidence).toBeGreaterThan(0)
    expect(secondEvidence).toBeLessThan(fullEvidence)
    expect(fullEvidence).toBeLessThan(failedReturn)
    expect(extractFunction(source, "capture_attempt_evidence")).toContain(': >"$emulator_log"')
  })

  test("classifies launcher foreground after a background Chrome restart from focus evidence", async () => {
    const source = await readFile(laneScript, "utf8")
    const focus = await fixtureFile(
      "launcher-focus.txt",
      "mCurrentFocus=Window{12 u0 com.google.android.apps.nexuslauncher/.NexusLauncherActivity}\n",
    )
    const activity = await fixtureFile(
      "launcher-activity.txt",
      "mResumedActivity: ActivityRecord{12 com.google.android.apps.nexuslauncher/.NexusLauncherActivity}\n",
    )
    const logcat = await fixtureFile(
      "launcher-logcat.txt",
      "ActivityManager: Killing 3824:com.android.chrome/u0a123 because dependency GmsModuleProvider\nChrome restarted for a background receiver\n",
    )
    const report = `${focus}.report`
    const result = await runFunction(
      source,
      ["write_chrome_bootstrap_report"],
      'chrome_package=com.android.chrome; write_chrome_bootstrap_report "$1" "$2" "$3" "$4"',
      [focus, activity, logcat, report],
    )

    expect(result.status, result.stderr).toBe(0)
    expect(await readFile(report, "utf8")).toContain(
      "classification=foreground_left_chrome_with_device_fault_evidence",
    )
    expect(extractFunction(source, "write_chrome_bootstrap_report")).not.toContain("pidof")
  })

  test("reports Chrome foreground without device-fault evidence as a real bootstrap failure", async () => {
    const source = await readFile(laneScript, "utf8")
    const focus = await fixtureFile(
      "chrome-focus.txt",
      "mCurrentFocus=Window{12 u0 com.android.chrome/com.google.android.apps.chrome.Main}\n",
    )
    const activity = await fixtureFile(
      "chrome-activity.txt",
      "mResumedActivity: ActivityRecord{12 com.android.chrome/com.google.android.apps.chrome.Main}\n",
    )
    const logcat = await fixtureFile("chrome-logcat.txt", "unrelated line\n")
    const report = `${focus}.report`
    const result = await runFunction(
      source,
      ["write_chrome_bootstrap_report"],
      'chrome_package=com.android.chrome; write_chrome_bootstrap_report "$1" "$2" "$3" "$4"',
      [focus, activity, logcat, report],
    )

    expect(result.status, result.stderr).toBe(0)
    expect(await readFile(report, "utf8")).toContain(
      "classification=chrome_remained_foreground_without_device_fault_evidence",
    )
  })

  test("guards the bootstrap bound, foreground classifier, and product retry boundary", async () => {
    const source = await readFile(laneScript, "utf8")
    expect(() => assertChromeBootstrapContract(source)).not.toThrow()
    expect(() =>
      assertChromeBootstrapContract(
        source.replace(
          '  if [ "$bootstrap_status" -eq 0 ]; then\n    return 0\n  fi\n\n  set +e\n  capture_chrome_bootstrap_failure_evidence "$attempt" "second"',
          '  while [ "$bootstrap_status" -ne 0 ]; do\n    maestro --device "$adb_serial" test\n  done\n\n  set +e\n  capture_chrome_bootstrap_failure_evidence "$attempt" "second"',
        ),
      ),
    ).toThrow(/exactly two/)
    expect(() =>
      assertChromeBootstrapContract(
        source.replace(
          'if ! should_retry_transport_failure 1 "$artifacts/maestro-attempt-1.log"; then',
          'if [ "$first_status" -eq 0 ]; then',
        ),
      ),
    ).toThrow(/transport-only/)
    expect(() =>
      assertChromeBootstrapContract(source.replace("mCurrentFocus=", "pidof com.android.chrome")),
    ).toThrow(/foreground focus, not pidof/)
  })

  test("uses the production strict case-sensitive full-line classifier", async () => {
    const source = await readFile(laneScript, "utf8")
    const matches = [
      "device offline\n",
      "error: device offline\n",
      "DeviceServerDiedException: lower-case device detail\n",
      "com.maestro.DeviceServerDiedException\n",
    ]
    const rejects = [
      "DEVICE OFFLINE\n",
      "deviceserverdiedexception\n",
      "Product says device offline in help text\n",
      'Element not found: text: "device offline"\n',
    ]

    for (const contents of matches) {
      const log = await fixtureFile("match.log", contents)
      expect(
        (
          await runFunction(source, ["is_adb_transport_failure"], 'is_adb_transport_failure "$1"', [
            log,
          ])
        ).status,
      ).toBe(0)
    }
    for (const contents of rejects) {
      const log = await fixtureFile("reject.log", contents)
      expect(
        (
          await runFunction(source, ["is_adb_transport_failure"], 'is_adb_transport_failure "$1"', [
            log,
          ])
        ).status,
      ).not.toBe(0)
    }

    const matchEverything = source.replace(
      /^readonly adb_transport_pattern="[^"]*"$/m,
      'readonly adb_transport_pattern=".*"',
    )
    expect(matchEverything).not.toBe(source)
    const productLog = await fixtureFile("mutation-product.log", "normal product assertion\n")
    expect(
      (
        await runFunction(
          matchEverything,
          ["is_adb_transport_failure"],
          'is_adb_transport_failure "$1"',
          [productLog],
        )
      ).status,
    ).toBe(0)
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
      `${activeStreamMarker}\n[Failed] first flow (5s)\nDeviceServerDiedException: device offline\n`,
    )
    const transportTrigger = `${transportLog}.trigger`
    const transport = await runTransportMonitor(source, transportLog, transportTrigger, "3")

    expect(transport.status, transport.stderr).not.toBe(0)
    expect(transport.elapsed).toBeLessThan(1_500)
    expect(transport.stderr).toContain("stopping this attempt early")
    expect(await readFile(transportTrigger, "utf8")).toContain("DeviceServerDiedException")

    expect(source).toContain('initialize_maestro_run_log "$run_log" "$stream_marker"')
    expect(source).toContain(
      'stream_marker="EXPO_TURBO_MAESTRO_STREAM invocation=$invocation_token"',
    )
  })

  test("does not stop on stale text before the active stream marker", async () => {
    const source = await readFile(laneScript, "utf8")
    const log = await fixtureFile(
      "stale.log",
      `prior attempt header\nDeviceServerDiedException: stale text\n${activeStreamMarker}\n`,
    )
    const trigger = `${log}.trigger`
    const result = await runTransportMonitor(source, log, trigger, "0.3")

    expect(result.status, result.stderr).toBe(0)
    expect(await readFile(trigger, "utf8")).toContain("MAESTRO_STREAM_MARKER_INVALID")

    const withoutMarkerValidation = source.replace(
      'if [ "$first_line" != "$stream_marker" ]; then',
      "if false; then",
    )
    expect(withoutMarkerValidation).not.toBe(source)
    const mutatedTrigger = `${log}.mutation-trigger`
    const mutation = await runTransportMonitor(withoutMarkerValidation, log, mutatedTrigger, "0.3")
    expect(mutation.status, mutation.stderr).not.toBe(0)
    expect(await readFile(mutatedTrigger, "utf8")).toContain("stale text")
  })

  test("creates a fresh marker-only active log before monitor launch", async () => {
    const source = await readFile(laneScript, "utf8")
    const log = await fixtureFile(
      "fresh.log",
      "prior attempt\nDeviceServerDiedException: stale transport\n",
    )
    const result = await runFunction(
      source,
      ["initialize_maestro_run_log"],
      'initialize_maestro_run_log "$1" "$2"',
      [log, activeStreamMarker],
    )
    expect(result.status, result.stderr).toBe(0)
    expect(await readFile(log, "utf8")).toBe(`${activeStreamMarker}\n`)

    const withoutTruncate = source.replace('  : >"$run_log"', "  :")
    expect(withoutTruncate).not.toBe(source)
    await writeFile(log, "prior attempt\nDeviceServerDiedException: stale transport\n")
    await runFunction(
      withoutTruncate,
      ["initialize_maestro_run_log"],
      'initialize_maestro_run_log "$1" "$2"',
      [log, activeStreamMarker],
    )
    expect(await readFile(log, "utf8")).not.toBe(`${activeStreamMarker}\n`)
  })

  test("does not stop when the active marker is missing or wrong", async () => {
    const source = await readFile(laneScript, "utf8")
    const invalidMarkers: Array<[string, string]> = [
      ["missing-marker.log", "DeviceServerDiedException: device offline\n"],
      [
        "wrong-marker.log",
        "EXPO_TURBO_MAESTRO_STREAM invocation=wrong\nDeviceServerDiedException\n",
      ],
    ]
    for (const [name, contents] of invalidMarkers) {
      const log = await fixtureFile(name, contents)
      const trigger = `${log}.trigger`
      const result = await runTransportMonitor(source, log, trigger, "0.3")
      expect(result.status, result.stderr).toBe(0)
      expect(await readFile(trigger, "utf8")).toContain("state=stream_marker_validation_failed")
    }
  })

  test("does not read a prior attempt log", async () => {
    const source = await readFile(laneScript, "utf8")
    const fixture = await mkdtemp(join(tmpdir(), "android-maestro-prior-attempt-"))
    fixtures.push(fixture)
    await writeFile(
      join(fixture, "maestro-attempt-1.log"),
      `${activeStreamMarker}\nDeviceServerDiedException: prior attempt\n`,
    )
    const activeLog = join(fixture, "maestro-attempt-2.log")
    await writeFile(activeLog, `${activeStreamMarker}\n`)
    const trigger = `${activeLog}.trigger`
    const result = await runTransportMonitor(source, activeLog, trigger, "0.3")

    expect(result.status, result.stderr).toBe(0)
    expect(await Bun.file(trigger).exists()).toBe(false)
  })

  test("does not stop on product-rendered transport words", async () => {
    const source = await readFile(laneScript, "utf8")
    const productLines = [
      "- DeviceServerDiedException",
      "Element DeviceServerDiedException",
      'Element not found: text: "DeviceServerDiedException: device offline"',
    ]
    for (const [index, productLine] of productLines.entries()) {
      const log = await fixtureFile(
        `product-output-${index}.log`,
        `${activeStreamMarker}\n${productLine}\n`,
      )
      const classifier = await runFunction(
        source,
        ["is_adb_transport_failure"],
        'is_adb_transport_failure "$1"',
        [log],
      )
      expect(classifier.status, productLine).not.toBe(0)

      const trigger = `${log}.trigger`
      const result = await runTransportMonitor(source, log, trigger, "0.3")
      expect(result.status, `${productLine}: ${result.stderr}`).toBe(0)
      expect(await Bun.file(trigger).exists()).toBe(false)
    }
  })

  test("keeps grep and each available awk on identical ERE semantics", async () => {
    const source = await readFile(laneScript, "utf8")
    const awkCommands = await availableCommands(["awk", "gawk", "mawk"])
    expect(awkCommands).toContain("awk")

    for (const awkCommand of awkCommands) {
      for (const [name, line, mustMatch] of [
        ["transport", "com.maestro.DeviceServerDiedException", true],
        ["dash-product", "- DeviceServerDiedException", false],
        ["element-product", "Element DeviceServerDiedException", false],
      ] as const) {
        const log = await fixtureFile(
          `${awkCommand}-${name}.log`,
          `${activeStreamMarker}\n${line}\n`,
        )
        const classifier = await runFunction(
          source,
          ["is_adb_transport_failure"],
          'is_adb_transport_failure "$1"',
          [log],
        )
        expect(classifier.status === 0, `${awkCommand} grep ${line}`).toBe(mustMatch)
        const trigger = `${log}.trigger`
        const monitor = await runTransportMonitor(
          source,
          log,
          trigger,
          "0.3",
          true,
          true,
          awkCommand,
        )
        expect(monitor.status !== 0, `${awkCommand} monitor ${line}: ${monitor.stderr}`).toBe(
          mustMatch,
        )
        expect(await Bun.file(trigger).exists()).toBe(mustMatch)
      }
    }

    const divergent = source.replace(
      'EXPO_TURBO_ADB_TRANSPORT_PATTERN="$adb_transport_pattern" awk \\\n        \'BEGIN { pattern=ENVIRON["EXPO_TURBO_ADB_TRANSPORT_PATTERN"] } NR > 1 && $0 ~ pattern { print; found=1; exit } END { exit !found }\'',
      "awk -v pattern=\"$adb_transport_pattern\" \\\n        'NR > 1 && $0 ~ pattern { print; found=1; exit } END { exit !found }'",
    )
    expect(divergent).not.toBe(source)
    const mutationLog = await fixtureFile(
      "divergent-consumer.log",
      `${activeStreamMarker}\n- DeviceServerDiedException\n`,
    )
    const mutationTrigger = `${mutationLog}.trigger`
    const mutation = await runTransportMonitor(divergent, mutationLog, mutationTrigger, "0.3")
    expect(
      mutation.status,
      "the -v escape-processing mutation must stop the product fixture",
    ).not.toBe(0)
    expect(await Bun.file(mutationTrigger).exists()).toBe(true)
  })

  test("does not stop a PID whose invocation identity changed", async () => {
    const source = await readFile(laneScript, "utf8")
    const log = await fixtureFile(
      "reused-pid.log",
      `${activeStreamMarker}\nDeviceServerDiedException: device offline\n`,
    )
    const trigger = `${log}.trigger`
    const result = await runTransportMonitor(source, log, trigger, "0.3", false)

    expect(result.status, result.stderr).toBe(0)
    expect(await readFile(trigger, "utf8")).toContain("MAESTRO_MONITOR_IDENTITY_CHANGED")
  })

  test("does not stop after the active log path is replaced", async () => {
    const source = await readFile(laneScript, "utf8")
    const log = await fixtureFile(
      "replaced.log",
      `${activeStreamMarker}\nDeviceServerDiedException: device offline\n`,
    )
    const trigger = `${log}.trigger`
    const result = await runTransportMonitor(source, log, trigger, "0.3", true, false)

    expect(result.status, result.stderr).toBe(0)
    expect(await readFile(trigger, "utf8")).toContain("MAESTRO_MONITOR_IDENTITY_CHANGED")
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
    expect(savedError).toContain("fixture stdout")
    expect(savedError).toContain("fixture stderr")
    expect(savedOutput).toBe("fixture stdout\nfixture stderr\n")

    const withoutEvidencePrint = source.replace('  cat "$output" >&2', "  :")
    expect(withoutEvidencePrint).not.toBe(source)
    const mutationError = join(fixture, "mutation.stderr")
    await runFunction(
      withoutEvidencePrint,
      ["run_named_adb_command"],
      'if PATH="$3:$PATH" run_named_adb_command "$1" 5 "$2" push fixture 2>"$4"; then exit 0; else exit $?; fi',
      [output, command, fixture, mutationError],
    )
    expect(await readFile(mutationError, "utf8")).not.toContain("fixture stdout")
  })
})
