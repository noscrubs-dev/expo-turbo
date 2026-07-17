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
end
