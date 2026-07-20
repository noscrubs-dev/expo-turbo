# frozen_string_literal: true

module ExpoTurbo
  module Rails
    module Frames
      module Helper
        def expo_turbo_frame_tag(id, src: nil, target: nil, **attributes, &block)
          Frames.validate_id!(id)

          unless defined?(::Turbo::FramesHelper)
            raise ConfigurationError, "Turbo Frames helper is unavailable before Rails initializes"
          end

          frame = ::Turbo::FramesHelper.instance_method(:turbo_frame_tag)
            .bind_call(self, id, src: src, target: target, **attributes, &block)
          XmlFragments.parse_frame_fragment(frame.to_s)
          frame
        rescue XmlFragments::ParseError
          raise TemplateError, "Expo Turbo Frame output must be well-formed UTF-8 XML without DTDs or processing instructions"
        end
      end
    end
  end
end
