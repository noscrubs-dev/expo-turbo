# frozen_string_literal: true

module ApplicationCable
  class Connection < ActionCable::Connection::Base
    include ExpoTurbo::Rails::Cable::Connection
  end
end
