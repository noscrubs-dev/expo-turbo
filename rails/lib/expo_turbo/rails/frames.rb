# frozen_string_literal: true

module ExpoTurbo
  module Rails
    module Frames
      module_function

      def valid_id?(value)
        value.is_a?(String) &&
          value.encoding == Encoding::UTF_8 &&
          value.valid_encoding? &&
          !value.blank? &&
          value.each_codepoint.none? { |codepoint| codepoint <= 31 || codepoint == 127 }
      end

      def validate_id!(value)
        return value if valid_id?(value)

        raise TemplateError, "Expo Turbo Frame id must be a nonblank UTF-8 string without control characters"
      end
    end
  end
end
