# frozen_string_literal: true

module ExpoTurbo
  module Rails
    class Engine < ::Rails::Engine
      initializer "expo_turbo.rails.mime_type" do
        existing = Mime::Type.lookup_by_extension(MIME_SYMBOL)

        if existing.nil?
          Mime::Type.register MIME_TYPE, MIME_SYMBOL
        elsif existing.to_s != MIME_TYPE
          raise ConfigurationError, "#{MIME_SYMBOL.inspect} is already registered as #{existing}"
        end
      end
    end
  end
end
