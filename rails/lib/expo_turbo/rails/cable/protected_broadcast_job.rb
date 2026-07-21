# frozen_string_literal: true

module ExpoTurbo
  module Rails
    module Cable
      class ProtectedBroadcastJob < ::ActiveJob::Base
        discard_on ActiveJob::DeserializationError

        self.log_arguments = false

        def perform(token, content:)
          ExpoTurbo::Rails::Cable.broadcast_to_protected_token(token, content:)
        end
      end
    end
  end
end
