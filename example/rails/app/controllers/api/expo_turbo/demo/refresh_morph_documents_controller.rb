module Api
  module ExpoTurbo
    module Demo
      class RefreshMorphDocumentsController < ApplicationController
        def show
          render_expo_turbo "demo/refresh_morph_documents/show"
        end
      end
    end
  end
end
