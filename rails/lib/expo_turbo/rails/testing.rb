# frozen_string_literal: true

require "expo_turbo/rails"

module ExpoTurbo
  module Rails
    module Testing
      STREAM_FRAGMENT_ROOT = "expo-turbo-test-root"
      class XmlParseError < ArgumentError
      end

      module_function

      def parse_document(xml)
        XmlFragments.parse_document(xml)
      rescue XmlFragments::ParseError => error
        raise XmlParseError, error.message, cause: nil
      end

      def parse_stream_fragment(xml)
        XmlFragments.parse_stream_fragment(xml, root_name: STREAM_FRAGMENT_ROOT)
      rescue XmlFragments::ParseError => error
        raise XmlParseError, error.message, cause: nil
      end

      private_constant :STREAM_FRAGMENT_ROOT
    end
  end
end
