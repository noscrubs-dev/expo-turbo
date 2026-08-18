#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly script_dir
readonly worker="$script_dir/run-android-maestro.sh"

worker_pid=""
worker_pgid=""
cancellation_status=0
forwarding_error=0
entry_ready=0
pending_signal=""
pending_status=0

owned_worker_is_running() {
  local job_pid

  case "$worker_pid" in
  "" | *[!0-9]*) return 1 ;;
  esac
  if [ "$worker_pid" -le 1 ]; then
    return 1
  fi

  for job_pid in $(jobs -pr); do
    if [ "$job_pid" = "$worker_pid" ]; then
      return 0
    fi
  done
  return 1
}

read_worker_pgid() {
  local pgid

  pgid="$(ruby -e 'print Process.getpgid(Integer(ARGV.fetch(0)))' "$worker_pid" 2>/dev/null)"
  case "$pgid" in
  "" | *[!0-9]*) return 1 ;;
  esac
  printf '%s\n' "$pgid"
}

valid_worker_group() {
  local current_pgid
  local entry_pgid

  owned_worker_is_running || return 1
  current_pgid="$(read_worker_pgid)" || return 1
  entry_pgid="$(ruby -e 'print Process.getpgid(Integer(ARGV.fetch(0)))' "$$" 2>/dev/null)"
  case "$entry_pgid" in
  "" | *[!0-9]*) return 1 ;;
  esac

  if [ "$current_pgid" -le 1 ] ||
    [ "$current_pgid" != "$worker_pid" ] ||
    [ "$current_pgid" != "$worker_pgid" ] ||
    [ "$current_pgid" = "$entry_pgid" ]; then
    return 1
  fi
}

stop_invalid_worker() {
  local attempt

  if ! owned_worker_is_running; then
    return
  fi
  kill -TERM "$worker_pid" 2>/dev/null || true
  for attempt in $(seq 1 10); do
    if ! owned_worker_is_running; then
      return
    fi
    sleep 0.05
  done
  if owned_worker_is_running; then
    kill -KILL "$worker_pid" 2>/dev/null || true
  fi
}

forward_signal() {
  local signal="$1"
  local status="$2"

  # The worker can exit between GitHub sending the signal and this trap. In
  # that race, wait returns the real worker status and no PID is signalled.
  if ! owned_worker_is_running; then
    return
  fi
  if [ "$entry_ready" -eq 0 ]; then
    pending_signal="$signal"
    pending_status="$status"
    return
  fi
  if ! valid_worker_group; then
    echo "Android entry refused to signal an invalid or unowned process group (worker $worker_pid, expected group ${worker_pgid:-unset}, current group $(read_worker_pgid || echo invalid))." >&2
    forwarding_error=70
    stop_invalid_worker
    return
  fi

  cancellation_status="$status"
  if ! kill -s "$signal" -- "-$worker_pgid" 2>/dev/null; then
    if owned_worker_is_running; then
      echo "Android entry could not forward $signal to its worker group." >&2
      forwarding_error=71
      stop_invalid_worker
    fi
  fi
}

trap 'forward_signal INT 130' INT
trap 'forward_signal TERM 143' TERM

# Ruby is already a required Android-lane tool. Process.setsid gives the worker
# a new session and process group on both the Linux runner and macOS test hosts.
ruby -e 'Process.setsid; Signal.trap("INT", "DEFAULT"); Signal.trap("QUIT", "DEFAULT"); exec(*ARGV)' "$worker" &
worker_pid=$!

for _ in $(seq 1 100); do
  if ! owned_worker_is_running; then
    break
  fi
  worker_pgid="$(read_worker_pgid || true)"
  if [ "$worker_pgid" = "$worker_pid" ]; then
    break
  fi
  sleep 0.01
done

if owned_worker_is_running; then
  if [ -z "$worker_pgid" ] || ! valid_worker_group; then
    echo "Android entry could not establish a separate owned worker process group." >&2
    forwarding_error=70
    stop_invalid_worker
  fi
fi
entry_ready=1

if [ -n "$pending_signal" ] && owned_worker_is_running; then
  forward_signal "$pending_signal" "$pending_status"
fi

worker_status=0
while true; do
  set +e
  wait "$worker_pid"
  wait_status=$?
  set -e

  if ! owned_worker_is_running; then
    worker_status="$wait_status"
    break
  fi
  if [ "$forwarding_error" -ne 0 ]; then
    stop_invalid_worker
    continue
  fi
  if [ "$cancellation_status" -eq 0 ]; then
    echo "Android entry wait stopped while its worker was still active." >&2
    forwarding_error=72
    stop_invalid_worker
  fi
done

if [ "$forwarding_error" -ne 0 ]; then
  exit "$forwarding_error"
fi
if [ "$cancellation_status" -ne 0 ]; then
  exit "$cancellation_status"
fi
exit "$worker_status"
