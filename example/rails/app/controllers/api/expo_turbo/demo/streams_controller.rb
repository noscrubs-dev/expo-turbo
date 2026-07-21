module Api
  module ExpoTurbo
    module Demo
      class StreamsController < ApplicationController
        def show
          render_expo_turbo_stream(
            expo_turbo_stream.update(
              "demo-http-stream-message",
              partial: "demo/streams/http_message",
              locals: {message: "Rendered from XML partial"}
            ),
            expo_turbo_stream.append("demo-http-stream-list", '<DemoText id="demo-http-stream-item">Second sibling</DemoText>')
          )
        end
      end
    end
  end
end
