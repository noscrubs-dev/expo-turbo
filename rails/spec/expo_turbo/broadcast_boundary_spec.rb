# frozen_string_literal: true

require "action_controller/api"
require "spec_helper"
require "support/rendering"

# A broadcast has no request, so it has no format. turbo-rails renders a
# broadcast through ApplicationController.render with :turbo_stream written in
# its own source, and gives no hook to choose another format. Expo Turbo
# therefore keeps an explicitly named broadcast API instead of silently
# overriding broadcast_*, which would send browser HTML to native clients or
# native XML to browsers.
RSpec.describe "Expo Turbo broadcast boundary" do
  include ExpoTurboSpecRendering

  let(:controller_class) do
    Class.new(ActionController::API) do
      include ExpoTurbo::Rails::Controller
    end
  end

  it "does not override the turbo-rails model broadcast API" do
    overridden = ExpoTurbo::Rails::Controller.instance_methods(false).grep(/\Abroadcast_/)

    expect(overridden).to all(start_with("broadcast_expo_turbo_"))
    expect(::Turbo::Broadcastable.instance_methods).to include(:broadcast_replace_to)
    expect(ExpoTurbo::Rails::Controller.instance_methods(false)).not_to include(:broadcast_replace_to)
  end

  it "keeps the explicit builder Expo Turbo without a request format" do
    controller = controller_class.new
    controller.request = ActionDispatch::TestRequest.create

    expect(controller.expo_turbo_stream).to be_a(ExpoTurbo::Rails::Streams::TagBuilder)
    expect(controller.turbo_stream).not_to be_a(ExpoTurbo::Rails::Streams::TagBuilder)
  end

  it "uses the Expo Turbo builder for a request that accepts Expo Turbo" do
    controller = controller_class.new
    controller.request = ActionDispatch::TestRequest.create("HTTP_ACCEPT" => ExpoTurbo::Rails::MIME_TYPE)

    expect(controller.turbo_stream).to be_a(ExpoTurbo::Rails::Streams::TagBuilder)
  end
end
