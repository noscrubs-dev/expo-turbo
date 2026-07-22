# frozen_string_literal: true

require "rails_helper"
require "expo_turbo/rails/testing"
require "timeout"
require "tempfile"

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
    stream_link = document.at_xpath("//DemoDocumentLink[@id='demo-http-stream-link']")
    expect(stream_link&.[]("href")).to eq("/api/expo_turbo/demo/stream")
    expect(stream_link&.[]("data-turbo-stream")).to eq("")
    morph_stream_link = document.at_xpath("//DemoDocumentLink[@id='demo-http-stream-morph-link']")
    expect(morph_stream_link&.[]("href")).to eq("/api/expo_turbo/demo/stream?mode=morph")
    expect(morph_stream_link&.[]("data-turbo-stream")).to eq("")
    expect(document.at_xpath("//Gallery[@id='demo-http-stream-message']/DemoText")&.text)
      .to eq("Waiting for a Rails HTTP Stream response")
    expect(document.at_xpath("//Gallery[@id='demo-http-stream-list']")).to be_present
    expect(document.at_xpath("//DemoStreamMorphProbe[@id='demo-http-stream-morph-probe']")&.[]("message"))
      .to eq("Waiting for a Rails Stream morph")
    frame = document.at_xpath("//turbo-frame[@id='demo-frame']")
    expect(frame&.[]("src")).to eq("/api/expo_turbo/demo/frame")
    expect(document.at_xpath("//turbo-cable-stream-source")).to be_nil
  end

  it "serves standard sibling Stream fragments from confined XML partials" do
    host! "localhost"
    get "/api/expo_turbo/demo/stream"

    fragment = ExpoTurbo::Rails::Testing.parse_stream_fragment(response.body)
    streams = fragment.xpath("/expo-turbo-test-root/turbo-stream")

    expect(response).to have_http_status(:ok)
    expect(response.media_type).to eq(ExpoTurbo::Rails::TURBO_STREAM_MIME_TYPE)
    expect(streams.map { |stream| stream["action"] }).to eq(%w[update append])
    expect(streams.map { |stream| stream["target"] })
      .to eq(%w[demo-http-stream-message demo-http-stream-list])
    expect(streams.first.at_xpath("./template/DemoText[@id='demo-http-stream-message-value']")&.text)
      .to eq("Rendered from XML partial")
    expect(streams.first.at_xpath("./template/DemoText")&.text).not_to eq("HTML fallback")
    expect(streams.last.at_xpath("./template/DemoText[@id='demo-http-stream-item']")&.text)
      .to eq("Second sibling")
  end

  it "serves one ordinary Rails document that admits a bounded current-document morph" do
    host! "localhost"
    get "/api/expo_turbo/demo/refresh_morph_document"

    document = ExpoTurbo::Rails::Testing.parse_document(response.body)
    link = document.at_xpath("//DemoDocumentLink[@id='demo-document-refresh-morph-link']")

    expect(response).to have_http_status(:ok)
    expect(response.media_type).to eq(ExpoTurbo::Rails::MIME_TYPE)
    expect(document.root.name).to eq("Gallery")
    expect(document.root["id"]).to eq("demo-document-refresh-morph")
    expect(document.at_xpath("//DemoText[@id='demo-document-refresh-morph-response']")&.text)
      .to start_with("Canonical Rails document rendered at ")
    expect(link&.[]("href")).to eq("/api/expo_turbo/demo/stream?mode=refresh-morph")
    expect(link&.[]("data-turbo-stream")).to eq("")
    expect(document.at_xpath("//DemoStreamMorphProbe[@id='demo-document-refresh-morph-probe']")&.[]("message"))
      .to eq("Local state survives the Rails document refresh")
    expect(document.xpath("//turbo-frame | //turbo-stream | //turbo-cable-stream-source")).to be_empty
  end

  it "serves an exact Rails Stream morph from a confined XML partial" do
    host! "localhost"
    get "/api/expo_turbo/demo/stream", params: {mode: "morph"}

    fragment = ExpoTurbo::Rails::Testing.parse_stream_fragment(response.body)
    streams = fragment.xpath("/expo-turbo-test-root/turbo-stream")

    expect(response).to have_http_status(:ok)
    expect(response.media_type).to eq(ExpoTurbo::Rails::TURBO_STREAM_MIME_TYPE)
    expect(streams).to have_attributes(length: 1)
    stream = streams.first
    expect(stream["action"]).to eq("replace")
    expect(stream["method"]).to eq("morph")
    expect(stream["target"]).to eq("demo-http-stream-morph-probe")
    expect(stream.at_xpath("./template/DemoStreamMorphProbe[@id='demo-http-stream-morph-probe']")&.[]("message"))
      .to eq("Rendered from Rails Stream morph")
  end

  it "serves a standard request-id-free Refresh Stream morph" do
    host! "localhost"
    get "/api/expo_turbo/demo/stream", params: {mode: "refresh-morph"}

    stream = ExpoTurbo::Rails::Testing.parse_stream_fragment(response.body)
      .at_xpath("/expo-turbo-test-root/turbo-stream")

    expect(response).to have_http_status(:ok)
    expect(response.media_type).to eq(ExpoTurbo::Rails::TURBO_STREAM_MIME_TYPE)
    expect(stream["action"]).to eq("refresh")
    expect(stream["method"]).to eq("morph")
    expect(stream["request-id"]).to be_nil
    expect(stream.at_xpath("./template")).to be_nil
  end

  it "rejects an unknown standalone Rails Stream mode" do
    host! "localhost"
    get "/api/expo_turbo/demo/stream", params: {mode: "unsupported"}

    expect(response).to have_http_status(:bad_request)
  end

  it "delivers fixed public XML replace and refresh Streams through the Redis-backed Expo Action Cable namespace" do
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

    post "/api/expo_turbo/demo/broadcast", params: {kind: "refresh"}

    refresh_payload = Timeout.timeout(5) { deliveries.pop }
    refresh = ExpoTurbo::Rails::Testing.parse_stream_fragment(ActiveSupport::JSON.decode(refresh_payload))
      .at_xpath("/expo-turbo-test-root/turbo-stream")

    expect(response).to have_http_status(:no_content)
    expect(refresh["action"]).to eq("refresh")
    expect(refresh.attribute_nodes.map(&:name)).to eq(["action"])
    expect(refresh.at_xpath("./template")).to be_nil
    expect { Timeout.timeout(0.1) { deliveries.pop } }.to raise_error(Timeout::Error)
    expect { Timeout.timeout(0.1) { other_namespace_deliveries.pop } }.to raise_error(Timeout::Error)
  ensure
    adapter&.unsubscribe("demo-stream:expo", expo_callback) if expo_callback
    adapter&.unsubscribe("demo-stream", other_namespace_callback) if other_namespace_callback
    ActionCable.server.restart if adapter
  end

  it "rejects an unrecognized local broadcast control" do
    post "/api/expo_turbo/demo/broadcast", params: {kind: "forged"}

    expect(response).to have_http_status(:unprocessable_content)
    expect(response.body).to be_empty
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
    expect(frame.at_xpath("./DemoText[@id='demo-stream-message']")&.text)
      .to eq("Rendered from an XML Frame")
    source = frame.at_xpath("./turbo-cable-stream-source[@id='demo-stream-source']")
    expect(source&.[]("channel")).to eq("Turbo::StreamsChannel")
    expect(::Turbo::StreamsChannel.verified_stream_name(source["signed-stream-name"]))
      .to eq("demo-stream:expo")
  end

  it "returns authoritative XML Frame validation errors" do
    host! "localhost"
    get "/api/expo_turbo/demo/frame?state=invalid", headers: {"Turbo-Frame" => "demo-frame"}

    frame = ExpoTurbo::Rails::Testing.parse_document(response.body).root

    expect(response).to have_http_status(:unprocessable_content)
    expect(response.media_type).to eq(ExpoTurbo::Rails::MIME_TYPE)
    expect(frame.name).to eq("turbo-frame")
    expect(frame["id"]).to eq("demo-frame")
    expect(frame.at_xpath("./DemoText[@id='demo-stream-message']")&.text)
      .to eq("Frame validation failed")
  end

  it "serves the nested refresh-morph Frame endpoints only to their matching Frames" do
    host! "localhost"
    get "/api/expo_turbo/demo/morph/outer", headers: {"Turbo-Frame" => "morph-outer"}

    outer = ExpoTurbo::Rails::Testing.parse_document(response.body).root

    expect(response).to have_http_status(:ok)
    expect(response.media_type).to eq(ExpoTurbo::Rails::MIME_TYPE)
    expect(response.headers["Vary"]).to eq("Turbo-Frame")
    expect(outer.name).to eq("turbo-frame")
    expect(outer["id"]).to eq("morph-outer")
    expect(outer["src"]).to eq("/api/expo_turbo/demo/morph/outer")
    expect(outer["refresh"]).to eq("morph")
    expect(outer.at_xpath("./Gallery[@id='morph-shell']/DemoText[@id='morph-outer-version']")&.text)
      .to eq("Outer Frame response")
    inner = outer.at_xpath("./Gallery[@id='morph-shell']/turbo-frame[@id='morph-inner']")
    expect(inner&.[]("src")).to eq("/api/expo_turbo/demo/morph/inner")
    expect(inner&.[]("refresh")).to eq("morph")
    expect(inner&.at_xpath("./DemoText[@id='morph-inner-stale']")&.text)
      .to eq("This nested response is intentionally ignored before its own reload")

    get "/api/expo_turbo/demo/morph/inner", headers: {"Turbo-Frame" => "morph-inner"}

    inner = ExpoTurbo::Rails::Testing.parse_document(response.body).root

    expect(response).to have_http_status(:ok)
    expect(response.media_type).to eq(ExpoTurbo::Rails::MIME_TYPE)
    expect(response.headers["Vary"]).to eq("Turbo-Frame")
    expect(inner.name).to eq("turbo-frame")
    expect(inner["id"]).to eq("morph-inner")
    expect(inner["src"]).to eq("/api/expo_turbo/demo/morph/inner")
    expect(inner["refresh"]).to eq("morph")
    expect(inner.at_xpath("./DemoText[@id='morph-inner-version']")&.text).to eq("Inner Frame response")

    get "/api/expo_turbo/demo/morph/outer"
    expect(response).to have_http_status(:bad_request)

    get "/api/expo_turbo/demo/morph/inner", headers: {"Turbo-Frame" => "morph-outer"}
    expect(response).to have_http_status(:bad_request)
  end

  it "serves the canonical Rails Frame form only to its matching Frame" do
    host! "localhost"
    get "/api/expo_turbo/demo/form", headers: {"Turbo-Frame" => "demo-form-frame"}

    frame = ExpoTurbo::Rails::Testing.parse_document(response.body).root

    expect(response).to have_http_status(:ok)
    expect(response.media_type).to eq(ExpoTurbo::Rails::MIME_TYPE)
    expect(response.charset).to eq("utf-8")
    expect(response.headers["Vary"]).to eq("Turbo-Frame")
    expect(frame.name).to eq("turbo-frame")
    expect(frame["id"]).to eq("demo-form-frame")
    expect(frame.at_xpath("./DemoForm[@id='demo-form']")&.[]("action"))
      .to eq("/api/expo_turbo/demo/form")
    expect(frame.at_xpath(".//DemoFormInput[@id='demo-form-first-name']")&.[]("value")).to eq("")
    expect(frame.at_xpath(".//DemoFormSubmitter[@id='demo-form-submit']")&.[]("value")).to eq("save")
    expect(frame.at_xpath(".//DemoFormSubmitter[@id='demo-form-preserve-local']")&.[]("value"))
      .to eq("save-morph")
    expect(frame.at_xpath(".//DemoFormSubmitter[@id='demo-form-complete']")&.[]("value"))
      .to eq("no-content")
    upload_form = frame.at_xpath("./DemoForm[@id='demo-upload-form']")
    expect(upload_form&.[]("enctype")).to eq("multipart/form-data")
    upload = upload_form&.at_xpath("./DemoFormFile[@id='demo-form-attachment']")
    expect(upload&.[]("name")).to eq("profile[attachment]")
    expect(upload&.[]("filename")).to eq("expo-turbo-upload.txt")
    expect(upload_form&.at_xpath("./DemoFormSubmitter[@id='demo-form-upload-retry']")&.[]("value")).to eq("upload-retry")
    consent_form = frame.at_xpath("./DemoForm[@id='demo-consent-form']")
    consent = consent_form&.at_xpath("./DemoFormCheckbox[@id='demo-form-terms']")
    expect(consent&.[]("name")).to eq("profile[terms]")
    expect(consent&.[]("value")).to eq("accepted")
    expect(consent&.[]("checked")).to be_nil
    expect(consent_form&.at_xpath("./DemoFormSubmitter[@id='demo-form-consent']")&.[]("value"))
      .to eq("save-consent")
    plan_form = frame.at_xpath("./DemoForm[@id='demo-plan-form']")
    plan = plan_form&.at_xpath("./DemoFormPlanSelect[@id='demo-form-plan']")
    expect(plan&.[]("name")).to eq("profile[plan]")
    expect(plan&.[]("selected")).to eq("none")
    expect(plan_form&.at_xpath("./DemoFormSubmitter[@id='demo-form-plan-submit']")&.[]("value"))
      .to eq("save-plan")

    get "/api/expo_turbo/demo/form"
    expect(response).to have_http_status(:bad_request)

    get "/api/expo_turbo/demo/form", headers: {"Turbo-Frame" => "another-frame"}
    expect(response).to have_http_status(:bad_request)
  end

  it "returns an authoritative XML Frame for invalid URL-encoded form input" do
    host! "localhost"
    post "/api/expo_turbo/demo/form",
      params: {commit: "no-content", profile: {first_name: "invalid"}},
      headers: {"Content-Type" => "application/x-www-form-urlencoded", "Turbo-Frame" => "demo-form-frame"}

    frame = ExpoTurbo::Rails::Testing.parse_document(response.body).root

    expect(response).to have_http_status(:unprocessable_content)
    expect(response.media_type).to eq(ExpoTurbo::Rails::MIME_TYPE)
    expect(response.charset).to eq("utf-8")
    expect(response.headers["Vary"]).to eq("Turbo-Frame")
    expect(frame.name).to eq("turbo-frame")
    expect(frame["id"]).to eq("demo-form-frame")
    expect(frame.at_xpath(".//DemoFormInput[@id='demo-form-first-name']")&.[]("value")).to eq("invalid")
    expect(frame.at_xpath(".//DemoText[@id='demo-form-error']")&.text)
      .to eq("This demo name is unavailable")
  end

  it "returns a standard morph Stream for an opt-in local-draft validation response" do
    host! "localhost"
    post "/api/expo_turbo/demo/form",
      params: {commit: "save-morph", profile: {first_name: "invalid"}},
      headers: {"Content-Type" => "application/x-www-form-urlencoded", "Turbo-Frame" => "demo-form-frame"}

    fragment = ExpoTurbo::Rails::Testing.parse_stream_fragment(response.body)
    stream = fragment.at_xpath("/expo-turbo-test-root/turbo-stream")

    expect(response).to have_http_status(:unprocessable_content)
    expect(response.media_type).to eq(ExpoTurbo::Rails::TURBO_STREAM_MIME_TYPE)
    expect(response.headers["Vary"]).to eq("Turbo-Frame")
    expect(stream["action"]).to eq("replace")
    expect(stream["method"]).to eq("morph")
    expect(stream["target"]).to eq("demo-form")
    expect(stream.at_xpath("./template/DemoForm[@id='demo-form']/DemoFormInput[@id='demo-form-first-name']")&.[]("value"))
      .to eq("")
    expect(stream.at_xpath("./template/DemoForm/DemoText[@id='demo-form-error']")&.text)
      .to eq("This demo name is unavailable")
    expect(stream.at_xpath("./template/DemoForm/DemoFormSubmitter[@id='demo-form-preserve-local']")&.[]("value"))
      .to eq("save-morph")
  end

  it "accepts only the standalone text/plain form profile" do
    host! "localhost"
    headers = {"Content-Type" => "text/plain", "Turbo-Frame" => "demo-form-frame"}

    post "/api/expo_turbo/demo/form",
      params: "profile[first_name]=invalid\r\ncommit=save\r\n",
      headers: headers

    frame = ExpoTurbo::Rails::Testing.parse_document(response.body).root

    expect(response).to have_http_status(:unprocessable_content)
    expect(response.media_type).to eq(ExpoTurbo::Rails::MIME_TYPE)
    expect(frame.at_xpath(".//DemoFormInput[@id='demo-form-first-name']")&.[]("value")).to eq("invalid")
    expect(frame.at_xpath(".//DemoText[@id='demo-form-error']")&.text)
      .to eq("This demo name is unavailable")

    post "/api/expo_turbo/demo/form",
      params: "profile[first_name]=Ada\r\ncommit=save\r\n",
      headers: headers

    expect(response).to have_http_status(:see_other)
    expect(response.headers["Location"]).to eq("http://localhost/api/expo_turbo/demo/form")

    [
      "profile[first_name]=Ada\r\ncommit=save",
      "commit=save\r\nprofile[first_name]=Ada\r\n",
      "profile[first_name]=Ada\r\ncommit=save\r\nextra=value\r\n",
      "profile[first_name]=Ada\r\ncommit=delete\r\n",
      "profile[first_name]=Ada\r\ncommit=no-content\r\n",
      "profile[first_name]=Ada\r\ncommit=save\r\n\xFF".b
    ].each do |body|
      post "/api/expo_turbo/demo/form", params: body, headers: headers

      expect(response).to have_http_status(:bad_request)
      expect(response.body).to be_empty
      expect(response.headers["Vary"]).to eq("Turbo-Frame")
    end
  end

  it "redirects valid form submissions to the fixed canonical Frame GET" do
    host! "localhost"
    post "/api/expo_turbo/demo/form",
      params: {commit: "save", profile: {first_name: "Ada"}},
      headers: {"Content-Type" => "application/x-www-form-urlencoded", "Turbo-Frame" => "demo-form-frame"}

    expect(response).to have_http_status(:see_other)
    expect(response.headers["Location"]).to eq("http://localhost/api/expo_turbo/demo/form")
    expect(response.body).to be_empty
  end

  it "keeps an unchecked native consent control absent and returns matching 422 XML" do
    host! "localhost"
    headers = {"Content-Type" => "application/x-www-form-urlencoded", "Turbo-Frame" => "demo-form-frame"}

    post "/api/expo_turbo/demo/form", params: {commit: "save-consent"}, headers: headers

    frame = ExpoTurbo::Rails::Testing.parse_document(response.body).root

    expect(response).to have_http_status(:unprocessable_content)
    expect(response.media_type).to eq(ExpoTurbo::Rails::MIME_TYPE)
    expect(frame["id"]).to eq("demo-form-frame")
    consent = frame.at_xpath(".//DemoFormCheckbox[@id='demo-form-terms']")
    expect(consent&.[]("checked")).to be_nil
    expect(consent&.[]("error")).to eq("Accept the demo terms before saving")

    post "/api/expo_turbo/demo/form",
      params: {commit: "save-consent", profile: {terms: "accepted"}},
      headers: headers

    expect(response).to have_http_status(:see_other)
    expect(response.headers["Location"]).to eq("http://localhost/api/expo_turbo/demo/form")

    post "/api/expo_turbo/demo/form",
      params: {commit: "save-consent", profile: {terms: "forged"}},
      headers: headers

    frame = ExpoTurbo::Rails::Testing.parse_document(response.body).root
    consent = frame.at_xpath(".//DemoFormCheckbox[@id='demo-form-terms']")

    expect(response).to have_http_status(:unprocessable_content)
    expect(consent&.[]("checked")).to be_nil
    expect(consent&.[]("error")).to eq("Accept the demo terms before saving")
  end

  it "keeps an unselected native plan absent and returns matching 422 XML" do
    host! "localhost"
    headers = {"Content-Type" => "application/x-www-form-urlencoded", "Turbo-Frame" => "demo-form-frame"}

    post "/api/expo_turbo/demo/form", params: {commit: "save-plan"}, headers: headers

    frame = ExpoTurbo::Rails::Testing.parse_document(response.body).root
    plan = frame.at_xpath(".//DemoFormPlanSelect[@id='demo-form-plan']")

    expect(response).to have_http_status(:unprocessable_content)
    expect(response.media_type).to eq(ExpoTurbo::Rails::MIME_TYPE)
    expect(plan&.[]("selected")).to eq("none")
    expect(plan&.[]("error")).to eq("Choose a supported demo plan")

    post "/api/expo_turbo/demo/form",
      params: {commit: "save-plan", profile: {plan: "pro"}},
      headers: headers

    expect(response).to have_http_status(:see_other)
    expect(response.headers["Location"]).to eq("http://localhost/api/expo_turbo/demo/form")

    get "/api/expo_turbo/demo/form", headers: {"Turbo-Frame" => "demo-form-frame"}

    frame = ExpoTurbo::Rails::Testing.parse_document(response.body).root
    plan = frame.at_xpath(".//DemoFormPlanSelect[@id='demo-form-plan']")

    expect(response).to have_http_status(:ok)
    expect(plan&.[]("selected")).to eq("none")
    expect(plan&.[]("error")).to be_nil

    post "/api/expo_turbo/demo/form",
      params: {commit: "save-plan", profile: {plan: "forged"}},
      headers: headers

    frame = ExpoTurbo::Rails::Testing.parse_document(response.body).root
    plan = frame.at_xpath(".//DemoFormPlanSelect[@id='demo-form-plan']")

    expect(response).to have_http_status(:unprocessable_content)
    expect(plan&.[]("selected")).to eq("none")
    expect(plan&.[]("error")).to eq("Choose a supported demo plan")
  end

  it "accepts only bounded UTF-8 text/plain native multipart uploads and discards their bytes" do
    host! "localhost"
    headers = {"Turbo-Frame" => "demo-form-frame"}

    Tempfile.create(["expo-turbo-upload", ".txt"]) do |file|
      file.binmode
      file.write("Expo Turbo native multipart upload\n")
      file.rewind

      post "/api/expo_turbo/demo/form",
        params: {
          commit: "upload-retry",
          profile: {
            attachment: Rack::Test::UploadedFile.new(
              file.path,
              "text/plain",
              true,
              original_filename: "expo-turbo-upload.txt"
            )
          }
        },
        headers: headers

      expect(response).to have_http_status(:unprocessable_content)
      expect(response.media_type).to eq(ExpoTurbo::Rails::MIME_TYPE)
      frame = ExpoTurbo::Rails::Testing.parse_document(response.body).root
      expect(frame.at_xpath(".//DemoFormFile[@id='demo-form-attachment']")&.[]("error"))
        .to eq("Retry this selected attachment")

      post "/api/expo_turbo/demo/form",
        params: {
          commit: "upload",
          profile: {
            attachment: Rack::Test::UploadedFile.new(
              file.path,
              "text/plain",
              true,
              original_filename: "picked-notes.txt"
            )
          }
        },
        headers: headers

      expect(response).to have_http_status(:see_other)
      expect(response.headers["Location"]).to eq("http://localhost/api/expo_turbo/demo/form")
    end

    Tempfile.create(["expo-turbo-upload", ".txt"]) do |file|
      file.binmode
      file.write("picked from Files\n")
      file.rewind

      post "/api/expo_turbo/demo/form",
        params: {
          commit: "upload",
          profile: {
            attachment: Rack::Test::UploadedFile.new(
              file.path,
              "text/plain",
              true,
              original_filename: "picked-notes.txt"
            )
          }
        },
        headers: headers

      expect(response).to have_http_status(:see_other)
      expect(response.headers["Location"]).to eq("http://localhost/api/expo_turbo/demo/form")
    end

    Tempfile.create(["expo-turbo-upload", ".txt"]) do |file|
      file.binmode
      file.write("x" * (64 * 1024 + 1))
      file.rewind

      post "/api/expo_turbo/demo/form",
        params: {
          commit: "upload",
          profile: {
            attachment: Rack::Test::UploadedFile.new(
              file.path,
              "text/plain",
              true,
              original_filename: "too-large.txt"
            )
          }
        },
        headers: headers

      expect(response).to have_http_status(:unprocessable_content)
      expect(response.media_type).to eq(ExpoTurbo::Rails::MIME_TYPE)
      expect(response.headers["Vary"]).to eq("Turbo-Frame")
      frame = ExpoTurbo::Rails::Testing.parse_document(response.body).root
      expect(frame["id"]).to eq("demo-form-frame")
      expect(frame.at_xpath(".//DemoFormFile[@id='demo-form-attachment']")&.[]("error"))
        .to eq("Upload a UTF-8 text file from 1 to 64 KiB")
    end

    Tempfile.create(["expo-turbo-upload", ".bin"]) do |file|
      file.binmode
      file.write("picked from Files\n")
      file.rewind

      post "/api/expo_turbo/demo/form",
        params: {
          commit: "upload",
          profile: {
            attachment: Rack::Test::UploadedFile.new(
              file.path,
              "application/octet-stream",
              true,
              original_filename: "picked-notes.txt"
            )
          }
        },
        headers: headers

      expect(response).to have_http_status(:unprocessable_content)
      expect(response.media_type).to eq(ExpoTurbo::Rails::MIME_TYPE)
      expect(response.headers["Vary"]).to eq("Turbo-Frame")
      frame = ExpoTurbo::Rails::Testing.parse_document(response.body).root
      expect(frame["id"]).to eq("demo-form-frame")
      expect(frame.at_xpath(".//DemoFormFile[@id='demo-form-attachment']")&.[]("error"))
        .to eq("Upload a UTF-8 text file from 1 to 64 KiB")
    end
  end

  it "keeps a valid Frame form unchanged for the explicit no-content submitter" do
    host! "localhost"
    post "/api/expo_turbo/demo/form",
      params: {commit: "no-content", profile: {first_name: "Ada"}},
      headers: {"Content-Type" => "application/x-www-form-urlencoded", "Turbo-Frame" => "demo-form-frame"}

    expect(response).to have_http_status(:no_content)
    expect(response.headers["Location"]).to be_nil
    expect(response.headers["Vary"]).to eq("Turbo-Frame")
    expect(response.body).to be_empty
  end

  it "rejects unsupported or malformed form input without a JSON fallback" do
    host! "localhost"
    post "/api/expo_turbo/demo/form",
      params: {commit: "save", profile: {first_name: "Ada"}},
      headers: {"Content-Type" => "application/json", "Turbo-Frame" => "demo-form-frame"}
    expect(response).to have_http_status(:unsupported_media_type)
    expect(response.media_type).not_to eq(ExpoTurbo::Rails::MIME_TYPE)

    post "/api/expo_turbo/demo/form",
      params: {profile: {first_name: "Ada"}},
      headers: {"Content-Type" => "application/x-www-form-urlencoded", "Turbo-Frame" => "demo-form-frame"}
    expect(response).to have_http_status(:bad_request)

    post "/api/expo_turbo/demo/form",
      params: {commit: "save", profile: {first_name: {forged: "value"}}},
      headers: {"Content-Type" => "application/x-www-form-urlencoded", "Turbo-Frame" => "demo-form-frame"}
    expect(response).to have_http_status(:bad_request)

    post "/api/expo_turbo/demo/form",
      params: {commit: "save", profile: {first_name: "a" * 121}},
      headers: {"Content-Type" => "application/x-www-form-urlencoded", "Turbo-Frame" => "demo-form-frame"}
    expect(response).to have_http_status(:bad_request)

    post "/api/expo_turbo/demo/form",
      params: "commit=save&profile%5Bfirst_name%5D=invalid%00bad",
      headers: {"Content-Type" => "application/x-www-form-urlencoded", "Turbo-Frame" => "demo-form-frame"}
    expect(response).to have_http_status(:bad_request)
    expect(response.media_type).not_to eq("application/json")
    expect(response.body).to be_empty

    post "/api/expo_turbo/demo/form",
      params: "commit=save&profile%5Bfirst_name%5D=invalid%FFbad",
      headers: {"Content-Type" => "application/x-www-form-urlencoded", "Turbo-Frame" => "demo-form-frame"}
    expect(response).to have_http_status(:bad_request)
    expect(response.media_type).not_to eq("application/json")
    expect(response.body).to be_empty
    expect(response.headers["Vary"]).to eq("Turbo-Frame")

    post "/api/expo_turbo/demo/form",
      params: {commit: "other", profile: {first_name: "Ada"}},
      headers: {"Content-Type" => "application/x-www-form-urlencoded", "Turbo-Frame" => "demo-form-frame"}
    expect(response).to have_http_status(:bad_request)
  end

  it "escapes server-invalid submitted text instead of admitting XML" do
    host! "localhost"
    submitted = "invalid<DemoText id='forged'>not a component</DemoText>"
    post "/api/expo_turbo/demo/form",
      params: {commit: "save", profile: {first_name: submitted}},
      headers: {"Content-Type" => "application/x-www-form-urlencoded", "Turbo-Frame" => "demo-form-frame"}

    frame = ExpoTurbo::Rails::Testing.parse_document(response.body).root

    expect(response).to have_http_status(:unprocessable_content)
    expect(frame.at_xpath(".//DemoFormInput[@id='demo-form-first-name']")&.[]("value")).to eq(submitted)
    expect(frame.at_xpath(".//DemoText[@id='forged']")).to be_nil
  end
end
