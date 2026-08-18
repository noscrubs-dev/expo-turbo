#!/usr/bin/env bash
set -euo pipefail

readonly script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly repository_root="$(cd "$script_directory/../.." && pwd)"
readonly rails_directory="$repository_root/example/rails"
readonly expo_directory="$repository_root/example/expo"
readonly smoke_directory="$expo_directory/src"
readonly rails_origin="http://127.0.0.1:3001"
readonly readiness_attempts=30
readonly readiness_interval=1
readonly stop_checks=20
readonly stop_interval=0.1

rails_pid=""
bun_pid=""
log_file="$(mktemp "${TMPDIR:-/tmp}/expo-turbo-rails-smoke.XXXXXX")"

stop_child() {
  local pid="$1"
  local name="$2"
  local _

  if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then
    wait "$pid" 2>/dev/null || true
    return
  fi

  kill -TERM "$pid" 2>/dev/null || true
  for _ in $(seq 1 "$stop_checks"); do
    if ! kill -0 "$pid" 2>/dev/null; then
      wait "$pid" 2>/dev/null || true
      return
    fi
    sleep "$stop_interval"
  done

  echo "$name did not stop after TERM; sending KILL." >&2
  kill -KILL "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
}

cleanup() {
  local exit_status=$?
  trap - EXIT INT TERM
  stop_child "$bun_pid" "Bun smoke tests"
  stop_child "$rails_pid" "Rails smoke server"
  if [ "$exit_status" -ne 0 ] && [ -s "$log_file" ]; then
    cat "$log_file" >&2
  fi
  rm -f "$log_file"
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

(
  cd "$rails_directory"
  exec env \
    BUNDLE_GEMFILE="$rails_directory/Gemfile" \
    PORT=3001 \
    RAILS_ENV=development \
    bundle exec rails server -b 127.0.0.1
) >"$log_file" 2>&1 &
rails_pid=$!

ready=false
for _ in $(seq 1 "$readiness_attempts"); do
  if curl --fail --silent --show-error --max-time 1 "$rails_origin/up" >/dev/null 2>&1; then
    ready=true
    break
  fi
  if ! kill -0 "$rails_pid" 2>/dev/null; then
    echo "Rails exited before readiness." >&2
    exit 1
  fi
  sleep "$readiness_interval"
done

if [ "$ready" != true ]; then
  echo "Rails did not become ready within ${readiness_attempts} seconds." >&2
  exit 1
fi

(
  cd "$expo_directory"
  exec env EXPO_TURBO_DEMO_ORIGIN="$rails_origin" bun test --isolate "${smoke_files[@]}"
) &
bun_pid=$!

set +e
wait "$bun_pid"
test_status=$?
set -e
bun_pid=""
exit "$test_status"
