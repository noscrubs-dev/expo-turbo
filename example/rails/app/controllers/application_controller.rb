class ApplicationController < ActionController::API
  include ExpoTurbo::Rails::Controller

  expo_turbo_view_root Rails.root.join("app/views/expo_turbo")
  # Each child mode mirrors the demo client registry in
  # example/expo/src/demo-registry.tsx. The server rejects a child that the
  # native decoder cannot render before the response leaves the host.
  expo_turbo_template_capabilities(
    components: {
      "DemoForm" => {children: "nodes"},
      "DemoDocumentLink" => {children: "nodes"},
      "DemoFormCheckbox" => {children: "none"},
      "DemoFormFile" => {children: "none"},
      "DemoFormInput" => {children: "none"},
      "DemoFormPlanSelect" => {children: "none"},
      "DemoFormSubmitter" => {children: "none"},
      "DemoStreamMorphProbe" => {children: "none"},
      "Gallery" => {children: "nodes"},
      "DemoText" => {children: "text"}
    }
  )
end
