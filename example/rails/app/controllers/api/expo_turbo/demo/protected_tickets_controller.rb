# frozen_string_literal: true

module Api
  module ExpoTurbo
    module Demo
      class ProtectedTicketsController < ApplicationController
        def show
          response.set_header("Cache-Control", "no-store")
          render plain: ExpoTurboDemo::NativeCableTicket.issue, content_type: "text/plain; charset=utf-8"
        end
      end
    end
  end
end
