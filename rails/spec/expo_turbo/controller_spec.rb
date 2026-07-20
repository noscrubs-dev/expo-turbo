# frozen_string_literal: true

require "action_controller/api"
require "fileutils"
require "tmpdir"
require "spec_helper"

RSpec.describe ExpoTurbo::Rails::Controller do
  let(:controller_class) do
    Class.new(ActionController::API) do
      include ExpoTurbo::Rails::Controller
    end
  end

  it "confines templates to the configured host view root" do
    Dir.mktmpdir do |directory|
      root = File.join(directory, "expo_turbo")
      outside = File.join(directory, "outside.xml.erb")
      FileUtils.mkdir_p(root)
      File.write(outside, "<Outside />")

      controller_class.expo_turbo_view_root(root)
      controller = controller_class.new

      expect { controller.send(:expo_turbo_template_file, "../outside") }
        .to raise_error(ExpoTurbo::Rails::TemplateError, /outside the configured view root/)
    end
  end

  it "delegates literal Frame tags to turbo-rails from API view contexts" do
    controller = controller_class.new
    controller.request = ActionDispatch::TestRequest.create
    rendered = controller.view_context.expo_turbo_frame_tag(
      "details",
      src: "/frames/details",
      target: "sidebar",
      loading: :lazy
    ) { '<DemoText id="loaded">Loaded</DemoText>'.html_safe }
    frame = Nokogiri::XML(rendered.to_s) { |config| config.strict }.root

    expect(frame.name).to eq("turbo-frame")
    expect(frame["id"]).to eq("details")
    expect(frame["src"]).to eq("/frames/details")
    expect(frame["target"]).to eq("sidebar")
    expect(frame["loading"]).to eq("lazy")
    expect(frame.at_xpath("./DemoText")&.text).to eq("Loaded")
  end

  it "rejects invalid Expo Turbo Frame IDs" do
    controller = controller_class.new
    invalid_ids = [nil, :details, "", "  ", "\u2003", "details\nnext", "\xFF".dup.force_encoding(Encoding::UTF_8)]

    invalid_ids.each do |id|
      expect { controller.view_context.expo_turbo_frame_tag(id) }
        .to raise_error(ExpoTurbo::Rails::TemplateError, /Frame id/)
    end
  end

  it "exposes only valid Frame request headers without including HTML Frame layout behavior" do
    controller = controller_class.new
    controller.request = ActionDispatch::TestRequest.create("HTTP_TURBO_FRAME" => "details")

    expect(controller.expo_turbo_frame_request_id).to eq("details")
    expect(controller).to be_expo_turbo_frame_request
    expect(controller.view_context.expo_turbo_frame_request_id).to eq("details")
    expect(controller.view_context).to be_expo_turbo_frame_request
    expect(controller_class.ancestors).not_to include(Turbo::Frames::FrameRequest)

    controller.request.headers["Turbo-Frame"] = "details\u0000invalid"

    expect(controller.expo_turbo_frame_request_id).to be_nil
    expect(controller).not_to be_expo_turbo_frame_request
  end

  it "builds distinct conditional cache keys for documents and each valid Frame" do
    document = controller_with_request
    details = controller_with_request("HTTP_TURBO_FRAME" => "details")
    sidebar = controller_with_request("HTTP_TURBO_FRAME" => "sidebar")
    invalid = controller_with_request("HTTP_TURBO_FRAME" => "details\u0000invalid")

    expect(document.expo_turbo_cache_key("account")).to eq(["account", :expo_turbo, :document])
    expect(details.expo_turbo_cache_key("account")).to eq(["account", :expo_turbo, :frame, "details"])
    expect(sidebar.expo_turbo_cache_key("account")).to eq(["account", :expo_turbo, :frame, "sidebar"])
    expect(invalid.expo_turbo_cache_key("account")).to eq(["account", :expo_turbo, :document])
    expect(document.response.headers["Vary"]).to eq("Turbo-Frame")
  end

  it "keeps document and Frame ETags distinct through Rails conditional GET" do
    document_etag = conditional_etag(controller_with_request)
    details_etag = conditional_etag(controller_with_request("HTTP_TURBO_FRAME" => "details"))
    sidebar_etag = conditional_etag(controller_with_request("HTTP_TURBO_FRAME" => "sidebar"))

    expect(document_etag).not_to eq(details_etag)
    expect(details_etag).not_to eq(sidebar_etag)
  end

  it "does not accept a document validator for a Frame response" do
    document_etag = conditional_etag(controller_with_request)
    frame = controller_with_request(
      "HTTP_TURBO_FRAME" => "details",
      "HTTP_IF_NONE_MATCH" => document_etag
    )

    frame.fresh_when etag: frame.expo_turbo_cache_key("account")

    expect(frame.response.status).not_to eq(304)
  end

  it "retains the host representation version in conditional validators" do
    first_version = conditional_etag(controller_with_request, representation: "accounts/details-v1")
    next_version = conditional_etag(controller_with_request, representation: "accounts/details-v2")

    expect(first_version).not_to eq(next_version)
  end

  it "merges the Frame cache variation without replacing existing Vary values" do
    controller = controller_with_request
    controller.response.set_header "Vary", "Accept-Encoding, turbo-frame"

    expect(controller.expo_turbo_vary_by_frame!).to eq("Accept-Encoding, turbo-frame")
    expect(controller.response.headers["Vary"]).to eq("Accept-Encoding, turbo-frame")

    controller.response.set_header "Vary", "*"

    expect(controller.expo_turbo_vary_by_frame!).to eq("*")
  end

  it "retains Rails' Accept cache variation when the request negotiated a format" do
    controller = controller_with_request("HTTP_ACCEPT" => ExpoTurbo::Rails::MIME_TYPE)

    controller.expo_turbo_vary_by_frame!

    expect(controller.response.headers["Vary"]).to eq("Accept, Turbo-Frame")
  end

  def controller_with_request(headers = {})
    controller = controller_class.new
    controller.request = ActionDispatch::TestRequest.create(headers)
    controller.response = ActionDispatch::TestResponse.new
    controller
  end

  def conditional_etag(controller, representation: "accounts/details-v1")
    controller.fresh_when etag: controller.expo_turbo_cache_key("account", representation)
    controller.response.headers.fetch("ETag")
  end
end
