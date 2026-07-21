module Api
  module ExpoTurbo
    module Demo
      class BroadcastsController < ApplicationController
        def create
          case params[:kind]
          when nil, "replace"
            broadcast_expo_turbo_stream_to("demo-stream") do |stream|
              stream.replace(
                "demo-stream-message",
                partial: "demo/streams/message",
                locals: {message: "Broadcast from the standalone Rails demo"}
              )
            end
          when "refresh"
            broadcast_expo_turbo_refresh_to("demo-stream", request_id: nil)
          else
            head :unprocessable_content
            return
          end
          head :no_content
        end
      end
    end
  end
end
