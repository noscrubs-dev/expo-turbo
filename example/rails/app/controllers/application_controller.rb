class ApplicationController < ActionController::API
  # The Engine installs the concern, so no include is written here.
  #
  # Each child mode mirrors the demo client registry in
  # example/expo/src/demo-registry.tsx. The server rejects a child that the
  # native decoder cannot render before the response leaves the host.
  #
  # DemoText also answers to `p`, so one template can spell it as the HTML
  # element a browser understands. The demo client registry does not declare
  # that alias yet, so the shared greeting screen is admitted and served by
  # this host but is not yet renderable on the device; `aliases: ["p"]` on the
  # registry's text component is what closes that.
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
      "DemoText" => {aliases: ["p"], children: "text"}
    }
  )
end
