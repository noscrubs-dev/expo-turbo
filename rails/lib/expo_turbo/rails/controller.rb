# frozen_string_literal: true

require "active_support/concern"
require "active_support/core_ext/module/attr_internal"
require "action_controller/metal/helpers"
require "action_view/rendering"
require "rubygems/requirement"

module ExpoTurbo
  module Rails
    module Controller
      extend ActiveSupport::Concern
      include ActionController::Helpers
      include ActionView::Rendering
      # An API controller answers with head :no_content when an action does not
      # render. With a template for the action it should render the template,
      # exactly as ActionController::Base does, and keep head :no_content when
      # no template exists.
      include ActionController::ImplicitRender

      included do
        class_attribute :expo_turbo_template_capabilities_config, instance_accessor: false
        class_attribute :expo_turbo_compatibility_registry, instance_accessor: false
        # Every Frame response must contain the requested Frame. Set false for
        # one action that deliberately answers with a different Frame.
        class_attribute :expo_turbo_frame_match, default: true
        # Set false only for an endpoint that must deliver a payload the
        # protocol rejects, such as a client-behavior probe.
        class_attribute :expo_turbo_validate_responses, default: true
        # Lets one template serve both audiences. Set false to confine an Expo
        # Turbo render to .expo_turbo templates, as releases before 0.3.0 did.
        class_attribute :expo_turbo_html_template_fallback, default: true
        helper ::Turbo::Engine.helpers if defined?(::Turbo::Engine)
        helper ExpoTurbo::Rails::Attributes::Helper
        helper ExpoTurbo::Rails::Frames::Helper
        helper ExpoTurbo::Rails::DomIds::Helper
        helper ExpoTurbo::Rails::Streams::Helper
        helper ExpoTurbo::Rails::Caching::Helper
        # Vary is applied before any other filter runs, because an after_action
        # never runs when a filter halts the chain or the action raises, and an
        # authentication redirect, a rate limit, a rejected header, and a
        # rescued error all reach a shared cache. The after_action repeats it
        # for an action that replaced the header itself; the merge is
        # idempotent.
        prepend_before_action :expo_turbo_vary!
        before_action :expo_turbo_reject_invalid_frame_request!
        after_action :expo_turbo_validate_response!
        after_action :expo_turbo_vary!
        after_action :expo_turbo_report_response_vocabulary
        helper_method :expo_turbo_client_modules, :expo_turbo_client_revision_satisfies?, :expo_turbo_client_supports?,
          :expo_turbo_client_supports_attribute?, :expo_turbo_client_supports_component?, :expo_turbo_frame_request?,
          :expo_turbo_frame_request_id, :expo_turbo_request?
      end

      class_methods do
        def expo_turbo_template_capabilities(components: nil, manifest: nil, lockfile: nil, style_tokens: {}, max_style_tokens: 5)
          self.expo_turbo_template_capabilities_config = TemplateCapabilities.new(
            components:,
            manifest:,
            style_tokens:,
            max_style_tokens:
          )
          self.expo_turbo_compatibility_registry = lockfile ? CompatibilityRegistry.load(lockfile) : nil
        end
      end

      # The format this render answers in, and the one rule that decides both
      # the media type and whether a helper takes its Expo Turbo branch. Two
      # sources can name it, and they do not rank equally:
      #
      # - resolved: Rails worked it out, from the Accept header in
      #   ActionController::Rendering#process_action or from the respond_to
      #   branch that matched.
      # - demanded: the caller wrote it, as `render ..., formats: [...]`.
      #
      # A demand wins. Naming a format is a decision, and answering `render
      # formats: [:html]` with Expo Turbo XML because the client happened to
      # send a native Accept header overrules the one party that said what it
      # wanted. A demand lasts only for the render that carried it.
      #
      # Neither source is lookup_context.formats.first during a render.
      # ActionView prepends the format of the template that answered, so a
      # shared .html template rewrites the lookup context to :html while still
      # answering a native request. nil when nothing named a format, such as a
      # broadcast rendered through ApplicationController.render.
      def expo_turbo_selected_format
        @expo_turbo_demanded_format || @expo_turbo_resolved_format
      end

      # Both framework assignments arrive here, because ActionView::ViewPaths
      # delegates the writer to the lookup context and this concern sits above
      # it. Appending :html lets one template serve both audiences; the Expo
      # Turbo format stays first, so an .expo_turbo template always wins over
      # the .html template beside it.
      def formats=(values)
        values = expo_turbo_lookup_formats(values)
        @expo_turbo_resolved_format = Array(values).first
        super
      end

      # A demand belongs to the render that carried it and to nothing after it.
      # Both entry points restore what was in force, so a helper called between
      # two renders, or after a render_to_string, is already back on the
      # resolved format rather than on the last format anyone named.
      def render(*)
        expo_turbo_scoped_demand { super }
      end

      def render_to_string(*)
        expo_turbo_scoped_demand { super }
      end

      # ActionView::Rendering renders a template for every option, and this
      # concern adds it to API controllers, where it would otherwise hide the
      # registered renderers such as `render turbo_stream:`. Ask the renderers
      # first, exactly as ActionController::Base orders them.
      def render_to_body(options = {})
        if respond_to?(:_render_to_body_with_renderer, true)
          rendered = _render_to_body_with_renderer(options)
          return rendered if rendered
        end

        super
      end

      def expo_turbo_frame_request?
        expo_turbo_frame_request_id.present?
      end

      def expo_turbo_frame_request_id
        frame_id = expo_turbo_frame_header
        Frames.valid_id?(frame_id) ? frame_id : nil
      end

      # A malformed Frame id must not become a document request. That failure
      # is silent: the client asked for one representation and receives
      # another one.
      def expo_turbo_reject_invalid_frame_request!
        frame_id = expo_turbo_frame_header
        return if frame_id.nil? || Frames.valid_id?(frame_id)

        head :bad_request
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

        parsed_requirement = expo_turbo_parse_requirement(requirement)
        negotiation = expo_turbo_module_negotiation
        return true if negotiation.fetch(:latest)

        if negotiation[:entry]
          raise ArgumentError,
            "module-scoped requirements cannot test a vocabulary revision; use expo_turbo_client_revision_satisfies?"
        end

        version = negotiation.fetch(:modules)[module_name]
        return false unless version

        parsed_requirement.satisfied_by?(Gem::Version.new(version))
      end

      def expo_turbo_client_revision_satisfies?(requirement)
        parsed_requirement = expo_turbo_parse_requirement(requirement)
        negotiation = expo_turbo_module_negotiation
        return true if negotiation.fetch(:latest)

        entry = negotiation[:entry]
        return false unless entry

        parsed_requirement.satisfied_by?(Gem::Version.new(entry.revision.to_s))
      end

      def expo_turbo_client_supports_component?(tag)
        raise ArgumentError, "tag must be a nonblank String" unless tag.is_a?(String) && tag.present?

        negotiation = expo_turbo_module_negotiation
        return true if negotiation.fetch(:latest)

        negotiation[:entry]&.supports_component?(tag) || false
      end

      def expo_turbo_client_supports_attribute?(tag, attribute)
        raise ArgumentError, "tag must be a nonblank String" unless tag.is_a?(String) && tag.present?
        unless attribute.is_a?(String) && attribute.present?
          raise ArgumentError, "attribute must be a nonblank String"
        end

        negotiation = expo_turbo_module_negotiation
        return true if negotiation.fetch(:latest)

        negotiation[:entry]&.supports_attribute?(tag, attribute) || false
      end

      def expo_turbo_cache_variant
        [
          *Frames.cache_variant(expo_turbo_frame_request_id),
          :modules,
          expo_turbo_module_negotiation.fetch(:cache_variant)
        ]
      end

      # Keep the legacy dimension while the 0.3 gem reads the 0.2 modules
      # header. Removing it now would let two old clients share one response.
      VARY_DIMENSIONS = ["Accept", "Turbo-Frame", "X-Expo-Turbo-Client", "X-Expo-Turbo-Modules"].freeze

      # Applied to every response, not only to a request that already carries a
      # Frame header: a shared cache can receive a Frame request for the same
      # URL later. Accept is included even when the route forced the format,
      # because the vocabulary decision reads Accept.
      def expo_turbo_vary!
        values = response.headers["Vary"].to_s.split(",").map(&:strip).reject(&:blank?)
        return response.headers["Vary"] if values.include?("*")

        VARY_DIMENSIONS.each do |dimension|
          values << dimension if values.none? { |value| value.casecmp?(dimension) }
        end
        response.set_header "Vary", values.join(", ")
      end

      def expo_turbo_cache_key(*keys)
        expo_turbo_vary!
        [*keys, *expo_turbo_cache_variant]
      end

      # Format-aware in a request, exactly as in the view.
      def turbo_stream
        view_context.turbo_stream
      end

      # Always Expo Turbo. Broadcasts have no request and therefore no format,
      # so they need a builder that does not depend on one.
      def expo_turbo_stream
        view_context.expo_turbo_stream
      end

      private

      # Every controller-level render passes through here, and a view rendering
      # a partial does not, so this records the caller's own `formats:` and
      # nothing else.
      def _normalize_options(options)
        normalized = super
        demanded = normalized.key?(:formats) ? Array(normalized[:formats]).first : nil
        @expo_turbo_demanded_format = demanded.respond_to?(:to_sym) ? demanded.to_sym : nil
        normalized
      end

      def expo_turbo_scoped_demand
        previous = @expo_turbo_demanded_format
        yield
      ensure
        @expo_turbo_demanded_format = previous
      end

      def expo_turbo_lookup_formats(values)
        return values unless expo_turbo_html_template_fallback
        return values unless values.is_a?(Array) && values.first == MIME_SYMBOL
        return values if values.include?(:html)

        values + [:html]
      end

      # respond_to narrows lookup to the format of the branch it ran, writing
      # the lookup context directly. Repeat the assignment through the writer
      # above, so `format.expo_turbo` reaches the same templates a plain render
      # does.
      def _process_format(format)
        super
        self.formats = [format.to_sym] if format.respond_to?(:to_sym) && format.to_sym
      end

      # The format the render selected decides the media type. Rails offers the
      # format of the template that answered, which is not the same thing and
      # is sometimes nothing at all: a NAME.erb template carries no format, and
      # Rails then falls back to the lookup context, which for a native request
      # says Expo Turbo whatever the caller asked for.
      def _set_rendered_content_type(format)
        super(expo_turbo_rendered_format(format))
      end

      def expo_turbo_rendered_format(format)
        # A demand names the representation outright, whatever the template
        # that answered it was called and whether it was called anything.
        demanded = @expo_turbo_demanded_format
        return Mime[demanded] || format if demanded
        # A resolution overrides only in the direction the fallback created: an
        # .html or format-neutral template answering a native request is an
        # Expo Turbo representation, and labelling it text/html would mislead
        # the client and route the response around
        # expo_turbo_validate_response!, which switches on the media type.
        return format unless expo_turbo_html_template_fallback
        return format unless expo_turbo_selected_format == MIME_SYMBOL

        Mime[MIME_SYMBOL]
      end

      def expo_turbo_frame_header
        frame_id = request.get_header("HTTP_TURBO_FRAME")
        frame_id.is_a?(String) ? frame_id.dup.force_encoding(Encoding::UTF_8) : frame_id
      end

      MODULE_HEADER_PART = /\A(?:[A-Za-z0-9_.!~*'()-]|%[0-9A-Fa-f]{2})+\z/
      MODULE_VERSION_PATTERN = /\A[0-9]+(?:\.[0-9A-Za-z]+)*(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?\z/

      ASSUMED_LATEST = {vocabulary: :assumed_latest, latest: true, modules: {}.freeze, cache_variant: :latest}.freeze
      ASSUMED_NONE = {vocabulary: :assumed_none, latest: false, modules: {}.freeze, cache_variant: :none}.freeze
      VOCABULARY_HEADER = "X-Expo-Turbo-Vocabulary"
      VOCABULARY_HEADER_VALUES = {
        declared: "declared",
        legacy_declared: "legacy-declared",
        assumed_latest: "assumed-latest",
        assumed_none: "assumed-none"
      }.freeze

      # A verified native request fails CLOSED. Neither an absent header nor a
      # malformed one is evidence that the client understands a module, and
      # both states (an old client, a header-stripping proxy) are outside the
      # server's control. Only a request that does not accept Expo Turbo keeps
      # the fail-open assumption, because module gating cannot apply to it.
      def expo_turbo_module_negotiation
        descriptor = request.get_header("HTTP_X_EXPO_TURBO_CLIENT")
        header = request.get_header("HTTP_X_EXPO_TURBO_MODULES")
        native = expo_turbo_request?
        cached = defined?(@expo_turbo_module_negotiation) && @expo_turbo_module_negotiation
        if cached && cached.fetch(:descriptor).equal?(descriptor) && cached.fetch(:header).equal?(header) && cached.fetch(:native) == native
          expo_turbo_report_vocabulary(cached.fetch(:value))
          return cached.fetch(:value)
        end

        value = expo_turbo_negotiate_client(descriptor, header, native: native)
        @expo_turbo_module_negotiation = {descriptor: descriptor, header: header, native: native, value: value}.freeze
        expo_turbo_report_vocabulary(value)
        value
      end

      def expo_turbo_negotiate_client(descriptor, legacy_header, native:)
        unless descriptor.nil?
          return ASSUMED_LATEST unless native

          fields = CompatibilityRegistry.parse_descriptor(descriptor)
          return assumed_or_report_descriptor unless fields

          digest = fields["vocab"]
          return ASSUMED_NONE unless digest

          registry = self.class.expo_turbo_compatibility_registry
          unless registry
            expo_turbo_report_descriptor_failure(
              "Expo Turbo cannot resolve X-Expo-Turbo-Client; configure lockfile: in expo_turbo_template_capabilities"
            )
            return ASSUMED_NONE
          end
          entry = registry.resolve(digest)
          unless entry
            expo_turbo_report_descriptor_failure(
              "Expo Turbo ignored an unknown vocabulary digest in X-Expo-Turbo-Client"
            )
            return ASSUMED_NONE
          end

          return {
            vocabulary: :declared,
            latest: false,
            entry: entry,
            modules: {}.freeze,
            cache_variant: digest.freeze
          }.freeze
        end

        expo_turbo_negotiate_modules(legacy_header, native: native)
      end

      def assumed_or_report_descriptor
        expo_turbo_report_descriptor_failure("Expo Turbo ignored a malformed X-Expo-Turbo-Client header")
        ASSUMED_NONE
      end

      def expo_turbo_report_descriptor_failure(message)
        logger.warn(message) if respond_to?(:logger) && logger
      end

      def expo_turbo_parse_requirement(requirement)
        raise ArgumentError, "requirement must be a String" unless requirement.is_a?(String)
        raise ArgumentError, "requirement must not be empty" if requirement.strip.empty?

        requirement_parts = requirement.split(",", -1).map(&:strip)
        raise ArgumentError, "requirement must not contain empty clauses" if requirement_parts.any?(&:empty?)

        Gem::Requirement.new(*requirement_parts)
      end

      def expo_turbo_negotiate_modules(header, native:)
        assumed = native ? ASSUMED_NONE : ASSUMED_LATEST
        return assumed if header.nil?

        parsed = expo_turbo_parse_module_header(header)
        return assumed_or_report(assumed) unless parsed

        {
          vocabulary: :legacy_declared,
          latest: false,
          modules: parsed.fetch(:modules),
          cache_variant: parsed.fetch(:cache_variant)
        }.freeze
      end

      def assumed_or_report(assumed)
        expo_turbo_report_malformed_module_header
        assumed
      end

      def expo_turbo_response?
        media_type = response&.media_type
        media_type == MIME_TYPE || media_type == TURBO_STREAM_MIME_TYPE
      end

      def expo_turbo_report_response_vocabulary
        expo_turbo_module_negotiation if expo_turbo_request? || expo_turbo_response?
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
        return if expo_turbo_module_part_has_controls?(name) ||
          !RegistryIdentifier.valid?(name) ||
          expo_turbo_module_part_has_controls?(version)

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
        value.each_codepoint.any? { |codepoint| codepoint <= 31 || codepoint == 127 }
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

      # Ordinary `render` produces the response, so validation happens once, on
      # the finished response, before Rails delivers it. Rendering a template
      # of another format, or a Stream for a browser, is left alone.
      def expo_turbo_validate_response!
        return unless expo_turbo_validate_responses

        case response.media_type
        when MIME_TYPE then expo_turbo_validate_document_response!
        when TURBO_STREAM_MIME_TYPE then expo_turbo_validate_stream_response! if expo_turbo_request?
        end
      end

      def expo_turbo_validate_document_response!
        body = expo_turbo_response_body
        return if body.nil?

        document = XmlFragments.parse_document(body)
        XmlFragments.validate_document_ids!(document)
        expo_turbo_validate_document!(document)
        expo_turbo_match_frame_response!(document)
      rescue XmlFragments::DocumentIdError
        raise TemplateError, "Expo Turbo templates must use unique nonblank literal ids"
      rescue XmlFragments::ParseError
        raise TemplateError, "Expo Turbo templates must render well-formed UTF-8 XML"
      end

      def expo_turbo_validate_stream_response!
        body = expo_turbo_response_body
        return if body.nil?

        expo_turbo_validate_stream_fragment!(XmlFragments.parse_stream_fragment(body))
      rescue XmlFragments::ParseError
        raise TemplateError, "Expo Turbo Stream responses must contain well-formed XML Stream fragments"
      end

      def expo_turbo_response_body
        body = response.body
        return if body.nil? || body.empty?

        body = body.dup.force_encoding(Encoding::UTF_8)
        raise TemplateError, "Expo Turbo responses must render valid UTF-8" unless body.valid_encoding?

        body
      end

      # The controller cannot know the expected Frame before the view renders,
      # so the request header is compared against the Frame the response
      # actually contains. That removes the hand-written id from host code.
      def expo_turbo_match_frame_response!(document)
        frame_id = expo_turbo_frame_request_id
        return if frame_id.nil? || !expo_turbo_frame_match
        return if document.xpath("//*").any? { |element| expo_turbo_frame_element?(element, frame_id) }

        response.status = :bad_request
        response.body = ""
      end

      def expo_turbo_frame_element?(element, frame_id)
        return false unless element.name == "turbo-frame" && element.namespace&.prefix.nil?

        element.attribute_nodes.any? do |attribute|
          attribute.name == "id" && attribute.namespace.nil? && attribute.value == frame_id
        end
      end
    end
  end
end
