#!/usr/bin/env bash
# Boot the standalone demo stack for local development.
#
#   ./scripts/dev/run.sh          # Redis + Rails host + Expo (default)
#   ./scripts/dev/run.sh rails    # Redis + Rails host only
#   ./scripts/dev/run.sh expo     # Expo only, against EXPO_TURBO_RAILS_PORT
#
# Run it by hand, or let a worktree manager run it. It reads no tool-specific
# state: .superset/config.json only names this path.
#
# docs/getting-started.md runs the Rails host and Expo in two terminals. This
# one keeps Expo in the foreground so its interactive keys still work, and runs
# Redis and Rails behind it. Everything this script starts, it stops on exit.
#
# Ports are per checkout: each default is probed and the next free port is used
# when it is taken, so parallel worktrees do not fight over 3001 or 8081.
# Override with EXPO_TURBO_RAILS_PORT / EXPO_TURBO_EXPO_PORT.
#
# Redis is a shared service on 6379. This script starts it only when nothing
# answers there, and stops it only when it was the one that started it.
#
# Process and port records go in .tmp/, which scripts/dev/teardown.sh reads.

set -uo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
tmp_dir="$repo_root/.tmp"
cd "$repo_root" || exit 1
mkdir -p "$tmp_dir"

target="${1:-stack}"
redis_port="${EXPO_TURBO_REDIS_PORT:-6379}"
rails_pid=""
owned_redis_pid=""

log() { printf '\n==> %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }
die() {
  printf '\n!!! %s\n' "$*" >&2
  exit 1
}

case "$target" in
stack | rails | expo) ;;
*) die "unknown target '$target'. Use stack, rails, or expo." ;;
esac

port_in_use() {
  (exec 3<>"/dev/tcp/127.0.0.1/$1") >/dev/null 2>&1
}

free_port() {
  local port="$1"
  local limit=$((port + 20))
  while [ "$port" -lt "$limit" ]; do
    if ! port_in_use "$port"; then
      printf '%s' "$port"
      return 0
    fi
    port=$((port + 1))
  done
  return 1
}

cleanup() {
  trap - EXIT INT TERM

  if [ -n "$rails_pid" ] && kill -0 "$rails_pid" 2>/dev/null; then
    kill "$rails_pid" 2>/dev/null
  fi
  if [ -f "$tmp_dir/rails.pid" ]; then
    local recorded
    recorded="$(cat "$tmp_dir/rails.pid" 2>/dev/null)"
    if [ -n "$recorded" ] && kill -0 "$recorded" 2>/dev/null; then
      kill "$recorded" 2>/dev/null
    fi
    rm -f "$tmp_dir/rails.pid"
  fi

  if [ -n "$owned_redis_pid" ] && kill -0 "$owned_redis_pid" 2>/dev/null; then
    note "stopping the Redis this script started"
    kill "$owned_redis_pid" 2>/dev/null
  fi
  rm -f "$tmp_dir/redis.pid" "$tmp_dir/run.pid" "$tmp_dir/ports.env"
}
trap cleanup EXIT INT TERM

# The package is installed and built by scripts/dev/setup.sh. Repair the pieces
# a stale checkout can be missing rather than failing outright.
ensure_package_build() {
  if [ ! -d "$repo_root/node_modules" ]; then
    log "Installing the TypeScript package"
    bun install --frozen-lockfile || die "bun install failed"
  fi
  if [ ! -f "$repo_root/dist/index.js" ]; then
    log "Building dist/"
    bun run build || die "bun run build failed"
  fi
}

ensure_expo_install() {
  if [ ! -d "$repo_root/example/expo/node_modules" ]; then
    log "Installing example/expo"
    (cd "$repo_root/example/expo" && bun install --frozen-lockfile) ||
      die "example/expo install failed. Run ./scripts/dev/setup.sh"
  fi
}

ensure_rails_install() {
  command -v bundle >/dev/null 2>&1 ||
    die "bundler is not on PATH; the Rails host needs Ruby 3.3.8 and bundler"
  if ! (cd "$repo_root/example/rails" &&
    BUNDLE_GEMFILE="$repo_root/example/rails/Gemfile" bundle check >/dev/null 2>&1); then
    log "Installing example/rails"
    # The example's own idempotent setup script, minus its server start.
    (cd "$repo_root/example/rails" &&
      BUNDLE_GEMFILE="$repo_root/example/rails/Gemfile" bin/setup --skip-server) ||
      die "example/rails install failed. Run ./scripts/dev/setup.sh"
  fi
}

redis_ready() {
  if command -v redis-cli >/dev/null 2>&1; then
    [ "$(redis-cli -p "$redis_port" ping 2>/dev/null)" = "PONG" ]
  else
    port_in_use "$redis_port"
  fi
}

start_redis() {
  log "Redis on port $redis_port"
  if redis_ready; then
    note "already running; leaving it alone (other checkouts may share it)"
    return 0
  fi

  command -v redis-server >/dev/null 2>&1 ||
    die "nothing answers on port $redis_port and redis-server is not on PATH.
    Action Cable needs Redis: start one, or set REDIS_URL to a reachable server."

  redis-server --port "$redis_port" --save '' --appendonly no \
    >"$tmp_dir/redis.log" 2>&1 &
  owned_redis_pid=$!
  printf '%s\n' "$owned_redis_pid" >"$tmp_dir/redis.pid"

  local waited=0
  while [ "$waited" -lt 15 ]; do
    redis_ready && {
      note "started (pid $owned_redis_pid); this script will stop it on exit"
      return 0
    }
    kill -0 "$owned_redis_pid" 2>/dev/null ||
      die "redis-server exited. See $tmp_dir/redis.log"
    sleep 1
    waited=$((waited + 1))
  done
  die "Redis did not answer within 15s. See $tmp_dir/redis.log"
}

start_rails() {
  local port="$1"
  log "Rails host on http://127.0.0.1:$port"

  rm -f "$tmp_dir/rails.pid"
  # bin/dev is the example's own dev-server entry point and passes its arguments
  # through to bin/rails server, so a later change there is picked up here.
  (
    cd "$repo_root/example/rails" || exit 1
    BUNDLE_GEMFILE="$repo_root/example/rails/Gemfile" \
      RAILS_ENV="${RAILS_ENV:-development}" \
      bin/dev -b 127.0.0.1 -p "$port" -P "$tmp_dir/rails.pid" 2>&1 |
      awk '{ print "[rails] " $0; fflush() }'
  ) &
  rails_pid=$!

  local waited=0
  while [ "$waited" -lt 60 ]; do
    if curl --fail --silent --max-time 1 "http://127.0.0.1:$port/up" >/dev/null 2>&1; then
      note "ready"
      return 0
    fi
    kill -0 "$rails_pid" 2>/dev/null || die "Rails exited before it was ready"
    sleep 1
    waited=$((waited + 1))
  done
  die "Rails did not answer /up within 60s"
}

rails_port="${EXPO_TURBO_RAILS_PORT:-}"
if [ -z "$rails_port" ]; then
  rails_port="$(free_port 3001)" || die "no free port near 3001"
fi

expo_port="${EXPO_TURBO_EXPO_PORT:-}"
if [ -z "$expo_port" ]; then
  expo_port="$(free_port 8081)" || die "no free port near 8081"
fi

origin="${EXPO_PUBLIC_EXPO_TURBO_DEMO_ORIGIN:-http://127.0.0.1:$rails_port}"

printf '%s\n' "$$" >"$tmp_dir/run.pid"
{
  printf 'RAILS_PORT=%s\n' "$rails_port"
  printf 'EXPO_PORT=%s\n' "$expo_port"
  printf 'REDIS_PORT=%s\n' "$redis_port"
} >"$tmp_dir/ports.env"

log "$(basename "$repo_root") — target: $target"
note "Rails $rails_port | Expo $expo_port | demo origin $origin"

if [ "$target" != "expo" ]; then
  start_redis
  ensure_rails_install
  start_rails "$rails_port"
fi

if [ "$target" = "rails" ]; then
  note "Rails is in the foreground. Ctrl-C stops it."
  wait "$rails_pid"
  exit $?
fi

ensure_package_build
ensure_expo_install

log "Expo dev server"
note "physical devices need a device-reachable origin, not 127.0.0.1:"
note "EXPO_PUBLIC_EXPO_TURBO_DEMO_ORIGIN=http://<lan-ip>:$rails_port ./scripts/dev/run.sh"

cd "$repo_root/example/expo" || die "example/expo is missing"
EXPO_PUBLIC_EXPO_TURBO_DEMO_ORIGIN="$origin" bun start --port "$expo_port"
