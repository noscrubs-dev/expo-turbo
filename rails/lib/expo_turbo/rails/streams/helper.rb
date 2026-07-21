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
          unless valid_grant?(grant)
            raise ArgumentError, "Expo Turbo protected stream grants must be nonblank UTF-8 Strings"
          end

          data_attributes = attributes.select { |key, _| normalized_attribute_name(key) == "data" }
          if data_attributes.size > 1 || data_attributes.values.any? { |value| !value.is_a?(Hash) }
            raise ArgumentError, "Expo Turbo protected stream source data must be one Hash"
          end

          reserved_data_attribute = data_attributes.values.any? do |data|
            data.keys.any? do |key|
              RESERVED_PROTECTED_STREAM_SOURCE_DATA_ATTRIBUTES.include?(normalized_attribute_name(key))
            end
          end
          reserved_source_attribute = attributes.keys.any? do |key|
            RESERVED_PROTECTED_STREAM_SOURCE_ATTRIBUTES.include?(normalized_attribute_name(key))
          end
          if reserved_source_attribute || reserved_data_attribute
            raise ArgumentError, "Expo Turbo protected stream sources reserve channel, signed stream name, and grant attributes"
          end

          ExpoTurbo::Rails::Cable.configuration
          data = data_attributes.values.first || {}
          source_attributes = attributes.reject { |key, _| normalized_attribute_name(key) == "data" }
          token = ExpoTurbo::Rails::Cable.protected_stream_token_for(*streamables)

          tag.turbo_cable_stream_source(
            **source_attributes,
            channel: ExpoTurbo::Rails::Cable::ProtectedStreamsChannel.name,
            "signed-stream-name": token,
            data: data.merge(grant:)
          )
        end

        private

        def normalized_attribute_name(key)
          key.to_s.tr("_", "-")
        end

        def valid_grant?(grant)
          grant.is_a?(String) && grant.encoding == Encoding::UTF_8 && grant.valid_encoding? && grant.present?
        end
      end
    end
  end
end
