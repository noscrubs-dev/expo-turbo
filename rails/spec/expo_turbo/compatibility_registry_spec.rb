# frozen_string_literal: true

require "json"
require "spec_helper"
require "tmpdir"

RSpec.describe ExpoTurbo::Rails::CompatibilityRegistry do
  let(:digest) { "sha256-128:f04ab2d6529c683a1094a0b8ddc8d5ea" }
  let(:manifest_path) { File.expand_path("../../../example/rails/config/expo_turbo_manifest.json", __dir__) }

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
end
