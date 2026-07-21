# frozen_string_literal: true

require "action_controller/api"
require "spec_helper"
require "expo_turbo/rails/testing"

class ExpoTurboUpstreamParityRecord
  ModelName = Struct.new(:param_key)

  def self.model_name
    @model_name ||= ModelName.new("demo_record")
  end

  attr_reader :id

  def initialize(id)
    @id = id
  end

  def to_key
    [id]
  end

  def to_model
    self
  end

  def persisted?
    true
  end

  def model_name
    self.class.model_name
  end
end

class ExpoTurboUpstreamParityFrameContext
  include ActionView::Helpers::TagHelper
  include Turbo::FramesHelper

  def url_for(value)
    value
  end
end

RSpec.describe "Expo Turbo upstream helper parity" do
  let(:template_actions) { %i[append prepend before after replace update] }
  let(:selector_actions) { %i[append_all prepend_all before_all after_all replace_all update_all] }
  let(:xml_payload) { '<Demo:Item xmlns:Demo="urn:expo-demo" Demo:state="saved"><![CDATA[Saved]]><!-- parity --></Demo:Item>' }

  let(:controller_class) do
    Class.new(ActionController::API) do
      include ExpoTurbo::Rails::Controller
    end
  end

  def expo_stream
    controller_class.new.expo_turbo_stream
  end

  def upstream_stream
    Turbo::Streams::TagBuilder.new(Struct.new(:formats).new([]))
  end

  def expo_frame(id, **attributes, &block)
    controller = controller_class.new
    controller.request = ActionDispatch::TestRequest.create
    controller.view_context.expo_turbo_frame_tag(id, **attributes, &block)
  end

  def normalized_attributes(node)
    node.attribute_nodes.map do |attribute|
      {
        "name" => attribute.name,
        "namespaceUri" => attribute.namespace&.href,
        "value" => attribute.value
      }
    end.sort_by { |attribute| [attribute.fetch("namespaceUri").to_s, attribute.fetch("name")] }
  end

  def normalized_node(node)
    if node.element?
      {
        "kind" => "element",
        "name" => node.name,
        "namespaceUri" => node.namespace&.href,
        "attributes" => normalized_attributes(node),
        "children" => node.children.filter_map { |child| normalized_node(child) }
      }
    elsif node.cdata?
      {"kind" => "cdata", "text" => node.text}
    elsif node.comment?
      {"kind" => "comment", "text" => node.text}
    elsif node.text?
      {"kind" => "text", "text" => node.text}
    end
  end

  def normalized_stream(stream)
    ExpoTurbo::Rails::Testing.parse_stream_fragment(stream.to_s).root.element_children.map { |node| normalized_node(node) }
  end

  def normalized_frame(frame)
    normalized_node(ExpoTurbo::Rails::Testing.parse_document(frame.to_s).root)
  end

  def attribute_value(node, name)
    attribute = node.fetch("attributes").find do |candidate|
      candidate.fetch("name") == name && candidate.fetch("namespaceUri").nil?
    end
    attribute&.fetch("value")
  end

  def stream_attribute(stream, name)
    attribute_value(normalized_stream(stream).first, name)
  end

  def expect_stream_parity(expo, upstream)
    expect(normalized_stream(expo)).to eq(normalized_stream(upstream))
  end

  def expect_frame_parity(expo, upstream)
    expect(normalized_frame(expo)).to eq(normalized_frame(upstream))
  end

  def target_turbo_rails?
    case Gem.loaded_specs.fetch("turbo-rails").version.to_s
    when "2.0.10"
      false
    when "2.0.23"
      true
    else
      raise "add explicit upstream helper parity expectations for turbo-rails #{Gem.loaded_specs.fetch("turbo-rails").version}"
    end
  end

  it "matches upstream built-in and selector Stream envelopes structurally" do
    template_actions.each do |action|
      attributes = %i[replace update].include?(action) ? {method: :morph} : {}
      expect_stream_parity(
        expo_stream.public_send(action, "items", xml_payload, **attributes),
        upstream_stream.public_send(action, "items", xml_payload, **attributes)
      )
    end

    selector_actions.each do |action|
      attributes = %i[replace_all update_all].include?(action) ? {method: :morph} : {}
      expect_stream_parity(
        expo_stream.public_send(action, ".item", xml_payload, **attributes),
        upstream_stream.public_send(action, ".item", xml_payload, **attributes)
      )
    end

    expect_stream_parity(expo_stream.remove("item-1"), upstream_stream.remove("item-1"))
    expect_stream_parity(expo_stream.remove_all(".item"), upstream_stream.remove_all(".item"))
  end

  it "matches record IDs and records the legacy class-target delta" do
    record = ExpoTurboUpstreamParityRecord.new(7)

    expect_stream_parity(
      expo_stream.append(record, xml_payload),
      upstream_stream.append(record, xml_payload)
    )
    expect_stream_parity(
      expo_stream.append_all(record, xml_payload),
      upstream_stream.append_all(record, xml_payload)
    )

    expo_target = expo_stream.remove(ExpoTurboUpstreamParityRecord)
    expo_selector = expo_stream.remove_all(ExpoTurboUpstreamParityRecord)
    upstream_target = upstream_stream.remove(ExpoTurboUpstreamParityRecord)
    upstream_selector = upstream_stream.remove_all(ExpoTurboUpstreamParityRecord)

    expect(stream_attribute(expo_target, "target")).to eq("new_demo_record")
    expect(stream_attribute(expo_selector, "targets")).to eq("#new_demo_record")

    if target_turbo_rails?
      expect_stream_parity(expo_target, upstream_target)
      expect_stream_parity(expo_selector, upstream_selector)
    else
      expect(stream_attribute(upstream_target, "target")).to eq("ExpoTurboUpstreamParityRecord")
      expect(stream_attribute(upstream_selector, "targets")).to eq("ExpoTurboUpstreamParityRecord")
    end
  end

  it "uses the target refresh envelope while documenting blank request-ID deltas" do
    Turbo.with_request_id("ambient-request") do
      expect_stream_parity(expo_stream.refresh, upstream_stream.refresh)
    end

    expect_stream_parity(
      expo_stream.refresh(request_id: "request-1", method: "morph", scroll: "preserve"),
      upstream_stream.refresh(request_id: "request-1", method: "morph", scroll: "preserve")
    )
    expect_stream_parity(expo_stream.refresh(request_id: nil), upstream_stream.refresh(request_id: nil))

    ["", false].each do |request_id|
      expo = expo_stream.refresh(request_id:, method: "morph", scroll: "preserve")
      upstream = upstream_stream.refresh(request_id:, method: "morph", scroll: "preserve")

      expect(stream_attribute(expo, "request-id")).to be_nil
      if target_turbo_rails?
        expect_stream_parity(expo, upstream)
      else
        expect(stream_attribute(upstream, "request-id")).to eq(request_id.to_s)
      end
    end

    Turbo.with_request_id("") do
      expo = expo_stream.refresh
      upstream = upstream_stream.refresh

      expect(stream_attribute(expo, "request-id")).to be_nil
      if target_turbo_rails?
        expect_stream_parity(expo, upstream)
      else
        expect(stream_attribute(upstream, "request-id")).to eq("")
      end
    end
  end

  it "matches literal Frame markup and records the legacy class-ID delta" do
    payload = '<DemoText id="loaded">Loaded</DemoText>'.html_safe
    expo = expo_frame("details", src: "/frames/details", target: "sidebar", loading: :lazy) { payload }
    upstream = ExpoTurboUpstreamParityFrameContext.new.turbo_frame_tag(
      "details",
      src: "/frames/details",
      target: "sidebar",
      loading: :lazy
    ) { payload }

    expect_frame_parity(expo, upstream)

    expo_class = expo_frame(ExpoTurboUpstreamParityRecord)
    upstream_class = ExpoTurboUpstreamParityFrameContext.new.turbo_frame_tag(ExpoTurboUpstreamParityRecord)

    expect(attribute_value(normalized_frame(expo_class), "id")).to eq("new_demo_record")
    if target_turbo_rails?
      expect_frame_parity(expo_class, upstream_class)
    else
      expect(attribute_value(normalized_frame(upstream_class), "id")).to eq("ExpoTurboUpstreamParityRecord")
    end
  end
end
