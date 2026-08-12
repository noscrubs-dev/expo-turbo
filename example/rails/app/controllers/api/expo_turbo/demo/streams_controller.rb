module Api
  module ExpoTurbo
    module Demo
      class StreamsController < ApplicationController
        def show
          return render_morph_stream if params[:mode] == "morph"
          return render_document_refresh_morph_stream if params[:mode] == "refresh-morph"
          return render_originating_document_refresh_morph_stream if params[:mode] == "refresh-morph-originating"
          return head :bad_request unless params[:mode].blank?

          render_default_stream
        end

        private

        def render_default_stream
          render turbo_stream: [
            turbo_stream.update(
              "demo-http-stream-message",
              partial: "http_message",
              locals: {message: "Rendered from XML partial"}
            ),
            turbo_stream.append("demo-http-stream-list", '<DemoText id="demo-http-stream-item">Second sibling</DemoText>')
          ]
        end

        def render_morph_stream
          render turbo_stream: [
            turbo_stream.replace(
              "demo-http-stream-morph-probe",
              method: :morph,
              partial: "http_morph_probe",
              locals: {message: "Rendered from Rails Stream morph"}
            )
          ]
        end

        def render_document_refresh_morph_stream
          render turbo_stream: turbo_stream.refresh(request_id: nil, method: :morph)
        end

        def render_originating_document_refresh_morph_stream
          request_id = request.get_header("HTTP_X_TURBO_REQUEST_ID")
          return head :bad_request if request_id.blank?

          render turbo_stream: [
            turbo_stream.replace(
              "demo-document-refresh-morph-suppression",
              '<DemoText id="demo-document-refresh-morph-suppression">Rails echoed the originating request ID, so the document Refresh Stream was suppressed.</DemoText>'
            ),
            turbo_stream.refresh(request_id:, method: :morph)
          ]
        end
      end
    end
  end
end
