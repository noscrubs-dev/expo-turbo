# frozen_string_literal: true

module ExpoTurbo
  module Rails
    class Engine < ::Rails::Engine
      config.expo_turbo = ActiveSupport::OrderedOptions.new

      initializer "expo_turbo.rails.mime_type" do
        existing = Mime::Type.lookup_by_extension(MIME_SYMBOL)

        if existing.nil?
          Mime::Type.register MIME_TYPE, MIME_SYMBOL
        elsif existing.to_s != MIME_TYPE
          raise ConfigurationError, "#{MIME_SYMBOL.inspect} is already registered as #{existing}"
        end
      end

      # Installed after "turbo.helpers" so that every Expo Turbo helper module
      # enters the helper chain behind its turbo-rails namesake. `super` in a
      # helper then reaches the HTML implementation.
      initializer "expo_turbo.rails.controller", after: "turbo.helpers" do |app|
        next if app.config.expo_turbo.include_controller == false

        ActiveSupport.on_load(:action_controller) do
          include ExpoTurbo::Rails::Controller
        end
      end
    end
  end
end
