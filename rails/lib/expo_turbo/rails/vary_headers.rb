# frozen_string_literal: true

module ExpoTurbo
  module Rails
    # Stamps the Expo Turbo cache dimensions on the way out, at the Rack layer.
    #
    # A controller callback cannot reach every response. It is skipped when a
    # host filter halts the chain before the concern's own filter runs, and a
    # response that ActionDispatch::ShowExceptions renders never passes through
    # a controller at all. Both are ordinary responses that a shared cache can
    # store, and both must carry Vary.
    #
    # The middleware sits immediately outside ActionDispatch::ShowExceptions.
    # That position covers every response the Rails application produces,
    # including its exception pages, and deliberately excludes responses that
    # are produced above it: static files, Rack::Sendfile, host authorization,
    # and the web server itself. Those are not representations of an Expo Turbo
    # resource, so their bytes do not depend on Accept, Turbo-Frame, or the
    # client module versions.
    class VaryHeaders
      DIMENSIONS = ["Accept", "Turbo-Frame", "X-Expo-Turbo-Modules"].freeze
      HEADER = "vary"

      def initialize(app)
        @app = app
      end

      def call(env)
        status, headers, body = @app.call(env)
        [status, vary(headers), body]
      end

      private

      def vary(headers)
        return headers unless headers.respond_to?(:[]) && headers.respond_to?(:[]=)

        key = vary_key(headers)
        values = headers[key].to_s.split(",").map(&:strip).reject(&:empty?)
        return headers if values.include?("*")

        DIMENSIONS.each do |dimension|
          values << dimension if values.none? { |value| value.casecmp?(dimension) }
        end

        headers = headers.dup if headers.frozen?
        headers[key] = values.join(", ")
        headers
      end

      def vary_key(headers)
        return HEADER unless headers.respond_to?(:keys)

        headers.keys.find { |key| key.is_a?(String) && key.casecmp?(HEADER) } || HEADER
      end
    end
  end
end
