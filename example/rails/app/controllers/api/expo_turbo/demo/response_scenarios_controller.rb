# frozen_string_literal: true

module Api
  module ExpoTurbo
    module Demo
      class ResponseScenariosController < ApplicationController
        FRAME_ID = "demo-response-frame"
        MAX_DELAY_MS = 1_000

        def show
          case params[:scenario]
          when "document-client-error"
            render_document(status: :unprocessable_content)
          when "document-server-error"
            render_document(status: :internal_server_error)
          when "empty"
            head :no_content
          when "wrong-mime"
            render plain: "This is intentionally not Expo Turbo XML.", content_type: "text/plain"
          when "frame"
            render_frame
          when "missing-frame"
            render_frame(id: "another-frame")
          when "delayed-frame"
            sleep(delay_ms.fdiv(1_000))
            render_frame
          else
            head :not_found
          end
        end

        private

        def delay_ms
          Integer(params.fetch(:delay_ms, 100), exception: false)&.clamp(0, MAX_DELAY_MS) || 0
        end

        def render_document(status:)
          render_expo_turbo(
            "demo/response_scenarios/document",
            locals: {status: Rack::Utils.status_code(status)},
            status:
          )
        end

        def render_frame(id: FRAME_ID)
          expo_turbo_vary_by_frame!
          return head :bad_request unless expo_turbo_frame_request_id == FRAME_ID

          render_expo_turbo "demo/response_scenarios/frame", locals: {id:}
        end
      end
    end
  end
end
