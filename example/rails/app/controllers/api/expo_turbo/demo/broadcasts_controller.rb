module Api
  module ExpoTurbo
    module Demo
      class BroadcastsController < ApplicationController
        def create
          broadcast_expo_turbo_stream_to("demo-stream") do |stream|
            stream.replace(
              "demo-stream-message",
              partial: "demo/streams/message",
              locals: {message: "Broadcast from the standalone Rails demo"}
            )
          end
          head :no_content
        end
      end
    end
  end
end
