#!/usr/bin/env ruby

worker = File.expand_path("run-android-maestro.sh", __dir__)
poll_attempts = 100
poll_interval = 0.01

def wait_for_worker(worker_pid)
  Process.waitpid2(worker_pid, Process::WNOHANG)&.last
rescue Errno::ECHILD
  nil
end

def stop_unproved_worker(worker_pid, poll_attempts, poll_interval)
  begin
    Process.kill("TERM", worker_pid)
  rescue Errno::ESRCH
    return
  end

  poll_attempts.times do
    return if wait_for_worker(worker_pid)

    sleep poll_interval
  end

  begin
    Process.kill("KILL", worker_pid)
  rescue Errno::ESRCH
    return
  end
  Process.waitpid(worker_pid)
rescue Errno::ECHILD
  nil
end

def process_group_exists?(worker_pgid)
  Process.kill(0, -worker_pgid)
  true
rescue Errno::ESRCH
  false
rescue Errno::EPERM
  true
end

def reap_worker_bounded(worker_pid, poll_attempts, poll_interval)
  poll_attempts.times do
    worker_status = wait_for_worker(worker_pid)
    return worker_status if worker_status

    sleep poll_interval
  end
  nil
end

def forward_queued_signals(pending_signals, worker_pgid)
  while (signal = pending_signals.shift)
    begin
      Process.kill(signal, -worker_pgid)
    rescue Errno::ESRCH
      return false
    rescue Errno::EPERM
      warn "Android entry could not forward #{signal} to its owned worker process group (EPERM)."
    end
  end
  true
end

def stop_proved_worker_group(
  worker_pid,
  worker_pgid,
  pending_signals,
  poll_attempts,
  poll_interval
)
  unless worker_pid > 1 && worker_pgid > 1 && worker_pgid == worker_pid
    warn "Android entry refused cleanup without its prior worker process-group proof."
    return [wait_for_worker(worker_pid), false]
  end

  begin
    Process.kill("TERM", -worker_pgid)
  rescue Errno::ESRCH
    # The proved group exited before cleanup sent TERM.
  rescue Errno::EPERM
    warn "Android entry could not terminate its owned worker process group (EPERM)."
  end

  worker_status = nil
  poll_attempts.times do
    worker_status ||= wait_for_worker(worker_pid)
    forward_queued_signals(pending_signals, worker_pgid)
    unless process_group_exists?(worker_pgid)
      return [worker_status || reap_worker_bounded(worker_pid, poll_attempts, poll_interval), true]
    end

    sleep poll_interval
  end

  begin
    Process.kill("KILL", -worker_pgid)
  rescue Errno::ESRCH
    # The proved group exited after the bounded TERM wait.
  rescue Errno::EPERM
    warn "Android entry could not kill its owned worker process group (EPERM)."
  end

  poll_attempts.times do
    worker_status ||= wait_for_worker(worker_pid)
    forward_queued_signals(pending_signals, worker_pgid)
    unless process_group_exists?(worker_pgid)
      return [worker_status || reap_worker_bounded(worker_pid, poll_attempts, poll_interval), true]
    end

    sleep poll_interval
  end

  warn "Android entry owned worker process group survived bounded cleanup."
  [worker_status, false]
end

pending_signals = []
cancellation_status = nil
group_proven = false
worker_pgid = nil

{
  "INT" => 130,
  "TERM" => 143,
}.each do |signal, status|
  Signal.trap(signal) do
    pending_signals << signal
    cancellation_status ||= status
  end
end

worker_pid = Process.spawn([worker, worker], pgroup: true)

worker_status = nil
poll_attempts.times do
  worker_status = wait_for_worker(worker_pid)
  break if worker_status

  begin
    worker_pgid = Process.getpgid(worker_pid)
    if worker_pid > 1 && worker_pgid == worker_pid
      group_proven = true
      break
    end

    warn "Android entry could not establish a separate owned worker process group."
    stop_unproved_worker(worker_pid, poll_attempts, poll_interval)
    exit 70
  rescue Errno::ESRCH
    # The directly owned child exited before its group could be read. Reap it
    # below so its genuine status wins over startup validation.
  end

  sleep poll_interval
end

unless worker_status || group_proven
  worker_status = wait_for_worker(worker_pid)
  unless worker_status
    warn "Android entry could not establish a separate owned worker process group."
    stop_unproved_worker(worker_pid, poll_attempts, poll_interval)
    exit 70
  end
end

cancellation_status = nil if worker_status && !group_proven

cancellation_deadline = nil
signal_forwarded = false

until worker_status
  worker_status = wait_for_worker(worker_pid)
  if worker_status
    if group_proven && process_group_exists?(worker_pgid)
      warn "Android entry worker exited while its owned process group still had live descendants."
      _, group_stopped = stop_proved_worker_group(
        worker_pid,
        worker_pgid,
        pending_signals,
        poll_attempts,
        poll_interval,
      )
      warn "Android entry could not remove the live descendant process group." unless group_stopped
      exit 70
    end
    cancellation_status = nil unless signal_forwarded
    break
  end

  cancellation_deadline ||= Process.clock_gettime(Process::CLOCK_MONOTONIC) + 1 if cancellation_status

  while (signal = pending_signals.shift)
    begin
      Process.kill(signal, -worker_pgid)
      signal_forwarded = true
    rescue Errno::ESRCH, Errno::EPERM => error
      worker_status = wait_for_worker(worker_pid)
      group_exists = process_group_exists?(worker_pgid)
      if worker_status && !group_exists
        cancellation_status = nil unless signal_forwarded
        break
      end

      warn "Android entry could not forward #{signal} to its owned worker process group (#{error.class.name.delete_prefix("Errno::")})."
      _, group_stopped = stop_proved_worker_group(
        worker_pid,
        worker_pgid,
        pending_signals,
        poll_attempts,
        poll_interval,
      )
      warn "Android entry could not remove the live descendant process group." unless group_stopped
      exit 70
    end
  end
  next if worker_status

  if cancellation_deadline && Process.clock_gettime(Process::CLOCK_MONOTONIC) >= cancellation_deadline
    warn "Android entry worker did not stop after cancellation; cleaning its owned process group."
    _, group_stopped = stop_proved_worker_group(
      worker_pid,
      worker_pgid,
      pending_signals,
      poll_attempts,
      poll_interval,
    )
    unless group_stopped
      warn "Android entry could not remove the cancelled worker process group."
      exit 70
    end
    exit cancellation_status
  end

  sleep poll_interval
end

if cancellation_status
  exit cancellation_status
end
if worker_status.signaled?
  exit 128 + worker_status.termsig
end

exit worker_status.exitstatus
