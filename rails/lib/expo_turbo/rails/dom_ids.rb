# frozen_string_literal: true

require "action_view/record_identifier"
require "active_support/deprecation"

module ExpoTurbo
  module Rails
    module DomIds
      DEPRECATOR = ActiveSupport::Deprecation.new("0.5.0", "expo_turbo-rails")

      module_function

      def id_for(record_or_class, role = :record)
        DEPRECATOR.warn(
          "ExpoTurbo::Rails::DomIds.id_for is deprecated and will be removed in expo_turbo-rails 0.5.0; " \
          "use ActionView::RecordIdentifier.dom_id or the standard dom_id view helper"
        )
        prefix = (role == :record) ? nil : role
        ActionView::RecordIdentifier.dom_id(record_or_class, prefix)
      end
    end
  end
end
