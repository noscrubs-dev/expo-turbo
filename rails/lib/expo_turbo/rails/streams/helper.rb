# frozen_string_literal: true

module ExpoTurbo
  module Rails
    module Streams
      module Helper
        RESERVED_STREAM_SOURCE_ATTRIBUTES = %w[channel signed-stream-name data-channel data-signed-stream-name].freeze
        RESERVED_STREAM_SOURCE_DATA_ATTRIBUTES = %w[channel signed-stream-name].freeze
        RESERVED_PROTECTED_STREAM_SOURCE_ATTRIBUTES = (RESERVED_STREAM_SOURCE_ATTRIBUTES + %w[data-grant grant]).freeze
        RESERVED_PROTECTED_STREAM_SOURCE_DATA_ATTRIBUTES = (RESERVED_STREAM_SOURCE_DATA_ATTRIBUTES + %w[grant]).freeze

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

        def expo_turbo_protected_stream_from(*streamables, grant:, **attributes)
          unless grant.is_a?(String) && grant.encoding == Encoding::UTF_8 && grant.valid_encoding? && grant.present?
            raise ArgumentError, "Expo Turbo protected stream grants must be nonblank UTF-8 Strings"
          end

          data_attributes = attributes.select { |key, _| key.to_s == "data" }
          if data_attributes.size > 1 || data_attributes.values.any? { |value| !value.is_a?(Hash) }
            raise ArgumentError, "Expo Turbo protected stream source data must be one Hash"
          end

          reserved_data_attribute = data_attributes.values.any? do |data|
            data.keys.any? do |key|
              RESERVED_PROTECTED_STREAM_SOURCE_DATA_ATTRIBUTES.include?(key.to_s.tr("_", "-"))
            end
          end
          if attributes.keys.any? { |key| RESERVED_PROTECTED_STREAM_SOURCE_ATTRIBUTES.include?(key.to_s.tr("_", "-")) } || reserved_data_attribute
            raise ArgumentError, "Expo Turbo protected stream sources reserve channel, signed stream name, and grant attributes"
          end

          data = data_attributes.values.first || {}
          source_attributes = attributes.reject { |key, _| key.to_s == "data" }

          ::Turbo::StreamsHelper.instance_method(:turbo_stream_from).bind_call(
            self,
            *ExpoTurbo::Rails::Streams.streamables_for(*streamables),
            **source_attributes,
            channel: ExpoTurbo::Rails::Cable::ProtectedStreamsChannel,
            data: data.merge(grant: grant)
          )
        end
      end
    end
  end
end
