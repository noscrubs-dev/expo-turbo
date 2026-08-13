# frozen_string_literal: true

require "action_controller/api"
require "spec_helper"
require "support/rendering"
require "expo_turbo/rails/testing"

RSpec.describe "Expo Turbo format selection" do
  include ExpoTurboSpecRendering

  let(:controller_class) do
    Class.new(ActionController::API) do
      include ExpoTurbo::Rails::Controller
    end
  end

  # A browser may name the Expo Turbo media type at a lower quality than
  # text/html. Rails then renders HTML, and the helpers must render HTML too.
  it "keeps HTML helper behavior when Rails selected HTML" do
    context = negotiated_view_context("text/html, application/vnd.expo-turbo+xml;q=0.1")
    record = ExpoTurboFormatSpecRecord.new(7)

    expect(context.dom_id(record, :edit)).to eq("edit_demo_record_7")
    expect(stream_name(context.turbo_stream_from("room"))).to eq("room")
    expect(context.turbo_stream).not_to be_a(ExpoTurbo::Rails::Streams::TagBuilder)
  end

  # This request is a verified native request by Accept alone, and Rails still
  # selects HTML for it. The selected format has to win.
  it "keeps HTML helper behavior when Accept ties but Rails selected HTML" do
    accept = "text/html, #{ExpoTurbo::Rails::MIME_TYPE}"
    context = negotiated_view_context(accept)
    record = ExpoTurboFormatSpecRecord.new(7)

    expect(controller_with_accept(accept)).to be_expo_turbo_request
    expect(context.lookup_context.formats.first).to eq(:html)
    expect(context.dom_id(record, :edit)).to eq("edit_demo_record_7")
    expect(stream_name(context.turbo_stream_from("room"))).to eq("room")
    expect(context.turbo_stream).not_to be_a(ExpoTurbo::Rails::Streams::TagBuilder)
  end

  it "uses Expo Turbo helper behavior when Rails selected the Expo Turbo format" do
    context = negotiated_view_context(ExpoTurbo::Rails::MIME_TYPE)
    record = ExpoTurboFormatSpecRecord.new(7)

    expect(context.dom_id(record, :frame)).to eq("frame_demo_record_7")
    expect { context.dom_id(record, :edit) }.to raise_error(ArgumentError, /role/)
    expect(stream_name(context.turbo_stream_from("room"))).to eq("room:expo")
    expect(context.turbo_stream).to be_a(ExpoTurbo::Rails::Streams::TagBuilder)
  end

  # A Stream response shares its media type with the browser, so the selected
  # format cannot separate the two audiences and the Accept header decides.
  it "uses the Expo Turbo Stream builder only for a verified native Stream request" do
    native = negotiated_view_context(
      "#{ExpoTurbo::Rails::TURBO_STREAM_MIME_TYPE}, #{ExpoTurbo::Rails::MIME_TYPE}"
    )
    web = negotiated_view_context(
      "#{ExpoTurbo::Rails::TURBO_STREAM_MIME_TYPE}, text/html, application/vnd.expo-turbo+xml;q=0.1"
    )

    expect(native.turbo_stream).to be_a(ExpoTurbo::Rails::Streams::TagBuilder)
    expect(web.turbo_stream).not_to be_a(ExpoTurbo::Rails::Streams::TagBuilder)
  end

  it "does not treat a lower-quality Expo Turbo type as a native request" do
    [
      "text/html, application/vnd.expo-turbo+xml;q=0.1",
      "application/vnd.expo-turbo+xml;q=0.5, */*",
      "text/html;q=0.9, application/vnd.expo-turbo+xml;q=0.8"
    ].each do |accept|
      expect(controller_with_accept(accept)).not_to be_expo_turbo_request
    end
  end

  it "keeps a verified native Accept value native" do
    [
      ExpoTurbo::Rails::MIME_TYPE,
      "#{ExpoTurbo::Rails::TURBO_STREAM_MIME_TYPE}, #{ExpoTurbo::Rails::MIME_TYPE}",
      "application/vnd.expo-turbo+xml;q=1.0",
      "application/vnd.expo-turbo+xml;q=1"
    ].each do |accept|
      expect(controller_with_accept(accept)).to be_expo_turbo_request
    end
  end

  # An Accept value the server cannot parse must not switch the request into
  # fail-closed native negotiation.
  it "rejects a malformed quality value instead of assuming a native request" do
    [
      "application/vnd.expo-turbo+xml;q=0.5junk",
      "application/vnd.expo-turbo+xml;q=2",
      "application/vnd.expo-turbo+xml;q=1.5",
      "application/vnd.expo-turbo+xml;q=-1",
      "application/vnd.expo-turbo+xml;q=abc",
      "application/vnd.expo-turbo+xml;q=0.1234",
      "application/vnd.expo-turbo+xml;q="
    ].each do |accept|
      controller = controller_with_accept(accept)

      expect(controller).not_to be_expo_turbo_request
      expect(controller.expo_turbo_client_supports?("cart", ">= 1")).to be(true)
    end
  end

  # Last-wins on a repeated q would let a crafted Accept value flip the
  # classification by appending one parameter.
  it "rejects an entry that repeats its quality parameter" do
    [
      "text/html;q=0.5, application/vnd.expo-turbo+xml;q=0.1;q=0.9",
      "text/html;q=0.5, application/vnd.expo-turbo+xml;q=0.9;q=0.1",
      "application/vnd.expo-turbo+xml;q=1;q=1",
      "application/vnd.expo-turbo+xml;Q=0.9;q=0.9"
    ].each do |accept|
      expect(controller_with_accept(accept)).not_to be_expo_turbo_request
    end
  end

  it "keeps a single quality parameter beside other parameters" do
    [
      "application/vnd.expo-turbo+xml;q=0.9;charset=utf-8",
      "application/vnd.expo-turbo+xml;charset=utf-8;q=0.9"
    ].each do |accept|
      expect(controller_with_accept(accept)).to be_expo_turbo_request
    end
  end

  # A quoted parameter value that contains a semicolon is legal and no client
  # sends one. The server reads it as unusable rather than guessing, which
  # leaves the request non-native: the safe direction for syntax it cannot read.
  it "treats an unreadable quoted parameter as not native" do
    expect(controller_with_accept('application/vnd.expo-turbo+xml;profile="a;q=9"'))
      .not_to be_expo_turbo_request
  end

  it "ignores a malformed quality value on an unrelated media range" do
    controller = controller_with_accept("text/html;q=junk, #{ExpoTurbo::Rails::MIME_TYPE}")

    expect(controller).to be_expo_turbo_request
  end

  def stream_name(source)
    token = ExpoTurbo::Rails::Testing.parse_document(source.to_s).root["signed-stream-name"]
    ::Turbo::StreamsChannel.verified_stream_name(token)
  end

  def controller_with_accept(accept)
    controller = controller_class.new
    controller.request = ActionDispatch::TestRequest.create("HTTP_ACCEPT" => accept)
    controller.response = ActionDispatch::TestResponse.new
    controller
  end

  # Mirrors what ActionController::Rendering#process_action does, so the view
  # context sees the format Rails actually selected for the request.
  def negotiated_view_context(accept)
    controller = controller_with_accept(accept)
    controller.formats = controller.request.formats.filter_map(&:ref)
    controller.view_context
  end
end

class ExpoTurboFormatSpecRecord
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
