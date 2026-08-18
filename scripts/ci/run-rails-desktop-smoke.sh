#!/usr/bin/env bash
set -euo pipefail

readonly script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly repository_root="$(cd "$script_directory/../.." && pwd)"
readonly rails_directory="$repository_root/example/rails"
readonly expo_directory="$repository_root/example/expo"
readonly smoke_directory="$expo_directory/src"
readonly rails_port=3001
readonly redis_port=6379
readonly rails_origin="http://127.0.0.1:$rails_port"
readonly redis_url="redis://127.0.0.1:$redis_port/15"
readonly readiness_attempts="${EXPO_TURBO_SMOKE_READINESS_ATTEMPTS:-30}"
readonly readiness_interval="${EXPO_TURBO_SMOKE_READINESS_INTERVAL:-1}"
readonly stop_checks=20
readonly stop_interval=0.1

rails_pid=""
redis_pid=""
bun_pid=""
monitor_pid=""
service_failure_file="$(mktemp "${TMPDIR:-/tmp}/expo-turbo-service-failure.XXXXXX")"
rails_log_file="$(mktemp "${TMPDIR:-/tmp}/expo-turbo-rails-smoke.XXXXXX")"
redis_log_file="$(mktemp "${TMPDIR:-/tmp}/expo-turbo-redis-smoke.XXXXXX")"

stop_child() {
  local pid="$1"
  local name="$2"
  local _

  if [ -z "$pid" ] || ! child_is_alive "$pid"; then
    wait "$pid" 2>/dev/null || true
    return
  fi

  kill -TERM "$pid" 2>/dev/null || true
  for _ in $(seq 1 "$stop_checks"); do
    if ! child_is_alive "$pid"; then
      wait "$pid" 2>/dev/null || true
      return
    fi
    sleep "$stop_interval"
  done

  echo "$name did not stop after TERM; sending KILL." >&2
  kill -KILL "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
}

child_is_alive() {
  local pid="$1"

  kill -0 "$pid" 2>/dev/null
}

cleanup() {
  local exit_status=$?
  trap - EXIT INT TERM
  stop_child "$monitor_pid" "Service monitor"
  stop_child "$bun_pid" "Bun smoke tests"
  stop_child "$rails_pid" "Rails smoke server"
  stop_child "$redis_pid" "Redis smoke server"
  if [ "$exit_status" -ne 0 ]; then
    [ ! -s "$rails_log_file" ] || cat "$rails_log_file" >&2
    [ ! -s "$redis_log_file" ] || cat "$redis_log_file" >&2
  fi
  rm -f "$service_failure_file" "$rails_log_file" "$redis_log_file"
  exit "$exit_status"
}

handle_interrupt() {
  trap - INT TERM
  exit 130
}

handle_terminate() {
  trap - INT TERM
  exit 143
}

port_is_free() {
  ruby -rsocket -e 'server = TCPServer.new("127.0.0.1", Integer(ARGV.fetch(0))); server.close' "$1" \
    >/dev/null 2>&1
}

require_owned_service() {
  local pid="$1"
  local name="$2"
  local phase="$3"

  if ! child_is_alive "$pid"; then
    echo "$name exited $phase." >&2
    return 1
  fi
}

monitor_services() {
  while child_is_alive "$bun_pid"; do
    if ! child_is_alive "$rails_pid"; then
      printf '%s\n' "Rails exited while Bun smoke tests were running." >"$service_failure_file"
      kill -TERM "$bun_pid" 2>/dev/null || true
      return 1
    fi
    if ! child_is_alive "$redis_pid"; then
      printf '%s\n' "Redis exited while Bun smoke tests were running." >"$service_failure_file"
      kill -TERM "$bun_pid" 2>/dev/null || true
      return 1
    fi
    sleep "$stop_interval"
  done
}

trap cleanup EXIT
trap handle_interrupt INT
trap handle_terminate TERM

if [ ! -d "$rails_directory" ] || [ ! -d "$smoke_directory" ]; then
  echo "Rails desktop smoke directories are missing." >&2
  exit 1
fi

smoke_files=()
smoke_basenames=""
while IFS= read -r -d '' smoke_file; do
  relative_file="src/${smoke_file#"$smoke_directory/"}"
  smoke_files+=("$relative_file")
  smoke_basenames="${smoke_basenames}$(basename "$smoke_file")
"
done < <(
  find "$smoke_directory" -type f \
    \( -name 'demo-live-*.rails-smoke.test.ts' \
    -o -name 'demo-live-*.rails-smoke.test.tsx' \
    -o -name 'demo-live-*.rails-smoke.test.js' \
    -o -name 'demo-live-*.rails-smoke.test.jsx' \
    -o -name 'demo-live-*.redis-smoke.test.ts' \
    -o -name 'demo-live-*.redis-smoke.test.tsx' \
    -o -name 'demo-live-*.redis-smoke.test.js' \
    -o -name 'demo-live-*.redis-smoke.test.jsx' \) \
    -print0
)

if [ "${#smoke_files[@]}" -eq 0 ]; then
  echo "Rails desktop smoke discovery found no live smoke files." >&2
  exit 1
fi

duplicate_basename="$(printf '%s' "$smoke_basenames" | LC_ALL=C sort | uniq -d | head -n 1)"
if [ -n "$duplicate_basename" ]; then
  echo "Rails desktop smoke discovery is ambiguous: duplicate file name $duplicate_basename." >&2
  exit 1
fi

ambiguous_link="$(
  find "$smoke_directory" -type l \
    \( -name 'demo-live-*.rails-smoke.test.*' -o -name 'demo-live-*.redis-smoke.test.*' \) \
    -print -quit
)"
if [ -n "$ambiguous_link" ]; then
  echo "Rails desktop smoke discovery is ambiguous: matching symbolic link $ambiguous_link." >&2
  exit 1
fi

command -v redis-server >/dev/null 2>&1 || {
  echo "redis-server is required for the Rails desktop smoke." >&2
  exit 1
}
command -v redis-cli >/dev/null 2>&1 || {
  echo "redis-cli is required for the Rails desktop smoke." >&2
  exit 1
}

if ! port_is_free "$rails_port"; then
  echo "Rails desktop smoke requires free port $rails_port." >&2
  exit 1
fi
if ! port_is_free "$redis_port"; then
  echo "Rails desktop smoke requires free port $redis_port." >&2
  exit 1
fi

redis-server --bind 127.0.0.1 --port "$redis_port" --save '' --appendonly no \
  >"$redis_log_file" 2>&1 &
redis_pid=$!
require_owned_service "$redis_pid" "Redis" "immediately after start"

redis_ready=false
for _ in $(seq 1 "$readiness_attempts"); do
  require_owned_service "$redis_pid" "Redis" "before readiness"
  if [ "$(redis-cli -h 127.0.0.1 -p "$redis_port" ping 2>/dev/null)" = PONG ]; then
    require_owned_service "$redis_pid" "Redis" "immediately after readiness"
    redis_ready=true
    break
  fi
  require_owned_service "$redis_pid" "Redis" "before readiness"
  sleep "$readiness_interval"
done

if [ "$redis_ready" != true ]; then
  echo "Redis did not become ready within ${readiness_attempts} seconds." >&2
  exit 1
fi

(
  cd "$rails_directory"
  exec env \
    BUNDLE_GEMFILE="$rails_directory/Gemfile" \
    PORT="$rails_port" \
    RAILS_ENV=development \
    REDIS_URL="$redis_url" \
    bundle exec rails server -b 127.0.0.1
) >"$rails_log_file" 2>&1 &
rails_pid=$!
require_owned_service "$rails_pid" "Rails" "immediately after start"

rails_ready=false
for _ in $(seq 1 "$readiness_attempts"); do
  require_owned_service "$rails_pid" "Rails" "before readiness"
  require_owned_service "$redis_pid" "Redis" "while Rails was starting"
  if curl --fail --silent --show-error --max-time 1 "$rails_origin/up" >/dev/null 2>&1; then
    require_owned_service "$rails_pid" "Rails" "immediately after readiness"
    require_owned_service "$redis_pid" "Redis" "when Rails became ready"
    rails_ready=true
    break
  fi
  require_owned_service "$rails_pid" "Rails" "before readiness"
  require_owned_service "$redis_pid" "Redis" "while Rails was starting"
  sleep "$readiness_interval"
done

if [ "$rails_ready" != true ]; then
  echo "Rails did not become ready within ${readiness_attempts} seconds." >&2
  exit 1
fi

(
  cd "$expo_directory"
  exec env \
    EXPO_TURBO_DEMO_ORIGIN="$rails_origin" \
    REDIS_URL="$redis_url" \
    bun test --isolate "${smoke_files[@]}"
) &
bun_pid=$!
(
  trap - EXIT INT TERM
  monitor_services
) &
monitor_pid=$!

set +e
wait "$bun_pid"
test_status=$?
bun_pid=""
wait "$monitor_pid"
monitor_status=$?
monitor_pid=""
set -e

if [ -s "$service_failure_file" ]; then
  cat "$service_failure_file" >&2
  [ "$test_status" -ne 0 ] || test_status=1
elif [ "$monitor_status" -ne 0 ]; then
  echo "Owned service monitor failed." >&2
  [ "$test_status" -ne 0 ] || test_status=1
elif ! child_is_alive "$rails_pid"; then
  echo "Rails exited before Bun smoke tests completed." >&2
  [ "$test_status" -ne 0 ] || test_status=1
elif ! child_is_alive "$redis_pid"; then
  echo "Redis exited before Bun smoke tests completed." >&2
  [ "$test_status" -ne 0 ] || test_status=1
fi

exit "$test_status"
