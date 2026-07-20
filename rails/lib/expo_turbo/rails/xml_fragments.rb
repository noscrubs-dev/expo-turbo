# frozen_string_literal: true

module ExpoTurbo
  module Rails
    module XmlFragments
      DEFAULT_FRAGMENT_ROOT = "expo-turbo-fragment-root"
      XML_DECLARATION = /\A<\?xml\s+(?<attributes>.*?)\?>/m
      XML_ENCODING = /\bencoding\s*=\s*["'](?<encoding>[^"']+)["']/i
      DOCTYPE = /<!DOCTYPE(?:\s|>)/i
      NON_MARKUP = /<!\[CDATA\[.*?\]\]>|<!--.*?-->|<\?.*?\?>/m

      class ParseError < StandardError
      end

      module_function

      def parse_document(xml)
        parse_xml(validate_source!(xml, "document", allow_declaration: true), "document")
      end

      def parse_stream_fragment(xml, root_name: DEFAULT_FRAGMENT_ROOT)
        document = parse_fragment(xml, "Stream fragment", root_name:)
        validate_fragment_root!(document, "Stream fragment") do |elements|
          elements.present? && elements.all? { |element| literal_element?(element, "turbo-stream") }
        end
        document
      end

      def parse_frame_fragment(xml, root_name: DEFAULT_FRAGMENT_ROOT)
        document = parse_fragment(xml, "Frame fragment", root_name:)
        validate_fragment_root!(document, "Frame fragment") do |elements|
          elements.one? && literal_element?(elements.first, "turbo-frame")
        end
        document
      end

      def parse_fragment(xml, label, root_name:)
        xml = validate_source!(xml, label, allow_declaration: false)
        parse_xml("<#{root_name}>#{xml}</#{root_name}>", label)
      end

      def validate_source!(xml, label, allow_declaration:)
        xml = xml.dup.force_encoding(Encoding::UTF_8) if xml.is_a?(String) && xml.encoding == Encoding::ASCII_8BIT
        valid_utf8 = xml.is_a?(String) && xml.encoding == Encoding::UTF_8 && xml.valid_encoding? && xml.strip.present?
        raise ParseError, error_message(label) unless valid_utf8
        raise ParseError, error_message(label) if xml.gsub(NON_MARKUP, "").match?(DOCTYPE)

        declaration = xml.match(XML_DECLARATION)
        return xml unless declaration

        encoding = declaration[:attributes].match(XML_ENCODING)&.[](:encoding)
        valid_declaration = allow_declaration && (encoding.nil? || encoding.casecmp?("UTF-8"))
        raise ParseError, error_message(label) unless valid_declaration

        xml
      end

      def parse_xml(xml, label)
        require "nokogiri"

        document = Nokogiri::XML::Document.parse(xml, nil, nil) { |config| config.strict.nonet }
        raise ParseError, error_message(label) unless document.root
        raise ParseError, error_message(label) if document.errors.any?
        raise ParseError, error_message(label) if document.internal_subset || document.external_subset
        raise ParseError, error_message(label) if document.xpath("//processing-instruction()").any?

        document
      rescue Nokogiri::XML::SyntaxError
        raise ParseError, error_message(label), cause: nil
      end

      def validate_fragment_root!(document, label)
        root = document.root
        valid_elements = yield(root.element_children)
        non_whitespace_text = root.children.any? { |node| node.text? && node.text.strip.present? }
        raise ParseError, error_message(label) unless valid_elements && !non_whitespace_text
      end

      def literal_element?(element, name)
        element.name == name && element.namespace.nil?
      end

      def error_message(label)
        "Expo Turbo #{label} must be well-formed UTF-8 XML without DTDs or processing instructions"
      end

      private_class_method :parse_fragment, :validate_source!, :parse_xml, :validate_fragment_root!, :literal_element?, :error_message
      private_constant :DEFAULT_FRAGMENT_ROOT, :XML_DECLARATION, :XML_ENCODING, :DOCTYPE, :NON_MARKUP
    end
  end
end
