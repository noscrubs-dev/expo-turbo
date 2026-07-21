# frozen_string_literal: true

module Api
  module ExpoTurbo
    module Demo
      class FormsController < ApplicationController
        FRAME_ID = "demo-form-frame"
        MAX_FIRST_NAME_BYTES = 120
        URL_ENCODED_MEDIA_TYPE = "application/x-www-form-urlencoded"

        rescue_from ActionController::BadRequest, ActionController::ParameterMissing, with: :render_bad_form_request

        before_action :require_form_frame!

        def show
          render_form
        end

        def create
          return head :unsupported_media_type unless request.media_type == URL_ENCODED_MEDIA_TYPE

          first_name = params.expect(profile: [:first_name]).fetch(:first_name)
          commit = params.expect(:commit)
          return head :bad_request unless valid_first_name?(first_name)
          return head :bad_request unless ["save", "no-content"].include?(commit)

          error = validation_error(first_name)
          return render_form(first_name:, error:, status: :unprocessable_content) if error

          return head :no_content if commit == "no-content"

          redirect_to api_expo_turbo_demo_form_path, status: :see_other
        end

        private

        def require_form_frame!
          expo_turbo_vary_by_frame!
          head :bad_request unless expo_turbo_frame_request_id == FRAME_ID
        end

        def render_form(first_name: "", error: nil, status: :ok)
          render_expo_turbo "demo/forms/show", locals: {error:, first_name:}, status:
        end

        def render_bad_form_request
          expo_turbo_vary_by_frame!
          head :bad_request
        end

        def valid_first_name?(first_name)
          first_name.is_a?(String) &&
            first_name.encoding == Encoding::UTF_8 &&
            first_name.valid_encoding? &&
            first_name.bytesize <= MAX_FIRST_NAME_BYTES &&
            first_name.each_codepoint.none? { |codepoint|
              codepoint <= 31 || codepoint == 127 || codepoint.between?(0xFFFE, 0xFFFF)
            }
        end

        def validation_error(first_name)
          return "First name is required" if first_name.strip.empty?
          "This demo name is unavailable" if first_name.start_with?("invalid")
        end
      end
    end
  end
end
