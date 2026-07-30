# frozen_string_literal: true

require "spec_helper"

RSpec.describe ExpoTurbo::Rails::RouteConstraint do
  subject(:matches) do
    request = ActionDispatch::TestRequest.create("HTTP_ACCEPT" => accept)

    described_class.new.matches?(request)
  end

  it "matches an explicit positive Expo Turbo media range without substring matching" do
    expect(described_class.new.matches?(
      ActionDispatch::TestRequest.create(
        "HTTP_ACCEPT" => "application/json, #{ExpoTurbo::Rails::MIME_TYPE};q=0.2"
      )
    )).to be(true)
    expect(described_class.new.matches?(
      ActionDispatch::TestRequest.create(
        "HTTP_ACCEPT" => "#{ExpoTurbo::Rails::MIME_TYPE}-suffix"
      )
    )).to be(false)
  end

  it "rejects an explicit zero-quality Expo Turbo media range" do
    expect(described_class.new.matches?(
      ActionDispatch::TestRequest.create(
        "HTTP_ACCEPT" => "#{ExpoTurbo::Rails::MIME_TYPE};q=0"
      )
    )).to be(false)
  end

  it "matches positive wildcards and rejects a zero-quality most-specific range" do
    {
      "application/*" => true,
      "*/*" => true,
      "application/*;q=0, */*;q=1" => false,
      "#{ExpoTurbo::Rails::MIME_TYPE};q=0, application/*;q=1" => false,
      "#{ExpoTurbo::Rails::MIME_TYPE};q=0.1, application/*;q=0" => true
    }.each do |accept, expected|
      request = ActionDispatch::TestRequest.create("HTTP_ACCEPT" => accept)

      expect(described_class.new.matches?(request)).to be(expected), accept
    end
  end

  context "without an Expo Turbo media range" do
    let(:accept) { "application/json" }

    it { is_expected.to be(false) }
  end

  context "without an Accept header" do
    let(:accept) { nil }

    it { is_expected.to be(false) }
  end
end
