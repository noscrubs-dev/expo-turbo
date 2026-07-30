# frozen_string_literal: true

require "json"

module ExpoTurbo
  module Rails
    class TemplateCapabilities
      MANIFEST_VERSION = 1
      PROTOCOL_ELEMENTS = %w[turbo-cable-stream-source turbo-frame turbo-stream template].freeze
      RESERVED_COMPONENT_NAMES = [*PROTOCOL_ELEMENTS, "expo-turbo-fragment"].freeze
      SHARED_ATTRIBUTE_NAMES = %w[autofocus class dir dirname form id xml:space xmlns].freeze
      TOKEN_PATTERN = /\A[a-z][a-z0-9-]*(?::[a-z][a-z0-9-]*)*\z/
      MAX_TOKEN_LENGTH = 64
      JAVASCRIPT_WHITESPACE = /[\u0009-\u000D\u0020\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]+/u
      LEADING_JAVASCRIPT_WHITESPACE = /\A[\u0009-\u000D\u0020\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]+/u
      TRAILING_JAVASCRIPT_WHITESPACE = /[\u0009-\u000D\u0020\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]+\z/u

      class ValidationError < StandardError
      end

      def initialize(components: nil, manifest: nil, style_tokens: {}, max_style_tokens: 5)
        if components.nil? == manifest.nil?
          raise ConfigurationError, "Expo Turbo template capabilities require exactly one of components or manifest"
        end

        manifest_backed = !manifest.nil?
        components = load_manifest_components(manifest) if manifest_backed
        @components, @style_token_components, @component_attributes = normalize_components(
          components,
          manifest_backed:
        )
        @style_tokens = normalize_style_tokens(style_tokens)
        @max_style_tokens = validate_max_style_tokens!(max_style_tokens)
        freeze
      end

      def validate_document!(document)
        validate_subtree!(document.root)
        document
      end

      def validate_frame_fragment!(document)
        validate_fragment!(document)
      end

      def validate_stream_fragment!(document)
        validate_fragment!(document)
      end

      private

      def load_manifest_components(path)
        manifest = parse_manifest(read_manifest(path))
        unless manifest["manifestVersion"] == MANIFEST_VERSION
          raise ConfigurationError, "Expo Turbo capability manifest version is unsupported"
        end
        unless manifest["protocolVersion"] == PROTOCOL_VERSION
          raise ConfigurationError, "Expo Turbo capability manifest protocol version does not match"
        end
        unless manifest["hash"].is_a?(String) && /\Afnv1a32:[0-9a-f]{8}\z/.match?(manifest["hash"])
          raise ConfigurationError, "Expo Turbo capability manifest hash is invalid"
        end

        validate_manifest_modules!(manifest["modules"])
        normalize_manifest_components(manifest["components"])
      end

      def read_manifest(path)
        path = path.to_path if path.respond_to?(:to_path)
        unless path.is_a?(String) && !path.empty?
          raise ConfigurationError, "Expo Turbo capability manifest path must be a nonblank path"
        end

        File.binread(path).force_encoding(Encoding::UTF_8).tap do |body|
          unless body.valid_encoding?
            raise ConfigurationError, "Expo Turbo capability manifest must be valid UTF-8"
          end
        end
      rescue SystemCallError, ArgumentError
        raise ConfigurationError, "Expo Turbo capability manifest could not be read"
      end

      def parse_manifest(body)
        JSON.parse(body).tap do |manifest|
          unless manifest.is_a?(Hash)
            raise ConfigurationError, "Expo Turbo capability manifest must be a JSON object"
          end
        end
      rescue JSON::ParserError
        raise ConfigurationError, "Expo Turbo capability manifest must be valid JSON"
      end

      def validate_manifest_modules!(modules)
        unless modules.is_a?(Array)
          raise ConfigurationError, "Expo Turbo capability manifest requires a module list"
        end

        names = {}
        modules.each do |component_module|
          unless component_module.is_a?(Hash) &&
              component_module["name"].is_a?(String) &&
              !component_module["name"].strip.empty? &&
              component_module["version"].is_a?(String) &&
              !component_module["version"].strip.empty?
            raise ConfigurationError, "Expo Turbo capability manifest modules require names and versions"
          end
          if names.key?(component_module["name"])
            raise ConfigurationError, "Expo Turbo capability manifest contains a duplicate module"
          end

          names[component_module["name"]] = true
        end
      end

      def normalize_manifest_components(component_entries)
        unless component_entries.is_a?(Array)
          raise ConfigurationError, "Expo Turbo capability manifest requires a component list"
        end

        component_entries.each_with_object({}) do |component, components|
          unless component.is_a?(Hash) && component["tag"].is_a?(String) && component["aliases"].is_a?(Array)
            raise ConfigurationError, "Expo Turbo capability manifest components require tags and aliases"
          end
          unless component["aliases"].all? { |alias_name| alias_name.is_a?(String) }
            raise ConfigurationError, "Expo Turbo capability manifest aliases must be strings"
          end

          attributes = component["attributes"]
          valid_attributes = attributes.is_a?(Array) && attributes.all? do |attribute|
            attribute.is_a?(Hash) &&
              attribute["name"].is_a?(String) &&
              !attribute["name"].empty? &&
              (!attribute.key?("required") || [true, false].include?(attribute["required"]))
          end
          raise ConfigurationError, "Expo Turbo capability manifest components require attribute names" unless valid_attributes

          attribute_names = attributes.map { |attribute| attribute["name"] }
          if attribute_names.uniq.length != attribute_names.length
            raise ConfigurationError, "Expo Turbo capability manifest contains duplicate attributes"
          end
          if components.key?(component["tag"])
            raise ConfigurationError, "Expo Turbo capability manifest contains a duplicate component"
          end

          components[component["tag"]] = {
            aliases: component["aliases"],
            attributes: attribute_names,
            required_attributes: attributes.filter_map { |attribute| attribute["name"] if attribute["required"] },
            style_tokens: attribute_names.include?("style-tokens")
          }
        end
      end

      def normalize_components(components, manifest_backed:)
        raise ConfigurationError, "Expo Turbo template capabilities require a component map" unless components.is_a?(Hash)

        component_attributes = {}
        names = {}
        style_token_components = {}
        components.each do |tag, configuration|
          tag = validate_component_name!(tag)
          configuration = normalize_component_configuration(tag, configuration, manifest_backed:)
          declare_component_name!(names, tag, tag)
          if manifest_backed
            component_attributes[tag] = {
              allowed: configuration[:attributes].to_h { |name| [name, true] }.freeze,
              required: configuration[:required_attributes].to_h { |name| [name, true] }.freeze
            }.freeze
          end
          style_token_components[tag] = true if configuration[:style_tokens]
          configuration[:aliases].each { |alias_name| declare_component_name!(names, alias_name, tag) }
        end
        [names.freeze, style_token_components.freeze, component_attributes.freeze]
      end

      def normalize_component_configuration(tag, configuration, manifest_backed:)
        configuration = {} if configuration.nil?
        allowed_keys = %i[aliases style_tokens]
        allowed_keys.concat(%i[attributes required_attributes]) if manifest_backed
        unless configuration.is_a?(Hash) && (configuration.keys - allowed_keys).empty?
          raise ConfigurationError, "Expo Turbo component #{tag.inspect} accepts only aliases and style_tokens"
        end

        aliases = configuration.fetch(:aliases, [])
        unless aliases.is_a?(Array)
          raise ConfigurationError, "Expo Turbo component #{tag.inspect} aliases must be an array"
        end

        aliases = aliases.map { |alias_name| validate_component_name!(alias_name) }.uniq
        if aliases.include?(tag)
          raise ConfigurationError, "Expo Turbo component #{tag.inspect} cannot alias itself"
        end

        style_tokens = configuration.fetch(:style_tokens, false)
        unless style_tokens == true || style_tokens == false
          raise ConfigurationError, "Expo Turbo component #{tag.inspect} style_tokens must be true or false"
        end

        attributes = manifest_backed ? configuration.fetch(:attributes) : []
        required_attributes = manifest_backed ? configuration.fetch(:required_attributes) : []
        {
          aliases: aliases.freeze,
          attributes: attributes.freeze,
          required_attributes: required_attributes.freeze,
          style_tokens:
        }.freeze
      end

      def declare_component_name!(names, name, canonical)
        if names.key?(name)
          raise ConfigurationError, "Expo Turbo component #{name.inspect} is declared more than once"
        end

        names[name] = canonical
      end

      def validate_component_name!(name)
        unless name.is_a?(String) && !javascript_trim(name).empty?
          raise ConfigurationError, "Expo Turbo component names must be nonblank strings"
        end
        if RESERVED_COMPONENT_NAMES.include?(name)
          raise ConfigurationError, "Expo Turbo component #{name.inspect} is reserved"
        end

        name
      end

      def normalize_style_tokens(style_tokens)
        raise ConfigurationError, "Expo Turbo template style tokens require a map" unless style_tokens.is_a?(Hash)

        style_tokens.each_with_object({}) do |(token, configuration), normalized|
          token = validate_style_token!(token)
          configuration = {} if configuration.nil?
          unless configuration.is_a?(Hash) && (configuration.keys - %i[components group]).empty?
            raise ConfigurationError, "Expo Turbo style token #{token.inspect} accepts only components and group"
          end

          components = normalize_style_components(token, configuration)
          group = configuration[:group]
          validate_style_token!(group) unless group.nil?
          normalized[token] = {components:, group:}.freeze
        end.freeze
      end

      def normalize_style_components(token, configuration)
        return unless configuration.key?(:components)

        components = configuration[:components]
        unless components.is_a?(Array) && components.any?
          raise ConfigurationError, "Expo Turbo style token #{token.inspect} requires nonblank components"
        end

        components.map do |component|
          component = validate_component_name!(component)
          canonical_component = @components[component]
          unless canonical_component
            raise ConfigurationError, "Expo Turbo style token #{token.inspect} references undeclared component #{component.inspect}"
          end
          unless @style_token_components.key?(canonical_component)
            raise ConfigurationError, "Expo Turbo style token #{token.inspect} references a component without style_tokens enabled"
          end

          canonical_component
        end.tap do |normalized|
          if normalized.uniq.length != normalized.length
            raise ConfigurationError, "Expo Turbo style token #{token.inspect} has duplicate components"
          end
        end.freeze
      end

      def validate_style_token!(token)
        unless token.is_a?(String) && token.length <= MAX_TOKEN_LENGTH && TOKEN_PATTERN.match?(token)
          raise ConfigurationError, "Expo Turbo style tokens must be bounded lowercase semantic tokens"
        end

        token
      end

      def validate_max_style_tokens!(max_style_tokens)
        unless max_style_tokens.is_a?(Integer) && max_style_tokens.positive?
          raise ConfigurationError, "Expo Turbo template capabilities require a positive style token limit"
        end

        max_style_tokens
      end

      def validate_fragment!(document)
        document.root.element_children.each { |element| validate_subtree!(element) }
        document
      end

      def validate_subtree!(root)
        elements = [root]
        until elements.empty?
          element = elements.pop
          validate_element!(element)
          element.element_children.reverse_each { |child| elements << child }
        end
      end

      def validate_element!(element)
        return if protocol_element?(element)

        component = @components[qualified_element_name(element)]
        raise ValidationError, "Expo Turbo template contains an undeclared component" unless component

        validate_component_attributes!(element, component)
        style_tokens = literal_attribute(element, "style-tokens")&.value
        if style_tokens
          unless @style_token_components.key?(component)
            raise ValidationError, "Expo Turbo template uses style tokens on an unsupported component"
          end

          validate_style_tokens!(style_tokens, component)
        end
      end

      def protocol_element?(element)
        PROTOCOL_ELEMENTS.include?(qualified_element_name(element))
      end

      def qualified_element_name(element)
        prefix = element.namespace&.prefix
        (prefix && !prefix.empty?) ? "#{prefix}:#{element.name}" : element.name
      end

      def literal_attribute(element, name)
        element.attribute_nodes.find { |attribute| attribute.name == name && attribute.namespace.nil? }
      end

      def validate_component_attributes!(element, component)
        capabilities = @component_attributes[component]
        return unless capabilities

        present = {}
        element.attribute_nodes.each do |attribute|
          name = qualified_attribute_name(attribute)
          present[name] = true
          next if shared_attribute_name?(name) || capabilities[:allowed].key?(name)

          raise ValidationError, "Expo Turbo template contains an undeclared component attribute"
        end
        return if capabilities[:required].keys.all? { |name| present.key?(name) }

        raise ValidationError, "Expo Turbo template omits a required component attribute"
      end

      def qualified_attribute_name(attribute)
        prefix = attribute.namespace&.prefix
        (prefix && !prefix.empty?) ? "#{prefix}:#{attribute.name}" : attribute.name
      end

      def shared_attribute_name?(name)
        SHARED_ATTRIBUTE_NAMES.include?(name) || name.start_with?("data-", "xmlns:")
      end

      def validate_style_tokens!(value, component)
        tokens = javascript_token_list(value)
        raise ValidationError, "Expo Turbo template has too many style tokens" if tokens.length > @max_style_tokens

        groups = {}
        used = {}
        tokens.each do |token|
          definition = @style_tokens[token]
          raise ValidationError, "Expo Turbo template has an unknown style token" unless definition
          raise ValidationError, "Expo Turbo template has a duplicate style token" if used.key?(token)

          used[token] = true
          if definition[:components] && !definition[:components].include?(component)
            raise ValidationError, "Expo Turbo template uses a style token on an unsupported component"
          end
          next unless definition[:group]

          raise ValidationError, "Expo Turbo template has conflicting style tokens" if groups.key?(definition[:group])

          groups[definition[:group]] = true
        end
      end

      def javascript_token_list(value)
        value = javascript_trim(value)
        value.empty? ? [] : value.split(JAVASCRIPT_WHITESPACE)
      end

      def javascript_trim(value)
        value.gsub(LEADING_JAVASCRIPT_WHITESPACE, "").gsub(TRAILING_JAVASCRIPT_WHITESPACE, "")
      end
    end
  end
end
