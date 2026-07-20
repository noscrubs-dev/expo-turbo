# frozen_string_literal: true

module ExpoTurbo
  module Rails
    module Streams
      STREAM_NAMESPACE = :expo

      class << self
        def broadcast_to(*streamables, content:)
          broadcast_to_stream(stream_name_for(*streamables), content: content)
        end

        def broadcast_later_to(*streamables, content:)
          BroadcastJob.perform_later(stream_name_for(*streamables), content: valid_content!(content))
        end

        def broadcast_to_stream(stream_name, content:)
          ::Turbo::StreamsChannel.broadcast_stream_to(valid_stream_name!(stream_name), content: valid_content!(content))
        end

        def streamables_for(*streamables)
          normalized = streamables.flatten.compact_blank
          raise ArgumentError, "streamables must include a nonblank value" if normalized.empty?

          [*normalized, STREAM_NAMESPACE]
        end

        def stream_name_for(*streamables)
          stream_name = streamables_for(*streamables)
            .map { |streamable| streamable.try(:to_gid_param) || streamable.to_param }
            .join(":")
          valid_stream_name!(stream_name)
        end

        private

        def valid_content!(content)
          raise ArgumentError, "content must be a nonblank String" unless content.is_a?(String)
          raise TemplateError, "Expo Turbo Stream broadcasts must render valid UTF-8" unless content.encoding == Encoding::UTF_8 && content.valid_encoding?
          raise ArgumentError, "content must be a nonblank String" unless content.present?

          content
        end

        def valid_stream_name!(stream_name)
          valid_stream_name = stream_name.is_a?(String) &&
            stream_name.encoding == Encoding::UTF_8 &&
            stream_name.valid_encoding? &&
            stream_name.present? &&
            stream_name.end_with?(":#{STREAM_NAMESPACE}")
          unless valid_stream_name
            raise ArgumentError, "stream name must be a nonblank UTF-8 String ending in :#{STREAM_NAMESPACE}"
          end

          stream_name
        end
      end
    end
  end
end
