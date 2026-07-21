# frozen_string_literal: true

module Api
  module ExpoTurbo
    module Demo
      class MorphFramesController < ApplicationController
        OUTER_FRAME_ID = "morph-outer"
        INNER_FRAME_ID = "morph-inner"

        def outer
          render_frame OUTER_FRAME_ID, "demo/morph_frames/outer"
        end

        def inner
          render_frame INNER_FRAME_ID, "demo/morph_frames/inner"
        end

        private

        def render_frame(frame_id, template)
          expo_turbo_vary_by_frame!
          return head :bad_request unless expo_turbo_frame_request_id == frame_id

          render_expo_turbo template
        end
      end
    end
  end
end
