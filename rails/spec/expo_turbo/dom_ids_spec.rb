# frozen_string_literal: true

require "action_controller/api"
require "spec_helper"

class ExpoTurboDomIdsSpecRecord
  ModelName = Struct.new(:param_key)

  def self.model_name
    @model_name ||= ModelName.new("room")
  end

  def initialize(key, persisted: true)
    @key = key
    @persisted = persisted
  end

  def to_key
    @key
  end

  def to_model
    self
  end

  def persisted?
    @persisted
  end

  def model_name
    self.class.model_name
  end
end

RSpec.describe ExpoTurbo::Rails::DomIds do
  let(:saved) { ExpoTurboDomIdsSpecRecord.new([7]) }
  let(:unsaved) { ExpoTurboDomIdsSpecRecord.new(nil, persisted: false) }

  let(:controller_class) do
    Class.new(ActionController::API) do
      include ExpoTurbo::Rails::Controller
    end
  end

  def view_context(accept)
    controller = controller_class.new
    controller.request = ActionDispatch::TestRequest.create("HTTP_ACCEPT" => accept)
    controller.response = ActionDispatch::TestResponse.new
    controller.formats = controller.request.formats.filter_map(&:ref)
    controller.view_context
  end

  def dom_id_cases(context)
    {
      saved: context.dom_id(saved),
      unsaved: context.dom_id(unsaved),
      model: context.dom_id(ExpoTurboDomIdsSpecRecord),
      frame: context.dom_id(saved, :frame),
      edit: context.dom_id(saved, :edit),
      record: context.dom_id(saved, :record),
      arbitrary: context.dom_id(saved, :sidebar),
      record_list: context.dom_id(saved, :list),
      model_list: context.dom_id(ExpoTurboDomIdsSpecRecord, :list)
    }
  end

  def target_from(stream)
    Nokogiri::XML(stream.to_s) { |config| config.strict }.root["target"]
  end

  it "uses Rails DOM IDs in HTML and Expo Turbo formats" do
    html = dom_id_cases(view_context("text/html"))
    expo = dom_id_cases(view_context(ExpoTurbo::Rails::MIME_TYPE))

    expect(html).to eq(
      saved: "room_7",
      unsaved: "new_room",
      model: "new_room",
      frame: "frame_room_7",
      edit: "edit_room_7",
      record: "record_room_7",
      arbitrary: "sidebar_room_7",
      record_list: "list_room_7",
      model_list: "list_room"
    )
    expect(expo).to eq(html)
  end

  it "keeps Frame and Stream record targets on the same Rails IDs in both formats" do
    ["text/html", ExpoTurbo::Rails::MIME_TYPE].each do |accept|
      context = view_context(accept)

      record_id = context.dom_id(saved, :frame)
      record_frame = context.turbo_frame_tag(saved, :frame)
      record_stream = context.turbo_stream.remove([saved, :frame])

      expect(Nokogiri::XML(record_frame.to_s) { |config| config.strict }.root["id"]).to eq(record_id)
      expect(target_from(record_stream)).to eq(record_id)
    end
  end

  it "keeps Expo Turbo Frame and Stream model-list targets on the Rails ID" do
    context = view_context(ExpoTurbo::Rails::MIME_TYPE)
    model_id = context.dom_id(ExpoTurboDomIdsSpecRecord, :list)
    model_frame = context.turbo_frame_tag(ExpoTurboDomIdsSpecRecord, :list)
    model_stream = context.turbo_stream.remove([ExpoTurboDomIdsSpecRecord, :list])

    expect(Nokogiri::XML(model_frame.to_s) { |config| config.strict }.root["id"]).to eq(model_id)
    expect(target_from(model_stream)).to eq(model_id)
  end

  it "keeps the direct wrapper for 0.4 and delegates each result to Rails" do
    allow(described_class::DEPRECATOR).to receive(:warn)
    expect(ActionView::RecordIdentifier).to receive(:dom_id).with(saved, nil).and_return("rails-record-id")
    expect(ActionView::RecordIdentifier).to receive(:dom_id).with(unsaved, :sidebar).and_return("rails-unsaved-id")

    expect(described_class.id_for(saved)).to eq("rails-record-id")
    expect(described_class.id_for(unsaved, :sidebar)).to eq("rails-unsaved-id")
  end

  it "warns that the direct wrapper will be removed in 0.5" do
    expect(described_class::DEPRECATOR).to receive(:warn).with(/removed in expo_turbo-rails 0\.5\.0/)

    described_class.id_for(saved)
  end

  it "does not load or install the removed format-specific helper" do
    expect(defined?(ExpoTurbo::Rails::DomIds::Helper)).to be_nil
    expect(controller_class._helpers.ancestors.map(&:name)).not_to include("ExpoTurbo::Rails::DomIds::Helper")
  end

  it "catches a mutation that reinstalls the old format-specific helper" do
    legacy_format_helper = Module.new do
      include ExpoTurbo::Rails::Format::Helper

      def dom_id(record_or_class, prefix = nil)
        return super unless expo_turbo_render?

        ExpoTurbo::Rails::DomIds.id_for(record_or_class, prefix.nil? ? :record : prefix.to_sym)
      end
    end
    context = view_context(ExpoTurbo::Rails::MIME_TYPE)
    context.singleton_class.prepend(legacy_format_helper)

    described_class::DEPRECATOR.silence do
      mismatches = dom_id_cases(context).reject do |name, value|
        value == dom_id_cases(view_context("text/html")).fetch(name)
      end

      expect(mismatches).to eq(record: "room_7")
    end
  end
end
