# frozen_string_literal: true

module Api
  module ExpoTurbo
    module Demo
      class ProtectedBroadcastsController < ApplicationController
        def create
          content = expo_turbo_stream.replace(
            "demo-protected-stream-message",
            partial: "demo/streams/protected_message",
            locals: {message: "Protected broadcast from the standalone Rails demo"}
          ).to_s
          ::ExpoTurbo::Rails::Cable.broadcast_protected_to(ExpoTurboDemo::NativeCableTicket::STREAM, content:)

          head :no_content
        end
      end
    end
  end
end
