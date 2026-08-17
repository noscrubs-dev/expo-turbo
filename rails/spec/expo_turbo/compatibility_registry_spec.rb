# frozen_string_literal: true

require "json"
require "spec_helper"
require "tmpdir"

RSpec.describe ExpoTurbo::Rails::CompatibilityRegistry do
  let(:manifest_path) { File.expand_path("../../../example/rails/config/expo_turbo_manifest.json", __dir__) }
  let(:digest) { JSON.parse(File.read(manifest_path)).fetch("hash") }

  def compatibility_manifest(version: 2)
    {
      "manifestVersion" => version,
      "protocolVersion" => ExpoTurbo::Rails::PROTOCOL_VERSION,
      "modules" => [{"name" => "example"}],
      "components" => [{
        "aliases" => ["LegacyCard"],
        "attributes" => [{"codec" => "string", "name" => "title", "prop" => "title"}],
        "children" => "none",
        "formOwner" => false,
        "morphState" => "preserve",
        "tag" => "DemoCard"
      }]
    }
  end

  def write_compatibility_fixture(directory, manifest)
    digest_source = {
      "components" => manifest.fetch("components"),
      "modules" => manifest.fetch("modules"),
      "protocolVersion" => manifest.fetch("protocolVersion")
    }
    fixture_digest = "sha256-128:#{Digest::SHA256.hexdigest(JSON.generate(digest_source))[0, 32]}"
    manifest = manifest.merge("hash" => fixture_digest)
    File.write(File.join(directory, "manifest.json"), JSON.generate(manifest))
    lock = {
      "lockVersion" => 1,
      "current" => fixture_digest,
      "history" => [{
        "revision" => 1,
        "digest" => fixture_digest,
        "published" => false,
        "package" => "example",
        "manifest" => "manifest.json"
      }]
    }
    lockfile = File.join(directory, "expo-turbo.lock.json")
    File.write(lockfile, JSON.generate(lock))
    [lockfile, fixture_digest]
  end

  it "rejects duplicate digests before a hash key can collapse them" do
    lock = {
      "lockVersion" => 1,
      "current" => digest,
      "history" => [
        {"revision" => 1, "digest" => digest},
        {"revision" => 2, "digest" => digest}
      ]
    }

    # Reverting digest uniqueness lets the last duplicate silently replace the first.
    expect { described_class.from_data(lock:, vocabularies: {digest => {}}) }
      .to raise_error(ExpoTurbo::Rails::ConfigurationError, /digests must be unique/)
  end

  it "recomputes the manifest digest instead of trusting its hash field" do
    Dir.mktmpdir("expo-turbo-compatibility") do |directory|
      manifest = JSON.parse(File.read(manifest_path))
      manifest.fetch("components").first["tag"] = "TamperedTag"
      File.write(File.join(directory, "manifest.json"), JSON.generate(manifest))
      lock = {
        lockVersion: 1,
        current: digest,
        history: [
          {revision: 1, digest:, published: false, package: "example", manifest: "manifest.json"}
        ]
      }
      lockfile = File.join(directory, "expo-turbo.lock.json")
      File.write(lockfile, JSON.generate(lock))

      # Reverting digest recomputation accepts modified registry content under the old digest.
      expect { described_class.load(lockfile) }
        .to raise_error(ExpoTurbo::Rails::ConfigurationError, /computed digest/)
    end
  end

  it "loads the checked-in digest-matching compatibility lock" do
    lockfile = File.expand_path("../../../expo-turbo.lock.json", __dir__)

    registry = described_class.load(lockfile)

    expect(registry.resolve(digest)).not_to be_nil
    expect(registry.resolve(digest).supports_component?("DemoCard")).to be(true)
    expect(registry.resolve(digest).supports_attribute?("DemoCard", "title")).to be(true)
  end

  it "loads a manifestVersion 1 attribute without prop or codec" do
    Dir.mktmpdir("expo-turbo-compatibility") do |directory|
      manifest = compatibility_manifest(version: 1)
      manifest.fetch("components").first.fetch("attributes").first.delete("prop")
      manifest.fetch("components").first.fetch("attributes").first.delete("codec")
      lockfile, fixture_digest = write_compatibility_fixture(directory, manifest)

      expect(described_class.load(lockfile).resolve(fixture_digest).supports_attribute?("DemoCard", "title")).to be(true)
    end
  end

  it "loads historical manifestVersion 2 attributes with either optional identity absent" do
    %w[prop codec].each do |field|
      Dir.mktmpdir("expo-turbo-compatibility") do |directory|
        manifest = compatibility_manifest
        manifest.fetch("components").first.fetch("attributes").first.delete(field)
        lockfile, fixture_digest = write_compatibility_fixture(directory, manifest)

        expect(described_class.load(lockfile).resolve(fixture_digest).supports_attribute?("DemoCard", "title")).to be(true)
      end
    end
  end

  it "keeps normal deprecation prose valid in JSON emitted with a capability manifest" do
    Dir.mktmpdir("expo-turbo-compatibility") do |directory|
      manifest = compatibility_manifest
      manifest.fetch("components").first.fetch("attributes").first["deprecated"] = "Use title instead: café 😀"
      lockfile, fixture_digest = write_compatibility_fixture(directory, manifest)

      parsed = JSON.parse(File.binread(File.join(directory, "manifest.json")))
      registry = described_class.load(lockfile)

      expect(parsed.dig("components", 0, "attributes", 0, "deprecated")).to eq("Use title instead: café 😀")
      expect(registry.resolve(fixture_digest).supports_attribute?("DemoCard", "title")).to be(true)
    end
  end

  it "maps every malformed loaded manifest identity to its exact configuration path and type" do
    cases = [
      [->(manifest) { manifest.fetch("modules").first["name"] = 1 }, "modules[0].name", "Integer"],
      [->(manifest) { manifest.fetch("components").first["tag"] = nil }, "components[0].tag", "NilClass"],
      [->(manifest) { manifest.fetch("components").first["aliases"][0] = false }, "components[0].aliases[0]", "FalseClass"],
      [->(manifest) { manifest.fetch("components").first.fetch("attributes").first["name"] = [] }, "components[0].attributes[0].name", "Array"],
      [->(manifest) { manifest.fetch("components").first.fetch("attributes").first["prop"] = 1 }, "components[0].attributes[0].prop", "Integer"],
      [->(manifest) { manifest.fetch("components").first.fetch("attributes").first["codec"] = {} }, "components[0].attributes[0].codec", "Hash"]
    ]

    cases.each do |mutation, path, type|
      Dir.mktmpdir("expo-turbo-compatibility") do |directory|
        manifest = compatibility_manifest
        mutation.call(manifest)
        lockfile, = write_compatibility_fixture(directory, manifest)

        expect { described_class.load(lockfile) }.to raise_error(
          ExpoTurbo::Rails::ConfigurationError,
          "Expo Turbo registry identifier #{path} must be a String, got #{type}"
        )
      end
    end
  end

  it "maps malformed direct compatibility vocabulary identities to ConfigurationError" do
    lock = {
      "lockVersion" => 1,
      "current" => digest,
      "history" => [{"revision" => 1, "digest" => digest}]
    }
    cases = [
      [{1 => ["title"]}, "components[0].tag", "Integer"],
      [{DemoCard: ["title"]}, "components[0].tag", "Symbol"],
      [{"DemoCard" => [nil]}, "components[0].attributes[0].name", "NilClass"]
    ]

    cases.each do |components, path, type|
      expect { described_class.from_data(lock:, vocabularies: {digest => components}) }.to raise_error(
        ExpoTurbo::Rails::ConfigurationError,
        "Expo Turbo registry identifier #{path} must be a String, got #{type}"
      )
    end
  end

  it "does not leak a parser error for invalid UTF-8 lock data" do
    Dir.mktmpdir("expo-turbo-compatibility") do |directory|
      lockfile = File.join(directory, "expo-turbo.lock.json")
      File.binwrite(lockfile, "{\"lockVersion\":1,\"history\":[\"\xFF\"]}")

      expect { described_class.load(lockfile) }.to raise_error(
        ExpoTurbo::Rails::ConfigurationError,
        "Expo Turbo compatibility lock could not be loaded"
      )
    end
  end

  it "rejects noncharacters in direct compatibility vocabulary identities" do
    lock = {
      "lockVersion" => 1,
      "current" => digest,
      "history" => [{"revision" => 1, "digest" => digest}]
    }

    expect {
      described_class.from_data(lock:, vocabularies: {digest => {"Demo\uFDD0" => ["title"]}})
    }.to raise_error(
      ExpoTurbo::Rails::ConfigurationError,
      "Expo Turbo registry identifier components[0].tag contains Unicode noncharacter U+FDD0 at scalar index 4"
    )
    expect {
      described_class.from_data(lock:, vocabularies: {digest => {"Demo" => ["title\uFDD0"]}})
    }.to raise_error(
      ExpoTurbo::Rails::ConfigurationError,
      "Expo Turbo registry identifier components[0].attributes[0].name contains Unicode noncharacter U+FDD0 at scalar index 5"
    )
  end
end
