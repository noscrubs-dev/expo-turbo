# frozen_string_literal: true

require "action_controller/api"
require "fileutils"
require "tmpdir"
require "spec_helper"

RSpec.describe ExpoTurbo::Rails::Controller do
  let(:controller_class) do
    Class.new(ActionController::API) do
      include ExpoTurbo::Rails::Controller
    end
  end

  it "confines templates to the configured host view root" do
    Dir.mktmpdir do |directory|
      root = File.join(directory, "expo_turbo")
      outside = File.join(directory, "outside.xml.erb")
      FileUtils.mkdir_p(root)
      File.write(outside, "<Outside />")

      controller_class.expo_turbo_view_root(root)
      controller = controller_class.new

      expect { controller.send(:expo_turbo_template_file, "../outside") }
        .to raise_error(ExpoTurbo::Rails::TemplateError, /outside the configured view root/)
    end
  end
end
