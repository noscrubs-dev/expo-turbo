# frozen_string_literal: true

require "action_view/record_identifier"
require "active_support/deprecation"

module ExpoTurbo
  module Rails
    module DomIds
      DEPRECATOR_NAME = :expo_turbo_rails
      DEPRECATOR = ActiveSupport::Deprecation.new("0.5.0", "expo_turbo-rails")
      DEPRECATION_MESSAGE =
        "ExpoTurbo::Rails::DomIds.id_for is deprecated and will be removed in expo_turbo-rails 0.5.0; " \
        "replace id_for(record, :record) with dom_id(record), not dom_id(record, :record), because the wrapper " \
        "preserves the 0.3 rule that an explicit :record role has no prefix"

      module_function

      def id_for(record_or_class, role = :record)
        DEPRECATOR.warn(DEPRECATION_MESSAGE)
        prefix = (role == :record) ? nil : role
        ActionView::RecordIdentifier.dom_id(record_or_class, prefix)
      end
    end
  end
end
