# frozen_string_literal: true

require "action_controller/api"
require "spec_helper"

RSpec.describe ExpoTurbo::Rails::Streams::Helper do
  let(:controller_class) do
    Class.new(ActionController::API) do
      include ExpoTurbo::Rails::Controller
    end
  end

  it "renders a protected source with the custom channel and opaque grant" do
    source = controller_class.new.view_context.expo_turbo_protected_stream_from(
      "room",
      grant: "opaque-grant",
      id: "protected-source",
      data: {room_name: "room #1"}
    ).to_s
    signed_name = source[/signed-stream-name="([^"]+)"/, 1]

    expect(source).to include(
      'channel="ExpoTurbo::Rails::Cable::ProtectedStreamsChannel"',
      'data-grant="opaque-grant"',
      'data-room-name="room #1"',
      'id="protected-source"'
    )
    expect(::Turbo::StreamsChannel.verified_stream_name(signed_name)).to eq("room:expo")
  end

  it "does not allow callers to forge the protected source descriptor or grant" do
    context = controller_class.new.view_context

    [
      {channel: "OtherChannel"},
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
