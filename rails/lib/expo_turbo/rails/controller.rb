# frozen_string_literal: true

require "active_support/concern"
require "active_support/core_ext/module/attr_internal"
require "action_controller/metal/helpers"
require "action_view/rendering"
require "pathname"

module ExpoTurbo
  module Rails
    module Controller
      extend ActiveSupport::Concern
      include ActionController::Helpers
      include ActionView::Rendering

      included do
        class_attribute :expo_turbo_views_path, instance_accessor: false
        helper ExpoTurbo::Rails::Frames::Helper
        helper ExpoTurbo::Rails::DomIds::Helper
        helper ExpoTurbo::Rails::Streams::Helper
        helper_method :expo_turbo_frame_request?, :expo_turbo_frame_request_id
      end

      class_methods do
        def expo_turbo_view_root(path)
          self.expo_turbo_views_path = Pathname(path).expand_path
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

        render plain: body, content_type: MIME_TYPE, status: status
      end

      def expo_turbo_frame_request?
        expo_turbo_frame_request_id.present?
      end

      def expo_turbo_frame_request_id
        frame_id = request.headers["Turbo-Frame"]
        Frames.valid_id?(frame_id) ? frame_id : nil
      end

      def expo_turbo_cache_variant
        Frames.cache_variant(expo_turbo_frame_request_id)
      end

      def expo_turbo_vary_by_frame!
        values = response.headers["Vary"].to_s.split(",").map(&:strip).reject(&:blank?)
        return response.headers["Vary"] if values.include?("*")

        values << "Accept" if request.should_apply_vary_header? && values.none? { |value| value.casecmp?("Accept") }
        values << "Turbo-Frame" if values.none? { |value| value.casecmp?("Turbo-Frame") }
        response.set_header "Vary", values.join(", ")
      end

      def expo_turbo_cache_key(*keys)
        expo_turbo_vary_by_frame!
        [*keys, *expo_turbo_cache_variant]
      end

      def expo_turbo_stream
        view_context.expo_turbo_stream
      end

      def render_expo_turbo_stream(*streams, status: :ok)
        streams << yield(expo_turbo_stream) if block_given?
        body = streams.flatten.compact.join
        raise TemplateError, "Expo Turbo Stream responses must render valid UTF-8" unless body.encoding == Encoding::UTF_8 && body.valid_encoding?

        render plain: body, content_type: TURBO_STREAM_MIME_TYPE, status: status
      end

      def broadcast_expo_turbo_stream_to(*streamables, content: nil)
        raise ArgumentError, "provide content or a block, not both" if block_given? && !content.nil?

        content = yield(expo_turbo_stream) if block_given?
        ExpoTurbo::Rails::Streams.broadcast_to(*streamables, content: content)
      end

      def broadcast_expo_turbo_stream_later_to(*streamables, content: nil)
        raise ArgumentError, "provide content or a block, not both" if block_given? && !content.nil?

        content = yield(expo_turbo_stream) if block_given?
        ExpoTurbo::Rails::Streams.broadcast_later_to(*streamables, content: content)
      end

      private

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
