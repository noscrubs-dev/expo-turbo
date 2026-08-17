# frozen_string_literal: true

require "json"
require "spec_helper"

RSpec.describe ExpoTurbo::Rails::RegistryIdentifier do
  let(:grammar) do
    path = File.expand_path("../../../protocol/registry-identifier-grammar.json", __dir__)
    JSON.parse(File.read(path))
  end

  def scalar(hex)
    [hex.to_i(16)].pack("U")
  end

  it "consumes every shared valid scalar and sequence without normalization" do
    grammar.fetch("validScalarHex").each do |hex|
      expect { described_class.validate!(scalar(hex), "field.path") }.not_to raise_error
    end
    values = grammar.fetch("validSequenceScalarHex").map do |fixture|
      fixture.fetch("scalars").map { |hex| scalar(hex) }.join
    end
    values.each { |value| expect { described_class.validate!(value, "field.path") }.not_to raise_error }
    expect(values[0]).not_to eq(values[1])
  end

  it "rejects every shared noncharacter at scalar start, middle, end, and first of many" do
    grammar.fetch("invalidScalarHex").each do |hex|
      invalid = scalar(hex)
      [["#{invalid}ab", 0], ["a#{invalid}b", 1], ["ab#{invalid}", 2]].each do |value, index|
        expect { described_class.validate!(value, "field.path") }.to raise_error(
          ExpoTurbo::Rails::ConfigurationError,
          "Expo Turbo registry identifier field.path contains Unicode noncharacter U+#{hex} at scalar index #{index}"
        )
      end
    end
    expect { described_class.validate!("a#{scalar("FDD0")}#{scalar("10FFFF")}", "field.path") }
      .to raise_error(/U\+FDD0 at scalar index 1/)
    expect { described_class.validate!("#{scalar("1F600")}#{scalar("1FFFE")}", "field.path") }
      .to raise_error(/U\+1FFFE at scalar index 1/)
  end

  it "rejects shared malformed UTF-8 bytes before codepoint iteration" do
    grammar.fetch("rubyMalformedUtf8Hex").each do |fixture|
      value = [fixture.fetch("bytes")].pack("H*").force_encoding(Encoding::UTF_8)
      expect { described_class.validate!(value, "module.name") }.to raise_error(
        ExpoTurbo::Rails::ConfigurationError,
        "Expo Turbo registry identifier module.name is not valid UTF-8"
      )
    end
  end

  it "rejects non-string values before encoding inspection" do
    {1 => "Integer", :tag => "Symbol", nil => "NilClass"}.each do |value, type|
      expect { described_class.validate!(value, "component.tag") }.to raise_error(
        ExpoTurbo::Rails::ConfigurationError,
        "Expo Turbo registry identifier component.tag must be a String, got #{type}"
      )
      expect(described_class.valid?(value)).to be(false)
    end
  end
end
