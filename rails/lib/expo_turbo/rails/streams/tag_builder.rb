# frozen_string_literal: true

unless defined?(::Turbo::Streams::ActionHelper)
  raise ExpoTurbo::Rails::ConfigurationError, "initialize Rails before using Expo Turbo Stream helpers"
end

module ExpoTurbo
  module Rails
    module Streams
      class TagBuilder
        include ::Turbo::Streams::ActionHelper

        def initialize(view_context, partial_resolver:)
          @view_context = view_context
          @partial_resolver = partial_resolver
        end

        def append(target, content = nil, partial: nil, locals: {}, **attributes, &)
          target_action(:append, target, content, partial:, locals:, attributes:, &)
        end

        def append_all(targets, content = nil, partial: nil, locals: {}, **attributes, &)
          targets_action(:append, targets, content, partial:, locals:, attributes:, &)
        end

        def prepend(target, content = nil, partial: nil, locals: {}, **attributes, &)
          target_action(:prepend, target, content, partial:, locals:, attributes:, &)
        end

        def prepend_all(targets, content = nil, partial: nil, locals: {}, **attributes, &)
          targets_action(:prepend, targets, content, partial:, locals:, attributes:, &)
        end

        def before(target, content = nil, partial: nil, locals: {}, **attributes, &)
          target_action(:before, target, content, partial:, locals:, attributes:, &)
        end

        def before_all(targets, content = nil, partial: nil, locals: {}, **attributes, &)
          targets_action(:before, targets, content, partial:, locals:, attributes:, &)
        end

        def after(target, content = nil, partial: nil, locals: {}, **attributes, &)
          target_action(:after, target, content, partial:, locals:, attributes:, &)
        end

        def after_all(targets, content = nil, partial: nil, locals: {}, **attributes, &)
          targets_action(:after, targets, content, partial:, locals:, attributes:, &)
        end

        def replace(target, content = nil, method: nil, partial: nil, locals: {}, **attributes, &)
          target_action(:replace, target, content, method:, partial:, locals:, attributes:, &)
        end

        def replace_all(targets, content = nil, method: nil, partial: nil, locals: {}, **attributes, &)
          targets_action(:replace, targets, content, method:, partial:, locals:, attributes:, &)
        end

        def update(target, content = nil, method: nil, partial: nil, locals: {}, **attributes, &)
          target_action(:update, target, content, method:, partial:, locals:, attributes:, &)
        end

        def update_all(targets, content = nil, method: nil, partial: nil, locals: {}, **attributes, &)
          targets_action(:update, targets, content, method:, partial:, locals:, attributes:, &)
        end

        def remove(target, **attributes)
          target_action(:remove, target, nil, partial: nil, locals: {}, attributes:)
        end

        def remove_all(targets, **attributes)
          targets_action(:remove, targets, nil, partial: nil, locals: {}, attributes:)
        end

        def refresh(request_id: nil, **attributes)
          if request_id.nil?
            turbo_stream_refresh_tag(**attributes)
          else
            turbo_stream_refresh_tag(request_id:, **attributes)
          end
        end

        private

        def target_action(action, target, content, partial:, locals:, attributes:, method: nil, &block)
          ensure_present!(target, :target)
          turbo_stream_action_tag(
            action,
            target: target,
            template: template_for(action, content, partial:, locals:, &block),
            method: method,
            **attributes
          )
        end

        def targets_action(action, targets, content, partial:, locals:, attributes:, method: nil, &block)
          ensure_present!(targets, :targets)
          turbo_stream_action_tag(
            action,
            targets: targets,
            template: template_for(action, content, partial:, locals:, &block),
            method: method,
            **attributes
          )
        end

        def template_for(action, content, partial:, locals:, &block)
          return if action == :remove

          if partial && (!content.nil? || block)
            raise ArgumentError, "provide content, a block, or a partial, not more than one"
          end

          if partial
            @view_context.render(
              inline: File.read(@partial_resolver.call(partial)),
              type: :erb,
              formats: [:xml],
              layout: false,
              locals: locals
            )
          elsif block
            @view_context.capture(&block)
          else
            content.to_s
          end
        end

        def ensure_present!(value, name)
          raise ArgumentError, "#{name} must be present" if value.blank?
        end
      end
    end
  end
end
