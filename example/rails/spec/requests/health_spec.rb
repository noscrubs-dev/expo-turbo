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
  end
end
