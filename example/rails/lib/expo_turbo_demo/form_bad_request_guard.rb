# frozen_string_literal: true

module ExpoTurboDemo
  class FormBadRequestGuard
    FORM_PATH = "/api/expo_turbo/demo/form"
    RESPONSE_HEADERS = {
      "content-length" => "0",
      "content-type" => "text/plain; charset=utf-8",
      "vary" => "Turbo-Frame"
    }.freeze

    def initialize(app)
      @app = app
    end

    def call(env)
      @app.call(env)
    rescue ActionController::BadRequest
      raise unless env["PATH_INFO"] == FORM_PATH && env["REQUEST_METHOD"] == "POST"

      [400, RESPONSE_HEADERS.dup, []]
    end
  end
end
