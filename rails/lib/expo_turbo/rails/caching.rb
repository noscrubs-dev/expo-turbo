# frozen_string_literal: true

module ExpoTurbo
  module Rails
    module Caching
      # Vary protects a shared HTTP cache. It does not protect Rails.cache: a
      # fragment gated on a module version, or rendered for one Frame, can be
      # read back for a different client. This helper folds the same vocabulary
      # identity into every fragment key of an Expo Turbo render, and leaves
      # HTML fragment keys unchanged.
      module Helper
        def cache_fragment_name(name = {}, skip_digest: nil, digest_path: nil)
          return super unless expo_turbo_fragment_identity?

          super([name, *controller.expo_turbo_cache_variant], skip_digest:, digest_path:)
        end

        private

        def expo_turbo_fragment_identity?
          return false unless controller.respond_to?(:expo_turbo_cache_variant)

          controller.expo_turbo_request? || Array(lookup_context.formats).first == MIME_SYMBOL
        end
      end
    end
  end
end
