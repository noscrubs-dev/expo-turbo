module Api
  module ExpoTurbo
    module Demo
      class StreamsController < ApplicationController
        def show
          return render_morph_stream if params[:mode] == "morph"
          return render_document_refresh_morph_stream if params[:mode] == "refresh-morph"
          return head :bad_request unless params[:mode].blank?

          render_default_stream
        end

        private

        def render_default_stream
          render_expo_turbo_stream(
            expo_turbo_stream.update(
              "demo-http-stream-message",
              partial: "demo/streams/http_message",
              locals: {message: "Rendered from XML partial"}
            ),
            expo_turbo_stream.append("demo-http-stream-list", '<DemoText id="demo-http-stream-item">Second sibling</DemoText>')
          )
        end

        def render_morph_stream
          render_expo_turbo_stream(
            expo_turbo_stream.replace(
              "demo-http-stream-morph-probe",
              method: :morph,
              partial: "demo/streams/http_morph_probe",
              locals: {message: "Rendered from Rails Stream morph"}
            )
          )
        end

        def render_document_refresh_morph_stream
          render_expo_turbo_stream(expo_turbo_stream.refresh(request_id: nil, method: :morph))
        end
      end
    end
  end
end
