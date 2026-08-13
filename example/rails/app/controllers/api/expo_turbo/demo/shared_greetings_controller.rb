module Api
  module ExpoTurbo
    module Demo
      # The one demo screen with a single template. Its route forces no format,
      # so the Accept header decides: a browser gets text/html and a native
      # client gets application/vnd.expo-turbo+xml, from the same file. The
      # action renders implicitly, because the template exists.
      class SharedGreetingsController < ApplicationController
        def show
          @greeting = "One template, two audiences"
        end
      end
    end
  end
end
