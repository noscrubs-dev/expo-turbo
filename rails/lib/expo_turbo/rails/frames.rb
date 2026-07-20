# frozen_string_literal: true

module ExpoTurbo
  module Rails
    module Frames
      CACHE_VARIANT_NAMESPACE = :expo_turbo

      module_function

      def valid_id?(value)
        value.is_a?(String) &&
          value.encoding == Encoding::UTF_8 &&
          value.valid_encoding? &&
          !value.blank? &&
          value.each_codepoint.none? { |codepoint| codepoint <= 31 || codepoint == 127 || codepoint.between?(0xFFFE, 0xFFFF) }
      end

      def validate_id!(value, label: "Frame")
        return value if valid_id?(value)

        raise TemplateError, "Expo Turbo #{label} id must be a nonblank UTF-8 string without control characters"
      end

      def cache_variant(frame_id)
        return [CACHE_VARIANT_NAMESPACE, :document].freeze if frame_id.nil?

        [CACHE_VARIANT_NAMESPACE, :frame, frame_id.dup.freeze].freeze
      end
    end
  end
end
