# frozen_string_literal: true

require "json"
require "spec_helper"
require "tempfile"

# One template can serve a browser and a native client only if the element
# names in it mean something to both. The divergence is element names alone:
# every protocol wrapper is already the Turbo name, and a component reaches its
# HTML name through the alias it declares. This file pins that contract, and
# the two boundaries a host will actually hit.
module ExpoTurboHtmlNameAliasesSpec
  REPOSITORY_DIRECTORY = File.expand_path("../../..", __dir__)
  # WHATWG HTML, "The form element": the content attributes of <form>, minus
  # the global attributes every element carries.
  HTML_FORM_ATTRIBUTE_NAMES = %w[
    accept-charset action autocomplete enctype method name novalidate rel target
  ].freeze
end

RSpec.describe "HTML element names in Expo Turbo templates" do
  def parse(xml)
    ExpoTurbo::Rails::XmlFragments.parse_document(xml)
  end

  def manifest_capabilities(components, **options)
    file = Tempfile.new(["expo-turbo-capabilities", ".json"])
    file.write(
      JSON.generate(
        manifestVersion: 1,
        protocolVersion: ExpoTurbo::Rails::PROTOCOL_VERSION,
        hash: "fnv1a32:1234abcd",
        modules: [{name: "demo", version: "1.0.0"}],
        components: components
      )
    )
    file.close
    yield ExpoTurbo::Rails::TemplateCapabilities.new(manifest: file.path, **options)
  ensure
    file&.unlink
  end

  describe "the protocol wrappers" do
    # Nothing to alias: the four wrappers a template writes are spelled exactly
    # as Turbo spells them in HTML, so a shared template needs no translation
    # for a Frame, a Stream, a Cable source, or a template body.
    it "carry their Turbo names and need no declaration" do
      capabilities = ExpoTurbo::Rails::TemplateCapabilities.new(components: {})
      document = parse(<<~XML.chomp)
        <turbo-frame id="details">
          <turbo-cable-stream-source channel="Turbo::StreamsChannel" signed-stream-name="abc"/>
          <turbo-stream action="append" target="items"><template/></turbo-stream>
        </turbo-frame>
      XML

      expect(capabilities.validate_document!(document)).to equal(document)
      expect(ExpoTurbo::Rails::TemplateCapabilities::PROTOCOL_ELEMENTS)
        .to contain_exactly("template", "turbo-cable-stream-source", "turbo-frame", "turbo-stream")
    end
  end

  describe "an HTML element name declared as an alias" do
    let(:capabilities) do
      ExpoTurbo::Rails::TemplateCapabilities.new(
        components: {
          "DemoText" => {aliases: ["p"], children: "text"},
          "DemoLink" => {aliases: ["a"], children: "text"},
          "DemoForm" => {aliases: ["form"], children: "nodes"},
          "DemoInput" => {aliases: ["input"], children: "none"}
        }
      )
    end

    it "is admitted wherever its component is" do
      document = parse(<<~XML.chomp)
        <form id="signup"><p id="hint">Pick a plan</p><a id="terms">Terms</a><input id="email"/></form>
      XML

      expect(capabilities.validate_document!(document)).to equal(document)
    end

    it "carries the child mode of the component it names" do
      expect { capabilities.validate_document!(parse('<p id="a"><a id="b">x</a></p>')) }
        .to raise_error(ExpoTurbo::Rails::TemplateCapabilities::ValidationError, /accepts text/)
      expect { capabilities.validate_document!(parse('<input id="a">text</input>')) }
        .to raise_error(ExpoTurbo::Rails::TemplateCapabilities::ValidationError, /accepts no children/)
      expect { capabilities.validate_document!(parse('<form id="a">bare</form>')) }
        .to raise_error(ExpoTurbo::Rails::TemplateCapabilities::ValidationError, /accepts elements/)
    end

    it "is not admitted when the component does not declare it" do
      undeclared = ExpoTurbo::Rails::TemplateCapabilities.new(components: {"DemoText" => {children: "text"}})

      expect { undeclared.validate_document!(parse('<p id="a">x</p>')) }
        .to raise_error(ExpoTurbo::Rails::TemplateCapabilities::ValidationError, /undeclared component/)
    end

    it "carries the attribute rules of the component it names" do
      components = [
        {tag: "DemoText", aliases: ["p"], attributes: [{name: "value", required: true}]},
        {tag: "DemoForm", aliases: ["form"], attributes: [], formOwner: true}
      ]

      manifest_capabilities(components) do |capabilities|
        expect(capabilities.validate_document!(parse('<p value="ok" id="a"/>'))).to be_truthy
        expect(capabilities.validate_document!(parse('<form action="/x" method="post"/>'))).to be_truthy
        expect { capabilities.validate_document!(parse('<p id="a"/>')) }
          .to raise_error(ExpoTurbo::Rails::TemplateCapabilities::ValidationError, /required component attribute/)
        expect { capabilities.validate_document!(parse('<p value="ok" surprise="1"/>')) }
          .to raise_error(ExpoTurbo::Rails::TemplateCapabilities::ValidationError, /undeclared component attribute/)
        # Form ownership follows the component, not the element name: the
        # alias may write the form attributes and the non-owner may not.
        expect { capabilities.validate_document!(parse('<p value="ok" action="/x"/>')) }
          .to raise_error(ExpoTurbo::Rails::TemplateCapabilities::ValidationError, /undeclared component attribute/)
      end
    end
  end

  describe "the no-ambiguity rule" do
    # Two names for one component is the whole point. One name for two
    # components would make a shared template mean two different screens.
    it "admits two names for one component" do
      capabilities = ExpoTurbo::Rails::TemplateCapabilities.new(
        components: {"DemoText" => {aliases: %w[p span], children: "text"}}
      )
      document = parse('<p id="a">x</p>')

      expect(capabilities.validate_document!(document)).to equal(document)
      expect(capabilities.validate_document!(parse('<span id="b">x</span>'))).to be_truthy
    end

    it "refuses one name for two components, in either declaration order" do
      expect {
        ExpoTurbo::Rails::TemplateCapabilities.new(components: {"DemoText" => {aliases: ["p"]}, "p" => {}})
      }.to raise_error(ExpoTurbo::Rails::ConfigurationError, /"p" is declared more than once/)
      expect {
        ExpoTurbo::Rails::TemplateCapabilities.new(components: {"p" => {}, "DemoText" => {aliases: ["p"]}})
      }.to raise_error(ExpoTurbo::Rails::ConfigurationError, /"p" is declared more than once/)
      expect {
        ExpoTurbo::Rails::TemplateCapabilities.new(
          components: {"DemoText" => {aliases: ["p"]}, "DemoParagraph" => {aliases: ["p"]}}
        )
      }.to raise_error(ExpoTurbo::Rails::ConfigurationError, /"p" is declared more than once/)
    end

    it "refuses a protocol wrapper name as an alias" do
      %w[template turbo-frame turbo-stream turbo-cable-stream-source expo-turbo-fragment].each do |reserved|
        expect {
          ExpoTurbo::Rails::TemplateCapabilities.new(components: {"DemoText" => {aliases: [reserved]}})
        }.to raise_error(ExpoTurbo::Rails::ConfigurationError, /#{Regexp.escape(reserved.inspect)} is reserved/)
      end
    end
  end

  # These two are the reason a shared template is not free. Both are verified
  # facts about Rails output, not guesses, and both are documented in the
  # README rather than worked around here.
  describe "the boundaries a Rails HTML helper hits" do
    it "does not admit the accept-charset that form_with writes" do
      manifest_capabilities([{tag: "DemoForm", aliases: ["form"], attributes: [], formOwner: true}]) do |capabilities|
        expect {
          capabilities.validate_document!(parse('<form action="/x" accept-charset="UTF-8" method="post"/>'))
        }.to raise_error(ExpoTurbo::Rails::TemplateCapabilities::ValidationError, /undeclared component attribute/)
      end
    end

    it "does not parse an HTML void element that carries no closing slash" do
      expect { parse("<DemoText><br></DemoText>") }
        .to raise_error(ExpoTurbo::Rails::XmlFragments::ParseError)
      expect(parse("<DemoText><br/></DemoText>")).to be_truthy
    end
  end

  # The server admits exactly what the client decoder admits. A name the
  # server let through and the client rejected would fail on the device with
  # no server-side evidence at all.
  describe "parity with the client decoder" do
    let(:decoder_source) do
      path = File.join(ExpoTurboHtmlNameAliasesSpec::REPOSITORY_DIRECTORY, "src/registry/registry-decode-internal.ts")
      skip "client decoder parity requires repository sources" unless File.file?(path)
      File.read(path)
    end
    let(:registry_source) do
      path = File.join(ExpoTurboHtmlNameAliasesSpec::REPOSITORY_DIRECTORY, "src/registry/registry.ts")
      skip "client registry parity requires repository sources" unless File.file?(path)
      File.read(path)
    end

    it "reserves the same names the client reserves" do
      reserved = registry_source[/const RESERVED_TAGS = new Set\(\[(.*?)\]\)/m, 1].scan(/"([^"]+)"/).flatten

      expect(reserved).to match_array(ExpoTurbo::Rails::TemplateCapabilities::RESERVED_COMPONENT_NAMES)
    end

    # The client reserves no HTML element name, so a host may name a component
    # `a`, `form`, or `input` outright instead of aliasing to it.
    it "leaves every HTML element name available to a component" do
      reserved = ExpoTurbo::Rails::TemplateCapabilities::RESERVED_COMPONENT_NAMES

      expect(reserved & %w[a form input p div span img button label select textarea]).to be_empty
    end

    it "allows the same form-owner attributes the client allows" do
      allowed = decoder_source[/const FORM_OWNER_ATTRIBUTE_NAMES = new Set\(\[(.*?)\]\)/m, 1].scan(/"([^"]+)"/).flatten

      expect(allowed).to match_array(ExpoTurbo::Rails::TemplateCapabilities::FORM_OWNER_ATTRIBUTE_NAMES)
    end

    # A strict subset of HTML's <form> attributes, which is why form_with
    # output is not admitted as-is.
    it "allows fewer form-owner attributes than HTML defines for <form>" do
      allowed = ExpoTurbo::Rails::TemplateCapabilities::FORM_OWNER_ATTRIBUTE_NAMES

      expect(ExpoTurboHtmlNameAliasesSpec::HTML_FORM_ATTRIBUTE_NAMES).to include(*allowed)
      expect(ExpoTurboHtmlNameAliasesSpec::HTML_FORM_ATTRIBUTE_NAMES - allowed)
        .to contain_exactly("accept-charset", "autocomplete", "name", "rel")
    end

    it "shares the same element-independent attributes the client shares" do
      shared = decoder_source[/function isSharedAttribute\(name: string\): boolean \{(.*?)\n\}/m, 1]
        .scan(/name === "([^"]+)"/).flatten

      expect(shared).to match_array(
        ExpoTurbo::Rails::TemplateCapabilities::SHARED_ATTRIBUTE_NAMES
      )
    end
  end
end
