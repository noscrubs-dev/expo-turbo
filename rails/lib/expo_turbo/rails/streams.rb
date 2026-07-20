# frozen_string_literal: true

module ExpoTurbo
  module Rails
    module Streams
      STREAM_NAMESPACE = :expo

      class << self
        def broadcast_to(*streamables, content:)
          ::Turbo::StreamsChannel.broadcast_stream_to(*streamables_for(*streamables), content: valid_content!(content))
        end

        def streamables_for(*streamables)
          normalized = streamables.flatten.compact_blank
          raise ArgumentError, "streamables must include a nonblank value" if normalized.empty?

          [*normalized, STREAM_NAMESPACE]
        end

        private

        def valid_content!(content)
          raise ArgumentError, "content must be a nonblank String" unless content.is_a?(String)
          raise TemplateError, "Expo Turbo Stream broadcasts must render valid UTF-8" unless content.encoding == Encoding::UTF_8 && content.valid_encoding?
          raise ArgumentError, "content must be a nonblank String" unless content.present?

          content
        end
      end
    end
  end
end
