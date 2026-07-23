# frozen_string_literal: true

module ApplicationCable
  class Connection < ActionCable::Connection::Base
    include ExpoTurbo::Rails::Cable::Connection

    identified_by :expo_turbo_demo_subject

    def connect
      self.expo_turbo_demo_subject = expo_turbo_subject
    end
  end
end
