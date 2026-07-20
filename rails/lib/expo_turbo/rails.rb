# frozen_string_literal: true

require "rails"
require "action_cable"
require "active_job"
require "turbo-rails"

require_relative "rails/version"
require_relative "rails/protocol"
require_relative "rails/errors"
require_relative "rails/frames"
require_relative "rails/frames/helper"
require_relative "rails/streams"
require_relative "rails/streams/broadcast_job"
require_relative "rails/streams/helper"
require_relative "rails/controller"
require_relative "rails/engine"

module ExpoTurbo
  module Rails
    module Streams
      autoload :TagBuilder, "expo_turbo/rails/streams/tag_builder"
    end
  end
end
