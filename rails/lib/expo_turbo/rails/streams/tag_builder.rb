# frozen_string_literal: true

unless defined?(::Turbo::Streams::ActionHelper)
  raise ExpoTurbo::Rails::ConfigurationError, "initialize Rails before using Expo Turbo Stream helpers"
end

module ExpoTurbo
  module Rails
    module Streams
      class TagBuilder
        include ::Turbo::Streams::ActionHelper

        CONTENT_ATTRIBUTE_KEYS = [:content, "content"].freeze

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
          reject_content!(attributes)
          target_action(:remove, target, nil, partial: nil, locals: {}, attributes:)
        end

        def remove_all(targets, **attributes)
          reject_content!(attributes)
          targets_action(:remove, targets, nil, partial: nil, locals: {}, attributes:)
        end

        def refresh(request_id: nil, **attributes)
          reject_content!(attributes)

          if request_id.nil?
            validate_stream_fragment!(turbo_stream_refresh_tag(**attributes))
          else
            validate_stream_fragment!(turbo_stream_refresh_tag(request_id:, **attributes))
          end
        end

        private

        def target_action(action, target, content, partial:, locals:, attributes:, method: nil, &block)
          ensure_present!(target, :target)
          validate_stream_fragment!(
            turbo_stream_action_tag(
              action,
              target: target,
              template: template_for(action, content_from_attributes(content, attributes), partial:, locals:, &block),
              method: method,
              **attributes
            )
          )
        end

        def targets_action(action, targets, content, partial:, locals:, attributes:, method: nil, &block)
          ensure_present!(targets, :targets)
          validate_stream_fragment!(
            turbo_stream_action_tag(
              action,
              targets: targets,
              template: template_for(action, content_from_attributes(content, attributes), partial:, locals:, &block),
              method: method,
              **attributes
            )
          )
        end

        def template_for(action, content, partial:, locals:, &block)
          return if action == :remove

          if (!content.nil? && (partial || block)) || (partial && block)
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

        def content_from_attributes(content, attributes)
          content_key = content_attribute_key(attributes)
          return content unless content_key

          raise ArgumentError, "provide positional content or keyword content, not both" unless content.nil?

          attributes.delete(content_key)
        end

        def reject_content!(attributes)
          return unless content_attribute_key(attributes)

          raise ArgumentError, "content is only supported by template-bearing Stream actions"
        end

        def content_attribute_key(attributes)
          keys = CONTENT_ATTRIBUTE_KEYS.select { |key| attributes.key?(key) }
          return if keys.empty?

          raise ArgumentError, "provide keyword content once" if keys.length > 1

          keys.first
        end

        def ensure_present!(value, name)
          raise ArgumentError, "#{name} must be present" if value.blank?
        end

        def validate_stream_fragment!(stream)
          XmlFragments.parse_stream_fragment(stream.to_s)
          stream
        rescue XmlFragments::ParseError
          raise TemplateError, "Expo Turbo Stream output must be well-formed UTF-8 XML without DTDs or processing instructions"
        end
      end
    end
  end
end
