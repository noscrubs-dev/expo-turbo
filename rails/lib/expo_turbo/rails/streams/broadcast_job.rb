# frozen_string_literal: true

module ExpoTurbo
  module Rails
    module Streams
      class BroadcastJob < ::ActiveJob::Base
        self.log_arguments = false

        def perform(stream_name, content:)
          Streams.broadcast_to_stream(stream_name, content: content)
        end
      end
    end
  end
end
