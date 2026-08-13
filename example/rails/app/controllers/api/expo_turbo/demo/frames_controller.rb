module Api
  module ExpoTurbo
    module Demo
      class FramesController < ApplicationController
        # This endpoint serves a Frame only. The gem compares the request
        # header against the Frame the response actually contains, so no
        # Frame id is written here.
        before_action :require_frame_request!

        def show
          invalid = params[:state] == "invalid"
          render locals: {message: invalid ? "Frame validation failed" : "Rendered from an XML Frame"},
            status: invalid ? :unprocessable_content : :ok
        end

        private

        def require_frame_request!
          head :bad_request unless expo_turbo_frame_request?
        end
      end
    end
  end
end
