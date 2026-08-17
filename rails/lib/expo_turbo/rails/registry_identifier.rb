# frozen_string_literal: true

module ExpoTurbo
  module Rails
    module RegistryIdentifier
      module_function

      def validate!(value, field_path, error_class: ConfigurationError)
        unless value.is_a?(String)
          raise error_class,
            "Expo Turbo registry identifier #{field_path} must be a String, got #{value.class}"
        end
        unless value.valid_encoding?
          raise error_class, "Expo Turbo registry identifier #{field_path} is not valid UTF-8"
        end

        value.each_codepoint.with_index do |codepoint, scalar_index|
          next unless noncharacter?(codepoint)

          formatted = codepoint.to_s(16).upcase.rjust(4, "0")
          raise error_class,
            "Expo Turbo registry identifier #{field_path} contains Unicode noncharacter U+#{formatted} at scalar index #{scalar_index}"
        end
        value
      end

      def valid?(value)
        validate!(value, "value")
        true
      rescue ConfigurationError
        false
      end

      def noncharacter?(codepoint)
        codepoint.between?(0xFDD0, 0xFDEF) ||
          (codepoint <= 0x10FFFF && [0xFFFE, 0xFFFF].include?(codepoint & 0xFFFF))
      end
    end
  end
end
