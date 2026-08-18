# frozen_string_literal: true

require "action_controller/api"
require "open3"
require "rbconfig"
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

  it "delegates an explicit record role to Rails with no prefix" do
    allow(described_class::DEPRECATOR).to receive(:warn)
    expect(ActionView::RecordIdentifier).to receive(:dom_id).with(saved, nil).and_return("rails-record-id")

    expect(described_class.id_for(saved, :record)).to eq("rails-record-id")
  end

  it "gives the exact no-prefix migration for the default role" do
    expect(described_class::DEPRECATOR).to receive(:warn).with(described_class::RECORD_DEPRECATION_MESSAGE)

    described_class.id_for(saved)
  end

  it "gives the exact no-prefix migration for an explicit record role" do
    expect(described_class::DEPRECATOR).to receive(:warn).with(described_class::RECORD_DEPRECATION_MESSAGE)

    described_class.id_for(saved, :record)
  end

  it "keeps each non-record role in its exact migration" do
    expect(described_class::DEPRECATOR).to receive(:warn).with(
      "ExpoTurbo::Rails::DomIds.id_for is deprecated and will be removed in expo_turbo-rails 0.5.0; " \
      "replace id_for(record, :frame) with dom_id(record, :frame); keep the :frame prefix"
    )
    described_class.id_for(saved, :frame)

    expect(described_class::DEPRECATOR).to receive(:warn).with(
      "ExpoTurbo::Rails::DomIds.id_for is deprecated and will be removed in expo_turbo-rails 0.5.0; " \
      "replace id_for(record, :sidebar) with dom_id(record, :sidebar); keep the :sidebar prefix"
    )
    described_class.id_for(saved, :sidebar)
  end

  it "does not call a nonstandard role only to format its warning" do
    role = Object.new
    role.define_singleton_method(:inspect) { raise "warning inspected role" }
    role.define_singleton_method(:instance_of?) { |*| raise "warning inspected role type" }
    role.define_singleton_method(:to_s) { "sidebar" }

    expect(described_class::DEPRECATOR).to receive(:warn).with(
      "ExpoTurbo::Rails::DomIds.id_for is deprecated and will be removed in expo_turbo-rails 0.5.0; " \
      "replace id_for(record, role) with dom_id(record, role); keep the non-:record prefix"
    )

    expect(described_class.id_for(saved, role)).to eq("sidebar_room_7")
  end

  it "registers its deprecator during the actual test application boot" do
    expect(Rails.application).to be_initialized
    expect(described_class::DEPRECATOR_NAME).to eq(:expo_turbo_rails)
    expect(Rails.application.deprecators[described_class::DEPRECATOR_NAME]).to equal(described_class::DEPRECATOR)
    expect(Rails.application.deprecators.each.count { |deprecator| deprecator.equal?(described_class::DEPRECATOR) }).to eq(1)
  end

  it "registers once when its initializer is re-run for a separate application" do
    initializer = ExpoTurbo::Rails::Engine.initializers.find do |candidate|
      candidate.name == "expo_turbo.rails.deprecator"
    end
    original_behavior = described_class::DEPRECATOR.behavior
    throwaway_app = Class.new(::Rails::Application).new

    initializer.run(throwaway_app)
    initializer.run(throwaway_app)

    expect(throwaway_app.deprecators[described_class::DEPRECATOR_NAME]).to equal(described_class::DEPRECATOR)
    expect(throwaway_app.deprecators.each.count { |deprecator| deprecator.equal?(described_class::DEPRECATOR) }).to eq(1)
  ensure
    described_class::DEPRECATOR.behavior = original_behavior if original_behavior
  end

  it "uses the host behavior, attributes the caller, and obeys host silencing" do
    warnings = []
    original_behaviors = Rails.application.deprecators.each.to_h { |deprecator| [deprecator, deprecator.behavior] }
    Rails.application.deprecators.behavior = lambda do |message, callstack, deprecator|
      warnings << [message, callstack, deprecator]
    end

    call_site = __LINE__ + 1
    described_class.id_for(saved)
    Rails.application.deprecators.silence { described_class.id_for(saved) }

    expect(warnings.length).to eq(1)
    expect(warnings.first.fetch(0)).to include("ExpoTurbo::Rails::DomIds.id_for is deprecated")
    expect(warnings.first.fetch(1).first.path).to eq(__FILE__)
    expect(warnings.first.fetch(1).first.lineno).to eq(call_site)
    expect(warnings.first.fetch(2)).to equal(described_class::DEPRECATOR)
  ensure
    original_behaviors&.each { |deprecator, behavior| deprecator.behavior = behavior }
  end

  it "keeps normal Expo render calls warning-free" do
    expect(described_class::DEPRECATOR).not_to receive(:warn)

    dom_id_cases(view_context(ExpoTurbo::Rails::MIME_TYPE))
  end

  it "loads the gem and warns without an initialized Rails application" do
    gem_root = File.expand_path("../..", __dir__)
    script = <<~RUBY
      require "action_controller/railtie"
      require "expo_turbo/rails"
      abort "Rails application initialized" unless Rails.application.nil?

      model_name = Struct.new(:param_key).new("room")
      record = Object.new
      record.define_singleton_method(:to_key) { [7] }
      record.define_singleton_method(:model_name) { model_name }
      record.define_singleton_method(:to_model) { self }

      ExpoTurbo::Rails::DomIds::DEPRECATOR.behavior = :silence
      abort "wrong id" unless ExpoTurbo::Rails::DomIds.id_for(record, :record) == "room_7"
    RUBY
    output, status = Open3.capture2e(
      RbConfig.ruby,
      "-I#{File.join(gem_root, "lib")}",
      "-e",
      script,
      chdir: gem_root
    )

    expect(output).to eq("")
    expect(status).to be_success
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

  it "keeps Rails parity for role and key characters rejected by the old Expo helper" do
    unusual_key = ExpoTurboDomIdsSpecRecord.new(["north\nwing"])
    unusual_role = :"side\tbar"

    ["text/html", ExpoTurbo::Rails::MIME_TYPE].each do |accept|
      context = view_context(accept)

      expect(context.dom_id(saved, unusual_role))
        .to eq(ActionView::RecordIdentifier.dom_id(saved, unusual_role))
      expect(context.dom_id(saved, unusual_role)).to eq("side\tbar_room_7")
      expect(context.dom_id(unusual_key, :frame))
        .to eq(ActionView::RecordIdentifier.dom_id(unusual_key, :frame))
      expect(context.dom_id(unusual_key, :frame)).to eq("frame_room_north\nwing")
    end
  end
end
