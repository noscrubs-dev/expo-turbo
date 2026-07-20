# frozen_string_literal: true

require "action_view/record_identifier"

module ExpoTurbo
  module Rails
    module DomIds
      ROLE_PREFIXES = {
        record: nil,
        document: :document,
        frame: :frame,
        list: :list,
        form: :form,
        error: :error,
        loading: :loading
      }.freeze

      module_function

      def id_for(record_or_class, role = :record)
        prefix = ROLE_PREFIXES.fetch(role) do
          raise ArgumentError, "unsupported Expo Turbo target role: #{role.inspect}"
        end

        if record_or_class.is_a?(Class)
          raise ArgumentError, "only list targets may be derived from a model class" unless role == :list
          raise ArgumentError, "Expo Turbo list targets require a model class" unless record_or_class.respond_to?(:model_name)

          return validate!(ActionView::RecordIdentifier.dom_id(record_or_class, prefix))
        end

        model = record_or_class.respond_to?(:to_model) ? record_or_class.to_model : record_or_class
        unless model&.respond_to?(:to_key) && model.respond_to?(:persisted?) && model.persisted?
          raise ArgumentError, "Expo Turbo #{role} targets require a persisted model"
        end
        raise ArgumentError, "Expo Turbo #{role} targets require a persisted model" unless complete_key?(model.to_key)
        raise ArgumentError, "Expo Turbo #{role} targets require a model name" unless model.respond_to?(:model_name)

        validate!(ActionView::RecordIdentifier.dom_id(model, prefix))
      end

      def complete_key?(key)
        key.is_a?(Array) && key.any? && key.all? { |value| value && !value.to_s.empty? }
      end
      private_class_method :complete_key?

      def validate!(id)
        Frames.validate_id!(id, label: "target")
        id.freeze
      end
      private_class_method :validate!
    end
  end
end
