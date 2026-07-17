module Api
  module ExpoTurbo
    module Demo
      class DocumentsController < ApplicationController
        def show
          render_expo_turbo "demo/documents/show"
        end
      end
    end
  end
end
