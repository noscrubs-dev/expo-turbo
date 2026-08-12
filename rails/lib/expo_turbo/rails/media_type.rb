# frozen_string_literal: true

require "rack/media_type"

module ExpoTurbo
  module Rails
    # Recognizes a verified native request from its Accept header.
    #
    # A native client always names the Expo Turbo media type exactly. A browser
    # names it only through a wildcard, so wildcards deliberately do not match:
    # the result decides whether module negotiation may fail open.
    module MediaType
      ACCEPT_ENTRY = /[^,\s"](?:[^,"]|"[^"]*")*/

      module_function

      def explicitly_accepted?(accept)
        return false unless accept.is_a?(String)

        accept = accept.dup.force_encoding(Encoding::UTF_8)
        return false unless accept.valid_encoding? && !accept.strip.empty?

        accept.scan(ACCEPT_ENTRY).any? { |entry| expo_turbo_entry?(entry) }
      end

      def expo_turbo_entry?(entry)
        return false unless Rack::MediaType.type(entry)&.casecmp?(MIME_TYPE)

        Rack::MediaType.params(entry).fetch("q", 1).to_f.positive?
      rescue ArgumentError, TypeError
        false
      end
      private_class_method :expo_turbo_entry?
    end
  end
end
