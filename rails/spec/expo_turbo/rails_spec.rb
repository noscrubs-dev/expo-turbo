# frozen_string_literal: true

require "spec_helper"

RSpec.describe ExpoTurbo::Rails do
  it "exposes the scaffold version" do
    expect(described_class::VERSION).to eq("0.1.0")
  end

  it "pins the cross-language compatibility baselines" do
    expect(described_class::PROTOCOL_VERSION).to eq("0.1")
    expect(described_class::TURBO_BASELINE_VERSION).to eq("8.0.23")
    expect(described_class::TURBO_RAILS_BASELINE_VERSION).to eq("2.0.23")
    expect(described_class::TURBO_RAILS_MINIMUM_VERSION).to eq("2.0.10")
    expect(described_class::RAILS_BASELINE_VERSION).to eq("8.1.3")
    expect(described_class::MIME_TYPE).to eq("application/vnd.expo-turbo+xml")
    expect(described_class::MIME_SYMBOL).to eq(:expo_turbo)
  end

  it "provides a non-route-owning Rails Engine" do
    expect(described_class::Engine).to be < ::Rails::Engine
    expect(described_class::Engine.routes.routes).to be_empty
  end

  it "loads Action Cable and Active Job without mounting a Cable route" do
    route_paths = ExpoTurboRailsSpecApp.routes.routes.map { |route| route.path.spec.to_s }

    expect(defined?(ActionCable::Channel::Base)).to eq("constant")
    expect(defined?(ActiveJob::Base)).to eq("constant")
    expect(route_paths).not_to include(a_string_starting_with("/cable"))
  end
end
