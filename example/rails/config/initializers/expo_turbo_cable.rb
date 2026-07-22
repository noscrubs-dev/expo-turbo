# frozen_string_literal: true

Rails.application.config.to_prepare do
  ExpoTurbo::Rails::Cable.configure(
    credential_extractor: ->(connection) { connection.expo_turbo_request.headers[ExpoTurboDemo::NativeCableTicket::HEADER] },
    subject_resolver: ->(ticket) { ExpoTurboDemo::NativeCableTicket.subject_for(ticket) },
    subscription_authorizer: ->(**arguments) { ExpoTurboDemo::NativeCableTicket.authorizes?(**arguments) },
    subscription_error_reporter: ->(**) {}
  )
end
