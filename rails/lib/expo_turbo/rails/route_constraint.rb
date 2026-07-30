# frozen_string_literal: true

module ExpoTurbo
  module Rails
    class RouteConstraint
      ACCEPT_ENTRY = /[^,\s"](?:[^,"]|"[^"]*")*/
      QUALITY_SEPARATOR = /;\s*q="?/

      def matches?(request)
        accept = request.get_header("HTTP_ACCEPT").to_s.strip
        return false if accept.empty?

        mime_type = Mime[MIME_SYMBOL]
        return false unless mime_type
        return false unless request.negotiate_mime([mime_type]) == mime_type

        quality = accept.scan(ACCEPT_ENTRY).filter_map do |value|
          range, raw_quality = value.split(QUALITY_SEPARATOR, 2)
          parsed = Mime::Type.parse(range)
          next unless parsed.include?(mime_type) || parsed.include?(Mime::ALL)

          media_range = range.split(";", 2).first.strip
          specificity = if media_range == "*/*"
            0
          elsif media_range.end_with?("/*")
            1
          else
            2
          end

          [specificity, (raw_quality || 1).to_f]
        end.max_by { |specificity, range_quality| [specificity, range_quality] }&.last

        quality.to_f.positive?
      end
    end
  end
end
