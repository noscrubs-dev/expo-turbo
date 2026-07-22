# frozen_string_literal: true

module ExpoTurboDemo
  module NativeCableTicket
    HEADER = "X-Expo-Turbo-Demo-Ticket"
    GRANT = "demo-protected-frame"
    SUBJECT = "demo-native-subject"
    STREAM = "demo-protected-stream"
    TTL = 5.minutes
    VERIFIER_NAME = "expo_turbo/demo_native_cable_ticket"
    VERIFIER_PURPOSE = "expo_turbo.demo_native_cable_ticket"

    class << self
      def issue
        verifier.generate(SUBJECT, expires_in: TTL, purpose: VERIFIER_PURPOSE)
      end

      def subject_for(ticket)
        return unless ticket.is_a?(String)

        ticket = ticket.dup.force_encoding(Encoding::UTF_8)
        return unless ticket.valid_encoding? && ticket.present?

        subject = verifier.verified(ticket, purpose: VERIFIER_PURPOSE)
        subject if subject == SUBJECT
      end

      def authorizes?(subject:, stream_name:, grant:)
        subject == SUBJECT && stream_name == ExpoTurbo::Rails::Streams.stream_name_for(STREAM) && grant == GRANT
      end

      private

      def verifier
        Rails.application.message_verifier(VERIFIER_NAME)
      end
    end
  end
end
