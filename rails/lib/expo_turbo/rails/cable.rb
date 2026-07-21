# frozen_string_literal: true

require_relative "cable/configuration"
require_relative "cable/connection"
require_relative "cable/protected_broadcast_job"
require_relative "cable/protected_streams_channel"

module ExpoTurbo
  module Rails
    module Cable
      PROTECTED_STREAM_VERIFIER_NAME = "expo_turbo/protected_stream"
      PROTECTED_STREAM_PURPOSE = "expo_turbo.protected_stream"

      class << self
        def configure(credential_extractor:, subject_resolver:, subscription_authorizer:, subscription_error_reporter:)
          @configuration = Configuration.new(
            credential_extractor:,
            subject_resolver:,
            subscription_authorizer:,
            subscription_error_reporter:
          )
        end

        def configured?
          defined?(@configuration)
        end

        def configuration
          @configuration || raise(
            ConfigurationError,
            "configure ExpoTurbo::Rails::Cable before rendering or accepting protected Expo Turbo subscriptions"
          )
        end

        def protected_stream_token_for(*streamables)
          protected_stream_verifier.generate(
            Streams.stream_name_for(*streamables),
            purpose: PROTECTED_STREAM_PURPOSE
          ).encode(Encoding::UTF_8)
        end

        def verified_protected_stream_name(token)
          return unless valid_token?(token)

          stream_name = protected_stream_verifier.verified(token, purpose: PROTECTED_STREAM_PURPOSE)
          stream_name if Streams.valid_stream_name?(stream_name)
        end

        def broadcast_protected_to(*streamables, content:)
          broadcast_to_protected_token(protected_stream_token_for(*streamables), content:)
        end

        def broadcast_protected_later_to(*streamables, content:)
          ProtectedBroadcastJob.perform_later(
            protected_stream_token_for(*streamables),
            content: Streams.valid_content!(content)
          )
        end

        def broadcast_to_protected_token(token, content:)
          unless verified_protected_stream_name(token)
            raise ArgumentError, "protected stream token must be a valid Expo Turbo protected stream token"
          end

          ::Turbo::StreamsChannel.broadcast_stream_to(token, content: Streams.valid_content!(content))
        end

        def resolve_subject(connection)
          credential = configuration.credential_extractor.call(connection)
          configuration.subject_resolver.call(credential)
        end

        def subscription_authorized?(subject:, stream_name:, grant:)
          configuration.subscription_authorizer.call(subject:, stream_name:, grant:) == true
        end

        def report_subscription_error(code:, error:)
          configuration.subscription_error_reporter.call(code:, error_class: error.class.name)
        rescue
          # A failing observer must not make Action Cable log a descriptor containing the client-visible grant.
        end

        private

        def protected_stream_verifier
          ::Rails.application.message_verifier(PROTECTED_STREAM_VERIFIER_NAME)
        end

        def valid_token?(token)
          token.is_a?(String) && token.encoding == Encoding::UTF_8 && token.valid_encoding? && token.present?
        end
      end
    end
  end
end
