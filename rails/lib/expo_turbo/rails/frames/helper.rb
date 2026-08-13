# frozen_string_literal: true

require "action_view/record_identifier"

module ExpoTurbo
  module Rails
    module Frames
      module Helper
        include Format::Helper

        # The standard turbo-rails helper. For an HTML render it is turbo-rails
        # exactly, through `super`. For an Expo Turbo render the same tag is
        # produced and then admitted: valid UTF-8 XML without declarations,
        # DTDs, or processing instructions, a nonblank literal Frame id, and
        # the configured components and style tokens. Validation never
        # serializes the result, so preserved text keeps its authored bytes.
        def turbo_frame_tag(*ids, src: nil, target: nil, **attributes, &block)
          return super unless expo_turbo_render?

          ids = expo_turbo_normalized_frame_ids(ids)
          literal_id = expo_turbo_literal_frame_id(ids)
          Frames.validate_id!(literal_id) if literal_id
          frame = super
          document = XmlFragments.parse_frame_fragment(frame.to_s)
          Frames.validate_id!(expo_turbo_rendered_frame_id(document))
          controller.send(:expo_turbo_validate_frame_fragment!, document)
          frame
        rescue XmlFragments::ParseError
          raise TemplateError, "Expo Turbo Frame output must be well-formed UTF-8 XML without DTDs or processing instructions"
        end

        private

        # turbo-rails 2.0.10 renders a model class as its Ruby class name, and
        # 2.0.23 renders Rails' new_* id. Normalize first, so a host gets the
        # same Frame id on both supported versions.
        def expo_turbo_normalized_frame_ids(ids)
          return ids unless ids.first.is_a?(Class) && ids.first.respond_to?(:model_name)

          [ActionView::RecordIdentifier.dom_id(*ids)]
        end

        # A record normalizes through Rails' own dom_id, which always produces
        # a usable id. Only a literal id is checked before the tag is built, so
        # its error names the id instead of the markup.
        def expo_turbo_literal_frame_id(ids)
          return if ids.first.respond_to?(:to_key) || ids.first.is_a?(Class)

          # Joining Symbols can produce a US-ASCII String, which is valid UTF-8
          # input. Invalid bytes still fail the encoding check below.
          ids.join("_").dup.force_encoding(Encoding::UTF_8)
        end

        def expo_turbo_rendered_frame_id(document)
          document.root.element_children.first.attribute_nodes.find { |attribute|
            attribute.name == "id" && attribute.namespace.nil?
          }&.value
        end
      end
    end
  end
end
