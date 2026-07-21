# frozen_string_literal: true

module ExpoTurbo
  module Rails
    module Cable
      class ProtectedStreamsChannel < ::ActionCable::Channel::Base
        CALLBACK_FAILURE = Object.new.freeze

        def subscribed
          return reject unless ExpoTurbo::Rails::Cable.configured?

          token = params[:signed_stream_name]
          stream_name = ExpoTurbo::Rails::Cable.verified_protected_stream_name(token)
          return reject unless stream_name && valid_grant?(params[:grant])

          subject = resolved_subject
          return if subject.equal?(CALLBACK_FAILURE)
          return reject unless subject.present?

          authorized = subscription_authorized?(subject, stream_name, params[:grant])
          return if authorized.equal?(CALLBACK_FAILURE)
          return reject unless authorized

          stream_from token
        end

        private

        def valid_grant?(grant)
          grant.is_a?(String) && grant.encoding == Encoding::UTF_8 && grant.valid_encoding? && grant.present?
        end

        def resolved_subject
          connection.expo_turbo_subject
        rescue => error
          callback_failure(:subject_resolution_failed, error)
        end

        def subscription_authorized?(subject, stream_name, grant)
          ExpoTurbo::Rails::Cable.subscription_authorized?(subject:, stream_name:, grant:)
        rescue => error
          callback_failure(:subscription_authorization_failed, error)
        end

        def callback_failure(code, error)
          ExpoTurbo::Rails::Cable.report_subscription_error(code:, error:)
          reject
          CALLBACK_FAILURE
        end
      end
    end
  end
end
