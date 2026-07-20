module Api
  module ExpoTurbo
    module Demo
      class FramesController < ApplicationController
        def show
          expo_turbo_vary_by_frame!
          return head :bad_request unless expo_turbo_frame_request_id == "demo-frame"

          invalid = params[:state] == "invalid"
          render_expo_turbo(
            "demo/frames/show",
            locals: {message: invalid ? "Frame validation failed" : "Rendered from an XML Frame"},
            status: invalid ? :unprocessable_content : :ok
          )
        end
      end
    end
  end
end
