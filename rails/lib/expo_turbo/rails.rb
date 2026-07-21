# frozen_string_literal: true

require "rails"
require "action_cable"
require "active_job"
require "turbo-rails"

require_relative "rails/version"
require_relative "rails/protocol"
require_relative "rails/errors"
require_relative "rails/template_capabilities"
require_relative "rails/frames"
require_relative "rails/frames/helper"
require_relative "rails/dom_ids"
require_relative "rails/dom_ids/helper"
require_relative "rails/streams"
require_relative "rails/streams/broadcast_job"
require_relative "rails/streams/helper"
require_relative "rails/controller"
require_relative "rails/engine"

module ExpoTurbo
  module Rails
    autoload :XmlFragments, "expo_turbo/rails/xml_fragments"

    module Streams
      autoload :TagBuilder, "expo_turbo/rails/streams/tag_builder"
    end
  end
end
