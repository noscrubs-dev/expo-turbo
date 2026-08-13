class ApplicationController < ActionController::API
  # The Engine installs the concern, so no include is written here.
  #
  # Each child mode mirrors the demo client registry in
  # example/expo/src/demo-registry.tsx. The server rejects a child that the
  # native decoder cannot render before the response leaves the host.
  expo_turbo_template_capabilities(
    lockfile: Rails.root.join("../..", "expo-turbo.lock.json"),
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
