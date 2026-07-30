# frozen_string_literal: true

require "active_support/core_ext/erb/util"
require "active_support/core_ext/string/output_safety"

module ExpoTurbo
  module Rails
    module Attributes
      module Helper
        XML_WHITESPACE_REFERENCES = {
          "\t" => "&#9;",
          "\n" => "&#10;",
          "\r" => "&#13;"
        }.freeze

        def expo_turbo_attribute(value)
          ERB::Util.html_escape(value)
            .gsub(/[\t\n\r]/, XML_WHITESPACE_REFERENCES)
            .html_safe
        end
      end
    end
  end
end
