# frozen_string_literal: true

require "active_support/concern"

module ExpoTurbo
  module Rails
    module Cable
      module Connection
        extend ActiveSupport::Concern

        included do
          identified_by :expo_turbo_subject
          prepend Authentication
        end

        def connect
        end

        private

        def authenticate_expo_turbo_cable!
          configuration = ExpoTurbo::Rails::Cable.configuration
          credential = configuration.credential_extractor.call(self)
          self.expo_turbo_subject = configuration.subject_resolver.call(credential)
        end

        module Authentication
          def connect
            authenticate_expo_turbo_cable!
            super
          end
        end
      end
    end
  end
end
