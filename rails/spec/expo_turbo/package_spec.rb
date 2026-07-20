# frozen_string_literal: true

require "rubygems/package"
require "pathname"
require "stringio"
require "tmpdir"
require "zlib"
require "spec_helper"

RSpec.describe "expo_turbo-rails package" do
  def packaged_entries(artifact)
    entries = nil

    File.open(artifact, "rb") do |file|
      Gem::Package::TarReader.new(file) do |gem|
        data = gem.find { |entry| entry.full_name == "data.tar.gz" }

        Zlib::GzipReader.wrap(StringIO.new(data.read)) do |payload|
          entries = Gem::Package::TarReader.new(payload).filter_map do |entry|
            [entry.full_name, entry.file?] unless entry.directory?
          end
        end
      end
    end

    entries
  end

  it "ships only namespaced Ruby code and public package files" do
    gem_root = File.expand_path("../..", __dir__)
    specification = Gem::Specification.load(File.join(gem_root, "expo_turbo-rails.gemspec"))

    Dir.mktmpdir do |directory|
      artifact = File.join(directory, "#{specification.full_name}.gem")
      Dir.chdir(gem_root) { Gem::Package.build(specification, false, true, artifact) }

      entries = packaged_entries(artifact)
      files = entries.map(&:first)

      expect(files).to include("LICENSE.txt", "README.md", "lib/expo_turbo/rails.rb")
      expect(entries).to all(satisfy { |_file, regular_file| regular_file })
      expect(files).to all(
        satisfy do |file|
          path = Pathname.new(file)

          path.relative? &&
            path.cleanpath.to_s == file &&
            path.each_filename.none? { |segment| segment == "." || segment == ".." } &&
            (file.start_with?("lib/expo_turbo/") || %w[LICENSE.txt README.md].include?(file))
        end
      )
    end
  end
end
