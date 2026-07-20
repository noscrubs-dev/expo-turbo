# frozen_string_literal: true

require "action_controller/api"
require "spec_helper"
require "action_cable/subscription_adapter/base"
require "action_cable/subscription_adapter/subscriber_map"
require "action_cable/subscription_adapter/inline"
require "action_cable/subscription_adapter/async"
require "action_cable/subscription_adapter/test"
require "active_job/queue_adapters/test_adapter"
require "logger"

class ExpoTurboRefreshDebouncer
  def debounce(&block)
    @block = block
  end

  def flush
    callback, @block = @block, nil
    callback.call
  end
end

RSpec.describe ExpoTurbo::Rails::Streams do
  let(:controller_class) do
    Class.new(ActionController::API) do
      include ExpoTurbo::Rails::Controller
    end
  end

  around do |example|
    server = ActionCable.server
    previous_adapter = server.instance_variable_get(:@pubsub)
    previous_logger = server.config.logger
    previous_queue_adapter = ExpoTurbo::Rails::Streams::BroadcastJob.queue_adapter
    @test_adapter = ActionCable::SubscriptionAdapter::Test.new(server)
    @job_adapter = ActiveJob::QueueAdapters::TestAdapter.new
    server.config.logger = Logger.new(IO::NULL)
    server.instance_variable_set(:@pubsub, @test_adapter)
    ExpoTurbo::Rails::Streams::BroadcastJob.queue_adapter = @job_adapter
    example.run
  ensure
    server.instance_variable_set(:@pubsub, previous_adapter)
    server.config.logger = previous_logger
    ExpoTurbo::Rails::Streams::BroadcastJob.queue_adapter = previous_queue_adapter
  end

  it "normalizes streamables before signing or broadcasting" do
    expect(described_class.streamables_for("", nil, ["room", [:updates]])).to eq(["room", :updates, :expo])
    expect { described_class.streamables_for("", nil, []) }.to raise_error(ArgumentError, /nonblank/)
  end

  it "signs and broadcasts the same Expo-only stream" do
    source = controller_class.new.view_context.expo_turbo_stream_from("", "room", id: "room-source").to_s
    signed_name = source[/signed-stream-name="([^"]+)"/, 1]
    content = '<turbo-stream xmlns:Demo="urn:expo-demo" action="append" target="messages"><template><Demo:Item id="message-1"/></template></turbo-stream>'

    expect(source).to include('channel="Turbo::StreamsChannel"', 'id="room-source"')
    expect(::Turbo::StreamsChannel.verified_stream_name(signed_name)).to eq("room:expo")

    described_class.broadcast_to("", "room", content: content)

    expect(broadcast_payloads("room:expo")).to eq([content])
    expect(broadcast_payloads("room")).to be_empty
  end

  it "renders controller-owned XML before broadcasting it" do
    controller = controller_class.new

    controller.broadcast_expo_turbo_stream_to("room") do |stream|
      stream.refresh(request_id: "request-1", method: "morph", scroll: "preserve")
    end

    expect(broadcast_payloads("room:expo")).to eq([
      '<turbo-stream request-id="request-1" method="morph" scroll="preserve" action="refresh"></turbo-stream>'
    ])
  end

  it "builds immediate refresh broadcasts through the Expo-only stream" do
    controller = controller_class.new

    controller.broadcast_expo_turbo_refresh_to("room", request_id: "request-1", method: "morph", scroll: "preserve")

    expect(broadcast_payloads("room:expo")).to eq([
      '<turbo-stream request-id="request-1" method="morph" scroll="preserve" action="refresh"></turbo-stream>'
    ])
    expect(broadcast_payloads("room")).to be_empty
  end

  it "enqueues an exact Expo-only stream without broadcasting immediately" do
    streamable = Class.new do
      def to_gid_param
        "rooms/1"
      end
    end.new
    content = '<turbo-stream xmlns:Demo="urn:expo-demo" action="append" target="messages"><template><Demo:Item id="message-1"/></template></turbo-stream>'

    described_class.broadcast_later_to(streamable, :updates, content: content)

    job = @job_adapter.enqueued_jobs.fetch(0)
    arguments = ActiveJob::Arguments.deserialize(job[:args])
    source = controller_class.new.view_context.expo_turbo_stream_from(streamable, :updates).to_s
    signed_name = source[/signed-stream-name="([^"]+)"/, 1]
    expect(job[:job]).to eq(ExpoTurbo::Rails::Streams::BroadcastJob)
    expect(arguments).to eq(["rooms/1:updates:expo", {content: content}])
    expect(arguments.first).to be_a(String)
    expect(arguments.last.fetch(:content)).to be_a(String)
    expect(::Turbo::StreamsChannel.verified_stream_name(signed_name)).to eq(arguments.first)
    expect(broadcast_payloads("rooms/1:updates:expo")).to be_empty

    ActiveJob::Base.execute(job)

    expect(broadcast_payloads("rooms/1:updates:expo")).to eq([content])
    expect(broadcast_payloads("rooms/1:updates")).to be_empty
  end

  it "renders controller-owned XML before enqueueing it" do
    controller = controller_class.new

    controller.broadcast_expo_turbo_stream_later_to("room") do |stream|
      stream.refresh(request_id: "request-1", method: "morph", scroll: "preserve")
    end

    arguments = ActiveJob::Arguments.deserialize(@job_adapter.enqueued_jobs.fetch(0)[:args])
    expect(arguments).to eq([
      "room:expo",
      {content: '<turbo-stream request-id="request-1" method="morph" scroll="preserve" action="refresh"></turbo-stream>'}
    ])
    expect(broadcast_payloads("room:expo")).to be_empty
  end

  it "forwards delayed controller refresh broadcasts through the shared boundary" do
    debouncers = stub_refresh_debouncers
    controller = controller_class.new

    controller.broadcast_expo_turbo_refresh_later_to(
      "room",
      request_id: "request-1",
      method: "morph",
      scroll: "preserve"
    )

    expect(@job_adapter.enqueued_jobs).to be_empty
    debouncers.values.fetch(0).flush

    arguments = ActiveJob::Arguments.deserialize(@job_adapter.enqueued_jobs.fetch(0)[:args])
    expect(arguments).to eq([
      "room:expo",
      {content: '<turbo-stream request-id="request-1" method="morph" scroll="preserve" action="refresh"></turbo-stream>'}
    ])
  end

  it "captures a refresh stream name and request ID before delayed enqueueing" do
    debouncers = stub_refresh_debouncers
    streamable = Struct.new(:value) do
      def to_param
        value
      end
    end.new("room")

    ::Turbo.with_request_id("request-1") do
      described_class.broadcast_refresh_later_to(streamable, method: "morph", scroll: "preserve")
    end
    streamable.value = "changed"

    ::Turbo.with_request_id("request-2") do
      debouncers.values.fetch(0).flush
    end

    arguments = ActiveJob::Arguments.deserialize(@job_adapter.enqueued_jobs.fetch(0)[:args])
    expect(arguments).to eq([
      "room:expo",
      {content: '<turbo-stream request-id="request-1" method="morph" scroll="preserve" action="refresh"></turbo-stream>'}
    ])
    expect(broadcast_payloads("room:expo")).to be_empty
  end

  it "keeps an explicit nil refresh request ID absent despite ambient request state" do
    debouncers = stub_refresh_debouncers

    ::Turbo.with_request_id("ambient-request") do
      described_class.broadcast_refresh_later_to("room", request_id: nil)
      described_class.broadcast_refresh_later_to("room", request_id: "ambient-request")
    end

    expect(debouncers).to have_attributes(size: 2)
    debouncers.each_value(&:flush)

    arguments = @job_adapter.enqueued_jobs.map { |job| ActiveJob::Arguments.deserialize(job[:args]) }
    expect(arguments).to contain_exactly(
      ["room:expo", {content: '<turbo-stream action="refresh"></turbo-stream>'}],
      ["room:expo", {content: '<turbo-stream request-id="ambient-request" action="refresh"></turbo-stream>'}]
    )
  end

  it "debounces queued refreshes only by their full Expo stream and request ID" do
    debouncers = stub_refresh_debouncers

    described_class.broadcast_refresh_later_to("room", request_id: "request:one", method: "morph")
    described_class.broadcast_refresh_later_to("room", request_id: "request:one", method: "replace")
    described_class.broadcast_refresh_later_to("room", request_id: "one", method: "morph")
    described_class.broadcast_refresh_later_to("room", request_id: "other:expo:one", method: "morph")
    described_class.broadcast_refresh_later_to("room:expo:other", request_id: "one", method: "morph")

    expect(debouncers).to have_attributes(size: 4)
    expect(@job_adapter.enqueued_jobs).to be_empty

    debouncers.each_value(&:flush)

    arguments = @job_adapter.enqueued_jobs.map { |job| ActiveJob::Arguments.deserialize(job[:args]) }
    expect(arguments).to contain_exactly(
      ["room:expo", {content: '<turbo-stream request-id="request:one" method="replace" action="refresh"></turbo-stream>'}],
      ["room:expo", {content: '<turbo-stream request-id="one" method="morph" action="refresh"></turbo-stream>'}],
      ["room:expo", {content: '<turbo-stream request-id="other:expo:one" method="morph" action="refresh"></turbo-stream>'}],
      ["room:expo:other:expo", {content: '<turbo-stream request-id="one" method="morph" action="refresh"></turbo-stream>'}]
    )
  end

  it "rejects refresh template content before it can be deferred" do
    expect {
      described_class.broadcast_refresh_later_to("room", request_id: "request-1", content: "<DemoText/>")
    }.to raise_error(ArgumentError, /template-bearing Stream actions/)
    expect {
      described_class.broadcast_refresh_later_to("room", request_id: "request-1", **{"request-id" => "forged"})
    }.to raise_error(ArgumentError, /request_id must be provided/)
  end

  it "does not log raw queued broadcast arguments" do
    expect(ExpoTurbo::Rails::Streams::BroadcastJob.log_arguments?).to be(false)
  end

  it "discards queued argument deserialization failures without broadcasting" do
    job = ExpoTurbo::Rails::Streams::BroadcastJob.new(
      "room:expo",
      content: '<turbo-stream action="remove" target="notice"></turbo-stream>'
    ).serialize
    job["arguments"] = [{"_aj_globalid" => "gid://expo-turbo-rails-spec-app/MissingRecord/1"}]

    expect { ActiveJob::Base.execute(job) }.not_to raise_error
    expect(broadcast_payloads("room:expo")).to be_empty
  end

  it "rejects blank or invalid-UTF-8 broadcast content before it reaches Action Cable" do
    expect { described_class.broadcast_to("room", content: "") }.to raise_error(ArgumentError, /nonblank String/)
    expect { described_class.broadcast_later_to("room", content: "") }.to raise_error(ArgumentError, /nonblank String/)
    expect { described_class.broadcast_to("room", content: "\xFF".dup.force_encoding(Encoding::UTF_8)) }
      .to raise_error(ExpoTurbo::Rails::TemplateError, /valid UTF-8/)
    expect { described_class.broadcast_later_to("room", content: "\xFF".dup.force_encoding(Encoding::UTF_8)) }
      .to raise_error(ExpoTurbo::Rails::TemplateError, /valid UTF-8/)
    expect { described_class.broadcast_to_stream("room", content: "ok") }
      .to raise_error(ArgumentError, /stream name must be a nonblank UTF-8 String ending in :expo/)
    expect(@job_adapter.enqueued_jobs).to be_empty
    expect(broadcast_payloads("room:expo")).to be_empty
  end

  it "rejects malformed Stream fragments before sending or enqueueing them" do
    invalid_fragments = [
      '<turbo-stream action="append" target="messages"><template><Demo:Item/></template></turbo-stream>',
      '<?xml version="1.0"?><turbo-stream action="remove" target="notice"></turbo-stream>',
      '<!DOCTYPE Demo [<!ENTITY secret "not-for-errors">]><turbo-stream action="remove" target="notice"></turbo-stream>',
      '<?build data?><turbo-stream action="remove" target="notice"></turbo-stream>',
      '<turbo-stream xmlns="urn:expo-test" action="remove" target="notice"></turbo-stream>'
    ]

    invalid_fragments.each do |invalid|
      expect { described_class.broadcast_to("room", content: invalid) }
        .to raise_error(ExpoTurbo::Rails::TemplateError) { |error| expect(error.message).not_to include("Demo:Item", "not-for-errors") }
      expect { described_class.broadcast_later_to("room", content: invalid) }
        .to raise_error(ExpoTurbo::Rails::TemplateError, /well-formed XML Stream fragments/)
    end

    expect { ExpoTurbo::Rails::Streams::BroadcastJob.new.perform("room:expo", content: invalid_fragments.first) }
      .to raise_error(ExpoTurbo::Rails::TemplateError, /well-formed XML Stream fragments/)

    expect(@job_adapter.enqueued_jobs).to be_empty
    expect(broadcast_payloads("room:expo")).to be_empty
  end

  it "does not allow a source to override its signed standard-channel descriptor" do
    context = controller_class.new.view_context

    [
      {channel: "PrivateChannel"},
      {"channel" => "PrivateChannel"},
      {"signed-stream-name": "forged"},
      {"signed-stream-name" => "forged"},
      {"data-channel" => "PrivateChannel"},
      {"data-signed-stream-name" => "forged"}
    ].each do |attributes|
      expect { context.expo_turbo_stream_from("room", **attributes) }
        .to raise_error(ArgumentError, /reserve channel and signed stream name/)
    end
  end

  it "does not accept content and a block for a queued controller broadcast" do
    controller = controller_class.new

    expect {
      controller.broadcast_expo_turbo_stream_later_to("room", content: "<turbo-stream/>") { |stream| stream.remove("room") }
    }.to raise_error(ArgumentError, /content or a block/)
    expect(@job_adapter.enqueued_jobs).to be_empty
  end

  def broadcast_payloads(stream)
    @test_adapter.broadcasts(stream).map { |message| ActiveSupport::JSON.decode(message) }
  end

  def stub_refresh_debouncers
    debouncers = {}
    allow(::Turbo::ThreadDebouncer).to receive(:for) do |key|
      debouncers[key] ||= ExpoTurboRefreshDebouncer.new
    end
    debouncers
  end
end
