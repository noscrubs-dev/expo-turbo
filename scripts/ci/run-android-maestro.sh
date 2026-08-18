#!/usr/bin/env bash

set -euo pipefail

if [ "$(id -u)" -eq 0 ]; then
  echo "Android device conformance must not run as root." >&2
  exit 1
fi

if sudo -n true 2>/dev/null; then
  echo "The CI account must not have passwordless sudo." >&2
  exit 1
fi

if [ ! -r /dev/kvm ] || [ ! -w /dev/kvm ]; then
  echo "The CI account needs read/write access to /dev/kvm through the kvm group." >&2
  exit 1
fi

export ANDROID_HOME="${ANDROID_HOME:-$HOME/android-sdk}"
export ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-$ANDROID_HOME}"
export JAVA_HOME="${JAVA_HOME:-/usr/lib/jvm/java-21-openjdk-amd64}"
export PATH="$HOME/.local/bin:$HOME/.bun/bin:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"
export BUNDLE_GEMFILE="$PWD/example/rails/Gemfile"
export BUNDLE_PATH="$HOME/.cache/bundle/expo-turbo"
export GEM_HOME="$(ruby -e 'print Gem.user_dir')"
export NODE_ENV=production
export REDIS_URL="redis://127.0.0.1:6379/15"
export MAESTRO_CLI_NO_ANALYTICS=1
export MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED=true
export PATH="$GEM_HOME/bin:$PATH"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly script_dir
source "$script_dir/stop-process.sh"

# The last preflight guard, and the one reason it sits below the exports rather
# than beside the guards above: maestro resolves through the PATH they set. It
# still runs before any install, build, emulator, Rails, or suite work, so a
# runner whose Maestro drifted from the pin fails in seconds with an
# expected/actual message instead of quietly changing what the flows mean.
# The resolved version is kept for the run's environment evidence.
maestro_version="$("$script_dir/check-maestro-version.sh")"
readonly maestro_version

readonly adb_serial="emulator-5580"
readonly avd_name="expo-turbo-api35"
readonly rails_origin="http://127.0.0.1:3001"
readonly artifacts="$PWD/artifacts/android-device"
readonly rails_log="$artifacts/rails.log"
readonly emulator_log="$artifacts/emulator.log"
readonly resource_log="$artifacts/resources.log"
readonly reverse_response_log="$artifacts/reverse-probe-response.txt"
readonly reverse_probe_err_log="$artifacts/reverse-probe-stderr.txt"
readonly reverse_listeners_log="$artifacts/reverse-probe-listeners.txt"
readonly reverse_binding_log="$artifacts/reverse-probe-binding.txt"
readonly reverse_attempt_log="$artifacts/reverse-probe-attempt.txt"
readonly ss_missing_marker="(ss is not installed here - listener state unknown)"
readonly chrome_package="com.android.chrome"
readonly maestro_flow_path="${MAESTRO_FLOW_PATH:-.maestro}"
readonly adb_transport_pattern="^[[:space:]]*((Caused by: )?([[:alnum:]_.-]+\.)?DeviceServerDiedException([:[:space:]].*)?|(adb: |error: )?device offline|(adb: |error: )?host:transport:[^[:space:]]*offline.*|(adb: |error: )?device '[^']+' not found)[[:space:]]*$"

is_adb_transport_failure() {
  local log="$1"

  # These messages come from ADB or Maestro's device server. Do not include
  # selector timeouts, assertions, application crashes, or generic exceptions:
  # those are product/test failures and must remain failures.
  grep -Eq "$adb_transport_pattern" "$log"
}

should_retry_transport_failure() {
  local attempt="$1"
  local log="$2"

  [ "$attempt" -eq 1 ] && is_adb_transport_failure "$log"
}

process_identity() {
  local pid="$1"

  ps -o ppid= -o lstart= -p "$pid" 2>/dev/null | awk '{$1=$1; print}'
}

file_identity() {
  local path="$1"

  stat --format='%d:%i' "$path" 2>/dev/null
}

is_valid_process_identity() {
  local identity="$1"

  [[ "$identity" =~ ^[0-9]+[[:space:]].*[[:space:]][0-9]{4}$ ]]
}

is_valid_file_identity() {
  local identity="$1"

  [[ "$identity" =~ ^[0-9]+:[1-9][0-9]*$ ]]
}

initialize_maestro_run_log() {
  local run_log="$1"
  local stream_marker="$2"

  : >"$run_log"
  printf '%s\n' "$stream_marker" >>"$run_log"
}

write_monitor_startup_failure() {
  local artifact="$1"
  local diagnostic="$2"
  local unproven_pid="$3"
  local process_value="$4"
  local file_value="$5"

  {
    echo "state=monitor_startup_failed"
    echo "diagnostic=$diagnostic"
    echo "unproven_pid=$unproven_pid"
    echo "process_identity=$process_value"
    echo "file_identity=$file_value"
    echo "action=fail closed without signalling an unproven PID"
    echo "final_cleanup=trusted entry supervisor group sweep"
  } >"$artifact"
  echo "$diagnostic: live Maestro transport monitoring could not start; failing closed." >&2
}

record_monitor_safety_failure() {
  local artifact="$1"
  local attempt="$2"
  local state="$3"
  local diagnostic="$4"
  local detail="$5"

  {
    echo "attempt=$attempt"
    echo "state=$state"
    echo "diagnostic=$diagnostic"
    echo "$detail"
    echo "action=do not signal the Maestro PID; fail the suite closed"
  } >"$artifact"
  echo "$diagnostic: live Maestro transport proof failed; no process was signalled." >&2
}

drain_log_stream() {
  local pid="$1"
  local checks="$2"
  local poll_interval="$3"
  local _
  local process_state=""

  for _ in $(seq 1 "$checks"); do
    process_state="$(ps -o stat= -p "$pid" 2>/dev/null || true)"
    if ! kill -0 "$pid" 2>/dev/null || [[ "$process_state" == *Z* ]]; then
      wait "$pid" 2>/dev/null || true
      return 0
    fi
    sleep "$poll_interval"
  done

  return 1
}

run_named_adb_command() {
  local output="$1"
  local timeout_seconds="$2"
  shift 2
  local status=0

  timeout "$timeout_seconds" "$@" >"$output" 2>&1 || status=$?

  if [ "$status" -eq 0 ]; then
    return 0
  fi

  printf 'Pre-suite ADB command failed (exit %s):' "$status" >&2
  printf ' %q' "$@" >&2
  printf '\nSaved command output: %s\n' "$output" >&2
  cat "$output" >&2
  return "$status"
}

wait_for_stable_device() {
  local consecutive_checks=0

  for _ in $(seq 1 60); do
    if [ "$(timeout 5 adb -s "$adb_serial" get-state 2>/dev/null)" = "device" ] &&
      timeout 5 adb -s "$adb_serial" shell true >/dev/null 2>&1; then
      consecutive_checks=$((consecutive_checks + 1))
      if [ "$consecutive_checks" -eq 3 ]; then
        return
      fi
    else
      consecutive_checks=0
      timeout 10 adb reconnect offline >/dev/null 2>&1 || true
    fi
    sleep 2
  done

  echo "Android emulator did not maintain a stable ADB connection." >&2
  return 1
}

probe_host_reach() {
  # Makes exactly one request. Prints either the HTTP status or an unreachable
  # description - never both, and never the two concatenated. Returns non-zero
  # when Rails is not serving, matching what curl --fail used to decide.
  local code=""
  local status=0

  set +e
  code="$(curl --silent --max-time 5 -o /dev/null \
    -w '%{http_code}' "$rails_origin/up" 2>/dev/null)"
  status=$?
  set -e

  if [ "$status" -ne 0 ] || [ -z "$code" ] || [ "$code" = "000" ]; then
    echo "unreachable (curl exit ${status}, http_code ${code:-none})"
    return 1
  fi

  echo "$code"
  case "$code" in
  [123]??) return 0 ;;
  *) return 1 ;;
  esac
}

capture_reverse_evidence() {
  if command -v ss >/dev/null 2>&1; then
    ss -ltn >"$reverse_listeners_log" 2>&1 || true
  else
    echo "$ss_missing_marker" >"$reverse_listeners_log"
  fi

  timeout 15 adb -s "$adb_serial" reverse --list >"$reverse_binding_log" 2>&1 || true
}

describe_empty_probe() {
  local status="$1"

  if grep -qiE 'device .*(offline|not found|unauthorized)|^error:|^adb: ' \
    "$reverse_probe_err_log" 2>/dev/null; then
    echo "NO RESPONSE - zero bytes, and adb reported a transport error (see probe stderr below). ADB/device fault, not a Rails fault."
    return
  fi

  case "$status" in
  124)
    echo "NO RESPONSE - zero bytes because the probe hit its 15s timeout. Nothing came back in time."
    ;;
  127)
    echo "NO RESPONSE - zero bytes and the device reported command-not-found (127); 'toybox nc' is missing or not executable on this image."
    ;;
  0)
    echo "NO RESPONSE - zero bytes with a clean exit. CAUSE UNDETERMINED. Candidates: the adb shell session closed on host stdin EOF before nc delivered the request (the fault 47ae723 shipped), an adb transport drop that adb did not report, or Rails accepting the connection and closing it without replying. Use the probe stderr and Rails log below to tell them apart."
    ;;
  *)
    echo "NO RESPONSE - zero bytes and the device command exited ${status}. CAUSE UNDETERMINED. Candidates: nc failing on the device, adb transport loss, or the shell session closing early. Use the probe stderr below to tell them apart."
    ;;
  esac
}

report_rails_reverse_failure() {
  local reason="$1"

  # Runs in a subshell with errexit off so a failure inside the report can never
  # truncate it. Everything below was recorded during the failing attempt and is
  # only replayed here; nothing is measured again at report time, so the report
  # cannot contradict itself if the host recovers in between.
  (
    set +e
    echo "Android could not reach Rails through the ADB reverse tunnel."
    echo "Which check failed: $reason"
    echo
    echo "--- host listeners (ss -ltn), at the failing attempt ---"
    if grep -qF "$ss_missing_marker" "$reverse_listeners_log"; then
      cat "$reverse_listeners_log"
    else
      grep -E 'State|:3001' "$reverse_listeners_log"
      if ! grep -q ':3001' "$reverse_listeners_log"; then
        echo "(ss ran and found no listener on 3001)"
      fi
    fi
    echo "--- host reach of Rails, from this attempt's own host check ---"
    if [ -s "$reverse_attempt_log" ]; then
      cat "$reverse_attempt_log"
    else
      echo "(not captured)"
    fi
    echo "--- adb reverse --list, at the failing attempt ---"
    if [ -s "$reverse_binding_log" ]; then
      cat "$reverse_binding_log"
    else
      echo "(no binding listed)"
    fi
    echo "--- device response, first 512 raw bytes (od -c -N 512) ---"
    if [ -s "$reverse_response_log" ]; then
      od -c -N 512 "$reverse_response_log"
      echo "(total response size: $(wc -c <"$reverse_response_log" 2>/dev/null) bytes)"
    else
      echo "(ZERO BYTES - the device sent nothing back)"
    fi
    echo "--- device probe stderr ---"
    if [ -s "$reverse_probe_err_log" ]; then
      cat "$reverse_probe_err_log"
    else
      echo "(empty)"
    fi
    echo "--- tail -20 $rails_log ---"
    tail -20 "$rails_log" 2>/dev/null || echo "(no Rails log)"
  ) >&2
}

prepare_rails_reverse() {
  local reason="the probe never ran"
  local first_line=""
  local ok_status='^HTTP/[0-9.]+ 200 '
  local attempt=0
  local probe_status=0
  local host_reach=""
  local host_reach_ok=0

  for attempt in 1 2; do
    : >"$reverse_response_log"
    : >"$reverse_probe_err_log"
    : >"$reverse_binding_log"

    # One request per attempt. Its result is both the gate and the evidence
    # reported later, so nothing re-queries Rails after the failure.
    set +e
    host_reach="$(probe_host_reach)"
    host_reach_ok=$?
    set -e

    {
      echo "attempt=$attempt"
      echo "host_curl_http_code=$host_reach"
    } >"$reverse_attempt_log" 2>&1

    if [ "$host_reach_ok" -ne 0 ]; then
      reason="HOST CHECK FAILED - the host's own request to $rails_origin/up did not succeed (${host_reach}), so the tunnel has nothing healthy to forward to."
      capture_reverse_evidence
      sleep 2
      continue
    fi

    timeout 15 adb -s "$adb_serial" reverse --remove tcp:3001 >/dev/null 2>&1 || true
    if ! timeout 15 adb -s "$adb_serial" reverse tcp:3001 tcp:3001 >/dev/null 2>&1; then
      reason="REVERSE BINDING ABSENT - 'adb reverse tcp:3001 tcp:3001' did not bind."
      capture_reverse_evidence
      sleep 2
      continue
    fi

    timeout 15 adb -s "$adb_serial" reverse --list >"$reverse_binding_log" 2>&1 || true
    if ! grep -q 'tcp:3001 tcp:3001' "$reverse_binding_log"; then
      reason="REVERSE BINDING ABSENT - the bind call succeeded but 'adb reverse --list' does not show tcp:3001."
      capture_reverse_evidence
      sleep 2
      continue
    fi

    # stdin must stay open past the request. adb tears the shell session down as
    # soon as host stdin hits EOF, which kills nc before it delivers the request
    # and yields zero bytes back with the tunnel perfectly healthy.
    set +e
    { printf 'GET /up HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n'; sleep 2; } |
      timeout 15 adb -s "$adb_serial" shell 'toybox nc -w 5 127.0.0.1 3001' \
        >"$reverse_response_log" 2>"$reverse_probe_err_log"
    probe_status="${PIPESTATUS[1]}"
    set -e

    if [ ! -s "$reverse_response_log" ]; then
      reason="$(describe_empty_probe "$probe_status")"
      capture_reverse_evidence
      sleep 2
      continue
    fi

    IFS= read -r first_line <"$reverse_response_log" || true
    first_line="${first_line%$'\r'}"

    if [[ "$first_line" =~ $ok_status ]]; then
      return
    fi

    reason="NON-200 FROM RAILS - the device reached Rails but the status line was: ${first_line}"
    capture_reverse_evidence
    sleep 2
  done

  report_rails_reverse_failure "$reason"
  return 1
}

mkdir -p "$artifacts"
: >"$rails_log"
: >"$emulator_log"
: >"$resource_log"

rails_pid=""
emulator_pid=""
sampler_pid=""
maestro_pid=""
maestro_log_stream_pid=""
maestro_transport_monitor_pid=""
hide_error_dialogs_prior_value=""
hide_error_dialogs_restore_required=0

cleanup() {
  local status=$?
  trap - EXIT

  # Tell the supervisor that its first cancellation signal reached the EXIT
  # cleanup. The private inherited pipe lets the supervisor use the derived
  # cleanup budget instead of sending a second TERM after one second.
  if [[ "${ANDROID_MAESTRO_CLEANUP_FD:-}" =~ ^[0-9]+$ ]]; then
    printf "C" 2>/dev/null >&"$ANDROID_MAESTRO_CLEANUP_FD" || true
  fi

  if [ "${hide_error_dialogs_restore_required:-0}" -eq 1 ] &&
    declare -F restore_hide_error_dialogs >/dev/null; then
    restore_hide_error_dialogs "cleanup" || status=1
  fi

  timeout 15 adb -s "$adb_serial" logcat -d >"$artifacts/logcat.txt" 2>&1 || true
  stop_process "$rails_pid" "Rails" 50 50 0.1
  rails_pid=""
  timeout 15 adb -s "$adb_serial" emu kill >/dev/null 2>&1 || true

  stop_process "$sampler_pid" "resource sampler" 50 50 0.1
  stop_process "$emulator_pid" "Android emulator" 50 50 0.1

  # Evidence is optional. A missing runner utility or a failed evidence write
  # must not replace the suite result captured above.
  set +e
  {
    commit=""
    commit="$(git rev-parse HEAD)"
    echo "exit_status=$status"
    echo "commit=$commit"
    echo "runner=$(hostname)"
    echo "user=$(id)"
    echo "bun=$(bun --version)"
    echo "ruby=$(ruby --version)"
    echo "java=$(java -version 2>&1 | head -1)"
    # The version preflight asserted, not a second reading taken after the
    # suite, so the evidence names the Maestro the run actually used.
    echo "maestro=$maestro_version"
    echo "emulator=$(grep '^Pkg.Revision=' "$ANDROID_HOME/emulator/source.properties")"
    if command -v df >/dev/null 2>&1; then
      df -h / || echo "disk=(df failed)"
    else
      echo "disk=(df is not installed)"
    fi
    if command -v free >/dev/null 2>&1; then
      free -h || echo "memory=(free failed)"
    else
      echo "memory=(free is not installed)"
    fi
    echo "evidence_complete=true"
  } >"$artifacts/environment.txt"
  set -e

  exit "$status"
}

handle_interrupt() {
  trap - INT TERM
  exit 130
}

handle_terminate() {
  trap - INT TERM
  exit 143
}

# Signals must choose their own conventional status before EXIT runs cleanup.
# Reading $? in a multi-signal trap can see the last successful command, which
# would record a cancellation as a successful Android conformance run.
trap cleanup EXIT
trap handle_interrupt INT
trap handle_terminate TERM

sample_top_processes() {
  local ps_status

  # awk reads the whole ps stream. Unlike head, it does not close the pipe
  # after row 20 and make a large ps report exit with SIGPIPE under pipefail.
  # Keep a real ps failure as evidence, but do not let optional sampling stop
  # the Android lane.
  set +e
  ps -eo pid,ppid,rss,%cpu,comm,args --sort=-rss | awk 'NR <= 20'
  ps_status="${PIPESTATUS[0]}"
  set -e

  if [ "$ps_status" -ne 0 ]; then
    echo "WARNING: resource sampler: ps exited ${ps_status}; continuing." >&2
  fi
}

(
  while true; do
    date --iso-8601=seconds
    free -m
    df -m /
    sample_top_processes
    sleep 10
  done
) >>"$resource_log" 2>&1 &
sampler_pid=$!

bun install --frozen-lockfile
bun run build

adb kill-server >/dev/null 2>&1 || true
if adb -s "$adb_serial" get-state >/dev/null 2>&1; then
  adb -s "$adb_serial" emu kill >/dev/null 2>&1 || true
  for _ in $(seq 1 30); do
    if ! adb -s "$adb_serial" get-state >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
fi

(
  cd example/expo
  bun install --frozen-lockfile
  bun x expo prebuild --platform android --no-install --clean
)

gem install --user-install bundler --version 2.7.2 --no-document
(
  cd example/rails
  bundle install
  export PORT=3001 RAILS_ENV=development
  exec bundle exec rails server -b 127.0.0.1
) >"$rails_log" 2>&1 &
rails_pid=$!

for _ in $(seq 1 60); do
  if curl --fail --silent --show-error --max-time 1 "$rails_origin/up" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$rails_pid" 2>/dev/null; then
    echo "Rails exited before readiness." >&2
    exit 1
  fi
  sleep 1
done
curl --fail --silent --show-error --max-time 2 "$rails_origin/up" >/dev/null

(
  cd example/expo/android
  EXPO_PUBLIC_EXPO_TURBO_DEMO_ORIGIN="$rails_origin" \
    ./gradlew --no-daemon -PreactNativeArchitectures=x86_64 app:assembleRelease
)

readonly apk="$PWD/example/expo/android/app/build/outputs/apk/release/app-release.apk"
test -f "$apk"

readonly picker_fixture="$PWD/.maestro/fixtures/expo-turbo-android-picked.txt"
test -f "$picker_fixture"

write_chrome_bootstrap_report() {
  local focus_log="$1"
  local activity_log="$2"
  local relevant_logcat="$3"
  local report="$4"
  local current_focus=""
  local focused_app=""
  local resumed_activity=""
  local foreground="not_chrome"
  local device_fault="not_found"
  local classification=""

  current_focus="$(grep -Em1 '^[[:space:]]*mCurrentFocus=' "$focus_log" || true)"
  focused_app="$(grep -Em1 \
    '^[[:space:]]*mFocusedApp=ActivityRecord' \
    "$activity_log" || true)"
  resumed_activity="$(grep -Em1 \
    '^[[:space:]]*(mResumedActivity|ResumedActivity): ActivityRecord[^[:space:]]+[[:space:]]+u[0-9]+[[:space:]]+[[:alnum:]_.]+/[[:alnum:]_.$]+' \
    "$activity_log" || true)"

  if printf '%s\n%s\n%s\n' "$current_focus" "$focused_app" "$resumed_activity" |
    grep -qF "$chrome_package"; then
    foreground="chrome"
  fi
  if grep -Eqi \
    'ANR in .*gms|gms\.persistent.*ANR|Killing [0-9]+:com\.android\.chrome|GmsModuleProvider|Force removing ActivityRecord.*FirstRunActivity' \
    "$relevant_logcat"; then
    device_fault="found"
  fi

  if [ "$foreground" = "chrome" ] && [ "$device_fault" = "not_found" ]; then
    classification="chrome_remained_foreground_without_device_fault_evidence"
  elif [ "$foreground" = "chrome" ]; then
    classification="chrome_remained_foreground_with_device_fault_evidence"
  elif [ "$device_fault" = "found" ]; then
    classification="foreground_left_chrome_with_device_fault_evidence"
  else
    classification="foreground_left_chrome_without_device_fault_evidence"
  fi

  {
    echo "classification=$classification"
    echo "foreground=$foreground"
    echo "device_fault_evidence=$device_fault"
    echo "current_focus=$current_focus"
    echo "focused_app=${focused_app:-not captured by dumpsys}"
    echo "resumed_activity=${resumed_activity:-not captured by dumpsys}"
    echo "process_liveness=not used; a background Chrome process does not establish foreground state"
    echo "relevant_logcat_begin"
    if [ -s "$relevant_logcat" ]; then
      cat "$relevant_logcat"
    else
      echo "(no Chrome death or GMS ANR evidence in the bounded logcat window)"
    fi
    echo "relevant_logcat_end"
  } >"$report"
}

capture_chrome_bootstrap_failure_evidence() {
  (
    set +e
    local attempt="$1"
    local invocation="$2"
    local prefix="$artifacts/chrome-bootstrap-attempt-$attempt-$invocation"
    local focus_log="$prefix-focus.txt"
    local activity_log="$prefix-activity.txt"
    local logcat_log="$prefix-logcat.txt"
    local relevant_logcat="$prefix-relevant-logcat.txt"
    local report="$prefix-classification.txt"
    local diagnostic_failures=""

  if ! timeout 15 adb -s "$adb_serial" shell dumpsys window >"$focus_log" 2>&1; then
    echo "Chrome bootstrap evidence failed: could not capture current focus." >&2
    diagnostic_failures="${diagnostic_failures}window_probe_failed,"
  fi
  if ! grep -Eq '^[[:space:]]*mCurrentFocus=' "$focus_log"; then
    echo "Chrome bootstrap evidence failed: current focus was absent." >&2
    diagnostic_failures="${diagnostic_failures}current_focus_absent,"
  fi
  if ! timeout 15 adb -s "$adb_serial" shell dumpsys activity activities \
    >"$activity_log" 2>&1; then
    echo "Chrome bootstrap evidence failed: could not capture foreground activity." >&2
    diagnostic_failures="${diagnostic_failures}activity_probe_failed,"
  fi
  if ! timeout 15 adb -s "$adb_serial" logcat -d -t 1000 >"$logcat_log" 2>&1; then
    echo "Chrome bootstrap evidence failed: could not capture bounded logcat." >&2
    diagnostic_failures="${diagnostic_failures}logcat_probe_failed,"
  fi
  awk 'BEGIN { IGNORECASE=1 }
    /ANR in .*gms|gms\.persistent.*ANR|Killing [0-9]+:com\.android\.chrome|GmsModuleProvider|Force removing ActivityRecord.*FirstRunActivity/' \
    "$logcat_log" >"$relevant_logcat"
  if ! write_chrome_bootstrap_report \
    "$focus_log" "$activity_log" "$relevant_logcat" "$report"; then
    diagnostic_failures="${diagnostic_failures}report_parser_failed,"
    {
      echo "classification=diagnostic_capture_failed"
      echo "diagnostic_failures=$diagnostic_failures"
      echo "authority=diagnostic only; recovery continues"
    } >"$report"
  elif [ -n "$diagnostic_failures" ]; then
    {
      echo "diagnostic_failures=$diagnostic_failures"
      echo "authority=diagnostic only; recovery continues"
    } >>"$report"
  fi
  cat "$report" >&2
  exit 0
  ) || true
  return 0
}

enable_hide_error_dialogs() {
  local attempt="$1"
  local read_log="$artifacts/hide-error-dialogs-attempt-$attempt-read.txt"
  local set_log="$artifacts/hide-error-dialogs-attempt-$attempt-set.txt"
  local verify_log="$artifacts/hide-error-dialogs-attempt-$attempt-verify.txt"

  if ! run_named_adb_command "$read_log" 15 \
    adb -s "$adb_serial" shell settings get global hide_error_dialogs; then
    echo "Android hide_error_dialogs is not readable on the pinned image." >&2
    return 1
  fi
  hide_error_dialogs_prior_value="$(tr -d '\r\n' <"$read_log")"
  if [[ ! "$hide_error_dialogs_prior_value" =~ ^(null|0|1)$ ]]; then
    echo "Android hide_error_dialogs returned an unsafe prior value." >&2
    return 1
  fi

  hide_error_dialogs_restore_required=1
  if ! run_named_adb_command "$set_log" 15 \
    adb -s "$adb_serial" shell settings put global hide_error_dialogs 1; then
    return 1
  fi
  if ! run_named_adb_command "$verify_log" 15 \
    adb -s "$adb_serial" shell settings get global hide_error_dialogs; then
    return 1
  fi
  if [ "$(tr -d '\r\n' <"$verify_log")" != "1" ]; then
    echo "Android hide_error_dialogs could not be verified as enabled." >&2
    return 1
  fi
}

restore_hide_error_dialogs() {
  local attempt="$1"
  local restore_log="$artifacts/hide-error-dialogs-attempt-$attempt-restore.txt"
  local verify_log="$artifacts/hide-error-dialogs-attempt-$attempt-restored.txt"

  if [ "$hide_error_dialogs_restore_required" -ne 1 ]; then
    return 0
  fi
  if [[ ! "$hide_error_dialogs_prior_value" =~ ^(null|0|1)$ ]]; then
    echo "Android hide_error_dialogs prior value is not safe to restore." >&2
    return 1
  fi
  if [ "$hide_error_dialogs_prior_value" = "null" ]; then
    if ! run_named_adb_command "$restore_log" 15 \
      adb -s "$adb_serial" shell settings delete global hide_error_dialogs; then
      return 1
    fi
  else
    if ! run_named_adb_command "$restore_log" 15 \
      adb -s "$adb_serial" shell settings put global hide_error_dialogs \
      "$hide_error_dialogs_prior_value"; then
      return 1
    fi
  fi
  if ! run_named_adb_command "$verify_log" 15 \
    adb -s "$adb_serial" shell settings get global hide_error_dialogs; then
    return 1
  fi
  if [ "$(tr -d '\r\n' <"$verify_log")" != "$hide_error_dialogs_prior_value" ]; then
    echo "Android hide_error_dialogs was not restored to its prior value." >&2
    return 1
  fi
  hide_error_dialogs_restore_required=0
}

reset_chrome_bootstrap() {
  local attempt="$1"
  local package_log="$artifacts/chrome-bootstrap-attempt-$attempt-package.txt"
  local clear_log="$artifacts/chrome-bootstrap-attempt-$attempt-clear.txt"

  run_named_adb_command \
    "$artifacts/chrome-bootstrap-attempt-$attempt-reconnect-offline.txt" 10 \
    adb reconnect offline || true
  if ! wait_for_stable_device; then
    return 1
  fi
  if ! run_named_adb_command "$package_log" 15 \
    adb -s "$adb_serial" shell pm path "$chrome_package"; then
    return 1
  fi
  if ! grep -Eq '^package:.+\.apk\r?$' "$package_log"; then
    echo "Chrome bootstrap recovery refused to clear an unvalidated package." >&2
    return 1
  fi
  if ! run_named_adb_command "$clear_log" 30 \
    adb -s "$adb_serial" shell pm clear "$chrome_package"; then
    return 1
  fi
  if ! grep -Eq '^Success\r?$' "$clear_log"; then
    echo "Chrome bootstrap recovery did not confirm a successful package reset." >&2
    return 1
  fi
  if ! wait_for_stable_device; then
    return 1
  fi
}

run_chrome_bootstrap() {
  local attempt="$1"
  local bootstrap_output="$artifacts/maestro-tests-bootstrap-attempt-$attempt"
  local bootstrap_debug="$artifacts/maestro-debug-bootstrap-attempt-$attempt"
  local bootstrap_log="$artifacts/maestro-bootstrap-attempt-$attempt.log"
  local bootstrap_retry_output="$artifacts/maestro-tests-bootstrap-attempt-$attempt-retry"
  local bootstrap_retry_debug="$artifacts/maestro-debug-bootstrap-attempt-$attempt-retry"
  local bootstrap_retry_log="$artifacts/maestro-bootstrap-attempt-$attempt-retry.log"
  local bootstrap_status=0

  set +e
  maestro --device "$adb_serial" test \
    --test-output-dir "$bootstrap_output" \
    --debug-output "$bootstrap_debug" \
    --flatten-debug-output \
    scripts/ci/bootstrap-android-browser.yaml 2>&1 | tee "$bootstrap_log"
  bootstrap_status="${PIPESTATUS[0]}"
  set -e
  if [ "$bootstrap_status" -eq 0 ]; then
    return 0
  fi

  capture_chrome_bootstrap_failure_evidence "$attempt" "first" || true

  echo "Chrome bootstrap failed before product flows; resetting Chrome and retrying once." >&2
  if ! reset_chrome_bootstrap "$attempt"; then
    capture_attempt_evidence "$attempt" "$bootstrap_status" 1
    return "$bootstrap_status"
  fi

  set +e
  maestro --device "$adb_serial" test \
    --test-output-dir "$bootstrap_retry_output" \
    --debug-output "$bootstrap_retry_debug" \
    --flatten-debug-output \
    scripts/ci/bootstrap-android-browser.yaml 2>&1 | tee "$bootstrap_retry_log"
  bootstrap_status="${PIPESTATUS[0]}"
  set -e
  if [ "$bootstrap_status" -eq 0 ]; then
    return 0
  fi

  local evidence_status=0
  set +e
  capture_chrome_bootstrap_failure_evidence "$attempt" "second"
  capture_attempt_evidence "$attempt" "$bootstrap_status" 1
  if [ ! -s "$emulator_log" ] ||
    [ ! -s "$artifacts/logcat-attempt-$attempt.txt" ] ||
    [ ! -s "$artifacts/environment-attempt-$attempt.txt" ]; then
    evidence_status=1
  fi
  set -e
  if [ "$evidence_status" -ne 0 ]; then
    echo "The second Chrome bootstrap failed, and its focused evidence was incomplete." >&2
  else
    echo "The second Chrome bootstrap failed; its foreground classification does not excuse the failure." >&2
  fi
  return "$bootstrap_status"
}

run_chrome_bootstrap_with_hidden_dialogs() {
  local attempt="$1"
  local bootstrap_status=0

  if ! enable_hide_error_dialogs "$attempt"; then
    restore_hide_error_dialogs "$attempt" || true
    return 1
  fi

  set +e
  run_chrome_bootstrap "$attempt"
  bootstrap_status=$?
  set -e

  if ! restore_hide_error_dialogs "$attempt"; then
    return 1
  fi
  return "$bootstrap_status"
}

start_and_prepare_emulator() {
  local attempt="$1"
  local attempt_emulator_log="$artifacts/emulator-attempt-$attempt.log"

  echo "=== Starting clean Android emulator ===" >"$attempt_emulator_log"
  "$ANDROID_HOME/emulator/emulator" \
    -avd "$avd_name" \
    -port 5580 \
    -no-window \
    -no-audio \
    -no-boot-anim \
    -no-metrics \
    -no-snapshot \
    -wipe-data \
    -gpu swiftshader_indirect \
    -accel on >>"$attempt_emulator_log" 2>&1 &
  emulator_pid=$!

  timeout 180 adb -s "$adb_serial" wait-for-device
  for _ in $(seq 1 120); do
    if [ "$(timeout 5 adb -s "$adb_serial" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; then
      break
    fi
    sleep 2
  done
  if [ "$(timeout 5 adb -s "$adb_serial" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" != "1" ]; then
    echo "Android emulator did not complete boot within the bounded readiness window." >&2
    return 1
  fi

  run_named_adb_command "$artifacts/adb-logcat-clear-attempt-$attempt.log" 30 \
    adb -s "$adb_serial" logcat -c
  run_named_adb_command "$artifacts/adb-install-attempt-$attempt.log" 120 \
    adb -s "$adb_serial" install -r "$apk"
  run_named_adb_command "$artifacts/adb-fixture-push-attempt-$attempt.log" 30 \
    adb -s "$adb_serial" push \
    "$picker_fixture" /sdcard/Download/expo-turbo-android-picked.txt
  run_named_adb_command "$artifacts/adb-media-scan-attempt-$attempt.log" 30 \
    adb -s "$adb_serial" shell am broadcast \
    -a android.intent.action.MEDIA_SCANNER_SCAN_FILE \
    -d file:///sdcard/Download/expo-turbo-android-picked.txt

  wait_for_stable_device
  run_chrome_bootstrap_with_hidden_dialogs "$attempt"

  wait_for_stable_device
  if ! prepare_rails_reverse; then
    snapshot_reverse_evidence "$attempt"
    return 1
  fi
  snapshot_reverse_evidence "$attempt"
}

snapshot_reverse_evidence() {
  local attempt="$1"
  local path

  for path in \
    "$reverse_response_log" \
    "$reverse_probe_err_log" \
    "$reverse_listeners_log" \
    "$reverse_binding_log" \
    "$reverse_attempt_log"; do
    if [ -e "$path" ]; then
      cp "$path" "${path%.*}-attempt-$attempt.${path##*.}"
    fi
  done
}

capture_attempt_evidence() {
  local attempt="$1"
  local status="$2"
  local rails_start_byte="${3:-1}"
  local path

  timeout 15 adb -s "$adb_serial" logcat -d \
    >"$artifacts/logcat-attempt-$attempt.txt" 2>&1 || true
  {
    echo "attempt=$attempt"
    echo "source=$rails_log"
    echo "start_byte=$rails_start_byte"
    echo "content_begin"
    tail -c +"$rails_start_byte" "$rails_log" 2>/dev/null || true
  } >"$artifacts/rails-attempt-$attempt.log"
  {
    echo "attempt=$attempt"
    echo "suite_exit_status=$status"
    echo "commit=$(git rev-parse HEAD)"
    echo "adb_state=$(timeout 5 adb -s "$adb_serial" get-state 2>&1 || true)"
    echo "adb_reverse_begin"
    timeout 15 adb -s "$adb_serial" reverse --list 2>&1 || true
    echo "adb_reverse_end"
  } >"$artifacts/environment-attempt-$attempt.txt"

  : >"$emulator_log"
  for path in "$artifacts"/emulator-attempt-*.log; do
    [ -e "$path" ] || continue
    cat "$path" >>"$emulator_log"
  done
}

stop_emulator_for_retry() {
  timeout 15 adb -s "$adb_serial" emu kill >/dev/null 2>&1 || true
  stop_process "$emulator_pid" "Android emulator" 30 15 1
  emulator_pid=""
  adb kill-server >/dev/null 2>&1 || true
}

monitor_maestro_transport() {
  local attempt="$1"
  local pid="$2"
  local expected_process_identity="$3"
  local run_log="$4"
  local expected_file_identity="$5"
  local invocation_token="$6"
  local trigger_log="$7"
  local actual_file_identity=""
  local actual_process_identity=""
  local first_line=""
  local matched_line=""
  local stream_marker="EXPO_TURBO_MAESTRO_STREAM invocation=$invocation_token"

  while kill -0 "$pid" 2>/dev/null; do
    IFS= read -r first_line <"$run_log" || true
    if [ "$first_line" != "$stream_marker" ]; then
      record_monitor_safety_failure \
        "$trigger_log" \
        "$attempt" \
        "stream_marker_validation_failed" \
        "MAESTRO_STREAM_MARKER_INVALID" \
        "expected_marker=$stream_marker actual_first_line=$first_line"
      return 2
    fi

    if matched_line="$(
      EXPO_TURBO_ADB_TRANSPORT_PATTERN="$adb_transport_pattern" awk \
        'BEGIN { pattern=ENVIRON["EXPO_TURBO_ADB_TRANSPORT_PATTERN"] } NR > 1 && $0 ~ pattern { print; found=1; exit } END { exit !found }' \
        "$run_log" 2>/dev/null
    )"; then
      actual_process_identity="$(process_identity "$pid")"
      actual_file_identity="$(file_identity "$run_log")"
      if ! is_valid_process_identity "$actual_process_identity"; then
        record_monitor_safety_failure \
          "$trigger_log" \
          "$attempt" \
          "identity_validation_failed" \
          "MAESTRO_MONITOR_PROCESS_IDENTITY_INVALID" \
          "actual_process_identity=$actual_process_identity"
        return 2
      fi
      if ! is_valid_file_identity "$actual_file_identity"; then
        record_monitor_safety_failure \
          "$trigger_log" \
          "$attempt" \
          "identity_validation_failed" \
          "MAESTRO_MONITOR_FILE_IDENTITY_INVALID" \
          "actual_file_identity=$actual_file_identity"
        return 2
      fi
      if [ "$actual_process_identity" != "$expected_process_identity" ] ||
        [ "$actual_file_identity" != "$expected_file_identity" ]; then
        record_monitor_safety_failure \
          "$trigger_log" \
          "$attempt" \
          "identity_validation_failed" \
          "MAESTRO_MONITOR_IDENTITY_CHANGED" \
          "expected_process_identity=$expected_process_identity actual_process_identity=$actual_process_identity expected_file_identity=$expected_file_identity actual_file_identity=$actual_file_identity"
        return 2
      fi
      {
        echo "attempt=$attempt"
        echo "detected_at=$(date --iso-8601=seconds)"
        echo "stream_marker=$stream_marker"
        echo "process_identity=$actual_process_identity"
        echo "file_identity=$actual_file_identity"
        echo "matched_line=$matched_line"
        echo "action=stop active Maestro process and preserve attempt evidence"
      } >"$trigger_log"
      echo "Proven ADB transport loss detected during Maestro attempt $attempt; stopping this attempt early." >&2
      stop_process "$pid" "Maestro attempt $attempt" 50 50 0.1
      return 0
    fi
    sleep 0.2
  done
}

run_maestro_suite() {
  local attempt="$1"
  local junit="$artifacts/maestro-junit-attempt-$attempt.xml"
  local run_log="$artifacts/maestro-attempt-$attempt.log"
  local test_output="$artifacts/maestro-tests-attempt-$attempt"
  local debug_output="$artifacts/maestro-debug-attempt-$attempt"
  local trigger_log="$artifacts/maestro-transport-trigger-attempt-$attempt.txt"
  local startup_log="$artifacts/maestro-monitor-startup-attempt-$attempt.txt"
  local invocation_token="attempt-$attempt-worker-$$-$(date +%s%N)"
  local stream_marker="EXPO_TURBO_MAESTRO_STREAM invocation=$invocation_token"
  local maestro_process_identity=""
  local run_log_identity=""
  local status

  rm -f "$trigger_log" "$startup_log"
  initialize_maestro_run_log "$run_log" "$stream_marker"

  set +e
  maestro --device "$adb_serial" test \
      --format junit \
      --output "$junit" \
      --test-output-dir "$test_output" \
      --debug-output "$debug_output" \
      --flatten-debug-output \
      "$maestro_flow_path" >>"$run_log" 2>&1 &
  maestro_pid=$!
  maestro_process_identity="$(process_identity "$maestro_pid")"
  run_log_identity="$(file_identity "$run_log")"

  if ! is_valid_process_identity "$maestro_process_identity"; then
    write_monitor_startup_failure \
      "$startup_log" \
      "MAESTRO_MONITOR_PROCESS_IDENTITY_INVALID" \
      "$maestro_pid" \
      "$maestro_process_identity" \
      "$run_log_identity"
    maestro_pid=""
    set -e
    return 70
  fi
  if ! is_valid_file_identity "$run_log_identity"; then
    write_monitor_startup_failure \
      "$startup_log" \
      "MAESTRO_MONITOR_FILE_IDENTITY_INVALID" \
      "$maestro_pid" \
      "$maestro_process_identity" \
      "$run_log_identity"
    maestro_pid=""
    set -e
    return 70
  fi

  tail --pid="$maestro_pid" --sleep-interval=0.1 -n +1 -f "$run_log" &
  maestro_log_stream_pid=$!
  monitor_maestro_transport \
    "$attempt" \
    "$maestro_pid" \
    "$maestro_process_identity" \
    "$run_log" \
    "$run_log_identity" \
    "$invocation_token" \
    "$trigger_log" &
  maestro_transport_monitor_pid=$!

  wait "$maestro_pid"
  status=$?
  set -e

  stop_process "$maestro_transport_monitor_pid" "Maestro transport monitor" 50 50 0.1
  maestro_transport_monitor_pid=""
  if grep -Eq '^state=(stream_marker_validation_failed|identity_validation_failed)$' \
    "$trigger_log" 2>/dev/null; then
    status=70
  fi
  if ! drain_log_stream "$maestro_log_stream_pid" 40 0.05; then
    echo "Maestro log stream did not self-exit within 2 seconds; the saved attempt log remains authoritative." >&2
    stop_process "$maestro_log_stream_pid" "Maestro log stream" 50 50 0.1
  fi
  maestro_log_stream_pid=""
  maestro_pid=""

  if [ "$status" -eq 0 ]; then
    cp "$junit" "$artifacts/maestro-junit.xml"
  fi
  return "$status"
}

start_and_prepare_emulator 1

if run_maestro_suite 1; then
  capture_attempt_evidence 1 0 1
  exit 0
else
  first_status=$?
fi

capture_attempt_evidence 1 "$first_status" 1

if [ "$first_status" -eq 70 ]; then
  exit "$first_status"
fi

if ! should_retry_transport_failure 1 "$artifacts/maestro-attempt-1.log"; then
  exit "$first_status"
fi

echo "Maestro lost proven ADB transport; restarting the emulator and retrying the full suite once." >&2
stop_emulator_for_retry
rails_attempt_2_start_byte=$(($(wc -c <"$rails_log") + 1))
start_and_prepare_emulator 2

if run_maestro_suite 2; then
  capture_attempt_evidence 2 0 "$rails_attempt_2_start_byte"
  exit 0
else
  second_status=$?
  capture_attempt_evidence 2 "$second_status" "$rails_attempt_2_start_byte"
  exit "$second_status"
fi
