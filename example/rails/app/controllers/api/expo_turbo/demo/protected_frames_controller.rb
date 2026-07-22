# frozen_string_literal: true

module Api
  module ExpoTurbo
    module Demo
      class ProtectedFramesController < ApplicationController
        def show
          expo_turbo_vary_by_frame!
          return head :bad_request unless expo_turbo_frame_request_id == "demo-protected-frame"

          render_expo_turbo("demo/protected_frames/show")
        end
      end
    end
  end
end
