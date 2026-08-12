# frozen_string_literal: true

module Api
  module ExpoTurbo
    module Demo
      class ProtectedDocumentsController < ApplicationController
        def show
          render "show"
        end
      end
    end
  end
end
