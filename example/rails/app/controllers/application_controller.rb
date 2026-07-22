class ApplicationController < ActionController::API
  include ExpoTurbo::Rails::Controller

  expo_turbo_view_root Rails.root.join("app/views/expo_turbo")
  expo_turbo_template_capabilities(
    components: {
      "DemoForm" => {},
      "DemoDocumentLink" => {},
      "DemoFormCheckbox" => {},
      "DemoFormFile" => {},
      "DemoFormInput" => {},
      "DemoFormPlanSelect" => {},
      "DemoFormSubmitter" => {},
      "DemoStreamMorphProbe" => {},
      "Gallery" => {},
      "DemoText" => {}
    }
  )
end
