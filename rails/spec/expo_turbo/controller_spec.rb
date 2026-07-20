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
end
