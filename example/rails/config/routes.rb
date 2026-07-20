Rails.application.routes.draw do
  # Define your application routes per the DSL in https://guides.rubyonrails.org/routing.html

  # Reveal health status on /up that returns 200 if the app boots with no exceptions, otherwise 500.
  # Can be used by load balancers and uptime monitors to verify that the app is live.
  get "up", to: "rails/health#show", as: :rails_health_check

  namespace :api do
    namespace :expo_turbo do
      namespace :demo do
        resource :document, only: :show, defaults: {format: :expo_turbo}
        resource :stream, only: :show, defaults: {format: :turbo_stream}
      end
    end
  end
end
