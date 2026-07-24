# frozen_string_literal: true

require "action_controller/api"
require "json"
require "spec_helper"
require "expo_turbo/rails/testing"

module ExpoTurboProtocolFixturesSpec
  EVIDENCE_PATH = %r{\A(?:README\.md|(?:\.maestro|docs|example|protocol|rails|src)/[A-Za-z0-9._/-]+)\z}
  FEATURE_ID = /\A[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*\z/
  FIXTURE_PATH = %r{\Afixtures/[a-z0-9]+(?:-[a-z0-9]+)*\.xml\z}
  PROTOCOL_DIRECTORY = File.join(File.expand_path("../../..", __dir__), "protocol")
  REPOSITORY_DIRECTORY = File.dirname(PROTOCOL_DIRECTORY)
  TEST_EVIDENCE = /(?:\.test\.ts|_spec\.rb)\z/
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

  def frame(id, **attributes, &block)
    controller = controller_class.new
    controller.request = ActionDispatch::TestRequest.create
    controller.view_context.expo_turbo_frame_tag(id, **attributes, &block)
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

  def normalized_stream_actions(xml)
    document = ExpoTurbo::Rails::Testing.parse_stream_fragment(xml)
    document.root.element_children.map do |element|
      normalized = {
        "action" => element["action"].to_s,
        "templateTags" => element.at_xpath("./template")&.element_children&.map { |child| qualified_name(child) } || []
      }
      {
        "method" => "method",
        "requestId" => "request-id",
        "scroll" => "scroll",
        "target" => "target",
        "targets" => "targets"
      }.each do |key, attribute|
        value = element[attribute]
        normalized[key] = value unless value.nil?
      end
      normalized
    end
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

    expect(manifest.fetch("manifestVersion")).to eq(3)
    expect(manifest.fetch("protocolVersion")).to eq(ExpoTurbo::Rails::PROTOCOL_VERSION)
    expect(baselines.fetch("turbo")).to eq(ExpoTurbo::Rails::TURBO_BASELINE_VERSION)
    expect(baselines.fetch("turboRails").fetch("minimum")).to eq(ExpoTurbo::Rails::TURBO_RAILS_MINIMUM_VERSION)
    expect(baselines.fetch("turboRails").fetch("target")).to eq(ExpoTurbo::Rails::TURBO_RAILS_BASELINE_VERSION)
    expect(baselines.fetch("rails")).to eq(ExpoTurbo::Rails::RAILS_BASELINE_VERSION)
  end

  it "classifies every pinned upstream Turbo functional suite" do
    upstream = manifest.fetch("upstreamFunctionalBaseline")
    suites = upstream.fetch("suites")
    expected_paths = %w[
      async_script_tests.js
      autofocus_tests.js
      cache_observer_tests.js
      drive_disabled_tests.js
      drive_stylesheet_merging_tests.js
      drive_tests.js
      drive_view_transition_legacy_tests.js
      drive_view_transition_tests.js
      form_mode_tests.js
      form_submission_tests.js
      frame_navigation_tests.js
      frame_tests.js
      import_tests.js
      link_prefetch_observer_tests.js
      loading_tests.js
      navigation_tests.js
      page_refresh_stream_action_tests.js
      page_refresh_tests.js
      pausable_rendering_tests.js
      pausable_requests_tests.js
      preloader_tests.js
      rendering_tests.js
      root_tests.js
      scroll_restoration_tests.js
      stream_tests.js
      visit_tests.js
    ].map { |file| "src/tests/functional/#{file}" }

    expect(upstream.fetch("repository")).to eq("https://github.com/hotwired/turbo")
    expect(upstream.fetch("tag")).to eq("v#{ExpoTurbo::Rails::TURBO_BASELINE_VERSION}")
    expect(upstream.fetch("commit")).to eq("13fc0db0d017d7313ed0cb4729ce9729c2686cef")
    expect(suites.map { |suite| suite.fetch("path") }.sort).to eq(expected_paths.sort)

    suites.each do |suite|
      expect(suite.fetch("dispositions")).not_to be_empty
      expect(suite.fetch("dispositions")).to all(be_in(%w[exact n-a native-equivalent]))
      expect(suite.fetch("rationale").strip.length).to be >= 30
      evidence = suite.fetch("evidence")
      expect(evidence).not_to be_empty
      expect(evidence).to all(match(ExpoTurboProtocolFixturesSpec::EVIDENCE_PATH))
      if suite.fetch("dispositions").any? { |disposition| disposition != "n-a" }
        expect(evidence).to include(match(ExpoTurboProtocolFixturesSpec::TEST_EVIDENCE))
      end
      evidence.each do |path|
        expect(File).to exist(File.join(ExpoTurboProtocolFixturesSpec::REPOSITORY_DIRECTORY, path))
      end
    end
  end

  it "records unique feature dispositions with live repository evidence" do
    features = manifest.fetch("features")
    ids = features.map { |feature| feature.fetch("id") }

    expect(ids.uniq).to eq(ids)
    expect(features.map { |feature| feature.fetch("disposition") }.uniq.sort)
      .to eq(%w[exact incomplete n-a native-equivalent])
    expect(features).to include(a_hash_including("disposition" => "incomplete"))

    features.each do |feature|
      id = feature.fetch("id")
      evidence = feature.fetch("evidence")
      expect(id).to match(ExpoTurboProtocolFixturesSpec::FEATURE_ID)
      expect(feature.fetch("area")).to eq(id.split(".").first)
      expect(feature.fetch("rationale").strip.length).to be >= 30
      expect(evidence).not_to be_empty
      expect(evidence).to all(match(ExpoTurboProtocolFixturesSpec::EVIDENCE_PATH))
      if %w[exact native-equivalent].include?(feature.fetch("disposition"))
        expect(evidence).to include(match(ExpoTurboProtocolFixturesSpec::TEST_EVIDENCE))
      end
      evidence.each do |path|
        expect(File).to exist(File.join(ExpoTurboProtocolFixturesSpec::REPOSITORY_DIRECTORY, path))
      end
    end
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
      expectation = declared_fixture.fetch("expect")
      if expectation.key?("normalized")
        expect(normalized_fixture(xml, declared_fixture)).to eq(expectation.fetch("normalized").fetch("nodes"))
      else
        expect(normalized_stream_actions(xml)).to eq(expectation.fetch("streamActions"))
      end
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

  it "emits the shared Frame envelope through the Rails helper" do
    expected = fixture("frame-envelope").fetch("expect").fetch("normalized").fetch("nodes")
    rendered = frame(
      "details",
      src: "/frames/details",
      target: "_top",
      loading: :lazy,
      disabled: true,
      autoscroll: true,
      refresh: :morph,
      recurse: "details child",
      data: {turbo_action: :advance}
    ) { '<DemoCard id="details-card">Loaded details</DemoCard>'.html_safe }

    expect(normalized_document(rendered.to_s)).to eq(expected)
  end

  it "emits every shared built-in Stream envelope through the Rails helper" do
    expected = fixture("stream-actions").fetch("expect").fetch("streamActions")
    rendered = [
      stream.append("items", '<DemoItem id="append-item"/>'),
      stream.prepend("items", '<DemoItem id="prepend-item"/>'),
      stream.replace("profile", '<DemoProfile id="profile"/>', method: :morph),
      stream.update_all(".item", "<DemoItem/>", method: :morph),
      stream.remove("stale"),
      stream.before("marker", '<DemoNotice id="before-marker"/>'),
      stream.after_all(".marker", '<DemoNotice id="after-marker"/>'),
      stream.refresh(request_id: "request-123", method: :morph, scroll: :preserve)
    ].join

    expect(normalized_stream_actions(rendered)).to eq(expected)
  end
end
