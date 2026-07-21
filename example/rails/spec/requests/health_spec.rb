# frozen_string_literal: true

require "rails_helper"
require "expo_turbo/rails/testing"
require "timeout"

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

    document = ExpoTurbo::Rails::Testing.parse_document(response.body)

    expect(response).to have_http_status(:ok)
    expect(response.media_type).to eq(ExpoTurbo::Rails::MIME_TYPE)
    expect(response.charset).to eq("utf-8")
    expect(response.body.dup.force_encoding(Encoding::UTF_8)).to be_valid_encoding
    expect(document.root.name).to eq("Gallery")
    expect(document.at_xpath("//DemoText[@id='welcome']")&.text).to eq("Standalone Rails host")
    expect(document.at_xpath("//DemoText[@id='demo-stream-message']")&.text)
      .to eq("Waiting for a public Action Cable broadcast")
    source = document.at_xpath("//turbo-cable-stream-source[@id='demo-stream-source']")
    expect(source&.[]("channel")).to eq("Turbo::StreamsChannel")
    expect(::Turbo::StreamsChannel.verified_stream_name(source["signed-stream-name"])).to eq("demo-stream:expo")
  end

  it "serves standard sibling Stream fragments from confined XML partials" do
    host! "localhost"
    get "/api/expo_turbo/demo/stream"

    fragment = ExpoTurbo::Rails::Testing.parse_stream_fragment(response.body)
    streams = fragment.xpath("/expo-turbo-test-root/turbo-stream")

    expect(response).to have_http_status(:ok)
    expect(response.media_type).to eq(ExpoTurbo::Rails::TURBO_STREAM_MIME_TYPE)
    expect(streams.map { |stream| stream["action"] }).to eq(%w[update append])
    expect(streams.first.at_xpath("./template/DemoText")&.text).to eq("Rendered from XML partial")
    expect(streams.first.at_xpath("./template/DemoText")&.text).not_to eq("HTML fallback")
    expect(streams.last.at_xpath("./template/DemoText")&.text).to eq("Second sibling")
  end

  it "delivers a public XML Stream through the Redis-backed Expo Action Cable namespace" do
    adapter = ActionCable.server.pubsub
    deliveries = Queue.new
    other_namespace_deliveries = Queue.new
    subscriptions = Queue.new
    expo_callback = ->(payload) { deliveries << payload }
    other_namespace_callback = ->(payload) { other_namespace_deliveries << payload }

    expect(adapter).to be_a(ActionCable::SubscriptionAdapter::Redis)

    adapter.subscribe("demo-stream:expo", expo_callback, -> { subscriptions << :expo })
    adapter.subscribe("demo-stream", other_namespace_callback, -> { subscriptions << :other_namespace })
    2.times { Timeout.timeout(5) { subscriptions.pop } }

    post "/api/expo_turbo/demo/broadcast"

    payload = Timeout.timeout(5) { deliveries.pop }
    stream = ExpoTurbo::Rails::Testing.parse_stream_fragment(ActiveSupport::JSON.decode(payload))
      .at_xpath("/expo-turbo-test-root/turbo-stream")

    expect(response).to have_http_status(:no_content)
    expect(stream["action"]).to eq("replace")
    expect(stream["target"]).to eq("demo-stream-message")
    expect(stream.at_xpath("./template/DemoText[@id='demo-stream-message']")&.text)
      .to eq("Broadcast from the standalone Rails demo")
    expect { Timeout.timeout(0.1) { deliveries.pop } }.to raise_error(Timeout::Error)
    expect { Timeout.timeout(0.1) { other_namespace_deliveries.pop } }.to raise_error(Timeout::Error)
  ensure
    adapter&.unsubscribe("demo-stream:expo", expo_callback) if expo_callback
    adapter&.unsubscribe("demo-stream", other_namespace_callback) if other_namespace_callback
    ActionCable.server.restart if adapter
  end

  it "serves a matching XML Frame for a native Frame request" do
    host! "localhost"
    get "/api/expo_turbo/demo/frame", headers: {"Turbo-Frame" => "demo-frame"}

    frame = ExpoTurbo::Rails::Testing.parse_document(response.body).root

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

    frame = ExpoTurbo::Rails::Testing.parse_document(response.body).root

    expect(response).to have_http_status(:unprocessable_content)
    expect(response.media_type).to eq(ExpoTurbo::Rails::MIME_TYPE)
    expect(frame.name).to eq("turbo-frame")
    expect(frame["id"]).to eq("demo-frame")
    expect(frame.at_xpath("./DemoText[@id='demo-frame-message']")&.text)
      .to eq("Frame validation failed")
  end
end
