# frozen_string_literal: true

module ExpoTurbo
  module Rails
    module Cable
      module Connection
        def expo_turbo_request
          request
        end

        def expo_turbo_subject
          return @expo_turbo_subject if defined?(@expo_turbo_subject_resolved)

          @expo_turbo_subject = ExpoTurbo::Rails::Cable.resolve_subject(self)
          @expo_turbo_subject_resolved = true
          @expo_turbo_subject
        end
      end
    end
  end
end
