# frozen_string_literal: true

module ExpoTurbo
  module Rails
    # Shared test for "this render is an Expo Turbo render". Every standard
    # helper uses it to decide between Expo Turbo behavior and `super`, so one
    # rule answers documents, Frames, Streams, IDs, and fragment cache keys.
    #
    # The rule reads the format Rails selected for this render, never the
    # Accept header on its own. A browser may name the Expo Turbo media type at
    # a low quality; Rails then renders HTML, and a helper that disagreed with
    # that choice would break an ordinary web page.
    #
    # The selected format is not lookup_context.formats.first once a render is
    # underway. ActionView prepends the format of the template it found, so a
    # shared .html template answering a native request leaves :html there. The
    # controller records the selection instead; the lookup context answers only
    # for a view context Rails never assigned formats to, such as a broadcast.
    #
    # A Turbo Stream response is the one format both audiences share, because
    # its media type is the same for a browser and for a native client. There
    # the selected format cannot separate them, so a verified native request
    # decides.
    module Format
      module Helper
        private

        def expo_turbo_render?
          return false unless controller.respond_to?(:expo_turbo_request?)

          case expo_turbo_render_format
          when MIME_SYMBOL then true
          when TURBO_STREAM_MIME_SYMBOL then controller.expo_turbo_request?
          else false
          end
        end

        def expo_turbo_render_format
          selected = controller.expo_turbo_selected_format if controller.respond_to?(:expo_turbo_selected_format)
          selected || Array(lookup_context.formats).first
        end
      end
    end
  end
end
