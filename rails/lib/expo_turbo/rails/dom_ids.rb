# frozen_string_literal: true

require "action_view/record_identifier"
require "active_support/deprecation"

module ExpoTurbo
  module Rails
    module DomIds
      DEPRECATOR_NAME = :expo_turbo_rails
      DEPRECATOR = ActiveSupport::Deprecation.new("0.5.0", "expo_turbo-rails")
      RECORD_DEPRECATION_MESSAGE =
        "ExpoTurbo::Rails::DomIds.id_for is deprecated and will be removed in expo_turbo-rails 0.5.0; " \
        "replace id_for(record) or id_for(record, :record) with dom_id(record), not dom_id(record, :record), " \
        "because the legacy :record role meant no prefix"

      module_function

      def id_for(record_or_class, role = :record)
        DEPRECATOR.warn(deprecation_message(role))
        prefix = case role
        when :record then nil
        else role
        end
        ActionView::RecordIdentifier.dom_id(record_or_class, prefix)
      end

      def deprecation_message(role)
        case role
        when :record then return RECORD_DEPRECATION_MESSAGE
        end

        if Symbol === role
          formatted_role = role.inspect
          "ExpoTurbo::Rails::DomIds.id_for is deprecated and will be removed in expo_turbo-rails 0.5.0; " \
            "replace id_for(record, #{formatted_role}) with dom_id(record, #{formatted_role}); keep the #{formatted_role} prefix"
        else
          "ExpoTurbo::Rails::DomIds.id_for is deprecated and will be removed in expo_turbo-rails 0.5.0; " \
            "replace id_for(record, role) with dom_id(record, role); keep the non-:record prefix"
        end
      end
      private_class_method :deprecation_message
    end
  end
end
