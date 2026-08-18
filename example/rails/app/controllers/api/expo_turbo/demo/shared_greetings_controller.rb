module Api
  module ExpoTurbo
    module Demo
      # The one demo screen with a single template. Its route forces no format,
      # so the Accept header decides: a browser gets text/html and a native
      # client gets application/vnd.expo-turbo+xml, from the same file. The
      # action renders implicitly, because the template exists.
      class SharedGreetingsController < ApplicationController
        class Greeting
          ModelName = Struct.new(:param_key)

          def self.model_name
            @model_name ||= ModelName.new("demo_shared_greeting")
          end

          def to_key = [7]
          def to_model = self
          def persisted? = true
          def model_name = self.class.model_name
        end

        def show
          @greeting = Greeting.new
        end
      end
    end
  end
end
