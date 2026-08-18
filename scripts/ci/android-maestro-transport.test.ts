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
  const guardedBootstrap = extractFunction(source, "run_chrome_bootstrap_with_hidden_dialogs")
  const enableHiddenDialogs = extractFunction(source, "enable_hide_error_dialogs")
  const classification = extractFunction(source, "write_chrome_bootstrap_report")
  const evidence = extractFunction(source, "capture_chrome_bootstrap_failure_evidence")
  const reset = extractFunction(source, "reset_chrome_bootstrap")
  const prepare = extractFunction(source, "start_and_prepare_emulator")
  const cleanup = extractFunction(source, "cleanup")

  if ((bootstrap.match(/maestro --device/g) ?? []).length !== 2) {
    throw new Error("Chrome bootstrap must have exactly two bounded invocations")
  }
  if (!bootstrap.includes('capture_chrome_bootstrap_failure_evidence "$attempt" "first"')) {
    throw new Error("Chrome bootstrap must capture the first failure before recovery")
  }
  if (!bootstrap.includes('capture_chrome_bootstrap_failure_evidence "$attempt" "first" || true')) {
    throw new Error("Chrome bootstrap diagnostics must not control the recovery retry")
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
    !evidence.includes('shell dumpsys window >"$focus_log"') ||
    evidence.includes("shell dumpsys window windows")
  ) {
    throw new Error("Chrome bootstrap evidence must use the full window dump")
  }
  if (
    !guardedBootstrap.includes('enable_hide_error_dialogs "$attempt"') ||
    !guardedBootstrap.includes('if ! restore_hide_error_dialogs "$attempt"; then') ||
    !prepare.includes('run_chrome_bootstrap_with_hidden_dialogs "$attempt"') ||
    prepare.includes('run_chrome_bootstrap "$attempt"')
  ) {
    throw new Error("Chrome bootstrap must restore hidden error dialogs before product flows")
  }
  if (!cleanup.includes('restore_hide_error_dialogs "cleanup" || status=1')) {
    throw new Error("EXIT cleanup must retry error-dialog restoration on every failure path")
  }
  if (
    !enableHiddenDialogs.includes("android.intent.action.CLOSE_SYSTEM_DIALOGS") ||
    !enableHiddenDialogs.includes("Application Not Responding:")
  ) {
    throw new Error("hidden-dialog setup must close and verify any pre-existing error dialog")
  }
  if (
    !reset.includes("adb reconnect offline") ||
    !reset.includes("adb reconnect offline || true") ||
    !reset.includes("wait_for_stable_device") ||
    !reset.includes('shell pm clear "$chrome_package"')
  ) {
    throw new Error("Chrome retry must reconnect ADB, prove stability, and clear Chrome")
  }
  if (
    !source.includes("if ! should_retry_transport_failure \\\n") ||
    !source.includes('"$artifacts/maestro-attempt-1.log" \\\n') ||
    !source.includes('"$artifacts/maestro-junit-attempt-1.xml"; then')
  ) {
    throw new Error("product suite retries must remain transport-only")
  }
}

async function androidEvidenceFixture(
  windowOutput: string,
  activityOutput: string,
  logcatOutput: string,
): Promise<string> {
  const fixture = await mkdtemp(join(tmpdir(), "android-maestro-evidence-"))
  fixtures.push(fixture)
  await Promise.all([
    writeFile(join(fixture, "window.txt"), windowOutput),
    writeFile(
      join(fixture, "window-windows.txt"),
      "WINDOW MANAGER WINDOWS (dumpsys window windows)\n",
    ),
    writeFile(join(fixture, "activity.txt"), activityOutput),
    writeFile(join(fixture, "logcat.txt"), logcatOutput),
    writeFile(
      join(fixture, "adb"),
      `#!/usr/bin/env bash
set -euo pipefail
fixture="\${0%/*}"
printf '%s\\n' "$*" >>"$fixture/commands.txt"
case "$*" in
  "-s emulator-5580 shell dumpsys window") cat "$fixture/window.txt" ;;
  "-s emulator-5580 shell dumpsys window windows") cat "$fixture/window-windows.txt" ;;
  "-s emulator-5580 shell dumpsys activity activities") cat "$fixture/activity.txt" ;;
  "-s emulator-5580 logcat -d -t 1000") cat "$fixture/logcat.txt" ;;
  *) exit 64 ;;
esac
`,
    ),
  ])
  await chmod(join(fixture, "adb"), 0o755)
  return fixture
}

async function runChromeBootstrapHarness(
  source: string,
  firstStatus: number,
  secondStatus: number,
  evidenceMode = "pass",
  resetMode = "pass",
): Promise<{ status: number; trace: string; calls: number }> {
  const trace = await fixtureFile("bootstrap-trace.txt", "")
  const result = await runFunction(
    source,
    ["run_chrome_bootstrap"],
    `fixture_root="\${1%/*}"
artifacts="$fixture_root/artifacts"
mkdir -p "$artifacts"
emulator_log="$fixture_root/emulator.log"
: >"$emulator_log"
trace_file="$1"
adb_serial=emulator-5580
first_bootstrap_status="$2"
second_bootstrap_status="$3"
evidence_mode="$4"
reset_mode="$5"
maestro() {
  local calls=0
  if [ -f "$trace_file.calls" ]; then calls="$(cat "$trace_file.calls")"; fi
  calls=$((calls + 1))
  printf '%s' "$calls" >"$trace_file.calls"
  if [ "$calls" -eq 1 ]; then return "$first_bootstrap_status"; fi
  return "$second_bootstrap_status"
}

capture_chrome_bootstrap_failure_evidence() {
  printf 'evidence:%s\\n' "$2" >>"$trace_file"
  if [ "$evidence_mode" = "pass" ]; then return 0; fi
  return 1
}
reset_chrome_bootstrap() {
  printf 'reset\\n' >>"$trace_file"
  if [ "$reset_mode" = "pass" ]; then return 0; fi
  return 1
}
capture_attempt_evidence() {
  printf 'full-evidence\\n' >>"$trace_file"
  : >"$emulator_log"
  : >"$artifacts/logcat-attempt-$1.txt"
  : >"$artifacts/environment-attempt-$1.txt"
}
exec 2>>"$trace_file.stderr"
run_chrome_bootstrap 1`,
    [trace, String(firstStatus), String(secondStatus), evidenceMode, resetMode],
  )
  const callsPath = `${trace}.calls`
  const calls = (await Bun.file(callsPath).exists()) ? Number(await readFile(callsPath, "utf8")) : 0
  return { status: result.status, trace: await readFile(trace, "utf8"), calls }
}

async function runHiddenDialogsHarness(
  source: string,
  priorSetting: "null" | "0" | "1" | "invalid",
  bootstrapStatus: number,
  failureMode = "none",
): Promise<{ status: number; trace: string; finalSetting: string; restoreRequired: boolean }> {
  const trace = await fixtureFile("hide-dialogs-trace.txt", "")
  const result = await runFunction(
    source,
    [
      "enable_hide_error_dialogs",
      "restore_hide_error_dialogs",
      "run_chrome_bootstrap_with_hidden_dialogs",
    ],
    `trace_file="$1"
artifacts="\${1%/*}/artifacts"
mkdir -p "$artifacts"
adb_serial=emulator-5580
hide_error_dialogs_prior_value=""
hide_error_dialogs_restore_required=0
setting="$2"
desired_bootstrap_status="$3"
failure_mode="$4"
restore_calls=0
dialog_open=1
run_named_adb_command() {
  local output="$1"
  shift 2
  printf '%s\\n' "$*" >>"$trace_file"
  case "$output" in
    *-read.txt)
      [ "$failure_mode" != "read-command" ] || return 31
      if [ "$setting" = "invalid" ]; then printf 'unexpected\\r\\n' >"$output"; else printf '%s\\r\\n' "$setting" >"$output"; fi
      ;;
    *-set.txt)
      [ "$failure_mode" != "set-command" ] || return 32
      setting=1
      : >"$output"
      ;;
    *-verify.txt)
      [ "$failure_mode" != "enable-verify-command" ] || return 34
      printf '%s\\n' "$setting" >"$output"
      [ "$failure_mode" != "enable-verify-value" ] || printf '0\\n' >"$output"
      ;;
    *-close.txt)
      [ "$failure_mode" != "close-command" ] || return 36
      dialog_open=0
      : >"$output"
      ;;
    *-closed.txt)
      [ "$failure_mode" != "close-verify-command" ] || return 37
      if [ "$failure_mode" = "close-verify-value" ]; then
        printf '  mCurrentFocus=Window{fixture u0 Application Not Responding: com.android.systemui}\\n' >"$output"
      else
        printf '  mCurrentFocus=Window{fixture u0 com.android.chrome/.Main}\\n' >"$output"
      fi
      ;;
    *-restore.txt)
      restore_calls=$((restore_calls + 1))
      if [ "$failure_mode" = "restore-command" ] ||
        { [ "$failure_mode" = "restore-command-once" ] && [ "$restore_calls" -eq 1 ]; }; then
        return 33
      fi
      case "$*" in
        *" settings delete global hide_error_dialogs") setting=null ;;
        *) setting="$hide_error_dialogs_prior_value" ;;
      esac
      : >"$output"
      ;;
    *-restored.txt)
      [ "$failure_mode" != "restore-verify-command" ] || return 35
      printf '%s\\n' "$setting" >"$output"
      if [ "$failure_mode" = "restore-verify-value" ]; then
        if [ "$hide_error_dialogs_prior_value" = "1" ]; then printf '0\\n' >"$output"; else printf '1\\n' >"$output"; fi
      fi
      ;;
  esac
}
run_chrome_bootstrap() {
  printf 'bootstrap setting=%s dialog_open=%s\\n' "$setting" "$dialog_open" >>"$trace_file"
  return "$desired_bootstrap_status"
}
if run_chrome_bootstrap_with_hidden_dialogs 1; then
  status=0
else
  status=$?
fi
printf 'wrapper_restore_required=%s\\n' "$hide_error_dialogs_restore_required" >>"$trace_file"
if [ "$failure_mode" = "restore-command-once" ] &&
  [ "$hide_error_dialogs_restore_required" -eq 1 ]; then
  restore_hide_error_dialogs cleanup
fi
printf 'observed setting=%s\\n' "$setting" >>"$trace_file"
printf 'restore_required=%s\\n' "$hide_error_dialogs_restore_required" >>"$trace_file"
printf 'status=%s\\n' "$status" >>"$trace_file"
exit 0`,
    [trace, priorSetting, String(bootstrapStatus), failureMode],
  )
  const traceContents = await readFile(trace, "utf8")
  const status = Number(traceContents.match(/^status=([0-9]+)$/m)?.[1] ?? -1)
  const finalSetting = traceContents.match(/^observed setting=(.*)$/m)?.[1] ?? "not-recorded"
  const restoreRequired = traceContents.match(/^restore_required=(.*)$/m)?.[1] === "1"
  expect(result.status, result.stderr).toBe(0)
  return { status, trace: traceContents, finalSetting, restoreRequired }
}

async function runBootstrapResetHarness(
  source: string,
  reconnectStatus: number,
): Promise<{ status: number; trace: string; calls: number; reconnectEvidence: string }> {
  const trace = await fixtureFile("bootstrap-reset-trace.txt", "")
  const result = await runFunction(
    source,
    ["reset_chrome_bootstrap", "run_chrome_bootstrap"],
    `fixture_root="\${1%/*}"
trace_file="$1"
artifacts="$fixture_root/artifacts"
mkdir -p "$artifacts"
adb_serial=emulator-5580
chrome_package=com.android.chrome
emulator_log="$fixture_root/emulator.log"
: >"$emulator_log"
reconnect_status="$2"
run_named_adb_command() {
  local output="$1"
  shift 2
  printf '%s\\n' "$*" >>"$trace_file"
  case "$output" in
    *-reconnect-offline.txt)
      printf 'no offline transports\\n' >"$output"
      return "$reconnect_status"
      ;;
    *-package.txt) printf 'package:/system/app/Chrome/Chrome.apk\\n' >"$output" ;;
    *-clear.txt) printf 'Success\\n' >"$output" ;;
  esac
}
wait_for_stable_device() { printf 'stable\\n' >>"$trace_file"; return 0; }
maestro() {
  calls=0
  [ ! -f "$fixture_root/bootstrap.calls" ] || calls="$(cat "$fixture_root/bootstrap.calls")"
  calls=$((calls + 1))
  printf '%s' "$calls" >"$fixture_root/bootstrap.calls"
  if [ "$calls" -eq 1 ]; then echo 'assertion failed: Chrome consent button'; return 17; fi
  return 0
}
capture_chrome_bootstrap_failure_evidence() { printf 'evidence:%s\\n' "$2" >>"$trace_file"; return 0; }
capture_attempt_evidence() { return 0; }
if run_chrome_bootstrap 1; then status=0; else status=$?; fi
printf 'status=%s\\n' "$status" >>"$trace_file"
exit 0`,
    [trace, String(reconnectStatus)],
  )
  const traceContents = await readFile(trace, "utf8")
  expect(result.status, result.stderr).toBe(0)
  return {
    status: Number(traceContents.match(/^status=([0-9]+)$/m)?.[1] ?? -1),
    trace: traceContents,
    calls: Number(await readFile(join(dirname(trace), "bootstrap.calls"), "utf8")),
    reconnectEvidence: await readFile(
      join(dirname(trace), "artifacts/chrome-bootstrap-attempt-1-reconnect-offline.txt"),
      "utf8",
    ),
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
    expect(result.status, JSON.stringify(result)).toBe(0)
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
      [
        "is_adb_transport_failure",
        "is_maestro_attempt_transport_failure",
        "should_retry_transport_failure",
      ],
      'should_retry_transport_failure "$1" "$2" "$3"',
      ["1", log, `${log}.missing-junit`],
    )
    expect(result.status).toBe(0)

    const oldGate = source.replace(
      '[ "$attempt" -eq 1 ] && is_maestro_attempt_transport_failure "$log" "$junit"',
      '[ "$attempt" -eq 1 ] && grep -Eq \'\\[Failed\\].*\\(0s\\)\' "$log" && is_maestro_attempt_transport_failure "$log" "$junit"',
    )
    expect(oldGate).not.toBe(source)
    expect(
      (
        await runFunction(
          oldGate,
          [
            "is_adb_transport_failure",
            "is_maestro_attempt_transport_failure",
            "should_retry_transport_failure",
          ],
          'should_retry_transport_failure "$1" "$2" "$3"',
          ["1", log, `${log}.missing-junit`],
        )
      ).status,
    ).not.toBe(0)
  })

  test("retries when the JUnit failure proves a device-server loss", async () => {
    const source = await readFile(laneScript, "utf8")
    const log = await fixtureFile("summary.log", "[Failed] Rails flow (19s)\n")
    const junit = await fixtureFile(
      "offline.xml",
      `<testsuite>
  <testcase status="ERROR">
    <failure>maestro.android.DeviceServerDiedException: Device server died during 'takeScreenshot': StatusRuntimeException: UNAVAILABLE
Caused by: java.io.IOException: Command failed (host:transport:emulator-5580): device offline</failure>
  </testcase>
</testsuite>\n`,
    )

    const result = await runFunction(
      source,
      [
        "is_adb_transport_failure",
        "is_maestro_attempt_transport_failure",
        "should_retry_transport_failure",
      ],
      'should_retry_transport_failure "$1" "$2" "$3"',
      ["1", log, junit],
    )
    expect(result.status, result.stderr).toBe(0)
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

    const productLog = await fixtureFile("product-summary.log", "[Failed] Rails flow (19s)\n")
    const productJunit = await fixtureFile(
      "product.xml",
      `<testsuite><testcase status="FAILURE"><failure>Element not found: text: "DeviceServerDiedException: device offline"</failure></testcase></testsuite>\n`,
    )
    const junitResult = await runFunction(
      source,
      ["is_adb_transport_failure", "is_maestro_attempt_transport_failure"],
      'is_maestro_attempt_transport_failure "$1" "$2"',
      [productLog, productJunit],
    )
    expect(junitResult.status, junitResult.stderr).not.toBe(0)

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

    const result = await runChromeBootstrapHarness(source, 17, 0)
    expect(result.status).toBe(0)
    expect(result.calls).toBe(2)
    expect(result.trace).toBe("evidence:first\nreset\n")
  })

  test("diagnostic parser failure still reaches the one allowed retry", async () => {
    const source = await readFile(laneScript, "utf8")
    const evidenceFailure = await runChromeBootstrapHarness(source, 17, 0, "fail")
    expect(evidenceFailure.status).toBe(0)
    expect(evidenceFailure.calls).toBe(2)
    expect(evidenceFailure.trace).toBe("evidence:first\nreset\n")

    const resetFailure = await runChromeBootstrapHarness(source, 17, 0, "pass", "fail")
    expect(resetFailure.status).toBe(17)
    expect(resetFailure.calls).toBe(1)
    expect(resetFailure.trace).toBe("evidence:first\nreset\nfull-evidence\n")
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

    const result = await runChromeBootstrapHarness(source, 17, 23)
    expect(result.status).toBe(23)
    expect(result.calls).toBe(2)
    expect(result.trace).toBe("evidence:first\nreset\nevidence:second\nfull-evidence\n")
  })

  test("captures and parses verbatim current Android foreground output", async () => {
    const source = await readFile(laneScript, "utf8")
    const fixture = await androidEvidenceFixture(
      `WINDOW MANAGER DISPLAY CONTENTS (dumpsys window displays)
  Display: mDisplayId=0
    mCurrentFocus=Window{9b77ef8 u0 com.android.chrome/com.google.android.apps.chrome.Main}
`,
      `ACTIVITY MANAGER ACTIVITIES (dumpsys activity activities)
Display #0 (activities from top to bottom):
  * Hist  #0: ActivityRecord{e53f100 u0 com.google.android.apps.nexuslauncher/.NexusLauncherActivity t1}
  ResumedActivity: ActivityRecord{f16e297 u0 com.android.chrome/com.google.android.apps.chrome.Main t9}
`,
      "ActivityTaskManager: unrelated bounded logcat line\n",
    )
    const result = await runFunction(
      source,
      ["write_chrome_bootstrap_report", "capture_chrome_bootstrap_failure_evidence"],
      'timeout() { shift; "$@"; }; PATH="$1:$PATH"; artifacts="$1/artifacts"; mkdir -p "$artifacts"; adb_serial=emulator-5580; chrome_package=com.android.chrome; capture_chrome_bootstrap_failure_evidence 1 first 2>"$1/capture.stderr"',
      [fixture],
    )

    expect(result.status, JSON.stringify(result)).toBe(0)
    expect(await readFile(join(fixture, "commands.txt"), "utf8")).toBe(
      "-s emulator-5580 shell dumpsys window\n" +
        "-s emulator-5580 shell dumpsys activity activities\n" +
        "-s emulator-5580 logcat -d -t 1000\n",
    )
    const report = await readFile(
      join(fixture, "artifacts/chrome-bootstrap-attempt-1-first-classification.txt"),
      "utf8",
    )
    expect(report).toContain(
      "classification=chrome_remained_foreground_without_device_fault_evidence",
    )
    expect(report).toContain(
      "resumed_activity=  ResumedActivity: ActivityRecord{f16e297 u0 com.android.chrome/com.google.android.apps.chrome.Main t9}",
    )
  })

  test("writes a diagnostic sentinel and continues when current focus capture is incomplete", async () => {
    const source = await readFile(laneScript, "utf8")
    const brokenSource = source.replace(
      'shell dumpsys window >"$focus_log"',
      'shell dumpsys window windows >"$focus_log"',
    )
    expect(brokenSource).not.toBe(source)
    const fixture = await androidEvidenceFixture(
      "WINDOW MANAGER DISPLAY CONTENTS (dumpsys window displays)\n  mCurrentFocus=Window{9b77ef8 u0 com.android.chrome/com.google.android.apps.chrome.Main}\n",
      "  ResumedActivity: ActivityRecord{f16e297 u0 com.android.chrome/com.google.android.apps.chrome.Main t9}\n",
      "unrelated line\n",
    )
    const result = await runFunction(
      brokenSource,
      ["write_chrome_bootstrap_report", "capture_chrome_bootstrap_failure_evidence"],
      'timeout() { shift; "$@"; }; PATH="$1:$PATH"; artifacts="$1/artifacts"; mkdir -p "$artifacts"; adb_serial=emulator-5580; chrome_package=com.android.chrome; capture_chrome_bootstrap_failure_evidence 1 first 2>"$1/capture.stderr"',
      [fixture],
    )

    expect(result.status).toBe(0)
    expect(await readFile(join(fixture, "capture.stderr"), "utf8")).toContain(
      "current focus was absent",
    )
    expect(
      await readFile(
        join(fixture, "artifacts/chrome-bootstrap-attempt-1-first-classification.txt"),
        "utf8",
      ),
    ).toContain("diagnostic_failures=current_focus_absent,")
    expect(await readFile(join(fixture, "commands.txt"), "utf8")).toBe(
      "-s emulator-5580 shell dumpsys window windows\n" +
        "-s emulator-5580 shell dumpsys activity activities\n" +
        "-s emulator-5580 logcat -d -t 1000\n",
    )
  })

  test("records the exact SystemUI ANR focus and launcher focused app", async () => {
    const source = await readFile(laneScript, "utf8")
    const fixture = await androidEvidenceFixture(
      "  mCurrentFocus=Window{af32e5a u0 Application Not Responding: com.android.systemui}\n",
      "  mFocusedApp=ActivityRecord{ecf0619 u0 com.google.android.apps.nexuslauncher/.NexusLauncherActivity t7}\n",
      "ActivityManager: unrelated line\n",
    )
    const result = await runFunction(
      source,
      ["write_chrome_bootstrap_report", "capture_chrome_bootstrap_failure_evidence"],
      'timeout() { shift; "$@"; }; PATH="$1:$PATH"; artifacts="$1/artifacts"; mkdir -p "$artifacts"; adb_serial=emulator-5580; chrome_package=com.android.chrome; capture_chrome_bootstrap_failure_evidence 1 first',
      [fixture],
    )

    expect(result.status, JSON.stringify(result)).toBe(0)
    const report = await readFile(
      join(fixture, "artifacts/chrome-bootstrap-attempt-1-first-classification.txt"),
      "utf8",
    )
    expect(report).toContain(
      "current_focus=  mCurrentFocus=Window{af32e5a u0 Application Not Responding: com.android.systemui}",
    )
    expect(report).toContain(
      "focused_app=  mFocusedApp=ActivityRecord{ecf0619 u0 com.google.android.apps.nexuslauncher/.NexusLauncherActivity t7}",
    )
    expect(report).toContain("classification=foreground_left_chrome_without_device_fault_evidence")
  })

  test("recovers an offline first bootstrap with SystemUI ANR evidence and one successful retry", async () => {
    const source = await readFile(laneScript, "utf8")
    const fixture = await androidEvidenceFixture(
      "  mCurrentFocus=Window{af32e5a u0 Application Not Responding: com.android.systemui}\n",
      "  mFocusedApp=ActivityRecord{ecf0619 u0 com.google.android.apps.nexuslauncher/.NexusLauncherActivity t7}\n",
      "ActivityManager: device transport recovered\n",
    )
    const result = await runFunction(
      source,
      [
        "write_chrome_bootstrap_report",
        "capture_chrome_bootstrap_failure_evidence",
        "run_chrome_bootstrap",
      ],
      `timeout() { shift; "$@"; }
PATH="$1:$PATH"
fixture_root="$1"
artifacts="$1/artifacts"
mkdir -p "$artifacts"
adb_serial=emulator-5580
chrome_package=com.android.chrome
emulator_log="$1/emulator.log"
: >"$emulator_log"
maestro() {
  calls=0
  [ ! -f "$fixture_root/bootstrap.calls" ] || calls="$(cat "$fixture_root/bootstrap.calls")"
  calls=$((calls + 1))
  printf '%s' "$calls" >"$fixture_root/bootstrap.calls"
  if [ "$calls" -eq 1 ]; then
    echo "DeviceServerDiedException: host:transport:emulator-5580 device offline"
    return 17
  fi
  return 0
}
reset_chrome_bootstrap() { echo "reconnected and reset" >>"$fixture_root/reset.trace"; return 0; }
capture_attempt_evidence() { return 0; }
if run_chrome_bootstrap 1; then
  status=0
else
  status=$?
fi
printf '%s' "$status" >"$fixture_root/bootstrap.status"
exit 0`,
      [fixture],
    )

    expect(result.status, JSON.stringify(result)).toBe(0)
    expect(await readFile(join(fixture, "bootstrap.status"), "utf8")).toBe("0")
    expect(await readFile(join(fixture, "bootstrap.calls"), "utf8")).toBe("2")
    expect(await readFile(join(fixture, "reset.trace"), "utf8")).toBe("reconnected and reset\n")
    expect(
      await readFile(
        join(fixture, "artifacts/chrome-bootstrap-attempt-1-first-classification.txt"),
        "utf8",
      ),
    ).toContain("Application Not Responding: com.android.systemui")
  })

  test("retries a non-transport bootstrap when reconnect finds no offline transport", async () => {
    const source = await readFile(laneScript, "utf8")
    const result = await runBootstrapResetHarness(source, 1)

    expect(result.status, JSON.stringify(result)).toBe(0)
    expect(result.calls).toBe(2)
    expect(result.reconnectEvidence).toBe("no offline transports\n")
    expect(result.trace).toContain("adb reconnect offline")
    expect(result.trace.match(/^stable$/gm)).toHaveLength(2)
    expect(result.trace).toContain("shell pm clear com.android.chrome")
  })

  test("accepts and exactly restores null, zero, and one hide-error-dialog states", async () => {
    const source = await readFile(laneScript, "utf8")
    for (const prior of ["null", "0", "1"] as const) {
      const success = await runHiddenDialogsHarness(source, prior, 0)
      expect(success.status, JSON.stringify(success)).toBe(0)
      expect(success.finalSetting).toBe(prior)
      expect(success.restoreRequired).toBe(false)
      expect(success.trace).toContain("settings put global hide_error_dialogs 1")
      expect(success.trace).toContain("am broadcast -a android.intent.action.CLOSE_SYSTEM_DIALOGS")
      expect(success.trace).toContain("bootstrap setting=1 dialog_open=0")
      if (prior === "null") {
        expect(success.trace).toContain("settings delete global hide_error_dialogs")
      } else {
        expect(success.trace).toContain(`settings put global hide_error_dialogs ${prior}`)
      }
      expect(success.trace.indexOf("bootstrap setting=1 dialog_open=0")).toBeLessThan(
        success.trace.indexOf(`observed setting=${prior}`),
      )
    }
  })

  test("restores the prior state on every hidden-dialog wrapper failure exit", async () => {
    const source = await readFile(laneScript, "utf8")
    const bootstrapFailure = await runHiddenDialogsHarness(source, "null", 23)
    expect(bootstrapFailure.status, JSON.stringify(bootstrapFailure)).toBe(23)
    expect(bootstrapFailure.finalSetting).toBe("null")
    expect(bootstrapFailure.restoreRequired).toBe(false)

    for (const failureMode of [
      "set-command",
      "enable-verify-command",
      "enable-verify-value",
      "close-command",
      "close-verify-command",
      "close-verify-value",
    ] as const) {
      const failure = await runHiddenDialogsHarness(source, "0", 0, failureMode)
      expect(failure.status).not.toBe(0)
      expect(failure.finalSetting).toBe("0")
      expect(failure.trace).toContain("settings put global hide_error_dialogs 0")
      expect(failure.trace).not.toContain("bootstrap setting=")
    }

    const readFailure = await runHiddenDialogsHarness(source, "0", 0, "read-command")
    expect(readFailure.status).not.toBe(0)
    expect(readFailure.finalSetting).toBe("0")
    expect(readFailure.restoreRequired).toBe(false)
    expect(readFailure.trace).not.toContain("settings put global hide_error_dialogs 1")
    expect(readFailure.trace).not.toContain("bootstrap setting=")

    const invalid = await runHiddenDialogsHarness(source, "invalid", 0)
    expect(invalid.status).not.toBe(0)
    expect(invalid.finalSetting).toBe("invalid")
    expect(invalid.restoreRequired).toBe(false)
    expect(invalid.trace).not.toContain("settings put global hide_error_dialogs 1")
    expect(invalid.trace).not.toContain("bootstrap setting=")
  })

  test("fails closed on restore and delete failures and retries restoration during cleanup", async () => {
    const source = await readFile(laneScript, "utf8")
    for (const [prior, failureMode] of [
      ["null", "restore-command"],
      ["0", "restore-command"],
      ["1", "restore-verify-command"],
      ["0", "restore-verify-value"],
    ] as const) {
      const failure = await runHiddenDialogsHarness(source, prior, 0, failureMode)
      expect(failure.status).not.toBe(0)
      expect(failure.restoreRequired).toBe(true)
      expect(failure.trace).toContain("wrapper_restore_required=1")
    }

    const cleanupRetry = await runHiddenDialogsHarness(source, "null", 0, "restore-command-once")
    expect(cleanupRetry.status).not.toBe(0)
    expect(cleanupRetry.finalSetting).toBe("null")
    expect(cleanupRetry.restoreRequired).toBe(false)
    expect(cleanupRetry.trace.match(/settings delete global hide_error_dialogs/g)).toHaveLength(2)
  })

  test("classifies launcher foreground after a background Chrome restart from focus evidence", async () => {
    const source = await readFile(laneScript, "utf8")
    const focus = await fixtureFile(
      "launcher-focus.txt",
      "  mCurrentFocus=Window{21be88f u0 com.google.android.apps.nexuslauncher/com.google.android.apps.nexuslauncher.NexusLauncherActivity}\n",
    )
    const activity = await fixtureFile(
      "launcher-activity.txt",
      "  ResumedActivity: ActivityRecord{56eb186 u0 com.google.android.apps.nexuslauncher/.NexusLauncherActivity t1}\n",
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
      "  mCurrentFocus=Window{9b77ef8 u0 com.android.chrome/com.google.android.apps.chrome.Main}\n",
    )
    const activity = await fixtureFile(
      "chrome-activity.txt",
      "  ResumedActivity: ActivityRecord{f16e297 u0 com.android.chrome/com.google.android.apps.chrome.Main t9}\n",
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
          '  capture_chrome_bootstrap_failure_evidence "$attempt" "second"',
          '  maestro --device "$adb_serial" test\n  capture_chrome_bootstrap_failure_evidence "$attempt" "second"',
        ),
      ),
    ).toThrow(/exactly two/)
    expect(() =>
      assertChromeBootstrapContract(
        source.replace(
          '"$artifacts/maestro-junit-attempt-1.xml"; then',
          '"$artifacts/maestro-attempt-1.log"; then',
        ),
      ),
    ).toThrow(/transport-only/)
    expect(() =>
      assertChromeBootstrapContract(source.replace("mCurrentFocus=", "pidof com.android.chrome")),
    ).toThrow(/foreground focus, not pidof/)
    expect(() =>
      assertChromeBootstrapContract(
        source.replace(
          '  capture_chrome_bootstrap_failure_evidence "$attempt" "first" || true',
          '  capture_chrome_bootstrap_failure_evidence "$attempt" "first" || return "$bootstrap_status"',
        ),
      ),
    ).toThrow(/diagnostics must not control/)
    expect(() =>
      assertChromeBootstrapContract(
        source.replaceAll('  if ! restore_hide_error_dialogs "$attempt"; then', "  if false; then"),
      ),
    ).toThrow(/restore hidden error dialogs/)
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
      [
        "is_adb_transport_failure",
        "is_maestro_attempt_transport_failure",
        "should_retry_transport_failure",
      ],
      'should_retry_transport_failure "$1" "$2" "$3"',
      ["2", log, `${log}.missing-junit`],
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
