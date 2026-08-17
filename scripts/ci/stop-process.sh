#!/usr/bin/env bash

# Stop one child process without letting CI cleanup wait forever. Production
# passes fixed limits. Tests pass shorter limits without using environment
# variables that could weaken the CI bound.
stop_process() {
  local pid="$1"
  local name="$2"
  local term_checks="$3"
  local kill_checks="$4"
  local poll_interval="$5"
  local _

  if [ -z "$pid" ]; then
    return
  fi

  kill -TERM "$pid" 2>/dev/null || true
  for _ in $(seq 1 "$term_checks"); do
    if ! kill -0 "$pid" 2>/dev/null; then
      wait "$pid" 2>/dev/null || true
      return
    fi
    sleep "$poll_interval"
  done

  if kill -0 "$pid" 2>/dev/null; then
    echo "$name did not stop after TERM; sending KILL." >&2
    kill -KILL "$pid" 2>/dev/null || true
  fi

  for _ in $(seq 1 "$kill_checks"); do
    # kill -0 also succeeds for an exited child that Bash has not reaped yet.
    # A zombie is safe to wait for; a running or uninterruptible child is not.
    local process_state=""
    process_state="$(ps -o stat= -p "$pid" 2>/dev/null || true)"
    if ! kill -0 "$pid" 2>/dev/null || [[ "$process_state" == *Z* ]]; then
      wait "$pid" 2>/dev/null || true
      return
    fi
    sleep "$poll_interval"
  done

  # Do not call wait while the process still exists. An uninterruptible child
  # must not stop the trap from writing environment evidence and returning the
  # suite result.
  if kill -0 "$pid" 2>/dev/null; then
    echo "$name still exists after KILL; cleanup will not wait for it." >&2
    return
  fi
  wait "$pid" 2>/dev/null || true
}
