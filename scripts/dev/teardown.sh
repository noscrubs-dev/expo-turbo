#!/usr/bin/env bash
# Stop everything scripts/dev/run.sh left running in this checkout.
#
# Run it by hand, or let a worktree manager run it before it deletes a worktree.
# It reads no tool-specific state: .superset/config.json only names this path.
#
# Setup installs into the checkout only, so deleting a worktree already removes
# node_modules/, dist/, .bundle/, and every log. What deleting a worktree does
# not do is stop the processes run.sh left behind, so that is this script's
# whole job: stop this checkout's Rails host, Expo dev server, and — only when
# this checkout started it — Redis.
#
# Redis on the shared port is never stopped unless .tmp/redis.pid says this
# checkout started it. Another checkout may be using it.

set -uo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
tmp_dir="$repo_root/.tmp"

note() { printf '    %s\n' "$*"; }

printf '\n==> Stopping anything this checkout left running\n'

if [ ! -d "$tmp_dir" ]; then
  note "nothing recorded; nothing to stop"
  exit 0
fi

read_pid() {
  [ -f "$1" ] || return 1
  local pid
  pid="$(cat "$1" 2>/dev/null)"
  case "$pid" in
  '' | *[!0-9]*) return 1 ;;
  esac
  printf '%s' "$pid"
}

stop_pid() {
  local pid="$1"
  local label="$2"
  local waited=0

  kill -0 "$pid" 2>/dev/null || return 0
  note "stopping $label (pid $pid)"
  kill "$pid" 2>/dev/null

  while [ "$waited" -lt 10 ]; do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 1
    waited=$((waited + 1))
  done

  note "$label did not exit; sending KILL"
  kill -9 "$pid" 2>/dev/null
}

# run.sh traps TERM and stops its own children, so give it the first try.
if pid="$(read_pid "$tmp_dir/run.pid")"; then
  stop_pid "$pid" "run script"
fi

if pid="$(read_pid "$tmp_dir/rails.pid")"; then
  stop_pid "$pid" "Rails host"
fi

if pid="$(read_pid "$tmp_dir/redis.pid")"; then
  stop_pid "$pid" "Redis (started by this checkout)"
fi

# A hard-killed terminal leaves listeners with no pid file. Sweep the recorded
# ports, but only for processes whose working directory is inside this checkout,
# so a parallel worktree on a neighbouring port is never touched. Redis is
# excluded on purpose: it is shared, and its pid file above is the only
# ownership claim.
if [ -f "$tmp_dir/ports.env" ] && command -v lsof >/dev/null 2>&1; then
  # shellcheck disable=SC1091
  . "$tmp_dir/ports.env" 2>/dev/null

  for port in "${RAILS_PORT:-}" "${EXPO_PORT:-}"; do
    [ -n "$port" ] || continue
    for pid in $(lsof -ti "tcp:$port" -sTCP:LISTEN 2>/dev/null); do
      cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)"
      case "$cwd" in
      "$repo_root" | "$repo_root"/*)
        stop_pid "$pid" "stray listener on port $port"
        ;;
      *)
        note "port $port is held by another checkout; leaving it alone"
        ;;
      esac
    done
  done
fi

rm -rf "$tmp_dir"
note "done"
