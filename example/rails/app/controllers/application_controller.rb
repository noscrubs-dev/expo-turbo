class ApplicationController < ActionController::API
  # The Engine installs the concern, so no include is written here.
  #
  # Each child mode mirrors the demo client registry in
  # example/expo/src/demo-registry.tsx. The server rejects a child that the
  # native decoder cannot render before the response leaves the host.
  #
  # DemoText also answers to `p`, so one template can spell it as the HTML
  # element a browser understands. The demo client registry declares the same
  # alias, so the shared greeting screen renders on the device from the same
  # bytes a browser reads as a paragraph. Both sides have to declare it: the
  # server admitting a name the client cannot resolve fails only on the device.
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
      "DemoText" => {aliases: ["p"], children: "text"}
    }
  )
end
