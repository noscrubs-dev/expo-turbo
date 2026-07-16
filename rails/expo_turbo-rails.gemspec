# frozen_string_literal: true

require_relative "lib/expo_turbo/rails/version"

Gem::Specification.new do |spec|
  spec.name = "expo_turbo-rails"
  spec.version = ExpoTurbo::Rails::VERSION
  spec.authors = ["NoScrubs"]
  spec.summary = "Rails integration scaffold for Expo Turbo"
  spec.description = "Host-neutral Rails package scaffold for the planned Expo Turbo protocol"
  spec.homepage = "https://github.com/noscrubs-dev/expo-turbo"
  spec.license = "MIT"
  spec.required_ruby_version = ">= 3.2"

  spec.metadata["allowed_push_host"] = "https://rubygems.org"
  spec.metadata["bug_tracker_uri"] = "https://github.com/noscrubs-dev/expo-turbo/issues"
  spec.metadata["changelog_uri"] = "https://github.com/noscrubs-dev/expo-turbo/blob/main/CHANGELOG.md"
  spec.metadata["rubygems_mfa_required"] = "true"
  spec.metadata["source_code_uri"] = spec.homepage

  spec.files = Dir.chdir(__dir__) { Dir["lib/**/*", "LICENSE.txt", "README.md"] }
  spec.require_paths = ["lib"]

  spec.add_dependency "railties", ">= 7.2", "< 8.2"
  spec.add_dependency "turbo-rails", ">= 2.0.10", "< 3"
end
