# frozen_string_literal: true

module ExpoTurbo
  module Rails
    module Streams
      module Helper
        def expo_turbo_stream
          TagBuilder.new(
            self,
            partial_resolver: ->(partial) { controller.send(:expo_turbo_partial_file, partial) }
          )
        end
      end
    end
  end
end
