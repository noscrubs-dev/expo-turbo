# frozen_string_literal: true

require "action_controller/api"
require "fileutils"
require "tmpdir"
require "spec_helper"

RSpec.describe "Expo Turbo cache identity" do
  let(:controller_class) do
    Class.new(ActionController::API) do
      include ExpoTurbo::Rails::Controller

      expo_turbo_template_capabilities(components: {"Screen" => {}})

      def show
        render_expo_turbo "show"
      end
    end
  end

  it "varies every response without a manual call in the action" do
    in_view_root do
      status, headers, = render_document

      expect(status).to eq(200)
      expect(headers["Vary"]).to eq("Accept, Turbo-Frame, X-Expo-Turbo-Modules")
    end
  end

  it "varies on Accept even when the route forced the response format" do
    controller = controller_with_request

    expect(controller.request.should_apply_vary_header?).to be(false)

    controller.expo_turbo_vary!

    expect(controller.response.headers["Vary"]).to eq("Accept, Turbo-Frame, X-Expo-Turbo-Modules")
  end

  it "does not keep a name that hides the module-version dimension" do
    expect(controller_with_request).not_to respond_to(:expo_turbo_vary_by_frame!)
  end

  it "separates Rails fragment cache keys by declared vocabulary" do
    first = native_controller("HTTP_X_EXPO_TURBO_MODULES" => "v1;cart=1")
    second = native_controller("HTTP_X_EXPO_TURBO_MODULES" => "v1;cart=2")
    absent = native_controller

    keys = [first, second, absent].map do |controller|
      ActiveSupport::Cache.expand_cache_key(
        controller.view_context.cache_fragment_name("account", skip_digest: true)
      )
    end

    expect(keys.uniq.length).to eq(3)
    expect(keys).to all(include("account"))
  end

  it "separates Rails fragment cache keys by requested Frame" do
    document = native_controller
    frame = native_controller("HTTP_TURBO_FRAME" => "details")

    document_key = document.view_context.cache_fragment_name("account", skip_digest: true)
    frame_key = frame.view_context.cache_fragment_name("account", skip_digest: true)

    expect(document_key).not_to eq(frame_key)
  end

  it "leaves fragment cache keys of a request that does not accept Expo Turbo unchanged" do
    controller = controller_with_request

    expect(controller.view_context.cache_fragment_name("account", skip_digest: true)).to eq("account")
  end

  def controller_with_request(headers = {})
    controller = controller_class.new
    controller.request = ActionDispatch::TestRequest.create(headers)
    controller.response = ActionDispatch::TestResponse.new
    controller
  end

  def native_controller(headers = {})
    controller_with_request({"HTTP_ACCEPT" => ExpoTurbo::Rails::MIME_TYPE}.merge(headers))
  end

  def in_view_root
    Dir.mktmpdir do |directory|
      root = File.join(directory, "expo_turbo")
      FileUtils.mkdir_p(root)
      File.write(File.join(root, "show.xml.erb"), "<Screen/>")
      controller_class.expo_turbo_view_root(root)
      yield
    end
  end

  def render_document
    status, headers, body = controller_class.action(:show).call(ActionDispatch::TestRequest.create.env)
    [status, headers, body.each.to_a.join]
  end
end
