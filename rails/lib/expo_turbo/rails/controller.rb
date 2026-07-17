# frozen_string_literal: true

require "active_support/concern"
require "active_support/core_ext/module/attr_internal"
require "action_view/rendering"
require "pathname"

module ExpoTurbo
  module Rails
    module Controller
      extend ActiveSupport::Concern
      include ActionView::Rendering

      included do
        class_attribute :expo_turbo_views_path, instance_accessor: false
      end

      class_methods do
        def expo_turbo_view_root(path)
          self.expo_turbo_views_path = Pathname(path).expand_path
        end
      end

      def render_expo_turbo(template, locals: {}, status: :ok)
        body = render_to_string(
          file: expo_turbo_template_file(template),
          formats: [:xml],
          layout: false,
          locals: locals
        )
        raise TemplateError, "Expo Turbo templates must render valid UTF-8" unless body.encoding == Encoding::UTF_8 && body.valid_encoding?

        render plain: body, content_type: MIME_TYPE, status: status
      end

      private

      def expo_turbo_template_file(template)
        root = self.class.expo_turbo_views_path
        raise ConfigurationError, "configure expo_turbo_view_root before rendering" unless root

        root = root.realpath
        relative_path = Pathname("#{template}.xml.erb")
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
