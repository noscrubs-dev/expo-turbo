# frozen_string_literal: true

require "expo_turbo/rails"
require "nokogiri"

module ExpoTurbo
  module Rails
    module Testing
      STREAM_FRAGMENT_ROOT = "expo-turbo-test-root"
      XML_DECLARATION = /\A<\?xml\s+(?<attributes>.*?)\?>/m
      XML_ENCODING = /\bencoding\s*=\s*["'](?<encoding>[^"']+)["']/i
      DOCTYPE = /<!DOCTYPE(?:\s|>)/i
      NON_MARKUP = /<!\[CDATA\[.*?\]\]>|<!--.*?-->|<\?.*?\?>/m

      class XmlParseError < ArgumentError
      end

      module_function

      def parse_document(xml)
        xml = validate_source!(xml, "document", allow_declaration: true)
        parse_xml(xml, "document")
      end

      def parse_stream_fragment(xml)
        xml = validate_source!(xml, "Stream fragment", allow_declaration: false)
        document = parse_xml("<#{STREAM_FRAGMENT_ROOT}>#{xml}</#{STREAM_FRAGMENT_ROOT}>", "Stream fragment")
        validate_stream_fragment!(document)
        document
      end

      def validate_source!(xml, label, allow_declaration:)
        xml = xml.dup.force_encoding(Encoding::UTF_8) if xml.is_a?(String) && xml.encoding == Encoding::ASCII_8BIT
        valid_utf8 = xml.is_a?(String) && xml.encoding == Encoding::UTF_8 && xml.valid_encoding? && xml.strip.present?
        raise XmlParseError, error_message(label) unless valid_utf8
        raise XmlParseError, error_message(label) if xml.gsub(NON_MARKUP, "").match?(DOCTYPE)

        declaration = xml.match(XML_DECLARATION)
        return xml unless declaration

        encoding = declaration[:attributes].match(XML_ENCODING)&.[](:encoding)
        valid_declaration = allow_declaration && (encoding.nil? || encoding.casecmp?("UTF-8"))
        raise XmlParseError, error_message(label) unless valid_declaration

        xml
      end

      def parse_xml(xml, label)
        document = Nokogiri::XML::Document.parse(xml, nil, nil) { |config| config.strict.nonet }
        raise XmlParseError, error_message(label) unless document.root
        raise XmlParseError, error_message(label) if document.errors.any?
        raise XmlParseError, error_message(label) if document.internal_subset || document.external_subset
        raise XmlParseError, error_message(label) if document.xpath("//processing-instruction()").any?

        document
      rescue Nokogiri::XML::SyntaxError
        raise XmlParseError, error_message(label), cause: nil
      end

      def validate_stream_fragment!(document)
        root = document.root
        streams = root.element_children
        valid_streams = streams.present? && streams.all? do |stream|
          stream.name == "turbo-stream" && stream.namespace&.prefix.nil?
        end
        non_whitespace_text = root.children.any? { |node| node.text? && node.text.strip.present? }
        raise XmlParseError, error_message("Stream fragment") unless valid_streams && !non_whitespace_text
      end

      def error_message(label)
        "Expo Turbo #{label} must be well-formed UTF-8 XML without DTDs or processing instructions"
      end

      private_class_method :validate_source!, :parse_xml, :validate_stream_fragment!, :error_message
      private_constant :STREAM_FRAGMENT_ROOT, :XML_DECLARATION, :XML_ENCODING, :DOCTYPE, :NON_MARKUP
    end
  end
end
