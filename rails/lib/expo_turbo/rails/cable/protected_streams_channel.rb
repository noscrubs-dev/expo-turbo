# frozen_string_literal: true

module ExpoTurbo
  module Rails
    module Cable
      class ProtectedStreamsChannel < ::ActionCable::Channel::Base
        class << self
          def verified_stream_name(signed_stream_name)
            ::Turbo.signed_stream_verifier.verified(signed_stream_name)
          end
        end

        def subscribed
          stream_name = self.class.verified_stream_name(params[:signed_stream_name])
          grant = params[:grant]

          if stream_name.present? && valid_grant?(grant) && expo_turbo_subject.present? && subscription_authorized?(stream_name, grant)
            stream_from stream_name
          else
            reject
          end
        end

        private

        def valid_grant?(grant)
          grant.is_a?(String) && grant.encoding == Encoding::UTF_8 && grant.valid_encoding? && grant.present?
        end

        def subscription_authorized?(stream_name, grant)
          ExpoTurbo::Rails::Cable.configuration.subscription_authorizer.call(
            subject: expo_turbo_subject,
            stream_name:,
            grant:
          )
        end
      end
    end
  end
end
