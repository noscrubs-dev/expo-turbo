Rails.application.routes.draw do
  # Define your application routes per the DSL in https://guides.rubyonrails.org/routing.html

  # Reveal health status on /up that returns 200 if the app boots with no exceptions, otherwise 500.
  # Can be used by load balancers and uptime monitors to verify that the app is live.
  get "up", to: "rails/health#show", as: :rails_health_check

  namespace :api do
    namespace :expo_turbo do
      namespace :demo do
        resource :document, only: :show, defaults: {format: :expo_turbo}
        resource :protected_document, only: :show, defaults: {format: :expo_turbo}
        resource :refresh_morph_document, only: :show, defaults: {format: :expo_turbo}
        resource :frame, only: :show, defaults: {format: :expo_turbo}
        resource :protected_frame, only: :show, defaults: {format: :expo_turbo}
        resource :form, only: %i[show create], defaults: {format: :expo_turbo}
        get "morph/outer", to: "morph_frames#outer", defaults: {format: :expo_turbo}
        get "morph/inner", to: "morph_frames#inner", defaults: {format: :expo_turbo}
        get "response_scenarios/:scenario", to: "response_scenarios#show", defaults: {format: :expo_turbo}
        resource :stream, only: :show, defaults: {format: :turbo_stream}
        resource :protected_ticket, only: :show
        resource :protected_revocation, only: :create if Rails.env.local?
        resource :broadcast, only: :create if Rails.env.local?
        resource :protected_broadcast, only: :create if Rails.env.local?
      end
    end
  end
end
