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

          ::Turbo::FramesHelper.instance_method(:turbo_frame_tag)
            .bind_call(self, id, src: src, target: target, **attributes, &block)
        end
      end
    end
  end
end
