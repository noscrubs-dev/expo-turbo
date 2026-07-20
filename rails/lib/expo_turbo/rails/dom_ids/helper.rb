# frozen_string_literal: true

module ExpoTurbo
  module Rails
    module DomIds
      module Helper
        def expo_turbo_dom_id(record_or_class, role = :record)
          DomIds.id_for(record_or_class, role)
        end
      end
    end
  end
end
