# frozen_string_literal: true

module ExpoTurbo
  module Rails
    # Shared test for "this render is an Expo Turbo render". Every standard
    # helper uses it to decide between Expo Turbo behavior and `super`, so one
    # rule answers documents, Frames, Streams, IDs, and fragment cache keys.
    module Format
      module Helper
        private

        def expo_turbo_render?
          return false unless controller.respond_to?(:expo_turbo_request?)

          Array(lookup_context.formats).first == MIME_SYMBOL || controller.expo_turbo_request?
        end
      end
    end
  end
end
