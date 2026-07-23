# frozen_string_literal: true

module Api
  module ExpoTurbo
    module Demo
      class ProtectedRevocationsController < ApplicationController
        def create
          ExpoTurboDemo::NativeCableTicket.revoke!
          ActionCable.server.remote_connections
            .where(expo_turbo_demo_subject: ExpoTurboDemo::NativeCableTicket::SUBJECT)
            .disconnect(reconnect: false)

          head :no_content
        end
      end
    end
  end
end
