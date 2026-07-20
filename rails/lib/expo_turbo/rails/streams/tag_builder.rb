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
        REQUEST_ID_ATTRIBUTE_KEYS = [:"request-id", "request-id"].freeze
        REQUEST_ID_UNSET = Object.new.freeze

        class XmlRenderableContext < BasicObject
          def initialize(view_context, partial_renderer)
            @view_context = view_context
            @partial_renderer = partial_renderer
          end

          def render(partial: nil, locals: {}, **options, &block)
            if partial.nil? || !locals.is_a?(::Hash) || options.any? || block
              ::Kernel.raise ::ExpoTurbo::Rails::TemplateError,
                "Expo Turbo renderables may render only configured XML partials"
            end

            @partial_renderer.call(partial, locals)
          end

          def capture(*arguments, &block)
            @view_context.capture(*arguments, &block)
          end
        end
        private_constant :XmlRenderableContext

        def initialize(view_context, partial_resolver:)
          @view_context = view_context
          @partial_resolver = partial_resolver
        end

        def append(target, content = nil, partial: nil, layout: nil, locals: {}, **attributes, &)
          target_action(:append, target, content, partial:, layout:, locals:, attributes:, &)
        end

        def append_all(targets, content = nil, partial: nil, layout: nil, locals: {}, **attributes, &)
          targets_action(:append, targets, content, partial:, layout:, locals:, attributes:, &)
        end

        def prepend(target, content = nil, partial: nil, layout: nil, locals: {}, **attributes, &)
          target_action(:prepend, target, content, partial:, layout:, locals:, attributes:, &)
        end

        def prepend_all(targets, content = nil, partial: nil, layout: nil, locals: {}, **attributes, &)
          targets_action(:prepend, targets, content, partial:, layout:, locals:, attributes:, &)
        end

        def before(target, content = nil, partial: nil, layout: nil, locals: {}, **attributes, &)
          target_action(:before, target, content, partial:, layout:, locals:, attributes:, &)
        end

        def before_all(targets, content = nil, partial: nil, layout: nil, locals: {}, **attributes, &)
          targets_action(:before, targets, content, partial:, layout:, locals:, attributes:, &)
        end

        def after(target, content = nil, partial: nil, layout: nil, locals: {}, **attributes, &)
          target_action(:after, target, content, partial:, layout:, locals:, attributes:, &)
        end

        def after_all(targets, content = nil, partial: nil, layout: nil, locals: {}, **attributes, &)
          targets_action(:after, targets, content, partial:, layout:, locals:, attributes:, &)
        end

        def replace(target, content = nil, method: nil, partial: nil, layout: nil, locals: {}, **attributes, &)
          target_action(:replace, target, content, method:, partial:, layout:, locals:, attributes:, &)
        end

        def replace_all(targets, content = nil, method: nil, partial: nil, layout: nil, locals: {}, **attributes, &)
          targets_action(:replace, targets, content, method:, partial:, layout:, locals:, attributes:, &)
        end

        def update(target, content = nil, method: nil, partial: nil, layout: nil, locals: {}, **attributes, &)
          target_action(:update, target, content, method:, partial:, layout:, locals:, attributes:, &)
        end

        def update_all(targets, content = nil, method: nil, partial: nil, layout: nil, locals: {}, **attributes, &)
          targets_action(:update, targets, content, method:, partial:, layout:, locals:, attributes:, &)
        end

        def remove(target, layout: nil, **attributes)
          reject_content!(attributes)
          reject_layout!(layout)
          target_action(:remove, target, nil, partial: nil, locals: {}, attributes:)
        end

        def remove_all(targets, layout: nil, **attributes)
          reject_content!(attributes)
          reject_layout!(layout)
          targets_action(:remove, targets, nil, partial: nil, locals: {}, attributes:)
        end

        def refresh(request_id: REQUEST_ID_UNSET, layout: nil, **attributes)
          reject_content!(attributes)
          reject_request_id!(attributes)
          reject_layout!(layout)

          if request_id.equal?(REQUEST_ID_UNSET)
            validate_stream_fragment!(turbo_stream_refresh_tag(**attributes))
          elsif request_id.nil?
            validate_stream_fragment!(turbo_stream_action_tag(:refresh, **attributes))
          else
            validate_stream_fragment!(turbo_stream_refresh_tag(request_id:, **attributes))
          end
        end

        private

        def target_action(action, target, content, partial:, locals:, attributes:, method: nil, layout: nil, &block)
          ensure_present!(target, :target)
          validate_stream_fragment!(
            turbo_stream_action_tag(
              action,
              target: target,
              template: template_for(action, target, content_from_attributes(content, attributes), partial:, layout:, locals:, &block),
              method: method,
              **attributes
            )
          )
        end

        def targets_action(action, targets, content, partial:, locals:, attributes:, method: nil, layout: nil, &block)
          ensure_present!(targets, :targets)
          validate_stream_fragment!(
            turbo_stream_action_tag(
              action,
              targets: targets,
              template: template_for(action, nil, content_from_attributes(content, attributes), partial:, layout:, locals:, &block),
              method: method,
              **attributes
            )
          )
        end

        def template_for(action, target, content, partial:, layout:, locals:, &block)
          return if action == :remove

          raise ArgumentError, "layout requires a block" if layout && !block
          if layout && (partial || !content.nil?)
            raise ArgumentError, "provide a layout with a block, not content or a partial"
          end
          if (!content.nil? && (partial || block)) || (partial && block)
            raise ArgumentError, "provide content, a block, or a partial, not more than one"
          end

          if partial
            render_xml_partial(partial, locals)
          elsif layout
            render_xml_layout(layout, locals, &block)
          elsif block
            @view_context.capture(&block)
          elsif content.respond_to?(:render_in)
            render_renderable(content)
          elsif !content.nil?
            render_record(content) || content.to_s
          else
            render_record(target).to_s
          end
        end

        def render_xml_partial(partial, locals)
          @view_context.render(
            inline: File.read(@partial_resolver.call(partial)),
            type: :erb,
            formats: [:xml],
            layout: false,
            locals: locals
          )
        end

        def render_xml_layout(layout, locals, &block)
          template = ActionView::Template::Inline.new(
            File.read(@partial_resolver.call(layout)),
            "expo_turbo/#{layout}.xml.erb",
            ActionView::Template.handler_for_extension(:erb),
            locals: locals.keys,
            format: :xml
          )

          template.render(@view_context, locals, &block)
        end

        def render_record(record)
          model = record.respond_to?(:to_model) ? record.to_model : record
          return unless model.respond_to?(:to_partial_path)

          partial = model.to_partial_path
          local_name = File.basename(partial.to_s).delete_prefix("_").to_sym
          render_xml_partial(partial, {local_name => record})
        end

        def render_renderable(renderable)
          format = renderable.format if renderable.respond_to?(:format)
          unless format.respond_to?(:to_sym) && format.to_sym == :xml
            raise ArgumentError, "Expo Turbo renderables must declare format: :xml"
          end

          context = XmlRenderableContext.new(@view_context, method(:render_xml_partial))
          renderable.render_in(context)
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

        def reject_request_id!(attributes)
          return unless REQUEST_ID_ATTRIBUTE_KEYS.any? { |key| attributes.key?(key) }

          raise ArgumentError, "request_id must be provided with request_id:"
        end

        def reject_layout!(layout)
          return if layout.nil?

          raise ArgumentError, "layout is only supported by template-bearing Stream actions"
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
