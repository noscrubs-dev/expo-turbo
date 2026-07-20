# frozen_string_literal: true

require "open3"
require "rbconfig"
require "spec_helper"
require "expo_turbo/rails/testing"

RSpec.describe ExpoTurbo::Rails::Testing do
  let(:parse_error) { ExpoTurbo::Rails::Testing::XmlParseError }

  it "keeps Nokogiri opt-in from the main gem entrypoint" do
    gem_root = File.expand_path("../..", __dir__)
    script = 'require "action_controller/railtie"; require "expo_turbo/rails"; abort "Nokogiri loaded" if defined?(Nokogiri)'
    _output, status = Open3.capture2e(RbConfig.ruby, "-I#{File.join(gem_root, "lib")}", "-e", script, chdir: gem_root)

    expect(status).to be_success
  end

  it "parses a strict UTF-8 XML document with namespaced components" do
    document = described_class.parse_document(<<~XML)
      <?xml version="1.0" encoding="UTF-8"?>
      <Demo:Screen xmlns:Demo="urn:expo-demo" id="screen"><Demo:Text>Ready</Demo:Text></Demo:Screen>
    XML

    expect(document.root.namespace.href).to eq("urn:expo-demo")
    expect(document.root["id"]).to eq("screen")
    expect(document.at_xpath("//Demo:Text", "Demo" => "urn:expo-demo")&.text).to eq("Ready")
  end

  it "accepts binary HTTP bytes only when they validate as UTF-8" do
    document = described_class.parse_document("<DemoText>Ready</DemoText>".dup.force_encoding(Encoding::ASCII_8BIT))

    expect(document.root.text).to eq("Ready")
  end

  it "preserves CDATA text that resembles a declaration" do
    document = described_class.parse_document("<DemoText><![CDATA[<!DOCTYPE not-a-declaration>]]></DemoText>")

    expect(document.root.text).to eq("<!DOCTYPE not-a-declaration>")
  end

  it "parses sibling Stream elements in authored order" do
    document = described_class.parse_stream_fragment(<<~XML)
      <turbo-stream action="update" target="notice"><template><Demo:Text xmlns:Demo="urn:expo-demo">First</Demo:Text></template></turbo-stream>
      <turbo-stream action="append" target="messages"><template><Demo:Text xmlns:Demo="urn:expo-demo">Second</Demo:Text></template></turbo-stream>
    XML
    streams = document.xpath("/expo-turbo-test-root/turbo-stream")

    expect(streams.map { |stream| [stream["action"], stream["target"]] })
      .to eq([["update", "notice"], ["append", "messages"]])
    expect(streams.first.at_xpath("./template/Demo:Text", "Demo" => "urn:expo-demo")&.text).to eq("First")
  end

  it "rejects malformed and unsafe document input without exposing source" do
    inputs = [
      "<Demo><Text></Demo>",
      "<Demo/><Other/>",
      "<Demo a=\"one\" a=\"two\"/>",
      "<Demo:Text/>",
      "<?build data?><Demo/>",
      "<!DOCTYPE Demo [<!ENTITY secret \"not-for-errors\">]><Demo>&secret;</Demo>",
      "<?xml version=\"1.0\" encoding=\"ISO-8859-1\"?><Demo/>",
      "\xFF".dup.force_encoding(Encoding::UTF_8)
    ]

    inputs.each do |xml|
      expect { described_class.parse_document(xml) }
        .to raise_error(parse_error, /well-formed UTF-8 XML/)
    end

    expect { described_class.parse_document("<!DOCTYPE Demo [<!ENTITY secret \"not-for-errors\">]><Demo>&secret;</Demo>") }
      .to raise_error(parse_error) { |error| expect(error.message).not_to include("not-for-errors") }
  end

  it "rejects declarations, non-Stream content, and malformed XML fragments" do
    inputs = [
      "<?xml version=\"1.0\" encoding=\"UTF-8\"?><turbo-stream action=\"remove\" target=\"notice\"/>",
      "plain text<turbo-stream action=\"remove\" target=\"notice\"/>",
      "<DemoText/>",
      "<x:turbo-stream xmlns:x=\"urn:expo-test\" action=\"remove\" target=\"notice\"/>",
      "<turbo-stream action=\"remove\" target=\"notice\">"
    ]

    inputs.each do |xml|
      expect { described_class.parse_stream_fragment(xml) }
        .to raise_error(parse_error, /well-formed UTF-8 XML/)
    end
  end
end
