# frozen_string_literal: true

require "rack/media_type"

module ExpoTurbo
  module Rails
    class RouteConstraint
      ACCEPT_ENTRY = /[^,\s"](?:[^,"]|"[^"]*")*/

      def matches?(request)
        accept = request.get_header("HTTP_ACCEPT").to_s.strip
        return false if accept.empty?

        mime_type = Mime[MIME_SYMBOL]
        return false unless mime_type

        quality = accept.scan(ACCEPT_ENTRY).filter_map do |value|
          begin
            media_range = Rack::MediaType.type(value)
            parsed = Mime::Type.parse(media_range)
          rescue Mime::Type::InvalidMimeType
            next
          end
          next unless parsed.include?(mime_type) || media_range == "*/*"

          specificity = if media_range == "*/*"
            0
          elsif media_range.end_with?("/*")
            1
          else
            2
          end

          [specificity, Rack::MediaType.params(value).fetch("q", 1).to_f]
        end.max_by { |specificity, range_quality| [specificity, range_quality] }&.last

        quality.to_f.positive?
      end
    end
  end
end
