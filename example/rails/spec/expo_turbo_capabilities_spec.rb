# frozen_string_literal: true

require "rails_helper"
require "expo_turbo/rails/testing"

RSpec.describe "demo capability declaration" do
  let(:capabilities) { ApplicationController.expo_turbo_template_capabilities_config }

  it "rejects bare text in a container that the demo registry renders as a View" do
    expect { validate("<Gallery>bare text</Gallery>") }
      .to raise_error(ExpoTurbo::Rails::TemplateCapabilities::ValidationError)
  end

  it "rejects an element inside a demo text component" do
    expect { validate("<Gallery><DemoText><DemoText>nested</DemoText></DemoText></Gallery>") }
      .to raise_error(ExpoTurbo::Rails::TemplateCapabilities::ValidationError)
  end

  it "rejects a child of a demo component that accepts none" do
    expect { validate('<Gallery><DemoStreamMorphProbe message="x">child</DemoStreamMorphProbe></Gallery>') }
      .to raise_error(ExpoTurbo::Rails::TemplateCapabilities::ValidationError)
  end

  it "admits the demo document shape" do
    expect { validate("<Gallery>\n  <DemoText>ready</DemoText>\n</Gallery>") }.not_to raise_error
  end

  def validate(xml)
    capabilities.validate_document!(ExpoTurbo::Rails::Testing.parse_document(xml))
  end
end
