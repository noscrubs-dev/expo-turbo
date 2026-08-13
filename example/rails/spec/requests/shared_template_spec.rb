# frozen_string_literal: true

require "rails_helper"
require "expo_turbo/rails/testing"

# The claim under test is narrow and checkable: one file on disk answers both
# audiences. Every assertion here names that file, and the last one reads it
# back to prove no second template exists to answer either request.
RSpec.describe "the shared greeting template" do
  let(:template) do
    Rails.root.join("app/views/api/expo_turbo/demo/shared_greetings/show.html.erb")
  end
  let(:body) { %(<turbo-frame id="demo-shared-greeting"><p id="demo-shared-greeting-text">One template, two audiences</p></turbo-frame>) }

  it "is the only template for the screen" do
    siblings = Dir.glob(File.join(File.dirname(template), "*"))

    expect(siblings).to contain_exactly(template.to_s)
  end

  it "answers a browser as HTML" do
    get "/api/expo_turbo/demo/shared_greeting", headers: {"Accept" => "text/html"}

    expect(response).to have_http_status(:ok)
    expect(response.media_type).to eq("text/html")
    expect(response.body.strip).to eq(body)
  end

  it "answers a native client as Expo Turbo XML" do
    get "/api/expo_turbo/demo/shared_greeting", headers: {"Accept" => ExpoTurbo::Rails::MIME_TYPE}

    expect(response).to have_http_status(:ok)
    expect(response.media_type).to eq(ExpoTurbo::Rails::MIME_TYPE)
    expect(response.charset).to eq("utf-8")
    expect(response.body.strip).to eq(body)
  end

  # The bodies being equal is the point: the divergence between the audiences
  # is the media type and the meaning of `p`, not the markup.
  it "sends the same bytes to both audiences" do
    get "/api/expo_turbo/demo/shared_greeting", headers: {"Accept" => "text/html"}
    html = response.body
    get "/api/expo_turbo/demo/shared_greeting", headers: {"Accept" => ExpoTurbo::Rails::MIME_TYPE}

    expect(response.body).to eq(html)
  end

  it "admits the native rendering as a protocol document" do
    get "/api/expo_turbo/demo/shared_greeting", headers: {"Accept" => ExpoTurbo::Rails::MIME_TYPE}

    document = ExpoTurbo::Rails::Testing.parse_document(response.body)
    text = document.at_xpath("//p[@id='demo-shared-greeting-text']")

    expect(document.root.name).to eq("turbo-frame")
    expect(text&.text).to eq("One template, two audiences")
    expect { ApplicationController.expo_turbo_template_capabilities_config.validate_document!(document) }
      .not_to raise_error
  end

  # `p` reaches DemoText only because ApplicationController declares the alias.
  # Without it the same bytes are an undeclared component and never ship.
  it "admits `p` only through the declared alias" do
    without_alias = ExpoTurbo::Rails::TemplateCapabilities.new(components: {"DemoText" => {children: "text"}})
    document = ExpoTurbo::Rails::Testing.parse_document(body)

    expect { without_alias.validate_document!(document) }
      .to raise_error(ExpoTurbo::Rails::TemplateCapabilities::ValidationError, /undeclared component/)
  end

  it "carries the cache dimensions that let both audiences share the URL" do
    get "/api/expo_turbo/demo/shared_greeting", headers: {"Accept" => ExpoTurbo::Rails::MIME_TYPE}

    vary = response.headers.fetch("Vary").split(",").map { |value| value.strip.downcase }

    expect(vary).to include("accept")
  end
end
