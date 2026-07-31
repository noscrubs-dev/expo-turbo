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

readonly adb_serial="emulator-5580"
readonly avd_name="expo-turbo-api35"
readonly rails_origin="http://127.0.0.1:3001"
readonly artifacts="$PWD/artifacts/android-device"
readonly rails_log="$artifacts/rails.log"
readonly emulator_log="$artifacts/emulator.log"
readonly resource_log="$artifacts/resources.log"
readonly maestro_flow_path="${MAESTRO_FLOW_PATH:-.maestro}"

wait_for_stable_device() {
  local consecutive_checks=0

  for _ in $(seq 1 60); do
    if [ "$(adb -s "$adb_serial" get-state 2>/dev/null)" = "device" ] &&
      adb -s "$adb_serial" shell true >/dev/null 2>&1; then
      consecutive_checks=$((consecutive_checks + 1))
      if [ "$consecutive_checks" -eq 3 ]; then
        return
      fi
    else
      consecutive_checks=0
      adb reconnect offline >/dev/null 2>&1 || true
    fi
    sleep 2
  done

  echo "Android emulator did not maintain a stable ADB connection." >&2
  return 1
}

prepare_rails_reverse() {
  for _ in 1 2; do
    adb -s "$adb_serial" reverse --remove tcp:3001 >/dev/null 2>&1 || true
    if adb -s "$adb_serial" reverse tcp:3001 tcp:3001 &&
      printf 'GET /up HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n' |
        timeout 10 adb -s "$adb_serial" shell 'toybox nc -w 5 127.0.0.1 3001' |
        tr -d '\r' |
        grep -Eq '^HTTP/[0-9.]+ 200 '; then
      return
    fi
    sleep 2
  done

  echo "Android could not reach Rails through the ADB reverse tunnel." >&2
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
  status=$?
  trap - EXIT INT TERM

  timeout 15 adb -s "$adb_serial" logcat -d >"$artifacts/logcat.txt" 2>&1 || true
  timeout 15 adb -s "$adb_serial" emu kill >/dev/null 2>&1 || true

  for pid in "$sampler_pid" "$rails_pid" "$emulator_pid"; do
    if [ -n "$pid" ]; then
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
  done

  {
    echo "exit_status=$status"
    echo "commit=$(git rev-parse HEAD)"
    echo "runner=$(hostname)"
    echo "user=$(id)"
    echo "bun=$(bun --version)"
    echo "ruby=$(ruby --version)"
    echo "java=$(java -version 2>&1 | head -1)"
    echo "maestro=$(maestro --version)"
    echo "emulator=$(grep '^Pkg.Revision=' "$ANDROID_HOME/emulator/source.properties")"
    df -h /
    free -h
  } >"$artifacts/environment.txt"

  exit "$status"
}
trap cleanup EXIT INT TERM

(
  while true; do
    date --iso-8601=seconds
    free -m
    df -m /
    ps -eo pid,ppid,rss,%cpu,comm,args --sort=-rss | head -20
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
  PORT=3001 RAILS_ENV=development bundle exec rails server -b 127.0.0.1
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
  echo "=== Starting clean Android emulator ===" >>"$emulator_log"
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
    -accel on >>"$emulator_log" 2>&1 &
  emulator_pid=$!

  timeout 180 adb -s "$adb_serial" wait-for-device
  for _ in $(seq 1 120); do
    if [ "$(adb -s "$adb_serial" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; then
      break
    fi
    sleep 2
  done
  test "$(adb -s "$adb_serial" shell getprop sys.boot_completed | tr -d '\r')" = "1"

  adb -s "$adb_serial" logcat -c
  adb -s "$adb_serial" install -r "$apk"
  adb -s "$adb_serial" push "$picker_fixture" /sdcard/Download/expo-turbo-android-picked.txt
  adb -s "$adb_serial" shell am broadcast \
    -a android.intent.action.MEDIA_SCANNER_SCAN_FILE \
    -d file:///sdcard/Download/expo-turbo-android-picked.txt >/dev/null

  wait_for_stable_device
  if ! maestro --device "$adb_serial" test scripts/ci/bootstrap-android-browser.yaml; then
    echo "Chrome bootstrap lost its first device session; reconnecting once." >&2
    adb reconnect offline >/dev/null 2>&1 || true
    wait_for_stable_device
    maestro --device "$adb_serial" test scripts/ci/bootstrap-android-browser.yaml
  fi

  wait_for_stable_device
  prepare_rails_reverse
}

stop_emulator_for_retry() {
  timeout 15 adb -s "$adb_serial" emu kill >/dev/null 2>&1 || true

  if [ -n "$emulator_pid" ]; then
    for _ in $(seq 1 30); do
      if ! kill -0 "$emulator_pid" 2>/dev/null; then
        break
      fi
      sleep 1
    done
    if kill -0 "$emulator_pid" 2>/dev/null; then
      kill "$emulator_pid" 2>/dev/null || true
      for _ in $(seq 1 15); do
        if ! kill -0 "$emulator_pid" 2>/dev/null; then
          break
        fi
        sleep 1
      done
    fi
    if kill -0 "$emulator_pid" 2>/dev/null; then
      kill -KILL "$emulator_pid" 2>/dev/null || true
    fi
    wait "$emulator_pid" 2>/dev/null || true
  fi

  emulator_pid=""
  adb kill-server >/dev/null 2>&1 || true
}

run_maestro_suite() {
  local attempt="$1"
  local junit="$artifacts/maestro-junit-attempt-$attempt.xml"
  local run_log="$artifacts/maestro-attempt-$attempt.log"
  local status

  set +e
  maestro --device "$adb_serial" test \
    --format junit \
    --output "$junit" \
    "$maestro_flow_path" 2>&1 | tee "$run_log"
  status="${PIPESTATUS[0]}"
  set -e

  if [ "$status" -eq 0 ]; then
    cp "$junit" "$artifacts/maestro-junit.xml"
  fi
  return "$status"
}

start_and_prepare_emulator

if run_maestro_suite 1; then
  exit 0
else
  first_status=$?
fi

if ! grep -Eiq "device offline|host:transport:[^)]*offline|device '[^']+' not found" "$artifacts/maestro-attempt-1.log" ||
  ! grep -Eq '\[Failed\].*\(0s\)' "$artifacts/maestro-attempt-1.log"; then
  exit "$first_status"
fi

echo "Maestro lost ADB transport and cascaded into zero-second failures; restarting the emulator and retrying the full suite once." >&2
timeout 15 adb -s "$adb_serial" logcat -d >"$artifacts/logcat-attempt-1.txt" 2>&1 || true
stop_emulator_for_retry
start_and_prepare_emulator

if run_maestro_suite 2; then
  exit 0
else
  second_status=$?
  exit "$second_status"
fi
