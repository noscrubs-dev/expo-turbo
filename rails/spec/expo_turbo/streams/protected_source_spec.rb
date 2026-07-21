# frozen_string_literal: true

require "action_controller/api"
require "spec_helper"

RSpec.describe ExpoTurbo::Rails::Streams::Helper do
  let(:controller_class) do
    Class.new(ActionController::API) do
      include ExpoTurbo::Rails::Controller
    end
  end

  around do |example|
    configuration = ExpoTurbo::Rails::Cable.instance_variable_get(:@configuration)
    ExpoTurbo::Rails::Cable.remove_instance_variable(:@configuration) if ExpoTurbo::Rails::Cable.instance_variable_defined?(:@configuration)
    ExpoTurbo::Rails::Cable.configure(
      credential_extractor: ->(_) { "credential" },
      subject_resolver: ->(_) { "subject" },
      subscription_authorizer: ->(**) { true },
      subscription_error_reporter: ->(**) {}
    )
    example.run
  ensure
    ExpoTurbo::Rails::Cable.instance_variable_set(:@configuration, configuration) if configuration
  end

  it "renders an isolated protected source with a custom channel and opaque grant" do
    source = controller_class.new.view_context.expo_turbo_protected_stream_from(
      "room",
      grant: "opaque-grant",
      id: "protected-source",
      data: {room_name: "room #1"}
    ).to_s
    token = source[/signed-stream-name="([^"]+)"/, 1]

    expect(source).to include(
      'channel="ExpoTurbo::Rails::Cable::ProtectedStreamsChannel"',
      'data-grant="opaque-grant"',
      'data-room-name="room #1"',
      'id="protected-source"'
    )
    expect(ExpoTurbo::Rails::Cable.verified_protected_stream_name(token)).to eq("room:expo")
    expect(::Turbo::StreamsChannel.verified_stream_name(token)).to be_nil
  end

  it "does not allow callers to forge the protected descriptor or grant" do
    context = controller_class.new.view_context

    [
      {channel: "OtherChannel"},
      {signed_stream_name: "forged"},
      {"signed-stream-name": "forged"},
      {"data-grant": "forged"},
      {data: {grant: "forged"}},
      {"data" => {"grant" => "forged"}}
    ].each do |attributes|
      expect { context.expo_turbo_protected_stream_from("room", grant: "opaque-grant", **attributes) }
        .to raise_error(ArgumentError, /reserve channel, signed stream name, and grant/)
    end

    expect { context.expo_turbo_protected_stream_from("room", grant: "") }
      .to raise_error(ArgumentError, /nonblank UTF-8/)
  end
end
