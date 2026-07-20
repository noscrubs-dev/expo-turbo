# frozen_string_literal: true

require "action_controller/api"
require "spec_helper"
require "action_cable/subscription_adapter/base"
require "action_cable/subscription_adapter/subscriber_map"
require "action_cable/subscription_adapter/inline"
require "action_cable/subscription_adapter/async"
require "action_cable/subscription_adapter/test"
require "logger"

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
    @test_adapter = ActionCable::SubscriptionAdapter::Test.new(server)
    server.config.logger = Logger.new(IO::NULL)
    server.instance_variable_set(:@pubsub, @test_adapter)
    example.run
  ensure
    server.instance_variable_set(:@pubsub, previous_adapter)
    server.config.logger = previous_logger
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

  it "rejects blank or invalid-UTF-8 broadcast content before it reaches Action Cable" do
    expect { described_class.broadcast_to("room", content: "") }.to raise_error(ArgumentError, /nonblank String/)
    expect { described_class.broadcast_to("room", content: "\xFF".dup.force_encoding(Encoding::UTF_8)) }
      .to raise_error(ExpoTurbo::Rails::TemplateError, /valid UTF-8/)
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

  def broadcast_payloads(stream)
    @test_adapter.broadcasts(stream).map { |message| ActiveSupport::JSON.decode(message) }
  end
end
