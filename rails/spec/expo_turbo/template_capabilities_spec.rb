# frozen_string_literal: true

require "spec_helper"
require "tempfile"

RSpec.describe ExpoTurbo::Rails::TemplateCapabilities do
  let(:capabilities) do
    described_class.new(
      components: {
        "Demo:Screen" => {},
        "DemoCard" => {aliases: ["Card"], style_tokens: true},
        "DemoText" => {}
      },
      style_tokens: {
        "layout:row" => {components: ["Card"], group: "layout"},
        "space:compact" => {components: ["Card"], group: "space"},
        "tone:info" => {components: ["Card"], group: "tone"},
        "tone:warning" => {components: ["Card"], group: "tone"}
      },
      max_style_tokens: 2
    )
  end

  it "rejects conflicting component and style declarations" do
    expect {
      described_class.new(components: {"DemoCard" => {aliases: ["Card"]}, "Card" => {}})
    }.to raise_error(ExpoTurbo::Rails::ConfigurationError, /declared more than once/)
    expect {
      described_class.new(components: {"expo-turbo-fragment" => {}})
    }.to raise_error(ExpoTurbo::Rails::ConfigurationError, /reserved/)
    expect {
      described_class.new(
        components: {"DemoCard" => {}},
        style_tokens: {"tone:info" => {components: ["Missing"]}}
      )
    }.to raise_error(ExpoTurbo::Rails::ConfigurationError, /undeclared component/)
    expect {
      described_class.new(
        components: {"DemoCard" => {}},
        style_tokens: {"tone:info" => {components: ["DemoCard"]}}
      )
    }.to raise_error(ExpoTurbo::Rails::ConfigurationError, /without style_tokens enabled/)
    expect {
      described_class.new(components: {}, max_style_tokens: 0)
    }.to raise_error(ExpoTurbo::Rails::ConfigurationError, /positive style token limit/)
  end

  it "loads the client registry capability manifest as the component source of truth" do
    manifest = Tempfile.new(["expo-turbo-capabilities", ".json"])
    manifest.write(
      JSON.generate(
        {
          manifestVersion: 1,
          protocolVersion: ExpoTurbo::Rails::PROTOCOL_VERSION,
          hash: "fnv1a32:1234abcd",
          modules: [{name: "demo", version: "1.2.3"}],
          components: [
            {
              tag: "DemoCard",
              aliases: ["Card"],
              attributes: [
                {name: "title", required: true},
                {name: "style-tokens", required: false}
              ]
            },
            {
              tag: "DemoText",
              aliases: [],
              attributes: [{name: "value"}],
              formOwner: false
            },
            {
              tag: "DemoForm",
              aliases: ["Form"],
              attributes: [],
              formOwner: true
            }
          ]
        }
      )
    )
    manifest.close
    from_manifest = described_class.new(
      manifest: Pathname(manifest.path),
      style_tokens: {"tone:info" => {components: ["Card"]}}
    )
    valid = ExpoTurbo::Rails::XmlFragments.parse_document(
      '<Card title="Status" style-tokens="tone:info" id="status" data-state="ready" xml:space="preserve"><DemoText/></Card>'
    )
    undeclared_attribute = ExpoTurbo::Rails::XmlFragments.parse_document(
      '<Card title="Status" surprise="value"/>'
    )
    missing_required_attribute = ExpoTurbo::Rails::XmlFragments.parse_document("<Card/>")
    valid_form = ExpoTurbo::Rails::XmlFragments.parse_document(
      '<Form action="/plans" enctype="multipart/form-data" method="post" novalidate="" target="_top"/>'
    )
    non_form_owner = ExpoTurbo::Rails::XmlFragments.parse_document(
      '<DemoText action="/plans"/>'
    )
    unknown = ExpoTurbo::Rails::XmlFragments.parse_document("<PrivateComponent/>")

    expect(from_manifest.validate_document!(valid)).to equal(valid)
    expect(from_manifest.validate_document!(valid_form)).to equal(valid_form)
    expect { from_manifest.validate_document!(undeclared_attribute) }
      .to raise_error(described_class::ValidationError, /undeclared component attribute/)
    expect { from_manifest.validate_document!(non_form_owner) }
      .to raise_error(described_class::ValidationError, /undeclared component attribute/)
    expect { from_manifest.validate_document!(missing_required_attribute) }
      .to raise_error(described_class::ValidationError, /required component attribute/)
    expect { from_manifest.validate_document!(unknown) }
      .to raise_error(described_class::ValidationError, /undeclared component/)
  ensure
    manifest&.unlink
  end

  it "loads the new sha256 vocabulary digest before clients start sending it" do
    manifest = Tempfile.new(["expo-turbo-capabilities", ".json"])
    manifest.write(
      JSON.generate(
        {
          manifestVersion: 2,
          protocolVersion: ExpoTurbo::Rails::PROTOCOL_VERSION,
          hash: "sha256-128:0123456789abcdef0123456789abcdef",
          modules: [{name: "expo-turbo-example"}],
          components: [{tag: "DemoCard", aliases: [], attributes: []}]
        }
      )
    )
    manifest.close

    expect { described_class.new(manifest: manifest.path) }.not_to raise_error
  ensure
    manifest&.unlink
  end

  it "rejects absent, conflicting, unreadable, and malformed capability manifests" do
    expect { described_class.new }
      .to raise_error(ExpoTurbo::Rails::ConfigurationError, /exactly one/)
    expect { described_class.new(components: {}, manifest: "capabilities.json") }
      .to raise_error(ExpoTurbo::Rails::ConfigurationError, /exactly one/)
    expect { described_class.new(manifest: "missing-capabilities.json") }
      .to raise_error(ExpoTurbo::Rails::ConfigurationError, /could not be read/)

    manifest = Tempfile.new(["expo-turbo-capabilities", ".json"])
    manifest.write('{"manifestVersion":1')
    manifest.close

    expect { described_class.new(manifest: manifest.path) }
      .to raise_error(ExpoTurbo::Rails::ConfigurationError, /valid JSON/)

    invalid_required = Tempfile.new(["expo-turbo-capabilities", ".json"])
    invalid_required.write(
      JSON.generate(
        {
          manifestVersion: 1,
          protocolVersion: ExpoTurbo::Rails::PROTOCOL_VERSION,
          hash: "fnv1a32:1234abcd",
          modules: [],
          components: [
            {tag: "DemoCard", aliases: [], attributes: [{name: "title", required: "yes"}]}
          ]
        }
      )
    )
    invalid_required.close

    expect { described_class.new(manifest: invalid_required.path) }
      .to raise_error(ExpoTurbo::Rails::ConfigurationError, /attribute names/)

    invalid_form_owner = Tempfile.new(["expo-turbo-capabilities", ".json"])
    invalid_form_owner.write(
      JSON.generate(
        {
          manifestVersion: 1,
          protocolVersion: ExpoTurbo::Rails::PROTOCOL_VERSION,
          hash: "fnv1a32:1234abcd",
          modules: [],
          components: [
            {tag: "DemoForm", aliases: [], attributes: [], formOwner: "yes"}
          ]
        }
      )
    )
    invalid_form_owner.close

    expect { described_class.new(manifest: invalid_form_owner.path) }
      .to raise_error(ExpoTurbo::Rails::ConfigurationError, /form ownership must be boolean/)
  ensure
    manifest&.unlink
    invalid_required&.unlink
    invalid_form_owner&.unlink
  end

  it "admits declared aliases, qualified component names, and literal protocol wrappers" do
    document = ExpoTurbo::Rails::XmlFragments.parse_document(
      '<Demo:Screen xmlns:Demo="urn:demo"><turbo-frame id="details"><Card id="card"/></turbo-frame></Demo:Screen>'
    )

    expect(capabilities.validate_document!(document)).to equal(document)
  end

  it "admits default-namespace protocol wrappers but rejects prefixed ones" do
    unknown = ExpoTurbo::Rails::XmlFragments.parse_document("<DemoText><PrivateComponent/></DemoText>")
    default_namespace_frame = ExpoTurbo::Rails::XmlFragments.parse_document(
      '<DemoText><turbo-frame xmlns="urn:turbo" id="details"/></DemoText>'
    )
    prefixed_frame = ExpoTurbo::Rails::XmlFragments.parse_document(
      '<DemoText xmlns:Turbo="urn:turbo"><Turbo:turbo-frame id="details"/></DemoText>'
    )

    expect { capabilities.validate_document!(unknown) }
      .to raise_error(described_class::ValidationError, /undeclared component/)
    expect(capabilities.validate_document!(default_namespace_frame)).to equal(default_namespace_frame)
    expect { capabilities.validate_document!(prefixed_frame) }
      .to raise_error(described_class::ValidationError, /undeclared component/)
  end

  it "matches the native style-token admission contract" do
    valid = ExpoTurbo::Rails::XmlFragments.parse_document(
      "<Card style-tokens=\"\u00A0tone:info  \tspace:compact\u00A0\"/>"
    )

    expect(capabilities.validate_document!(valid)).to equal(valid)

    [
      '<DemoCard style-tokens="missing"/>',
      '<DemoCard style-tokens="tone:info tone:info"/>',
      '<DemoCard style-tokens="tone:info space:compact layout:row"/>',
      '<DemoCard style-tokens="tone:info tone:warning"/>',
      '<DemoText style-tokens="tone:info"/>',
      '<DemoText style-tokens=""/>',
      "<DemoCard style-tokens=\"tone:info\u0085space:compact\"/>"
    ].each do |xml|
      document = ExpoTurbo::Rails::XmlFragments.parse_document(xml)

      expect { capabilities.validate_document!(document) }
        .to raise_error(described_class::ValidationError)
    end
  end

  it "validates Frame and Stream fragment payloads without admitting their synthetic root" do
    frame = ExpoTurbo::Rails::XmlFragments.parse_frame_fragment(
      '<turbo-frame id="details"><DemoCard style-tokens="tone:info space:compact"/></turbo-frame>'
    )
    streams = ExpoTurbo::Rails::XmlFragments.parse_stream_fragment(
      '<turbo-stream action="append" target="items"><template><DemoCard style-tokens="tone:info space:compact"/></template></turbo-stream>'
    )

    expect(capabilities.validate_frame_fragment!(frame)).to equal(frame)
    expect(capabilities.validate_stream_fragment!(streams)).to equal(streams)
  end

  it "validates Stream template payloads and fragment literal IDs" do
    unknown = ExpoTurbo::Rails::XmlFragments.parse_stream_fragment(
      '<turbo-stream action="append" target="items"><template><PrivateComponent/></template></turbo-stream>'
    )

    expect { capabilities.validate_stream_fragment!(unknown) }
      .to raise_error(described_class::ValidationError, /undeclared component/)
    expect {
      ExpoTurbo::Rails::XmlFragments.parse_frame_fragment('<turbo-frame id="details"><DemoCard id=" "/></turbo-frame>')
    }.to raise_error(ExpoTurbo::Rails::XmlFragments::DocumentIdError, /nonblank literal/)
    expect {
      ExpoTurbo::Rails::XmlFragments.parse_stream_fragment(
        '<turbo-stream action="append" target="items"><template><DemoCard id=" "/></template></turbo-stream>'
      )
    }.to raise_error(ExpoTurbo::Rails::XmlFragments::DocumentIdError, /nonblank literal/)
  end
end
