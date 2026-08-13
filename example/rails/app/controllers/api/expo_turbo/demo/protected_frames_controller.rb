# frozen_string_literal: true

module Api
  module ExpoTurbo
    module Demo
      class ProtectedFramesController < ApplicationController
        before_action :require_frame_request!

        def show
        end

        private

        def require_frame_request!
          head :bad_request unless expo_turbo_frame_request?
        end
      end
    end
  end
end
