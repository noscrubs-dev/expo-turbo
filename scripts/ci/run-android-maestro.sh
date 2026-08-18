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
readonly maestro_flow_path="${MAESTRO_FLOW_PATH:-.maestro}"

is_adb_transport_failure() {
  local log="$1"

  # These messages come from ADB or Maestro's device server. Do not include
  # selector timeouts, assertions, application crashes, or generic exceptions:
  # those are product/test failures and must remain failures.
  grep -Eiq \
    "DeviceServerDiedException|device offline|host:transport:[^)]*offline|device '[^']+' not found" \
    "$log"
}

should_retry_transport_failure() {
  local attempt="$1"
  local log="$2"

  [ "$attempt" -eq 1 ] && is_adb_transport_failure "$log"
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

cleanup() {
  local status=$?
  trap - EXIT

  # Tell the supervisor that its first cancellation signal reached the EXIT
  # cleanup. The private inherited pipe lets the supervisor use the derived
  # cleanup budget instead of sending a second TERM after one second.
  if [[ "${ANDROID_MAESTRO_CLEANUP_FD:-}" =~ ^[0-9]+$ ]]; then
    printf "C" 2>/dev/null >&"$ANDROID_MAESTRO_CLEANUP_FD" || true
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

start_and_prepare_emulator() {
  local attempt="$1"
  local attempt_emulator_log="$artifacts/emulator-attempt-$attempt.log"
  local bootstrap_output="$artifacts/maestro-tests-bootstrap-attempt-$attempt"
  local bootstrap_debug="$artifacts/maestro-debug-bootstrap-attempt-$attempt"
  local bootstrap_log="$artifacts/maestro-bootstrap-attempt-$attempt.log"
  local bootstrap_retry_output="$artifacts/maestro-tests-bootstrap-attempt-$attempt-retry"
  local bootstrap_retry_debug="$artifacts/maestro-debug-bootstrap-attempt-$attempt-retry"
  local bootstrap_retry_log="$artifacts/maestro-bootstrap-attempt-$attempt-retry.log"
  local bootstrap_status=0

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
  set +e
  maestro --device "$adb_serial" test \
    --test-output-dir "$bootstrap_output" \
    --debug-output "$bootstrap_debug" \
    --flatten-debug-output \
    scripts/ci/bootstrap-android-browser.yaml 2>&1 | tee "$bootstrap_log"
  bootstrap_status="${PIPESTATUS[0]}"
  set -e

  if [ "$bootstrap_status" -ne 0 ]; then
    if ! is_adb_transport_failure "$bootstrap_log"; then
      return "$bootstrap_status"
    fi

    echo "Chrome bootstrap lost proven ADB transport; reconnecting once." >&2
    timeout 10 adb reconnect offline >/dev/null 2>&1 || true
    wait_for_stable_device
    set +e
    maestro --device "$adb_serial" test \
      --test-output-dir "$bootstrap_retry_output" \
      --debug-output "$bootstrap_retry_debug" \
      --flatten-debug-output \
      scripts/ci/bootstrap-android-browser.yaml 2>&1 | tee "$bootstrap_retry_log"
    bootstrap_status="${PIPESTATUS[0]}"
    set -e
    if [ "$bootstrap_status" -ne 0 ]; then
      return "$bootstrap_status"
    fi
  fi

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
  local path

  timeout 15 adb -s "$adb_serial" logcat -d \
    >"$artifacts/logcat-attempt-$attempt.txt" 2>&1 || true
  cp "$rails_log" "$artifacts/rails-attempt-$attempt.log" 2>/dev/null || true
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

run_maestro_suite() {
  local attempt="$1"
  local junit="$artifacts/maestro-junit-attempt-$attempt.xml"
  local run_log="$artifacts/maestro-attempt-$attempt.log"
  local test_output="$artifacts/maestro-tests-attempt-$attempt"
  local debug_output="$artifacts/maestro-debug-attempt-$attempt"
  local status

  set +e
  maestro --device "$adb_serial" test \
    --format junit \
    --output "$junit" \
    --test-output-dir "$test_output" \
    --debug-output "$debug_output" \
    --flatten-debug-output \
    "$maestro_flow_path" 2>&1 | tee "$run_log"
  status="${PIPESTATUS[0]}"
  set -e

  if [ "$status" -eq 0 ]; then
    cp "$junit" "$artifacts/maestro-junit.xml"
  fi
  return "$status"
}

start_and_prepare_emulator 1

if run_maestro_suite 1; then
  capture_attempt_evidence 1 0
  exit 0
else
  first_status=$?
fi

capture_attempt_evidence 1 "$first_status"

if ! should_retry_transport_failure 1 "$artifacts/maestro-attempt-1.log"; then
  exit "$first_status"
fi

echo "Maestro lost proven ADB transport; restarting the emulator and retrying the full suite once." >&2
stop_emulator_for_retry
: >"$rails_log"
start_and_prepare_emulator 2

if run_maestro_suite 2; then
  capture_attempt_evidence 2 0
  exit 0
else
  second_status=$?
  capture_attempt_evidence 2 "$second_status"
  exit "$second_status"
fi
