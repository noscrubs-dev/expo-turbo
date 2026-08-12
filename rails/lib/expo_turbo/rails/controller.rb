# frozen_string_literal: true

require "active_support/concern"
require "active_support/core_ext/module/attr_internal"
require "action_controller/metal/helpers"
require "action_view/rendering"
require "pathname"
require "rubygems/requirement"

module ExpoTurbo
  module Rails
    module Controller
      extend ActiveSupport::Concern
      include ActionController::Helpers
      include ActionView::Rendering

      included do
        class_attribute :expo_turbo_views_path, instance_accessor: false
        class_attribute :expo_turbo_template_capabilities_config, instance_accessor: false
        helper ExpoTurbo::Rails::Attributes::Helper
        helper ExpoTurbo::Rails::Frames::Helper
        helper ExpoTurbo::Rails::DomIds::Helper
        helper ExpoTurbo::Rails::Streams::Helper
        helper_method :expo_turbo_client_modules, :expo_turbo_client_supports?, :expo_turbo_frame_request?,
          :expo_turbo_frame_request_id, :expo_turbo_request?
      end

      class_methods do
        def expo_turbo_view_root(path)
          self.expo_turbo_views_path = Pathname(path).expand_path
        end

        def expo_turbo_template_capabilities(components: nil, manifest: nil, style_tokens: {}, max_style_tokens: 5)
          self.expo_turbo_template_capabilities_config = TemplateCapabilities.new(
            components:,
            manifest:,
            style_tokens:,
            max_style_tokens:
          )
        end
      end

      def render_expo_turbo(template, locals: {}, status: :ok)
        body = render_to_string(
          inline: File.read(expo_turbo_template_file(template)),
          type: :erb,
          formats: [:xml],
          layout: false,
          locals: locals
        )
        raise TemplateError, "Expo Turbo templates must render valid UTF-8" unless body.encoding == Encoding::UTF_8 && body.valid_encoding?

        document = XmlFragments.parse_document(body)
        XmlFragments.validate_document_ids!(document)
        expo_turbo_validate_document!(document)

        render plain: body, content_type: MIME_TYPE, status: status
      rescue XmlFragments::DocumentIdError
        raise TemplateError, "Expo Turbo templates must use unique nonblank literal ids"
      rescue XmlFragments::ParseError
        raise TemplateError, "Expo Turbo templates must render well-formed UTF-8 XML"
      end

      def expo_turbo_frame_request?
        expo_turbo_frame_request_id.present?
      end

      def expo_turbo_frame_request_id
        frame_id = request.get_header("HTTP_TURBO_FRAME")
        frame_id = frame_id.dup.force_encoding(Encoding::UTF_8) if frame_id.is_a?(String)
        Frames.valid_id?(frame_id) ? frame_id : nil
      end

      # True only when the request names the Expo Turbo media type exactly.
      # A wildcard Accept value is not proof of a native client.
      def expo_turbo_request?
        MediaType.explicitly_accepted?(request.get_header("HTTP_ACCEPT"))
      end

      def expo_turbo_client_modules
        expo_turbo_module_negotiation.fetch(:modules)
      end

      # Reports which vocabulary answered this request:
      # :declared, :assumed_latest, or :assumed_none.
      def expo_turbo_vocabulary
        expo_turbo_module_negotiation.fetch(:vocabulary)
      end

      def expo_turbo_client_supports?(module_name, requirement)
        raise ArgumentError, "module_name must be a String" unless module_name.is_a?(String)
        raise ArgumentError, "module_name must not be blank" if module_name.blank?
        raise ArgumentError, "requirement must be a String" unless requirement.is_a?(String)
        raise ArgumentError, "requirement must not be empty" if requirement.strip.empty?

        requirement_parts = requirement.split(",", -1).map(&:strip)
        raise ArgumentError, "requirement must not contain empty clauses" if requirement_parts.any?(&:empty?)

        parsed_requirement = Gem::Requirement.new(*requirement_parts)
        negotiation = expo_turbo_module_negotiation
        return true if negotiation.fetch(:latest)

        version = negotiation.fetch(:modules)[module_name]
        return false unless version

        parsed_requirement.satisfied_by?(Gem::Version.new(version))
      end

      def expo_turbo_cache_variant
        [
          *Frames.cache_variant(expo_turbo_frame_request_id),
          :modules,
          expo_turbo_module_negotiation.fetch(:cache_variant)
        ]
      end

      def expo_turbo_vary_by_frame!
        values = response.headers["Vary"].to_s.split(",").map(&:strip).reject(&:blank?)
        return response.headers["Vary"] if values.include?("*")

        values << "Accept" if request.should_apply_vary_header? && values.none? { |value| value.casecmp?("Accept") }
        values << "Turbo-Frame" if values.none? { |value| value.casecmp?("Turbo-Frame") }
        values << "X-Expo-Turbo-Modules" if values.none? { |value| value.casecmp?("X-Expo-Turbo-Modules") }
        response.set_header "Vary", values.join(", ")
      end

      def expo_turbo_cache_key(*keys)
        expo_turbo_vary_by_frame!
        [*keys, *expo_turbo_cache_variant]
      end

      def expo_turbo_stream
        view_context.expo_turbo_stream
      end

      private

      MODULE_HEADER_PART = /\A(?:[A-Za-z0-9_.!~*'()-]|%[0-9A-Fa-f]{2})+\z/
      MODULE_VERSION_PATTERN = /\A[0-9]+(?:\.[0-9A-Za-z]+)*(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?\z/

      ASSUMED_LATEST = {vocabulary: :assumed_latest, latest: true, modules: {}.freeze, cache_variant: :latest}.freeze
      ASSUMED_NONE = {vocabulary: :assumed_none, latest: false, modules: {}.freeze, cache_variant: :none}.freeze
      VOCABULARY_HEADER = "X-Expo-Turbo-Vocabulary"
      VOCABULARY_HEADER_VALUES = {
        declared: "declared",
        assumed_latest: "assumed-latest",
        assumed_none: "assumed-none"
      }.freeze

      # A verified native request fails CLOSED. Neither an absent header nor a
      # malformed one is evidence that the client understands a module, and
      # both states (an old client, a header-stripping proxy) are outside the
      # server's control. Only a request that does not accept Expo Turbo keeps
      # the fail-open assumption, because module gating cannot apply to it.
      def expo_turbo_module_negotiation
        header = request.get_header("HTTP_X_EXPO_TURBO_MODULES")
        native = expo_turbo_request?
        cached = defined?(@expo_turbo_module_negotiation) && @expo_turbo_module_negotiation
        if cached && cached.fetch(:header).equal?(header) && cached.fetch(:native) == native
          expo_turbo_report_vocabulary(cached.fetch(:value))
          return cached.fetch(:value)
        end

        value = expo_turbo_negotiate_modules(header, native: native)
        @expo_turbo_module_negotiation = {header: header, native: native, value: value}.freeze
        expo_turbo_report_vocabulary(value)
        value
      end

      def expo_turbo_negotiate_modules(header, native:)
        assumed = native ? ASSUMED_NONE : ASSUMED_LATEST
        return assumed if header.nil?

        parsed = expo_turbo_parse_module_header(header)
        return assumed_or_report(assumed) unless parsed

        {
          vocabulary: :declared,
          latest: false,
          modules: parsed.fetch(:modules),
          cache_variant: parsed.fetch(:cache_variant)
        }.freeze
      end

      def assumed_or_report(assumed)
        expo_turbo_report_malformed_module_header
        assumed
      end

      def expo_turbo_report_vocabulary(value)
        return unless respond_to?(:response) && response

        response.set_header(VOCABULARY_HEADER, VOCABULARY_HEADER_VALUES.fetch(value.fetch(:vocabulary)))
      end

      def expo_turbo_parse_module_header(header)
        return unless header.is_a?(String)

        header = header.dup.force_encoding(Encoding::UTF_8)
        return unless header.valid_encoding? && header.ascii_only? && header.start_with?("v1;")

        payload = header.delete_prefix("v1;")
        return {modules: {}.freeze, cache_variant: "v1;"}.freeze if payload.empty?

        modules = {}
        encoded_pairs = []
        malformed_entries = 0
        payload.split(",", -1).each do |entry|
          pair = expo_turbo_parse_module_entry(entry)
          if pair.nil? || modules.key?(pair.fetch(:name))
            malformed_entries += 1
            next
          end

          name = pair.fetch(:name).freeze
          version = pair.fetch(:version).freeze
          modules[name] = version
          encoded_pairs << pair.fetch(:encoded)
        end
        expo_turbo_report_malformed_module_entries(malformed_entries) if malformed_entries.positive?

        modules.freeze
        encoded_pairs.sort!
        {modules: modules, cache_variant: "v1;#{encoded_pairs.join(",")}".freeze}.freeze
      rescue ArgumentError
        nil
      end

      def expo_turbo_parse_module_entry(entry)
        return unless entry.count("=") == 1

        encoded_name, encoded_version = entry.split("=", 2)
        return unless MODULE_HEADER_PART.match?(encoded_name) && MODULE_HEADER_PART.match?(encoded_version)

        name = expo_turbo_decode_module_part(encoded_name).force_encoding(Encoding::UTF_8)
        version = expo_turbo_decode_module_part(encoded_version).force_encoding(Encoding::UTF_8)
        return unless name.valid_encoding? && version.valid_encoding?
        return if expo_turbo_module_part_has_controls?(name) || expo_turbo_module_part_has_controls?(version)

        name = name.strip
        version = version.strip
        return if name.empty? || version.empty?
        return unless MODULE_VERSION_PATTERN.match?(version)
        Gem::Version.new(version)

        {
          name: name,
          version: version,
          encoded: "#{expo_turbo_encode_module_part(name)}=#{expo_turbo_encode_module_part(version)}".freeze
        }.freeze
      rescue ArgumentError
        nil
      end

      def expo_turbo_decode_module_part(encoded)
        encoded.gsub(/%([0-9A-Fa-f]{2})/) { Regexp.last_match(1).hex.chr }
      end

      def expo_turbo_encode_module_part(value)
        value.b.bytes.map do |byte|
          case byte
          when 48..57, 65..90, 97..122, 33, 39, 40, 41, 42, 45, 46, 95, 126
            byte.chr
          else
            format("%%%02X", byte)
          end
        end.join
      end

      def expo_turbo_module_part_has_controls?(value)
        value.each_codepoint.any? { |codepoint| codepoint <= 31 || codepoint == 127 || codepoint.between?(0xFFFE, 0xFFFF) }
      end

      # These warnings are not swallowed. A logger that cannot record a
      # malformed vocabulary header must not remove the only diagnostic.
      def expo_turbo_report_malformed_module_entries(count)
        return unless respond_to?(:logger) && logger

        label = (count == 1) ? "entry" : "entries"
        logger.warn("Expo Turbo ignored #{count} malformed X-Expo-Turbo-Modules #{label}")
      end

      def expo_turbo_report_malformed_module_header
        return unless respond_to?(:logger) && logger

        logger.warn("Expo Turbo ignored a malformed X-Expo-Turbo-Modules header")
      end

      public

      def render_expo_turbo_stream(*streams, status: :ok)
        streams << yield(expo_turbo_stream) if block_given?
        body = streams.flatten.compact.join
        raise TemplateError, "Expo Turbo Stream responses must render valid UTF-8" unless body.encoding == Encoding::UTF_8 && body.valid_encoding?

        document = XmlFragments.parse_stream_fragment(body)
        expo_turbo_validate_stream_fragment!(document)

        render plain: body, content_type: TURBO_STREAM_MIME_TYPE, status: status
      rescue XmlFragments::ParseError
        raise TemplateError, "Expo Turbo Stream responses must contain well-formed XML Stream fragments"
      end

      def broadcast_expo_turbo_stream_to(*streamables, content: nil)
        raise ArgumentError, "provide content or a block, not both" if block_given? && !content.nil?

        content = yield(expo_turbo_stream) if block_given?
        expo_turbo_validate_broadcast_stream!(content)
        ExpoTurbo::Rails::Streams.broadcast_to(*streamables, content: content)
      end

      def broadcast_expo_turbo_stream_later_to(*streamables, content: nil)
        raise ArgumentError, "provide content or a block, not both" if block_given? && !content.nil?

        content = yield(expo_turbo_stream) if block_given?
        expo_turbo_validate_broadcast_stream!(content)
        ExpoTurbo::Rails::Streams.broadcast_later_to(*streamables, content: content)
      end

      def broadcast_expo_turbo_refresh_to(*streamables, request_id: ::Turbo.current_request_id, **attributes)
        ExpoTurbo::Rails::Streams.broadcast_refresh_to(*streamables, request_id:, **attributes)
      end

      def broadcast_expo_turbo_refresh_later_to(*streamables, request_id: ::Turbo.current_request_id, **attributes)
        ExpoTurbo::Rails::Streams.broadcast_refresh_later_to(*streamables, request_id:, **attributes)
      end

      private

      def expo_turbo_validate_document!(document)
        expo_turbo_template_capabilities!.validate_document!(document)
      rescue TemplateCapabilities::ValidationError
        raise TemplateError, "Expo Turbo templates must use declared components and valid style tokens"
      end

      def expo_turbo_validate_frame_fragment!(document)
        capabilities = self.class.expo_turbo_template_capabilities_config
        return document unless capabilities

        capabilities.validate_frame_fragment!(document)
      rescue TemplateCapabilities::ValidationError
        raise TemplateError, "Expo Turbo templates must use declared components and valid style tokens"
      end

      def expo_turbo_validate_stream_fragment!(document)
        capabilities = self.class.expo_turbo_template_capabilities_config
        return document unless capabilities

        capabilities.validate_stream_fragment!(document)
      rescue TemplateCapabilities::ValidationError
        raise TemplateError, "Expo Turbo templates must use declared components and valid style tokens"
      end

      def expo_turbo_template_capabilities!
        self.class.expo_turbo_template_capabilities_config || raise(
          ConfigurationError,
          "configure expo_turbo_template_capabilities before rendering Expo Turbo templates"
        )
      end

      def expo_turbo_validate_broadcast_stream!(content)
        return content unless self.class.expo_turbo_template_capabilities_config
        return content unless content.is_a?(String) && content.encoding == Encoding::UTF_8 && content.valid_encoding? && content.present?

        expo_turbo_validate_stream_fragment!(XmlFragments.parse_stream_fragment(content))
        content
      rescue XmlFragments::ParseError
        raise TemplateError, "Expo Turbo Stream broadcasts must contain well-formed XML Stream fragments"
      end

      def expo_turbo_template_file(template)
        expo_turbo_view_file("#{template}.xml.erb")
      end

      def expo_turbo_partial_file(partial)
        relative_path = Pathname(partial.to_s)
        raise TemplateError, "Expo Turbo partial must be named" if partial.blank? || relative_path.absolute? || relative_path.extname.present?

        expo_turbo_view_file(relative_path.dirname.join("_#{relative_path.basename}").to_s + ".xml.erb")
      end

      def expo_turbo_view_file(relative_path)
        root = self.class.expo_turbo_views_path
        raise ConfigurationError, "configure expo_turbo_view_root before rendering" unless root

        root = root.realpath
        relative_path = Pathname(relative_path)
        raise TemplateError, "Expo Turbo template is outside the configured view root" if relative_path.absolute?

        candidate = root.join(relative_path).cleanpath
        raise TemplateError, "Expo Turbo template does not exist" unless candidate.file?

        candidate = candidate.realpath
        raise TemplateError, "Expo Turbo template is outside the configured view root" unless candidate.to_s.start_with?("#{root}#{File::SEPARATOR}")

        candidate.to_s
      end
    end
  end
end
