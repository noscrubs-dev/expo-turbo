# frozen_string_literal: true

module Api
  module ExpoTurbo
    module Demo
      class ProtectedDocumentsController < ApplicationController
        def show
          render_expo_turbo("demo/protected_documents/show")
        end
      end
    end
  end
end
