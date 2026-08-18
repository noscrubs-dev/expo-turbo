# frozen_string_literal: true

module ExpoTurbo
  module Rails
    class Engine < ::Rails::Engine
      config.expo_turbo = ActiveSupport::OrderedOptions.new

      initializer "expo_turbo.rails.deprecator" do |app|
        app.deprecators[ExpoTurbo::Rails::DomIds::DEPRECATOR_NAME] = ExpoTurbo::Rails::DomIds::DEPRECATOR
      end

      # A lint, not a runtime hook: loading the task does not load the linter,
      # and no request path reaches either.
      rake_tasks do
        load File.expand_path("tasks/paired_templates.rake", __dir__)
      end

      initializer "expo_turbo.rails.mime_type" do
        existing = Mime::Type.lookup_by_extension(MIME_SYMBOL)

        if existing.nil?
          Mime::Type.register MIME_TYPE, MIME_SYMBOL
        elsif existing.to_s != MIME_TYPE
          raise ConfigurationError, "#{MIME_SYMBOL.inspect} is already registered as #{existing}"
        end
      end

      # Outside ActionDispatch::ShowExceptions, so a response that no controller
      # callback can reach still carries the cache dimensions.
      initializer "expo_turbo.rails.vary" do |app|
        next if app.config.expo_turbo.vary_middleware == false

        app.middleware.insert_before ActionDispatch::ShowExceptions, ExpoTurbo::Rails::VaryHeaders
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
