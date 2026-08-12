# frozen_string_literal: true

require "spec_helper"
require "tempfile"

RSpec.describe "Expo Turbo child modes" do
  let(:capabilities) do
    ExpoTurbo::Rails::TemplateCapabilities.new(
      components: {
        "DemoCard" => {children: "nodes"},
        "DemoText" => {children: "text"},
        "DemoAction" => {children: "none"},
        "DemoLegacy" => {}
      }
    )
  end

  it "rejects bare text in a container that accepts elements only" do
    # On the device this text becomes an RCTRawText under a View: a nonfatal
    # RedBox in development and silent in production.
    expect { validate("<DemoCard>bare text</DemoCard>") }
      .to raise_error(ExpoTurbo::Rails::TemplateCapabilities::ValidationError, /bare text/)
    expect { validate("<DemoCard><DemoText>ok</DemoText>trailing</DemoCard>") }
      .to raise_error(ExpoTurbo::Rails::TemplateCapabilities::ValidationError, /bare text/)
    expect { validate("<DemoCard><![CDATA[  ]]></DemoCard>") }
      .to raise_error(ExpoTurbo::Rails::TemplateCapabilities::ValidationError, /bare text/)
    expect { validate('<DemoCard xml:space="preserve"> <DemoText/> </DemoCard>') }
      .to raise_error(ExpoTurbo::Rails::TemplateCapabilities::ValidationError, /bare text/)
  end

  it "admits layout whitespace and comments in a container that accepts elements" do
    expect { validate("<DemoCard>\n  <DemoText>ok</DemoText>\n  <!-- note -->\n</DemoCard>") }.not_to raise_error
    expect { validate("<DemoCard/>") }.not_to raise_error
    expect { validate('<DemoCard xml:space="preserve"><DemoText/></DemoCard>') }.not_to raise_error
  end

  it "rejects element children of a text component" do
    expect { validate("<DemoText><DemoCard/></DemoText>") }
      .to raise_error(ExpoTurbo::Rails::TemplateCapabilities::ValidationError, /text/)
    expect { validate("<DemoText>plain</DemoText>") }.not_to raise_error
  end

  it "rejects any child of a component that accepts none" do
    expect { validate("<DemoAction>text</DemoAction>") }
      .to raise_error(ExpoTurbo::Rails::TemplateCapabilities::ValidationError, /no children/)
    expect { validate("<DemoAction><DemoText/></DemoAction>") }
      .to raise_error(ExpoTurbo::Rails::TemplateCapabilities::ValidationError, /no children/)
    expect { validate("<DemoAction>\n</DemoAction>") }.not_to raise_error
    expect { validate("<DemoAction/>") }.not_to raise_error
  end

  it "leaves a component without a declared child mode unchecked" do
    expect { validate("<DemoLegacy>text<DemoText/></DemoLegacy>") }.not_to raise_error
  end

  it "rejects an unknown child mode in the host declaration" do
    expect {
      ExpoTurbo::Rails::TemplateCapabilities.new(components: {"DemoCard" => {children: "elements"}})
    }.to raise_error(ExpoTurbo::Rails::ConfigurationError, /children/)
  end

  it "keeps the child mode of a generated capability manifest" do
    from_manifest = manifest_capabilities(
      [
        {tag: "DemoCard", aliases: [], attributes: [], children: "nodes"},
        {tag: "DemoText", aliases: [], attributes: [], children: "text"}
      ]
    )
    invalid = ExpoTurbo::Rails::XmlFragments.parse_document("<DemoCard>bare</DemoCard>")
    valid = ExpoTurbo::Rails::XmlFragments.parse_document("<DemoCard><DemoText>ok</DemoText></DemoCard>")

    expect { from_manifest.validate_document!(invalid) }
      .to raise_error(ExpoTurbo::Rails::TemplateCapabilities::ValidationError)
    expect(from_manifest.validate_document!(valid)).to equal(valid)
  end

  it "rejects an invalid child mode in a capability manifest" do
    expect { manifest_capabilities([{tag: "DemoCard", aliases: [], attributes: [], children: "elements"}]) }
      .to raise_error(ExpoTurbo::Rails::ConfigurationError, /children/)
  end

  it "reads a manifest that predates the child mode without checking children" do
    from_manifest = manifest_capabilities([{tag: "DemoCard", aliases: [], attributes: []}])
    document = ExpoTurbo::Rails::XmlFragments.parse_document("<DemoCard>bare</DemoCard>")

    expect(from_manifest.validate_document!(document)).to equal(document)
  end

  def validate(xml)
    capabilities.validate_document!(ExpoTurbo::Rails::XmlFragments.parse_document(xml))
  end

  def manifest_capabilities(components)
    manifest = Tempfile.new(["expo-turbo-capabilities", ".json"])
    manifest.write(
      JSON.generate(
        manifestVersion: 1,
        protocolVersion: ExpoTurbo::Rails::PROTOCOL_VERSION,
        hash: "fnv1a32:1234abcd",
        modules: [{name: "demo", version: "1.2.3"}],
        components: components
      )
    )
    manifest.close
    ExpoTurbo::Rails::TemplateCapabilities.new(manifest: Pathname(manifest.path))
  end
end
