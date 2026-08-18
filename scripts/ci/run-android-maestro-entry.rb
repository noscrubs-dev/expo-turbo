#!/usr/bin/env ruby

worker = File.expand_path("run-android-maestro.sh", __dir__)

class AndroidMaestroSupervisor
  READY_TIMEOUT = 1.0
  CANCEL_TIMEOUT = 1.0
  TERM_GRACE = 0.25
  REAP_TIMEOUT = 1.0
  POLL_INTERVAL = 0.01
  SAFETY_STATUS = 70
  SIGNAL_STATUS = {"I" => 130, "T" => 143}.freeze

  def initialize(worker)
    @worker = worker
    @signal_reader, @signal_writer = IO.pipe
    @signal_reader.close_on_exec = true
    @signal_writer.close_on_exec = true
    @first_signal = nil
    @prefetched_signals = []
    @trap_failed = false
    @cleanup_failed = false
    @anchor_pid = nil
    @anchor_pgid = nil
    @anchor_reader = nil
    @worker_pid = nil
    @worker_proven = false
    @worker_status = nil
    @anchor_reaped = false
    @worker_reaped = false
  end

  def run
    install_and_prove_signal_queue
    start_and_prove_anchor

    drain_signals(forward: false)
    return finish_without_worker if cancelled?

    spawn_worker
    drain_signals(forward: true)
    prove_worker_or_capture_fast_exit
    run_worker unless @worker_status
    sweep_group
    result_status
  rescue => error
    warn "Android entry safety failure: #{error.class}: #{error.message}"
    @cleanup_failed = true
    cleanup_after_error
    SAFETY_STATUS
  ensure
    @signal_reader&.close unless @signal_reader&.closed?
    @signal_writer&.close unless @signal_writer&.closed?
    @anchor_reader&.close unless @anchor_reader&.closed?
  end

  private

  def monotonic
    Process.clock_gettime(Process::CLOCK_MONOTONIC)
  end

  def enqueue_signal(code)
    @first_signal ||= code if SIGNAL_STATUS.key?(code)
    result = @signal_writer.write_nonblock(code, exception: false)
    @trap_failed = true unless result == 1
  rescue
    @trap_failed = true
  end

  def install_and_prove_signal_queue
    {"INT" => "I", "TERM" => "T"}.each do |signal, code|
      Signal.trap(signal) { enqueue_signal(code) }
    end

    previous = Signal.trap("USR1") { enqueue_signal("V") }
    Process.kill("USR1", Process.pid)
    deadline = monotonic + READY_TIMEOUT
    validated = false
    until validated || monotonic >= deadline
      ready = IO.select([@signal_reader], nil, nil, deadline - monotonic)
      break unless ready

      bytes = @signal_reader.read_nonblock(4096, exception: false)
      next if bytes == :wait_readable
      raise "Ruby trap self-pipe validation failed" if bytes.nil?

      bytes.each_char do |code|
        if code == "V"
          validated = true
        elsif SIGNAL_STATUS.key?(code)
          @prefetched_signals << code
        else
          raise "Ruby trap self-pipe validation failed"
        end
      end
    end
    raise "Ruby trap self-pipe validation failed" unless validated && !@trap_failed
  ensure
    Signal.trap("USR1", previous) if defined?(previous) && previous
  end

  def start_and_prove_anchor
    @anchor_reader, anchor_writer = IO.pipe
    @anchor_reader.close_on_exec = true
    anchor_writer.close_on_exec = true

    @anchor_pid = fork do
      begin
        Signal.trap("INT", "IGNORE")
        Signal.trap("TERM", "IGNORE")
        @signal_reader.close
        @signal_writer.close
        @anchor_reader.close
        Process.setpgid(0, 0)
        exit! SAFETY_STATUS unless Process.pid > 1 && Process.getpgrp == Process.pid
        anchor_writer.write("R")
        loop { sleep 60 }
      rescue
        exit! SAFETY_STATUS
      end
    end
    anchor_writer.close

    deadline = monotonic + READY_TIMEOUT
    byte = nil
    until byte || monotonic >= deadline
      ready = IO.select([@anchor_reader, @signal_reader], nil, nil, deadline - monotonic)
      break unless ready

      readable = ready.first
      drain_signals(forward: false) if readable.include?(@signal_reader)
      if readable.include?(@anchor_reader)
        byte = @anchor_reader.read_nonblock(1, exception: false)
        raise "anchor liveness channel closed during startup" if byte.nil?
      end
    end
    raise "anchor did not become ready before the startup deadline" unless byte == "R"

    @anchor_pgid = Process.getpgid(@anchor_pid)
    parent_pgid = Process.getpgrp
    unless @anchor_pid > 1 && @anchor_pgid > 1 && @anchor_pgid == @anchor_pid && @anchor_pgid != parent_pgid
      raise "anchor PID and process-group proof failed"
    end
  rescue Errno::ESRCH, Errno::EPERM => error
    warn "Android entry anchor proof got #{error.class.name.delete_prefix("Errno::")}."
    raise "anchor PID and process-group proof failed"
  end

  def spawn_worker
    # The argv array prevents paths with spaces from becoming shell input.
    @worker_pid = Process.spawn([@worker, @worker], pgroup: @anchor_pgid)
  end

  def prove_worker_or_capture_fast_exit
    worker_pgid = Process.getpgid(@worker_pid)
    unless @worker_pid > 1 && worker_pgid == @anchor_pgid
      raise "worker process-group membership proof failed"
    end
    @worker_proven = true
  rescue Errno::ESRCH
    # A direct child can finish before getpgid. Its WNOHANG status is still
    # authoritative, and the anchor continues to pin the group for the sweep.
    drain_signals(forward: true)
    @worker_status = reap_once(@worker_pid, :worker)
    raise "worker vanished before membership proof" unless @worker_status
  rescue Errno::EPERM => error
    warn "Android entry worker proof got #{error.class.name.delete_prefix("Errno::")}."
    raise "worker process-group membership proof failed"
  end

  def run_worker
    cancellation_deadline = nil

    loop do
      drain_signals(forward: true)
      raise "signal trap queue overflowed" if @trap_failed
      cancellation_deadline ||= monotonic + CANCEL_TIMEOUT if cancelled?

      if anchor_eof?
        raise "anchor liveness channel closed while the worker was running"
      end

      @worker_status = reap_once(@worker_pid, :worker)
      break if @worker_status

      if cancellation_deadline && monotonic >= cancellation_deadline
        warn "Android entry worker did not stop before the cancellation deadline."
        break
      end

      timeout = cancellation_deadline ? [cancellation_deadline - monotonic, POLL_INTERVAL].min : POLL_INTERVAL
      IO.select([@signal_reader, @anchor_reader], nil, nil, [timeout, 0].max)
    end
  end

  def drain_signals(forward:)
    process_signal_codes(@prefetched_signals.shift(@prefetched_signals.length), forward: forward)
    loop do
      bytes = @signal_reader.read_nonblock(4096, exception: false)
      break if bytes == :wait_readable
      raise "signal queue closed unexpectedly" if bytes.nil?

      process_signal_codes(bytes.each_char, forward: forward)
    end
  end

  def process_signal_codes(codes, forward:)
    codes.each do |code|
      next if code == "V"
      raise "signal queue contained an invalid event" unless SIGNAL_STATUS.key?(code)
      @first_signal ||= code
      forward_signal(code) if forward && @anchor_pgid
    end
  end

  def forward_signal(code)
    signal = (code == "I") ? "INT" : "TERM"
    Process.kill(signal, -@anchor_pgid)
  rescue Errno::ESRCH, Errno::EPERM => error
    warn "Android entry signal #{signal} forward got #{error.class.name.delete_prefix("Errno::")}."
    @cleanup_failed = true
  end

  def anchor_eof?
    value = @anchor_reader.read_nonblock(1, exception: false)
    value.nil?
  end

  def finish_without_worker
    sweep_group
    result_status
  end

  def sweep_group
    return unless proved_anchor?

    signal_group("TERM")
    grace_deadline = monotonic + TERM_GRACE
    while monotonic < grace_deadline
      drain_signals(forward: true)
      @worker_status ||= reap_once(@worker_pid, :worker) if @worker_pid
      if anchor_eof?
        warn "Android entry anchor died before the group KILL sweep."
        @cleanup_failed = true
        break
      end
      timeout = [[grace_deadline - monotonic, POLL_INTERVAL].min, 0].max
      IO.select([@signal_reader, @anchor_reader], nil, nil, timeout)
    end
    drain_signals(forward: true)

    signal_group("KILL")
    final_group_probe
    reap_children_bounded
  end

  def signal_group(signal)
    raise "refused a group signal without the live anchor proof" unless proved_anchor? && !@anchor_reaped
    Process.kill(signal, -@anchor_pgid)
  rescue Errno::ESRCH, Errno::EPERM => error
    warn "Android entry group #{signal} got #{error.class.name.delete_prefix("Errno::")}."
    @cleanup_failed = true
  end

  def final_group_probe
    Process.kill(0, -@anchor_pgid)
  rescue Errno::ESRCH, Errno::EPERM => error
    # This is evidence only. It must never cause another signal to this PGID.
    warn "Android entry final group probe got #{error.class.name.delete_prefix("Errno::")} (advisory)."
  end

  def reap_children_bounded
    deadline = monotonic + REAP_TIMEOUT
    loop do
      drain_signals(forward: false)
      @worker_status ||= reap_once(@worker_pid, :worker) if @worker_pid && !@worker_reaped
      reap_once(@anchor_pid, :anchor) unless @anchor_reaped
      break if (@worker_pid.nil? || @worker_reaped) && @anchor_reaped
      break if monotonic >= deadline

      IO.select([@signal_reader], nil, nil, POLL_INTERVAL)
    end

    unless @worker_pid.nil? || @worker_reaped
      warn "Android entry direct worker exceeded the bounded reap deadline."
      @cleanup_failed = true
    end
    unless @anchor_reaped
      warn "Android entry anchor exceeded the bounded reap deadline."
      @cleanup_failed = true
    end
  end

  def reap_once(pid, child)
    return nil unless pid
    result = Process.waitpid2(pid, Process::WNOHANG)
    return nil unless result

    status = result.last
    child == :anchor ? @anchor_reaped = true : @worker_reaped = true
    status
  rescue Errno::ECHILD
    child == :anchor ? @anchor_reaped = true : @worker_reaped = true
    nil
  end

  def cleanup_after_error
    if proved_anchor? && !@anchor_reaped
      sweep_group
    elsif @anchor_pid && !@anchor_reaped
      stop_unproved_child(@anchor_pid, :anchor)
    end
    stop_unproved_child(@worker_pid, :worker) if @worker_pid && !@worker_reaped && !@worker_proven
  rescue => cleanup_error
    warn "Android entry bounded cleanup failed: #{cleanup_error.class}: #{cleanup_error.message}"
  end

  def stop_unproved_child(pid, child)
    begin
      Process.kill("TERM", pid)
    rescue Errno::ESRCH, Errno::EPERM => error
      warn "Android entry unproved child TERM got #{error.class.name.delete_prefix("Errno::")}."
    end
    deadline = monotonic + TERM_GRACE
    until monotonic >= deadline
      return if reap_once(pid, child)
      sleep POLL_INTERVAL
    end
    begin
      Process.kill("KILL", pid)
    rescue Errno::ESRCH, Errno::EPERM => error
      warn "Android entry unproved child KILL got #{error.class.name.delete_prefix("Errno::")}."
    end
    deadline = monotonic + REAP_TIMEOUT
    until monotonic >= deadline
      return if reap_once(pid, child)
      sleep POLL_INTERVAL
    end
  end

  def proved_anchor?
    @anchor_pid && @anchor_pid > 1 && @anchor_pgid == @anchor_pid && @anchor_pgid != Process.getpgrp
  end

  def cancelled?
    SIGNAL_STATUS.key?(@first_signal)
  end

  def result_status
    return SAFETY_STATUS if @cleanup_failed || @trap_failed
    return SIGNAL_STATUS.fetch(@first_signal) if cancelled?
    return SAFETY_STATUS unless @worker_status
    return 128 + @worker_status.termsig if @worker_status.signaled?

    @worker_status.exitstatus
  end
end

exit AndroidMaestroSupervisor.new(worker).run
