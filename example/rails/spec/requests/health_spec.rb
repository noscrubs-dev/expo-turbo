# frozen_string_literal: true

require "rails_helper"

RSpec.describe "standalone demo host" do
  it "boots the sibling gem without adding routes" do
    get "/up"

    expect(response).to have_http_status(:ok)
    expect(Rails.gem_version).to eq(Gem::Version.new("8.1.3"))
    expect(Gem.loaded_specs.fetch("turbo-rails").version).to eq(Gem::Version.new("2.0.23"))
    expect(ExpoTurbo::Rails::Engine).to be < Rails::Engine
    expect(ExpoTurbo::Rails::Engine.routes.routes).to be_empty
  end

  it "serves host-owned XML through the opt-in gem concern" do
    host! "localhost"
    get "/api/expo_turbo/demo/document"

    document = Nokogiri::XML(response.body) { |config| config.strict }

    expect(response).to have_http_status(:ok)
    expect(response.media_type).to eq(ExpoTurbo::Rails::MIME_TYPE)
    expect(response.charset).to eq("utf-8")
    expect(response.body.dup.force_encoding(Encoding::UTF_8)).to be_valid_encoding
    expect(document.root.name).to eq("DemoScreen")
    expect(document.at_xpath("//DemoText[@id='welcome']")&.text).to eq("Standalone Rails host")
    source = document.at_xpath("//turbo-cable-stream-source[@id='demo-stream-source']")
    expect(source&.[]("channel")).to eq("Turbo::StreamsChannel")
    expect(::Turbo::StreamsChannel.verified_stream_name(source["signed-stream-name"])).to eq("demo-stream:expo")
  end

  it "serves standard sibling Stream fragments from confined XML partials" do
    host! "localhost"
    get "/api/expo_turbo/demo/stream"

    fragment = Nokogiri::XML("<root>#{response.body}</root>") { |config| config.strict }
    streams = fragment.xpath("/root/turbo-stream")

    expect(response).to have_http_status(:ok)
    expect(response.media_type).to eq(ExpoTurbo::Rails::TURBO_STREAM_MIME_TYPE)
    expect(streams.map { |stream| stream["action"] }).to eq(%w[update append])
    expect(streams.first.at_xpath("./template/DemoText")&.text).to eq("Rendered from XML partial")
    expect(streams.first.at_xpath("./template/DemoText")&.text).not_to eq("HTML fallback")
    expect(streams.last.at_xpath("./template/DemoText")&.text).to eq("Second sibling")
  end

  it "broadcasts public XML only to the Expo stream namespace" do
    adapter = ActionCable.server.pubsub
    payload = '<turbo-stream xmlns:Demo="urn:expo-demo" action="update" target="demo-stream-message"><template><Demo:Text>Broadcast</Demo:Text></template></turbo-stream>'

    adapter.clear
    ExpoTurbo::Rails::Streams.broadcast_to("demo-stream", content: payload)

    messages = adapter.broadcasts("demo-stream:expo").map { |message| ActiveSupport::JSON.decode(message) }
    expect(messages).to eq([payload])
    expect(adapter.broadcasts("demo-stream")).to be_empty
  ensure
    adapter&.clear
  end

  it "serves a matching XML Frame for a native Frame request" do
    host! "localhost"
    get "/api/expo_turbo/demo/frame", headers: {"Turbo-Frame" => "demo-frame"}

    frame = Nokogiri::XML(response.body) { |config| config.strict }.root

    expect(response).to have_http_status(:ok)
    expect(response.media_type).to eq(ExpoTurbo::Rails::MIME_TYPE)
    expect(response.charset).to eq("utf-8")
    expect(response.headers["Vary"]).to eq("Turbo-Frame")
    expect(frame.name).to eq("turbo-frame")
    expect(frame["id"]).to eq("demo-frame")
    expect(frame.at_xpath("./DemoText[@id='demo-frame-message']")&.text)
      .to eq("Rendered from an XML Frame")
  end

  it "returns authoritative XML Frame validation errors" do
    host! "localhost"
    get "/api/expo_turbo/demo/frame?state=invalid", headers: {"Turbo-Frame" => "demo-frame"}

    frame = Nokogiri::XML(response.body) { |config| config.strict }.root

    expect(response).to have_http_status(:unprocessable_content)
    expect(response.media_type).to eq(ExpoTurbo::Rails::MIME_TYPE)
    expect(frame.name).to eq("turbo-frame")
    expect(frame["id"]).to eq("demo-frame")
    expect(frame.at_xpath("./DemoText[@id='demo-frame-message']")&.text)
      .to eq("Frame validation failed")
  end
end
