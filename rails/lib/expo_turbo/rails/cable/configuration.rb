# frozen_string_literal: true

module ExpoTurbo
  module Rails
    module Cable
      class Configuration
        attr_reader :credential_extractor, :subject_resolver, :subscription_authorizer

        def initialize(credential_extractor:, subject_resolver:, subscription_authorizer:)
          @credential_extractor = callable!(credential_extractor, "credential_extractor")
          @subject_resolver = callable!(subject_resolver, "subject_resolver")
          @subscription_authorizer = callable!(subscription_authorizer, "subscription_authorizer")
          freeze
        end

        private

        def callable!(value, name)
          return value if value.respond_to?(:call)

          raise ConfigurationError, "Expo Turbo Cable #{name} must respond to #call"
        end
      end
    end
  end
end
