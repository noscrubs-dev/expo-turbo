# frozen_string_literal: true

require "json"
require "digest"
require "pathname"

module ExpoTurbo
  module Rails
    class CompatibilityRegistry
      DIGEST_PATTERN = /\Asha256-128:[0-9a-f]{32}\z/
      DESCRIPTOR_VALUE_PATTERN = /\A[A-Za-z0-9._:+-]+\z/

      Entry = Data.define(:digest, :revision, :components) do
        def supports_component?(tag)
          components.key?(tag)
        end

        def supports_attribute?(tag, attribute)
          Array(components[tag]).include?(attribute)
        end
      end

      def self.from_data(lock:, vocabularies:)
        new(lock:, vocabularies:)
      end

      def self.load(lockfile)
        path = Pathname(lockfile)
        lock = JSON.parse(File.binread(path))
        vocabularies = lock.fetch("history").to_h do |entry|
          manifest_path = path.dirname.join(entry.fetch("manifest"))
          manifest = JSON.parse(File.binread(manifest_path))
          validate_manifest_identifiers!(manifest)
          unless manifest["hash"] == entry.fetch("digest")
            raise ConfigurationError, "Expo Turbo compatibility manifest digest does not match its lock entry"
          end
          digest_source = {
            "components" => manifest.fetch("components"),
            "modules" => manifest.fetch("modules"),
            "protocolVersion" => manifest.fetch("protocolVersion")
          }
          computed_digest = "sha256-128:#{Digest::SHA256.hexdigest(JSON.generate(digest_source))[0, 32]}"
          unless computed_digest == entry.fetch("digest")
            raise ConfigurationError, "Expo Turbo compatibility manifest computed digest does not match its lock entry"
          end
          components = manifest.fetch("components").to_h do |component|
            [component.fetch("tag"), component.fetch("attributes").map { |attribute| attribute.fetch("name") }]
          end
          [entry.fetch("digest"), components]
        end
        new(lock:, vocabularies:)
      rescue SystemCallError, JSON::ParserError, KeyError, TypeError
        raise ConfigurationError, "Expo Turbo compatibility lock could not be loaded"
      end

      def self.validate_manifest_identifiers!(manifest)
        manifest.fetch("modules").each_with_index do |component_module, module_index|
          RegistryIdentifier.validate!(component_module.fetch("name"), "modules[#{module_index}].name")
        end
        manifest.fetch("components").each_with_index do |component, component_index|
          RegistryIdentifier.validate!(component.fetch("tag"), "components[#{component_index}].tag")
          component.fetch("aliases").each_with_index do |alias_name, alias_index|
            RegistryIdentifier.validate!(alias_name, "components[#{component_index}].aliases[#{alias_index}]")
          end
          component.fetch("attributes").each_with_index do |attribute, attribute_index|
            prefix = "components[#{component_index}].attributes[#{attribute_index}]"
            %w[name prop codec].each do |field|
              RegistryIdentifier.validate!(attribute.fetch(field), "#{prefix}.#{field}")
            end
          end
        end
      end
      private_class_method :validate_manifest_identifiers!

      def self.parse_descriptor(value)
        return unless value.is_a?(String)

        value = value.dup.force_encoding(Encoding::UTF_8)
        return unless value.valid_encoding? && value.ascii_only?

        fields = {}
        valid = value.split(";", -1).all? do |part|
          name, field_value = part.strip.split("=", 2)
          next false unless name && field_value && !fields.key?(name)
          next false unless DESCRIPTOR_VALUE_PATTERN.match?(name) && DESCRIPTOR_VALUE_PATTERN.match?(field_value)

          fields[name] = field_value
          true
        end
        return unless valid
        expected_fields = fields.key?("vocab") ? %w[proto rt v vocab] : %w[proto rt v]
        return unless fields.keys.sort == expected_fields.sort
        return unless fields["v"] == "1" && fields["proto"] == PROTOCOL_VERSION && fields["rt"]
        return unless fields["vocab"].nil? || DIGEST_PATTERN.match?(fields["vocab"])

        fields.freeze
      end

      def initialize(lock:, vocabularies:)
        unless lock.is_a?(Hash) && lock["lockVersion"] == 1 && lock["history"].is_a?(Array)
          raise ConfigurationError, "Expo Turbo compatibility lock is invalid"
        end
        digests = {}
        revisions = {}
        @entries = lock.fetch("history").to_h do |record|
          digest = record["digest"]
          revision = record["revision"]
          unless DIGEST_PATTERN.match?(digest) && revision.is_a?(Integer) && revision.positive?
            raise ConfigurationError, "Expo Turbo compatibility lock history is invalid"
          end
          if revisions.key?(revision)
            raise ConfigurationError, "Expo Turbo compatibility lock revisions must be unique"
          end
          if digests.key?(digest)
            raise ConfigurationError, "Expo Turbo compatibility lock digests must be unique"
          end
          digests[digest] = true
          revisions[revision] = true
          components = vocabularies.fetch(digest, {})
          components.each_with_index do |(tag, attributes), component_index|
            RegistryIdentifier.validate!(tag, "components[#{component_index}].tag")
            Array(attributes).each_with_index do |attribute, attribute_index|
              RegistryIdentifier.validate!(attribute, "components[#{component_index}].attributes[#{attribute_index}].name")
            end
          end
          [digest, Entry.new(digest:, revision:, components: components.freeze).freeze]
        end.freeze
        current = lock["current"]
        unless @entries.key?(current)
          raise ConfigurationError, "Expo Turbo compatibility lock current digest is unknown"
        end
        freeze
      rescue KeyError
        raise ConfigurationError, "Expo Turbo compatibility lock vocabulary is missing"
      end

      def resolve(digest)
        @entries[digest]
      end
    end
  end
end
