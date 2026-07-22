# frozen_string_literal: true

module Api
  module ExpoTurbo
    module Demo
      class FormsController < ApplicationController
        FRAME_ID = "demo-form-frame"
        MAX_FIRST_NAME_BYTES = 120
        MAX_TEXT_PLAIN_BODY_BYTES = 1_048_576
        MAX_UPLOAD_BYTES = 64 * 1024
        MULTIPART_MEDIA_TYPE = "multipart/form-data"
        TEXT_PLAIN_MEDIA_TYPE = "text/plain"
        TERMS_VALIDATION_ERROR = "Accept the demo terms before saving"
        UPLOAD_VALIDATION_ERROR = "Upload a UTF-8 text file from 1 to 64 KiB"
        URL_ENCODED_MEDIA_TYPE = "application/x-www-form-urlencoded"
        UPLOAD_MEDIA_TYPES = ["text/plain", "text/plain;charset=utf-8", "text/plain; charset=utf-8"].freeze
        TEXT_PLAIN_FORM = /\Aprofile\[first_name\]=(?<first_name>[^\r\n]*)\r\ncommit=(?<commit>save)\r\n\z/

        rescue_from ActionController::BadRequest, ActionController::ParameterMissing, with: :render_bad_form_request

        before_action :require_form_frame!

        def show
          render_form
        end

        def create
          return submit_upload if request.media_type == MULTIPART_MEDIA_TYPE
          return head :unsupported_media_type unless [URL_ENCODED_MEDIA_TYPE, TEXT_PLAIN_MEDIA_TYPE].include?(request.media_type)
          return submit_consent if request.media_type == URL_ENCODED_MEDIA_TYPE && params[:commit] == "save-consent"

          submitted = submitted_form
          return head :bad_request unless submitted

          first_name = submitted.fetch(:first_name)
          commit = submitted.fetch(:commit)
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

        def render_form(first_name: "", error: nil, status: :ok, terms_accepted: false, terms_error: nil, upload_error: nil)
          render_expo_turbo "demo/forms/show", locals: {error:, first_name:, terms_accepted:, terms_error:, upload_error:}, status:
        end

        def render_bad_form_request
          expo_turbo_vary_by_frame!
          head :bad_request
        end

        def submitted_form
          case request.media_type
          when URL_ENCODED_MEDIA_TYPE
            {
              first_name: params.expect(profile: [:first_name]).fetch(:first_name),
              commit: params.expect(:commit)
            }
          when TEXT_PLAIN_MEDIA_TYPE
            parse_text_plain_form
          end
        end

        def submit_upload
          submitted = submitted_upload
          return head :bad_request unless submitted
          return head :bad_request unless submitted.fetch(:commit) == "upload"
          unless valid_demo_upload?(submitted.fetch(:attachment))
            return render_form(upload_error: UPLOAD_VALIDATION_ERROR, status: :unprocessable_content)
          end

          redirect_to api_expo_turbo_demo_form_path, status: :see_other
        end

        def submit_consent
          submitted = submitted_consent
          return head :bad_request unless submitted

          terms_accepted = submitted.fetch(:terms) == "accepted"
          unless terms_accepted
            return render_form(terms_error: TERMS_VALIDATION_ERROR, status: :unprocessable_content)
          end

          redirect_to api_expo_turbo_demo_form_path, status: :see_other
        end

        def submitted_upload
          {
            attachment: params.expect(profile: [:attachment]).fetch(:attachment),
            commit: params.expect(:commit)
          }
        end

        def submitted_consent
          return unless params.expect(:commit) == "save-consent"

          profile = params[:profile]
          return {terms: nil} if profile.nil?
          return unless profile.is_a?(ActionController::Parameters)

          terms = profile.permit(:terms)[:terms]
          return unless terms.nil? || terms.is_a?(String)

          {terms:}
        end

        def valid_demo_upload?(attachment)
          return false unless attachment.is_a?(ActionDispatch::Http::UploadedFile)
          return false unless valid_upload_filename?(attachment.original_filename)
          return false unless UPLOAD_MEDIA_TYPES.include?(attachment.content_type.to_s.downcase)
          return false unless attachment.size.is_a?(Integer) && attachment.size.between?(1, MAX_UPLOAD_BYTES)

          body = attachment.read
          attachment.rewind
          body.bytesize == attachment.size && valid_upload_body?(body)
        end

        def valid_upload_filename?(filename)
          return false unless filename.is_a?(String) && filename.bytesize.between?(1, 255)

          value = filename.dup.force_encoding(Encoding::UTF_8)
          value.valid_encoding? && value.match?(/\A[^\\\/\u0000-\u001F\u007F]+\z/)
        end

        def valid_upload_body?(body)
          value = body.dup.force_encoding(Encoding::UTF_8)
          value.valid_encoding?
        end

        def parse_text_plain_form
          raw = request.raw_post
          return unless raw.is_a?(String) && raw.bytesize <= MAX_TEXT_PLAIN_BODY_BYTES

          body = raw.dup.force_encoding(Encoding::UTF_8)
          return unless body.valid_encoding?

          match = TEXT_PLAIN_FORM.match(body)
          return unless match

          {first_name: match[:first_name], commit: match[:commit]}
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
