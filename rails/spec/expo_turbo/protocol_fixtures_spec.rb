# frozen_string_literal: true

require "action_controller/api"
require "json"
require "spec_helper"
require "expo_turbo/rails/testing"

module ExpoTurboProtocolFixturesSpec
  FIXTURE_PATH = %r{\Afixtures/[a-z0-9]+(?:-[a-z0-9]+)*\.xml\z}
  PROTOCOL_DIRECTORY = File.join(File.expand_path("../../..", __dir__), "protocol")
  XMLNS_NAMESPACE = "http://www.w3.org/2000/xmlns/"
end

RSpec.describe "shared protocol fixtures" do
  let(:controller_class) do
    Class.new(ActionController::API) do
      include ExpoTurbo::Rails::Controller
    end
  end
  let(:manifest) do
    JSON.parse(File.read(File.join(ExpoTurboProtocolFixturesSpec::PROTOCOL_DIRECTORY, "compatibility-manifest.json")))
  end

  def stream
    controller_class.new.expo_turbo_stream
  end

  def fixture_path(file)
    unless file.is_a?(String) && ExpoTurboProtocolFixturesSpec::FIXTURE_PATH.match?(file)
      raise ArgumentError, "Protocol fixtures must be local XML files under protocol/fixtures"
    end

    File.join(ExpoTurboProtocolFixturesSpec::PROTOCOL_DIRECTORY, file)
  end

  def normalized_attributes(node)
    node.attribute_nodes
      .reject do |attribute|
        attribute.name == "xmlns" || attribute.namespace&.prefix == "xmlns" ||
          attribute.namespace&.href == ExpoTurboProtocolFixturesSpec::XMLNS_NAMESPACE
      end
      .map { |attribute| [qualified_name(attribute), attribute.namespace&.href, attribute.value] }
      .sort_by { |attribute| [attribute[0], attribute[1].to_s, attribute[2]] }
  end

  def normalized_node(node)
    if node.text? || node.cdata?
      {"kind" => "text", "value" => node.text, "cdata" => node.cdata?}
    elsif node.comment?
      {"kind" => "comment", "value" => node.text}
    elsif node.element?
      {
        "kind" => "element",
        "qname" => qualified_name(node),
        "namespace" => node.namespace&.href,
        "attributes" => normalized_attributes(node),
        "children" => node.children.filter_map { |child| normalized_node(child) }
      }
    end
  end

  def normalized_document(xml)
    document = ExpoTurbo::Rails::Testing.parse_document(xml)
    ExpoTurbo::Rails::XmlFragments.validate_document_ids!(document)
    [normalized_node(document.root)]
  end

  def normalized_stream_fragment(xml)
    document = ExpoTurbo::Rails::Testing.parse_stream_fragment(xml)
    document.root.element_children.map { |element| normalized_node(element) }
  end

  def normalized_fixture(xml, fixture)
    case fixture.fetch("envelope")
    when "document"
      normalized_document(xml)
    when "stream-fragment"
      normalized_stream_fragment(xml)
    else
      raise ArgumentError, "Protocol fixture #{fixture.fetch("id")} has an invalid envelope"
    end
  end

  def qualified_name(node)
    prefix = node.namespace&.prefix
    return node.name if prefix.nil? || prefix.empty?

    "#{prefix}:#{node.name}"
  end

  def fixture(id)
    manifest.fetch("fixtures").find { |candidate| candidate.fetch("id") == id } || raise("Missing protocol fixture #{id}")
  end

  it "pins the shared protocol compatibility baselines" do
    baselines = manifest.fetch("baselines")

    expect(manifest.fetch("manifestVersion")).to eq(1)
    expect(manifest.fetch("protocolVersion")).to eq(ExpoTurbo::Rails::PROTOCOL_VERSION)
    expect(baselines.fetch("turbo")).to eq(ExpoTurbo::Rails::TURBO_BASELINE_VERSION)
    expect(baselines.fetch("turboRails").fetch("minimum")).to eq(ExpoTurbo::Rails::TURBO_RAILS_MINIMUM_VERSION)
    expect(baselines.fetch("turboRails").fetch("target")).to eq(ExpoTurbo::Rails::TURBO_RAILS_BASELINE_VERSION)
    expect(baselines.fetch("rails")).to eq(ExpoTurbo::Rails::RAILS_BASELINE_VERSION)
  end

  it "keeps fixture references within the shared XML source directory" do
    expect { fixture_path("fixtures/document-basic.xml") }.not_to raise_error
    ["/tmp/outside.xml", "fixtures/../outside.xml", "fixtures/document.txt"].each do |invalid_path|
      expect { fixture_path(invalid_path) }
        .to raise_error(ArgumentError, "Protocol fixtures must be local XML files under protocol/fixtures")
    end
  end

  it "accepts every declared document and Stream fixture" do
    manifest.fetch("fixtures").each do |declared_fixture|
      next unless declared_fixture.fetch("expect").fetch("outcome") == "accepted"

      xml = File.read(fixture_path(declared_fixture.fetch("file")))
      expected = declared_fixture.fetch("expect").fetch("normalized").fetch("nodes")
      expect(normalized_fixture(xml, declared_fixture)).to eq(expected)
    end
  end

  it "rejects every declared unsafe fixture" do
    manifest.fetch("fixtures").each do |declared_fixture|
      next unless declared_fixture.fetch("expect").fetch("outcome") == "rejected"

      xml = File.read(fixture_path(declared_fixture.fetch("file")))
      expect { normalized_fixture(xml, declared_fixture) }
        .to raise_error(ExpoTurbo::Rails::Testing::XmlParseError)
    end
  end

  it "emits the shared sibling Stream fixture through the Rails helper" do
    expected = fixture("stream-basic").fetch("expect").fetch("normalized").fetch("nodes")
    rendered = <<~XML.delete("\n")
      #{stream.append("items", '<DemoItem id="item-1">One</DemoItem>')}#{stream.remove("stale")}
    XML

    expect(normalized_stream_fragment(rendered)).to eq(expected)
  end
end
