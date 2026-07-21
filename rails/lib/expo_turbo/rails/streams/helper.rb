# frozen_string_literal: true

module ExpoTurbo
  module Rails
    module Streams
      module Helper
        def expo_turbo_stream
          TagBuilder.new(
            self,
            partial_resolver: ->(partial) { controller.send(:expo_turbo_partial_file, partial) },
            fragment_validator: ->(document) { controller.send(:expo_turbo_validate_stream_fragment!, document) }
          )
        end

        def expo_turbo_stream_from(*streamables, **attributes)
          if attributes.keys.any? do |key|
               %w[channel signed-stream-name data-channel data-signed-stream-name].include?(key.to_s)
             end
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
