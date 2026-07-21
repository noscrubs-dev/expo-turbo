# frozen_string_literal: true

require_relative "cable/configuration"
require_relative "cable/connection"
require_relative "cable/protected_streams_channel"

module ExpoTurbo
  module Rails
    module Cable
      class << self
        def configure(credential_extractor:, subject_resolver:, subscription_authorizer:)
          @configuration = Configuration.new(
            credential_extractor:,
            subject_resolver:,
            subscription_authorizer:
          )
        end

        def configuration
          @configuration || raise(
            ConfigurationError,
            "configure ExpoTurbo::Rails::Cable before accepting protected Expo Turbo subscriptions"
          )
        end
      end
    end
  end
end
