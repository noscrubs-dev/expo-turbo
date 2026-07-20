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

class ExpoTurboDomIdsBareSpecRecord < ExpoTurboDomIdsSpecRecord
  undef_method :to_model
end

RSpec.describe ExpoTurbo::Rails::DomIds do
  let(:record) { ExpoTurboDomIdsSpecRecord.new([7]) }

  it "derives deterministic role-constrained IDs from persisted records" do
    expect(described_class.id_for(record)).to eq("room_7")
    expect(described_class.id_for(record, :document)).to eq("document_room_7")
    expect(described_class.id_for(record, :frame)).to eq("frame_room_7")
    expect(described_class.id_for(record, :list)).to eq("list_room_7")
    expect(described_class.id_for(record, :form)).to eq("form_room_7")
    expect(described_class.id_for(record, :error)).to eq("error_room_7")
    expect(described_class.id_for(record, :loading)).to eq("loading_room_7")
    expect(described_class.id_for(record, :frame)).to be_frozen
  end

  it "derives collection targets from a model class" do
    expect(described_class.id_for(ExpoTurboDomIdsSpecRecord, :list)).to eq("list_room")
  end

  it "accepts a direct model without a to_model adapter" do
    expect(described_class.id_for(ExpoTurboDomIdsBareSpecRecord.new([8]))).to eq("room_8")
  end

  it "rejects unsupported roles and ambiguous model identities" do
    expect { described_class.id_for(record, :notice) }.to raise_error(ArgumentError, /unsupported Expo Turbo target role/)
    expect { described_class.id_for(ExpoTurboDomIdsSpecRecord, :frame) }
      .to raise_error(ArgumentError, /only list targets/)
    expect { described_class.id_for(nil) }.to raise_error(ArgumentError, /persisted model/)
    expect { described_class.id_for(ExpoTurboDomIdsSpecRecord.new(nil)) }.to raise_error(ArgumentError, /persisted model/)
    expect { described_class.id_for(ExpoTurboDomIdsSpecRecord.new([7], persisted: false)) }
      .to raise_error(ArgumentError, /persisted model/)
    expect { described_class.id_for(ExpoTurboDomIdsSpecRecord.new([])) }.to raise_error(ArgumentError, /persisted model/)
    expect { described_class.id_for(ExpoTurboDomIdsSpecRecord.new([nil])) }.to raise_error(ArgumentError, /persisted model/)
    expect { described_class.id_for(ExpoTurboDomIdsSpecRecord.new([false])) }.to raise_error(ArgumentError, /persisted model/)
    expect { described_class.id_for(ExpoTurboDomIdsSpecRecord.new([""])) }.to raise_error(ArgumentError, /persisted model/)
  end

  it "rejects generated IDs that are invalid for Expo Turbo XML targets" do
    invalid = ExpoTurboDomIdsSpecRecord.new(["room\u0000seven"])

    expect { described_class.id_for(invalid) }
      .to raise_error(ExpoTurbo::Rails::TemplateError, /target id/)
  end

  it "exposes literal IDs to the opt-in controller view context" do
    controller_class = Class.new(ActionController::API) do
      include ExpoTurbo::Rails::Controller
    end
    controller = controller_class.new
    controller.request = ActionDispatch::TestRequest.create
    context = controller.view_context
    id = context.expo_turbo_dom_id(record, :frame)
    rendered = context.expo_turbo_frame_tag(id) { '<Room id="room_7"/>'.html_safe }

    expect(id).to eq("frame_room_7")
    expect(Nokogiri::XML(rendered.to_s) { |config| config.strict }.root["id"]).to eq(id)
    expect(context.expo_turbo_stream.remove(context.expo_turbo_dom_id(record)).to_s)
      .to eq('<turbo-stream action="remove" target="room_7"></turbo-stream>')
  end
end
