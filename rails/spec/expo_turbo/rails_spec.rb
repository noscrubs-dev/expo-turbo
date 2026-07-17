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
  end

  it "provides a non-route-owning Rails Engine" do
    expect(described_class::Engine).to be < ::Rails::Engine
    expect(described_class::Engine.routes.routes).to be_empty
  end
end
