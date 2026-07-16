# frozen_string_literal: true

require "spec_helper"

RSpec.describe ExpoTurbo::Rails do
  it "exposes the scaffold version" do
    expect(described_class::VERSION).to eq("0.1.0")
  end

  it "provides a non-route-owning Rails Engine" do
    expect(described_class::Engine).to be < ::Rails::Engine
    expect(described_class::Engine.routes.routes).to be_empty
  end
end
