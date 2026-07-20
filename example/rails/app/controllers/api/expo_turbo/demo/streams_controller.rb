module Api
  module ExpoTurbo
    module Demo
      class StreamsController < ApplicationController
        def show
          render_expo_turbo_stream(
            expo_turbo_stream.update(
              "demo-stream-message",
              partial: "demo/streams/message",
              locals: {message: "Rendered from XML partial"}
            ),
            expo_turbo_stream.append("demo-stream-list", '<DemoText id="demo-stream-item">Second sibling</DemoText>')
          )
        end
      end
    end
  end
end
