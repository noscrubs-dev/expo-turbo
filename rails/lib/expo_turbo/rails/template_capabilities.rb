# frozen_string_literal: true

module ExpoTurbo
  module Rails
    class TemplateCapabilities
      PROTOCOL_ELEMENTS = %w[turbo-cable-stream-source turbo-frame turbo-stream template].freeze
      RESERVED_COMPONENT_NAMES = [*PROTOCOL_ELEMENTS, "expo-turbo-fragment"].freeze
      TOKEN_PATTERN = /\A[a-z][a-z0-9-]*(?::[a-z][a-z0-9-]*)*\z/
      MAX_TOKEN_LENGTH = 64
      JAVASCRIPT_WHITESPACE = /[\u0009-\u000D\u0020\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]+/u
      LEADING_JAVASCRIPT_WHITESPACE = /\A[\u0009-\u000D\u0020\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]+/u
      TRAILING_JAVASCRIPT_WHITESPACE = /[\u0009-\u000D\u0020\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]+\z/u

      class ValidationError < StandardError
      end

      def initialize(components:, style_tokens: {}, max_style_tokens: 5)
        @components, @style_token_components = normalize_components(components)
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

      def normalize_components(components)
        raise ConfigurationError, "Expo Turbo template capabilities require a component map" unless components.is_a?(Hash)

        names = {}
        style_token_components = {}
        components.each do |tag, configuration|
          tag = validate_component_name!(tag)
          configuration = normalize_component_configuration(tag, configuration)
          declare_component_name!(names, tag, tag)
          style_token_components[tag] = true if configuration[:style_tokens]
          configuration[:aliases].each { |alias_name| declare_component_name!(names, alias_name, tag) }
        end
        [names.freeze, style_token_components.freeze]
      end

      def normalize_component_configuration(tag, configuration)
        configuration = {} if configuration.nil?
        unless configuration.is_a?(Hash) && (configuration.keys - %i[aliases style_tokens]).empty?
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

        {aliases: aliases.freeze, style_tokens:}.freeze
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
