# frozen_string_literal: true

require "spec_helper"
require "action_controller/base"

# A host filter that halts before the concern's own filter runs, and an
# unrescued exception that ActionDispatch::ShowExceptions turns into its own
# response. Neither reaches a controller after-callback, and the second never
# reaches a controller callback at all.
class ExpoTurboVarySpecHaltedController < ActionController::Base
  prepend_before_action { head :unauthorized }

  def show
    head :ok
  end
end

class ExpoTurboVarySpecLateHaltedController < ActionController::Base
  def self.install_host_filter!
    prepend_before_action { head :payment_required }
  end

  def show
    head :ok
  end
end

ExpoTurboVarySpecLateHaltedController.install_host_filter!

class ExpoTurboVarySpecBoomController < ActionController::Base
  def show
    raise "expo turbo vary probe"
  end
end

class ExpoTurboVarySpecPlainController < ActionController::Base
  def show
    head :ok
  end
end

ExpoTurboRailsSpecApp.routes.draw do
  get "expo-turbo-vary-spec/halted", to: "expo_turbo_vary_spec_halted#show"
  get "expo-turbo-vary-spec/late-halted", to: "expo_turbo_vary_spec_late_halted#show"
  get "expo-turbo-vary-spec/boom", to: "expo_turbo_vary_spec_boom#show"
  get "expo-turbo-vary-spec/plain", to: "expo_turbo_vary_spec_plain#show"
end

RSpec.describe ExpoTurbo::Rails::VaryHeaders do
  let(:expected) { "Accept, Turbo-Frame, X-Expo-Turbo-Modules" }

  it "is installed outside ActionDispatch::ShowExceptions" do
    stack = ExpoTurboRailsSpecApp.middleware.middlewares

    expect(stack).to include(described_class)
    expect(stack.index(described_class)).to be < stack.index(ActionDispatch::ShowExceptions)
  end

  it "varies an ordinary routed response" do
    status, headers = request("/expo-turbo-vary-spec/plain")

    expect(status).to eq(200)
    expect(headers["vary"]).to eq(expected)
  end

  # A prepended host filter always runs before the concern's own filter, so the
  # after-callback and the prepended before-callback are both skipped.
  it "varies a response that a prepended host filter halted" do
    status, headers = request("/expo-turbo-vary-spec/halted")

    expect(status).to eq(401)
    expect(headers["vary"]).to eq(expected)
  end

  it "varies a response that a host filter prepended after the concern halted" do
    status, headers = request("/expo-turbo-vary-spec/late-halted")

    expect(status).to eq(402)
    expect(headers["vary"]).to eq(expected)
  end

  # ActionDispatch::ShowExceptions builds this response itself, from an
  # exceptions app that is not the controller.
  it "varies a response that ShowExceptions rendered for an unrescued exception" do
    status, headers = request("/expo-turbo-vary-spec/boom", "action_dispatch.show_exceptions" => :all)

    expect(status).to eq(500)
    expect(headers["vary"]).to eq(expected)
  end

  it "varies the routing error response for an unknown path" do
    status, headers = request("/expo-turbo-vary-spec/missing", "action_dispatch.show_exceptions" => :all)

    expect(status).to eq(404)
    expect(headers["vary"]).to eq(expected)
  end

  it "keeps existing Vary dimensions and does not repeat one" do
    headers = {"vary" => "Accept-Encoding, accept"}
    _, merged = described_class.new(->(_) { [200, headers, []] }).call({})

    expect(merged["vary"]).to eq("Accept-Encoding, accept, Turbo-Frame, X-Expo-Turbo-Modules")
  end

  it "leaves an uncacheable Vary alone" do
    headers = {"vary" => "*"}
    _, merged = described_class.new(->(_) { [200, headers, []] }).call({})

    expect(merged["vary"]).to eq("*")
  end

  it "stamps a frozen header set without raising" do
    _, merged = described_class.new(->(_) { [200, {}.freeze, []] }).call({})

    expect(merged["vary"]).to eq("Accept, Turbo-Frame, X-Expo-Turbo-Modules")
  end

  def request(path, env = {})
    status, headers, = ExpoTurboRailsSpecApp.call(
      Rack::MockRequest.env_for(
        path,
        {"HTTP_ACCEPT" => "text/html", "HTTP_HOST" => "localhost"}.merge(env)
      )
    )
    [status, headers]
  end
end
