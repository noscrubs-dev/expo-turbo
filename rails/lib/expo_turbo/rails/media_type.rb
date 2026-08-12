# frozen_string_literal: true

require "rack/media_type"

module ExpoTurbo
  module Rails
    # Recognizes a verified native request from its Accept header.
    #
    # A native client names the Expo Turbo media type exactly and prefers it:
    # it sends the type alone, or beside the Turbo Stream type at equal
    # quality. Three values therefore do not qualify, because getting this
    # wrong denies service to a client that is not native:
    #
    # - a wildcard, which every browser sends
    # - the type at a lower quality than another media range, which means the
    #   client prefers that other range
    # - a malformed quality value, which the server cannot interpret at all
    module MediaType
      ACCEPT_ENTRY = /[^,\s"](?:[^,"]|"[^"]*")*/
      # RFC 9110 qvalue: 0[.0-3 digits] or 1[.up to three zeros].
      QUALITY = /\A(?:0(?:\.\d{1,3})?|1(?:\.0{1,3})?)\z/
      # Parameter names of one media range. A quoted value is consumed whole, so
      # a semicolon inside it does not read as another parameter.
      PARAMETER_NAME = /;\s*([^;=\s"]+)\s*=\s*(?:"(?:[^"\\]|\\.)*"|[^;]*)/

      module_function

      def explicitly_accepted?(accept)
        return false unless accept.is_a?(String)

        accept = accept.dup.force_encoding(Encoding::UTF_8)
        return false unless accept.valid_encoding? && !accept.strip.empty?

        preferred = 0.0
        expo_turbo = nil
        accept.scan(ACCEPT_ENTRY).each do |entry|
          quality = entry_quality(entry)
          next unless quality

          preferred = quality if quality > preferred
          expo_turbo = quality if expo_turbo_entry?(entry) && (expo_turbo.nil? || quality > expo_turbo)
        end

        !expo_turbo.nil? && expo_turbo.positive? && expo_turbo >= preferred
      end

      # An entry whose quality cannot be parsed is ignored: it neither matches
      # nor competes, so unreadable syntax on one range cannot change how the
      # server reads another.
      #
      # A repeated quality parameter is unreadable rather than last-wins.
      # Last-wins would let one appended parameter flip the classification of a
      # request.
      def entry_quality(entry)
        return nil if repeated_quality?(entry)

        quality = Rack::MediaType.params(entry).fetch("q", "1").to_s
        QUALITY.match?(quality) ? quality.to_f : nil
      rescue ArgumentError, TypeError
        nil
      end
      private_class_method :entry_quality

      def repeated_quality?(entry)
        entry.scan(PARAMETER_NAME).count { |name| name.first.casecmp?("q") } > 1
      end
      private_class_method :repeated_quality?

      def expo_turbo_entry?(entry)
        Rack::MediaType.type(entry)&.casecmp?(MIME_TYPE) || false
      rescue ArgumentError, TypeError
        false
      end
      private_class_method :expo_turbo_entry?
    end
  end
end
