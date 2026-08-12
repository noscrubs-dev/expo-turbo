# frozen_string_literal: true

require "fileutils"
require "tmpdir"

# Renders through ordinary Rails view lookup, exactly as a host does. The Expo
# Turbo format is what confines lookup, so the specs use real view paths and
# .expo_turbo.erb templates rather than a private view root.
module ExpoTurboSpecRendering
  def with_templates(controller_class, templates)
    Dir.mktmpdir do |directory|
      root = File.join(directory, "views")
      templates.each do |name, source|
        path = File.join(root, name)
        FileUtils.mkdir_p(File.dirname(path))
        File.write(path, source)
      end
      controller_class.prepend_view_path(root)
      yield
    end
  end

  # A view context whose request accepts Expo Turbo, so every standard helper
  # takes its Expo Turbo branch rather than calling `super`.
  def expo_turbo_view_context(controller_class, headers = {})
    controller = controller_class.new
    controller.request = ActionDispatch::TestRequest.create(
      {"HTTP_ACCEPT" => ExpoTurbo::Rails::MIME_TYPE}.merge(headers)
    )
    controller.response = ActionDispatch::TestResponse.new
    controller.view_context
  end

  def dispatch(controller_class, action = :show, headers: {})
    status, response_headers, body = controller_class.action(action).call(
      ActionDispatch::TestRequest.create(
        {"HTTP_ACCEPT" => ExpoTurbo::Rails::MIME_TYPE}.merge(headers)
      ).env
    )
    [status, response_headers, body.each.to_a.join]
  end
end
