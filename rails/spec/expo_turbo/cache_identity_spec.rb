# frozen_string_literal: true

require "action_controller/api"
require "spec_helper"
require "support/rendering"

RSpec.describe "Expo Turbo cache identity" do
  include ExpoTurboSpecRendering

  let(:controller_class) do
    Class.new(ActionController::API) do
      include ExpoTurbo::Rails::Controller

      expo_turbo_template_capabilities(components: {"Screen" => {}})

      def show
        render "specs/show"
      end
    end
  end

  it "varies every response without a manual call in the action" do
    with_templates(controller_class, "specs/show.expo_turbo.erb" => "<Screen/>") do
      status, headers, = dispatch(controller_class)

      expect(status).to eq(200)
      expect(headers["Vary"]).to eq("Accept, Turbo-Frame, X-Expo-Turbo-Client, X-Expo-Turbo-Modules")
    end
  end

  # after_action does not run when a filter halts the chain, and an
  # authentication redirect, a rate limit, and a rejected header all halt it.
  # Those responses reach a shared cache too.
  it "varies a response that a halted Expo Turbo filter produced" do
    with_templates(controller_class, "specs/show.expo_turbo.erb" => "<Screen/>") do
      status, headers, = dispatch(controller_class, headers: {"HTTP_TURBO_FRAME" => "details\ninvalid"})

      expect(status).to eq(400)
      expect(headers["Vary"]).to eq("Accept, Turbo-Frame, X-Expo-Turbo-Client, X-Expo-Turbo-Modules")
    end
  end

  it "varies a response that a host filter halted" do
    guarded = Class.new(controller_class) do
      before_action { head :unauthorized }
    end

    with_templates(guarded, "specs/show.expo_turbo.erb" => "<Screen/>") do
      status, headers, = dispatch(guarded)

      expect(status).to eq(401)
      expect(headers["Vary"]).to eq("Accept, Turbo-Frame, X-Expo-Turbo-Client, X-Expo-Turbo-Modules")
    end
  end

  it "varies a response that a rescued action error produced" do
    failing = Class.new(controller_class) do
      rescue_from(ArgumentError) { head :unprocessable_content }

      def show
        raise ArgumentError, "boom"
      end
    end

    status, headers, = dispatch(failing)

    expect(status).to eq(422)
    expect(headers["Vary"]).to eq("Accept, Turbo-Frame, X-Expo-Turbo-Client, X-Expo-Turbo-Modules")
  end

  it "varies on Accept even when the route forced the response format" do
    controller = controller_with_request

    expect(controller.request.should_apply_vary_header?).to be(false)

    controller.expo_turbo_vary!

    expect(controller.response.headers["Vary"]).to eq("Accept, Turbo-Frame, X-Expo-Turbo-Client, X-Expo-Turbo-Modules")
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
    # ActionController::Rendering#process_action does exactly this, so the view
    # context sees the format Rails selected for the request.
    controller.formats = controller.request.formats.filter_map(&:ref)
    controller
  end

  def native_controller(headers = {})
    controller_with_request({"HTTP_ACCEPT" => ExpoTurbo::Rails::MIME_TYPE}.merge(headers))
  end
end
