# frozen_string_literal: true

require "action_controller/api"
require "spec_helper"

RSpec.describe "Expo Turbo client descriptor negotiation" do
  let(:descriptor_grammar) do
    path = File.expand_path("../../../protocol/client-descriptor-grammar.json", __dir__)
    JSON.parse(File.read(path))
  end
  let(:controller_class) do
    Class.new(ActionController::API) do
      include ExpoTurbo::Rails::Controller

      self.expo_turbo_compatibility_registry = ExpoTurbo::Rails::CompatibilityRegistry.from_data(
        lock: {
          "lockVersion" => 1,
          "current" => "sha256-128:0123456789abcdef0123456789abcdef",
          "history" => [
            {
              "revision" => 7,
              "digest" => "sha256-128:0123456789abcdef0123456789abcdef",
              "published" => false
            },
            {
              "revision" => 8,
              "digest" => "sha256-128:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
              "published" => false
            }
          ]
        },
        vocabularies: {
          "sha256-128:0123456789abcdef0123456789abcdef" => {
            "DemoCard" => ["title", "subtitle"]
          },
          "sha256-128:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" => {"RemovedCard" => []}
        }
      )
    end
  end

  it "resolves a digest without carrying its revision on the wire" do
    descriptor = "v=1; proto=0.1; rt=0.4.0; vocab=sha256-128:0123456789abcdef0123456789abcdef"
    controller = native_controller("HTTP_X_EXPO_TURBO_CLIENT" => descriptor)

    expect(controller.expo_turbo_client_supports_component?("DemoCard")).to be(true)
    expect(controller.expo_turbo_client_supports_attribute?("DemoCard", "subtitle")).to be(true)
    expect(controller.expo_turbo_client_supports_component?("RemovedCard")).to be(false)
    expect(controller.expo_turbo_client_revision_satisfies?(">= 7")).to be(true)
    expect(controller.expo_turbo_client_revision_satisfies?(">= 8")).to be(false)
    expect(controller.response.headers["X-Expo-Turbo-Vocabulary"]).to eq("declared")
  end

  it "shares the exact descriptor grammar with the client" do
    descriptor_grammar.fetch("accepted").each do |descriptor|
      expect(ExpoTurbo::Rails::CompatibilityRegistry.parse_descriptor(descriptor)).to be_a(Hash)
    end
    descriptor_grammar.fetch("rejected").each do |descriptor|
      # Reverting strict field admission accepts the pinned wire revision or another invalid form.
      expect(ExpoTurbo::Rails::CompatibilityRegistry.parse_descriptor(descriptor)).to be_nil
    end
  end

  it "warns when a descriptor cannot resolve because lockfile configuration is missing" do
    unconfigured_class = Class.new(ActionController::API) do
      include ExpoTurbo::Rails::Controller

      expo_turbo_template_capabilities(components: {"DemoCard" => {}})
    end
    controller = unconfigured_class.new
    controller.request = ActionDispatch::TestRequest.create(
      "HTTP_ACCEPT" => ExpoTurbo::Rails::MIME_TYPE,
      "HTTP_X_EXPO_TURBO_CLIENT" => descriptor_grammar.fetch("emitted").fetch("withVocabulary")
    )
    controller.response = ActionDispatch::TestResponse.new
    logger = double
    allow(logger).to receive(:warn)
    allow(controller).to receive(:logger).and_return(logger)

    expect(controller.expo_turbo_client_supports_component?("DemoCard")).to be(false)
    expect(controller.expo_turbo_client_supports_attribute?("DemoCard", "title")).to be(false)
    expect(controller.expo_turbo_client_revision_satisfies?(">= 1")).to be(false)
    expect(controller.response.headers["X-Expo-Turbo-Vocabulary"]).to eq("assumed-none")
    # Reverting the warning makes a missing lockfile fail this diagnostic assertion.
    expect(logger).to have_received(:warn).with(/lockfile:/)
  end

  it "warns when a valid descriptor carries an unknown digest" do
    controller = native_controller(
      "HTTP_X_EXPO_TURBO_CLIENT" => "v=1; proto=0.1; rt=0.4.0; vocab=sha256-128:cccccccccccccccccccccccccccccccc"
    )
    logger = double
    allow(logger).to receive(:warn)
    allow(controller).to receive(:logger).and_return(logger)

    expect(controller.expo_turbo_client_supports_component?("DemoCard")).to be(false)
    expect(controller.expo_turbo_client_supports_attribute?("DemoCard", "title")).to be(false)
    expect(controller.expo_turbo_client_revision_satisfies?(">= 1")).to be(false)
    expect(controller.response.headers["X-Expo-Turbo-Vocabulary"]).to eq("assumed-none")
    # Reverting the warning makes an unknown deployment digest fail this diagnostic assertion.
    expect(logger).to have_received(:warn).with(/unknown vocabulary digest/)
  end

  it "rejects a module-scoped numeric gate for a resolved descriptor" do
    controller = native_controller(
      "HTTP_X_EXPO_TURBO_CLIENT" => descriptor_grammar.fetch("emitted").fetch("withVocabulary")
    )

    # Reverting the guard makes this unknown module return true at revision 7.
    expect { controller.expo_turbo_client_supports?("module-that-never-existed", ">= 1") }
      .to raise_error(ArgumentError, /revision/)
    expect(controller.expo_turbo_client_revision_satisfies?(">= 7")).to be(true)
    expect(controller.expo_turbo_client_revision_satisfies?(">= 8")).to be(false)
  end

  it "prefers the descriptor over a conflicting legacy modules header" do
    controller = native_controller(
      "HTTP_X_EXPO_TURBO_CLIENT" => "v=1; proto=0.1; rt=0.4.0; vocab=sha256-128:0123456789abcdef0123456789abcdef",
      "HTTP_X_EXPO_TURBO_MODULES" => "v1;cart=999"
    )

    expect { controller.expo_turbo_client_supports?("cart", ">= 999") }
      .to raise_error(ArgumentError, /revision/)
    expect(controller.expo_turbo_client_supports_component?("DemoCard")).to be(true)
  end

  it "keeps two resolved descriptor digests separate in fragment cache identity" do
    first = native_controller(
      "HTTP_X_EXPO_TURBO_CLIENT" => "v=1; proto=0.1; rt=0.4.0; vocab=sha256-128:0123456789abcdef0123456789abcdef"
    )
    second = native_controller(
      "HTTP_X_EXPO_TURBO_CLIENT" => "v=1; proto=0.1; rt=0.4.0; vocab=sha256-128:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    )

    expect(first.expo_turbo_cache_variant).not_to eq(second.expo_turbo_cache_variant)
    expect(first.expo_turbo_client_supports_component?("RemovedCard")).to be(false)
    expect(second.expo_turbo_client_supports_component?("RemovedCard")).to be(true)
  end

  it "keeps the 0.2 modules header as an old-client fallback for one minor" do
    controller = native_controller("HTTP_X_EXPO_TURBO_MODULES" => "v1;cart=2")

    expect(controller.expo_turbo_client_supports?("cart", ">= 2")).to be(true)
    expect(controller.expo_turbo_client_supports?("cart", ">= 3")).to be(false)
    expect(controller.expo_turbo_client_supports_component?("DemoCard")).to be(false)
    expect(controller.response.headers["X-Expo-Turbo-Vocabulary"]).to eq("legacy-declared")
  end

  it "treats an explicit Expo Turbo Accept value as a verified native request" do
    [
      ExpoTurbo::Rails::MIME_TYPE,
      "#{ExpoTurbo::Rails::TURBO_STREAM_MIME_TYPE}, #{ExpoTurbo::Rails::MIME_TYPE}",
      "APPLICATION/VND.EXPO-TURBO+XML;q=0.4"
    ].each do |accept|
      expect(controller_with_request("HTTP_ACCEPT" => accept)).to be_expo_turbo_request
    end

    [
      nil,
      "",
      "*/*",
      "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "application/*",
      "application/vnd.expo-turbo+xml;q=0",
      "application/vnd.expo-turbo+xml-other"
    ].each do |accept|
      expect(controller_with_request("HTTP_ACCEPT" => accept)).not_to be_expo_turbo_request
    end
  end

  it "fails closed when a verified native request omits the module header" do
    controller = native_controller

    expect(controller.expo_turbo_client_modules).to eq({})
    expect(controller.expo_turbo_client_supports?("future-module", ">= 999")).to be(false)
    expect(controller.expo_turbo_client_supports?("cart", ">= 0")).to be(false)
    expect(controller.response.headers["X-Expo-Turbo-Vocabulary"]).to eq("assumed-none")
  end

  it "fails closed when a verified native request sends a malformed module envelope" do
    ["", "v2;cart=1", "\xFF".b].each do |header|
      controller = native_controller("HTTP_X_EXPO_TURBO_MODULES" => header)
      allow(controller).to receive(:logger).and_return(double(warn: nil))

      expect(controller.expo_turbo_client_modules).to eq({})
      expect(controller.expo_turbo_client_supports?("cart", ">= 0")).to be(false)
      expect(controller.response.headers["X-Expo-Turbo-Vocabulary"]).to eq("assumed-none")
    end
  end

  it "uses the declared vocabulary of a verified native request" do
    controller = native_controller("HTTP_X_EXPO_TURBO_MODULES" => "v1;cart=2")

    expect(controller.expo_turbo_client_supports?("cart", ">= 2")).to be(true)
    expect(controller.expo_turbo_client_supports?("cart", ">= 3")).to be(false)
    expect(controller.expo_turbo_client_supports?("missing", ">= 0")).to be(false)
    expect(controller.response.headers["X-Expo-Turbo-Vocabulary"]).to eq("legacy-declared")
  end

  it "keeps the fail-open assumption for a request that does not accept Expo Turbo" do
    controller = controller_with_request

    expect(controller.expo_turbo_client_supports?("future-module", ">= 999")).to be(true)
    expect(controller.response.headers["X-Expo-Turbo-Vocabulary"]).to eq("assumed-latest")
  end

  it "separates conditional validators for an assumed and a declared vocabulary" do
    assumed_none = native_controller
    assumed_latest = controller_with_request
    declared = native_controller("HTTP_X_EXPO_TURBO_MODULES" => "v1;cart=2")

    variants = [assumed_none, assumed_latest, declared].map(&:expo_turbo_cache_variant)

    expect(variants.uniq.length).to eq(3)
  end

  it "rejects a blank module name instead of answering for it" do
    [native_controller, controller_with_request].each do |controller|
      ["", " ", "　"].each do |module_name|
        expect { controller.expo_turbo_client_supports?(module_name, ">= 1") }
          .to raise_error(ArgumentError, /module_name/)
      end
    end
  end

  it "does not swallow a logger failure while it reports malformed module data" do
    controller = native_controller("HTTP_X_EXPO_TURBO_MODULES" => "v1;cart=2,bad=v2")
    logger = double
    allow(logger).to receive(:warn).and_raise(IOError, "log sink is gone")
    allow(controller).to receive(:logger).and_return(logger)

    expect { controller.expo_turbo_client_modules }.to raise_error(IOError)
  end

  it "does not swallow a logger failure while it reports a malformed module envelope" do
    controller = native_controller("HTTP_X_EXPO_TURBO_MODULES" => "v2;cart=1")
    logger = double
    allow(logger).to receive(:warn).and_raise(IOError, "log sink is gone")
    allow(controller).to receive(:logger).and_return(logger)

    expect { controller.expo_turbo_client_modules }.to raise_error(IOError)
  end

  def controller_with_request(headers = {})
    controller = controller_class.new
    controller.request = ActionDispatch::TestRequest.create(headers)
    controller.response = ActionDispatch::TestResponse.new
    controller
  end

  def native_controller(headers = {})
    controller_with_request({"HTTP_ACCEPT" => ExpoTurbo::Rails::MIME_TYPE}.merge(headers))
  end
end
