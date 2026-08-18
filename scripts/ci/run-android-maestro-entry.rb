#!/usr/bin/env ruby

worker = File.expand_path("run-android-maestro.sh", __dir__)

def wait_for_worker(worker_pid)
  Process.waitpid2(worker_pid, Process::WNOHANG)&.last
rescue Errno::ECHILD
  nil
end

def stop_unproved_worker(worker_pid)
  begin
    Process.kill("TERM", worker_pid)
  rescue Errno::ESRCH
    return
  end

  100.times do
    return if wait_for_worker(worker_pid)

    sleep 0.01
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

def process_group_exists?(worker_pid)
  Process.kill(0, -worker_pid)
  true
rescue Errno::ESRCH
  false
rescue Errno::EPERM
  true
end

def reap_worker_bounded(worker_pid)
  100.times do
    worker_status = wait_for_worker(worker_pid)
    return worker_status if worker_status

    sleep 0.01
  end
  nil
end

def stop_proved_worker_group(worker_pid)
  begin
    worker_pgid = Process.getpgid(worker_pid)
  rescue Errno::ESRCH
    worker_status = reap_worker_bounded(worker_pid)
    return worker_status if worker_status

    stop_unproved_worker(worker_pid)
    return
  end

  unless worker_pid > 1 && worker_pgid == worker_pid
    stop_unproved_worker(worker_pid)
    return
  end

  begin
    Process.kill("TERM", -worker_pid)
  rescue Errno::ESRCH
    # The group exited after ownership was checked.
  rescue Errno::EPERM
    warn "Android entry could not terminate its owned worker process group (EPERM)."
  end

  worker_status = nil
  100.times do
    worker_status ||= wait_for_worker(worker_pid)
    unless process_group_exists?(worker_pid)
      return worker_status || reap_worker_bounded(worker_pid)
    end

    sleep 0.01
  end

  begin
    Process.kill("KILL", -worker_pid)
  rescue Errno::ESRCH
    # The group exited after the bounded TERM wait.
  rescue Errno::EPERM
    warn "Android entry could not kill its owned worker process group (EPERM)."
  end

  100.times do
    worker_status ||= wait_for_worker(worker_pid)
    unless process_group_exists?(worker_pid)
      return worker_status || reap_worker_bounded(worker_pid)
    end

    sleep 0.01
  end

  warn "Android entry owned worker process group survived bounded cleanup."
  worker_status
end

pending_signal = nil
forwarded_status = nil
group_proven = false

{
  "INT" => 130,
  "TERM" => 143,
}.each do |signal, status|
  Signal.trap(signal) do
    pending_signal ||= [signal, status]
  end
end

worker_pid = Process.spawn(worker, pgroup: true)

worker_status = nil
100.times do
  worker_status = wait_for_worker(worker_pid)
  break if worker_status

  begin
    worker_pgid = Process.getpgid(worker_pid)
    if worker_pid > 1 && worker_pgid == worker_pid
      group_proven = true
      break
    end

    warn "Android entry could not establish a separate owned worker process group."
    stop_unproved_worker(worker_pid)
    exit 70
  rescue Errno::ESRCH
    # The directly owned child exited before its group could be read. Reap it
    # below so its genuine status wins over startup validation.
  end

  sleep 0.01
end

unless worker_status || group_proven
  worker_status = wait_for_worker(worker_pid)
  unless worker_status
    warn "Android entry could not establish a separate owned worker process group."
    stop_unproved_worker(worker_pid)
    exit 70
  end
end

until worker_status
  worker_status = wait_for_worker(worker_pid)
  break if worker_status

  if pending_signal && !forwarded_status
    signal, status = pending_signal
    begin
      Process.kill(signal, -worker_pid)
      forwarded_status = status
    rescue Errno::ESRCH, Errno::EPERM => error
      # macOS can report EPERM for a group that contains only an exited child.
      # Reap immediately so the child's genuine status wins in that race.
      worker_status = wait_for_worker(worker_pid)
      next if worker_status

      warn "Android entry could not forward #{signal} to its owned worker process group (#{error.class.name.delete_prefix("Errno::")})."
      stop_proved_worker_group(worker_pid)
      exit 70
    end
  end

  sleep 0.01
end

if forwarded_status
  exit forwarded_status
end
if worker_status.signaled?
  exit 128 + worker_status.termsig
end

exit worker_status.exitstatus
