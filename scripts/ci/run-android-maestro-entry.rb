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
    rescue Errno::ESRCH
      # The group disappeared after the last wait check. Reap the child and
      # preserve its genuine status instead of replacing it with cancellation.
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
