# frozen_string_literal: true

module ExpoTurbo
  module Rails
    module DomIds
      module Helper
        include Format::Helper

        # Rails' own dom_id. For an Expo Turbo render the prefix names a shared
        # target role, and every record role requires a persisted record with a
        # complete key, so an unsaved record cannot collapse into a shared
        # new_* target.
        def dom_id(record_or_class, prefix = nil)
          return super unless expo_turbo_render?

          DomIds.id_for(record_or_class, prefix.nil? ? :record : prefix.to_sym)
        end
      end
    end
  end
end
