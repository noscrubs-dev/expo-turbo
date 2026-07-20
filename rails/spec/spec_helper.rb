# frozen_string_literal: true

require "action_controller/railtie"
require "action_view/railtie"
require "expo_turbo/rails"

class ExpoTurboRailsSpecApp < Rails::Application
  config.eager_load = false
  config.secret_key_base = "expo-turbo-rails-spec-secret" * 4
end

ExpoTurboRailsSpecApp.initialize!
