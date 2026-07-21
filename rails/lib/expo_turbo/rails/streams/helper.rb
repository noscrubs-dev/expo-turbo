# frozen_string_literal: true

module ExpoTurbo
  module Rails
    module Streams
      module Helper
        RESERVED_STREAM_SOURCE_ATTRIBUTES = %w[channel signed-stream-name data-channel data-signed-stream-name].freeze
        RESERVED_STREAM_SOURCE_DATA_ATTRIBUTES = %w[channel signed-stream-name].freeze

        def expo_turbo_stream
          TagBuilder.new(
            self,
            partial_resolver: ->(partial) { controller.send(:expo_turbo_partial_file, partial) },
            fragment_validator: ->(document) { controller.send(:expo_turbo_validate_stream_fragment!, document) }
          )
        end

        def expo_turbo_stream_from(*streamables, **attributes)
          reserved_data_attribute = attributes
            .select { |key, _| key.to_s == "data" }
            .values
            .grep(Hash)
            .any? do |data|
              data.keys.any? do |key|
                RESERVED_STREAM_SOURCE_DATA_ATTRIBUTES.include?(key.to_s.tr("_", "-"))
              end
            end
          if attributes.keys.any? { |key| RESERVED_STREAM_SOURCE_ATTRIBUTES.include?(key.to_s) } || reserved_data_attribute
            raise ArgumentError, "Expo Turbo stream sources reserve channel and signed stream name attributes"
          end

          ::Turbo::StreamsHelper.instance_method(:turbo_stream_from).bind_call(
            self,
            *ExpoTurbo::Rails::Streams.streamables_for(*streamables),
            **attributes,
            channel: "Turbo::StreamsChannel"
          )
        end
      end
    end
  end
end
