# frozen_string_literal: true

require "action_controller/api"
require "spec_helper"
require "support/rendering"
require "expo_turbo/rails/testing"

class ExpoTurboFrameHelperSpecRecord
  ModelName = Struct.new(:param_key)

  def self.model_name
    @model_name ||= ModelName.new("demo_record")
  end
end

RSpec.describe ExpoTurbo::Rails::Controller do
  include ExpoTurboSpecRendering

  let(:controller_class) do
    Class.new(ActionController::API) do
      include ExpoTurbo::Rails::Controller

      expo_turbo_template_capabilities(
        components: {
          "Demo:Screen" => {},
          "Demo:Text" => {},
          "DemoText" => {},
          "Screen" => {},
          "Text" => {}
        }
      )

      def show
        render "specs/show"
      end
    end
  end

  # An HTML template may answer an Expo Turbo render, and the vocabulary rules
  # do not relax for it. Full coverage lives in template_fallback_spec.rb.
  it "admits an HTML template that answered an Expo Turbo render against the same vocabulary" do
    with_templates(controller_class, "specs/show.html.erb" => "<p>HTML</p>") do
      expect { render_document }.to raise_error(
        ExpoTurbo::Rails::TemplateError,
        "Expo Turbo templates must use declared components and valid style tokens"
      )
    end
  end

  it "requires declared capabilities before it delivers an Expo Turbo response" do
    unconfigured_controller = Class.new(ActionController::API) do
      include ExpoTurbo::Rails::Controller

      def show
        render "specs/show"
      end
    end

    with_templates(unconfigured_controller, "specs/show.expo_turbo.erb" => "<DemoScreen/>") do
      expect { dispatch(unconfigured_controller) }.to raise_error(
        ExpoTurbo::Rails::ConfigurationError,
        "configure expo_turbo_template_capabilities before rendering Expo Turbo templates"
      )
    end
  end

  it "redacts semantic template admission failures" do
    controller_class.expo_turbo_template_capabilities(components: {"DemoScreen" => {}})

    with_templates(
      controller_class,
      "specs/show.expo_turbo.erb" => '<DemoScreen><PrivateComponent secret="value"/></DemoScreen>'
    ) do
      expect { render_document }
        .to raise_error(ExpoTurbo::Rails::TemplateError, "Expo Turbo templates must use declared components and valid style tokens") { |error|
          expect(error.message).not_to include("PrivateComponent", "secret", "value")
        }
    end
  end

  it "renders a strict host XML document without changing its output" do
    template = <<~XML
      <?xml version="1.0" encoding="UTF-8"?>
      <Demo:Screen xmlns:Demo="urn:expo-demo" xml:space="preserve"><Demo:Text>first\r
      second\rthird</Demo:Text></Demo:Screen>
    XML

    with_templates(controller_class, "specs/show.expo_turbo.erb" => template) do
      status, headers, body = render_document
      document = ExpoTurbo::Rails::Testing.parse_document(body)
      text = document.at_xpath("/Demo:Screen/Demo:Text", "Demo" => "urn:expo-demo")

      expect(status).to eq(200)
      expect(headers.fetch("content-type")).to start_with(ExpoTurbo::Rails::MIME_TYPE)
      expect(body).to include("xml:space=\"preserve\"><Demo:Text>first\nsecond\rthird")
      expect(document.root["xml:space"]).to eq("preserve")
      expect(text.text).to eq("first\nsecond\nthird")
    end
  end

  it "escapes and preserves whitespace in XML attribute values" do
    controller = controller_with_request
    value = "first\r\nsecond\t<&\"'"
    body = controller.render_to_string(
      inline: '<Text value="<%= expo_turbo_attribute(value) %>"/>',
      type: :erb,
      formats: [:xml],
      layout: false,
      locals: {value:}
    )
    document = ExpoTurbo::Rails::Testing.parse_document(body)

    expect(body).to eq('<Text value="first&#13;&#10;second&#9;&lt;&amp;&quot;&#39;"/>')
    expect(document.root["value"]).to eq(value)
    expect(controller.view_context.expo_turbo_attribute(value)).to be_html_safe
  end

  it "rejects malformed host XML documents without exposing template source" do
    invalid_templates = [
      "<Demo:Screen><Demo:Text></Demo:Screen>",
      "<Demo:Screen/><Other/>",
      "<Demo:Screen><Demo:Text id=\"first\" id=\"second\"/></Demo:Screen>",
      "<Demo:Screen><Demo:Text/></Demo:Screen><?build secret?>",
      "<!DOCTYPE Demo [<!ENTITY secret \"not-for-errors\">]><Demo:Screen/>",
      "<?xml version=\"1.0\" encoding=\"ISO-8859-1\"?><Demo:Screen/>",
      "<Demo:Screen><Demo:Text/></Demo:Screen>"
    ]

    invalid_templates.each do |template|
      with_templates(controller_class, "specs/show.expo_turbo.erb" => template) do
        expect { render_document }
          .to raise_error(ExpoTurbo::Rails::TemplateError) { |error|
            expect(error.message).to eq("Expo Turbo templates must render well-formed UTF-8 XML")
            expect(error.message).not_to include("Demo:Text", "not-for-errors", "secret")
          }
      end
    end
  end

  it "rejects blank and duplicate literal document IDs without exposing template source" do
    invalid_templates = [
      '<Screen id=" "><Text /></Screen>',
      '<Screen id="&#xFEFF;"><Text /></Screen>',
      '<Screen><Text id="same"/><Card id="same"/></Screen>',
      '<Screen><turbo-frame id="same"/><turbo-frame id="same"/></Screen>'
    ]

    invalid_templates.each do |template|
      with_templates(controller_class, "specs/show.expo_turbo.erb" => template) do
        expect { render_document }
          .to raise_error(ExpoTurbo::Rails::TemplateError, "Expo Turbo templates must use unique nonblank literal ids") { |error|
            expect(error.message).not_to include("same", "Text")
          }
      end
    end
  end

  it "does not treat namespaced id attributes as literal document IDs" do
    template = '<Screen xmlns:meta="urn:metadata"><Text meta:id=""/></Screen>'

    with_templates(controller_class, "specs/show.expo_turbo.erb" => template) do
      status, = render_document

      expect(status).to eq(200)
    end
  end

  it "keeps literal ID blankness aligned with the native ECMAScript parser" do
    with_templates(controller_class, "specs/show.expo_turbo.erb" => '<Screen id="&#x85;"/>') do
      status, = render_document

      expect(status).to eq(200)
    end
  end

  it "delegates literal Frame tags to turbo-rails from API view contexts" do
    controller = controller_class.new
    controller.request = ActionDispatch::TestRequest.create("HTTP_ACCEPT" => ExpoTurbo::Rails::MIME_TYPE)
    controller.formats = controller.request.formats.filter_map(&:ref)
    rendered = controller.view_context.turbo_frame_tag(
      "details",
      src: "/frames/details",
      target: "sidebar",
      loading: :lazy
    ) { '<DemoText id="loaded">Loaded</DemoText>'.html_safe }
    frame = Nokogiri::XML(rendered.to_s) { |config| config.strict }.root

    expect(frame.name).to eq("turbo-frame")
    expect(frame["id"]).to eq("details")
    expect(frame["src"]).to eq("/frames/details")
    expect(frame["target"]).to eq("sidebar")
    expect(frame["loading"]).to eq("lazy")
    expect(frame.at_xpath("./DemoText")&.text).to eq("Loaded")
  end

  it "normalizes model classes to Turbo Frame IDs from API view contexts" do
    controller = controller_class.new
    controller.request = ActionDispatch::TestRequest.create("HTTP_ACCEPT" => ExpoTurbo::Rails::MIME_TYPE)
    controller.formats = controller.request.formats.filter_map(&:ref)
    rendered = controller.view_context.turbo_frame_tag(ExpoTurboFrameHelperSpecRecord)
    frame = Nokogiri::XML(rendered.to_s) { |config| config.strict }.root

    expect(frame["id"]).to eq("new_demo_record")
  end

  it "requires self-contained XML Frame fragments without changing preserved text" do
    controller = controller_class.new
    controller.request = ActionDispatch::TestRequest.create("HTTP_ACCEPT" => ExpoTurbo::Rails::MIME_TYPE)
    controller.formats = controller.request.formats.filter_map(&:ref)
    calls = 0
    rendered = controller.view_context.turbo_frame_tag("details") do
      calls += 1
      "<Demo:Text xmlns:Demo=\"urn:expo-demo\" xml:space=\"preserve\">first\r\nsecond\rthird</Demo:Text>".html_safe
    end
    frame = ExpoTurbo::Rails::Testing.parse_document(rendered.to_s).root
    text = frame.at_xpath("./Demo:Text", "Demo" => "urn:expo-demo")

    expect(calls).to eq(1)
    expect(text["xml:space"]).to eq("preserve")
    expect(text.text).to eq("first\nsecond\nthird")
  end

  it "rejects malformed Frame markup without exposing its source" do
    controller = controller_class.new
    controller.request = ActionDispatch::TestRequest.create("HTTP_ACCEPT" => ExpoTurbo::Rails::MIME_TYPE)
    controller.formats = controller.request.formats.filter_map(&:ref)

    [
      "<Demo:Text/>",
      "<?xml version=\"1.0\"?><DemoText/>",
      "<!DOCTYPE Demo [<!ENTITY secret \"not-for-errors\">]><DemoText/>",
      "<?build data?><DemoText/>"
    ].each do |markup|
      expect {
        controller.view_context.turbo_frame_tag("details") { markup.html_safe }
      }.to raise_error(ExpoTurbo::Rails::TemplateError) { |error| expect(error.message).not_to include("Demo:Text", "not-for-errors") }
    end
  end

  it "allows unprefixed Frame tags in a default namespace" do
    controller = controller_class.new
    controller.request = ActionDispatch::TestRequest.create("HTTP_ACCEPT" => ExpoTurbo::Rails::MIME_TYPE)
    controller.formats = controller.request.formats.filter_map(&:ref)
    rendered = controller.view_context.turbo_frame_tag("details", xmlns: "urn:expo-test")
    frame = ExpoTurbo::Rails::Testing.parse_document(rendered.to_s).root

    expect(frame.name).to eq("turbo-frame")
    expect(frame.namespace.href).to eq("urn:expo-test")
  end

  it "rejects invalid Expo Turbo Frame IDs" do
    context = expo_turbo_view_context(controller_class)
    invalid_ids = [nil, "", "  ", "\u2003", "details\nnext", "\uFFFE", "\uFFFF", "\xFF".dup.force_encoding(Encoding::UTF_8)]

    invalid_ids.each do |id|
      expect { context.turbo_frame_tag(id) }
        .to raise_error(ExpoTurbo::Rails::TemplateError, /Frame id/)
    end

    # turbo-rails normalizes a Symbol id, and the Expo Turbo branch keeps that.
    expect(context.turbo_frame_tag(:details).to_s).to include('id="details"')
  end

  it "normalizes Rack's binary Turbo-Frame header" do
    controller = controller_with_request("HTTP_TURBO_FRAME" => "details".b)

    expect(controller.request.get_header("HTTP_TURBO_FRAME").encoding).to eq(Encoding::ASCII_8BIT)

    frame_id = controller.expo_turbo_frame_request_id
    expect(frame_id).to eq("details")
    expect(frame_id.encoding).to eq(Encoding::UTF_8)

    controller.request.set_header("HTTP_TURBO_FRAME", "\xFF".b)
    expect(controller.expo_turbo_frame_request_id).to be_nil
  end

  it "exposes only valid Frame request headers without including HTML Frame layout behavior" do
    controller = controller_class.new
    controller.request = ActionDispatch::TestRequest.create("HTTP_TURBO_FRAME" => "details")

    expect(controller.expo_turbo_frame_request_id).to eq("details")
    expect(controller).to be_expo_turbo_frame_request
    expect(controller.view_context.expo_turbo_frame_request_id).to eq("details")
    expect(controller.view_context).to be_expo_turbo_frame_request
    expect(controller_class.ancestors).not_to include(Turbo::Frames::FrameRequest)

    controller.request.headers["Turbo-Frame"] = "details\u0000invalid"

    expect(controller.expo_turbo_frame_request_id).to be_nil
    expect(controller).not_to be_expo_turbo_frame_request
  end

  it "decodes module versions for document and Frame requests and exposes them to views" do
    headers = {
      "HTTP_ACCEPT" => ExpoTurbo::Rails::MIME_TYPE,
      "HTTP_X_EXPO_TURBO_MODULES" => "v1;Module%C3%A9=2.1.0,noscrubs-cart=3"
    }
    document = controller_with_request(headers)
    frame = controller_with_request(headers.merge("HTTP_TURBO_FRAME" => "details"))

    [document, frame].each do |controller|
      expect(controller.expo_turbo_client_modules).to eq("Moduleé" => "2.1.0", "noscrubs-cart" => "3")
      expect(controller.expo_turbo_client_supports?("noscrubs-cart", ">= 2")).to be(true)
      expect(controller.expo_turbo_client_supports?("noscrubs-cart", ">= 4")).to be(false)
      expect(controller.expo_turbo_client_supports?("missing", ">= 1")).to be(false)
      expect(controller.view_context.expo_turbo_client_modules).to eq(controller.expo_turbo_client_modules)
      expect(controller.view_context.expo_turbo_client_supports?("Moduleé", "~> 2.0")).to be(true)
    end
  end

  it "assumes latest capabilities only for a request that does not accept Expo Turbo" do
    absent_document = controller_with_request("HTTP_ACCEPT" => ExpoTurbo::Rails::MIME_TYPE)
    absent_frame = controller_with_request("HTTP_TURBO_FRAME" => "details")

    expect(absent_document.expo_turbo_client_modules).to eq({})
    expect(absent_document.expo_turbo_client_supports?("future-module", ">= 999")).to be(false)
    expect(absent_frame.expo_turbo_client_modules).to eq({})
    expect(absent_frame.expo_turbo_client_supports?("future-module", ">= 999")).to be(true)

    ["", "v2;cart=1", "\xFF".b].each do |header|
      controller = controller_with_request("HTTP_X_EXPO_TURBO_MODULES" => header)
      allow(controller).to receive(:logger).and_return(double(warn: nil))

      expect { controller.expo_turbo_client_modules }.not_to raise_error
      expect(controller.expo_turbo_client_modules).to eq({})
      expect(controller.expo_turbo_client_supports?("future-module", ">= 999")).to be(true)

      native = controller_with_request(
        "HTTP_ACCEPT" => ExpoTurbo::Rails::MIME_TYPE,
        "HTTP_X_EXPO_TURBO_MODULES" => header
      )
      allow(native).to receive(:logger).and_return(double(warn: nil))

      expect(native.expo_turbo_client_supports?("future-module", ">= 999")).to be(false)
    end
  end

  it "drops malformed module entries without discarding valid negotiation" do
    controller = controller_with_request(
      "HTTP_X_EXPO_TURBO_MODULES" => "v1;cart=2,bad-version=v2,bad%00name=1,other=3%0A,cart=4"
    )
    logger = double
    allow(logger).to receive(:warn)
    allow(controller).to receive(:logger).and_return(logger)

    expect(controller.expo_turbo_client_modules).to eq("cart" => "2")
    expect(controller.expo_turbo_client_supports?("cart", ">= 2")).to be(true)
    expect(controller.expo_turbo_client_supports?("bad-version", ">= 1")).to be(false)
    expect(logger).to have_received(:warn).with("Expo Turbo ignored 4 malformed X-Expo-Turbo-Modules entries")

    empty_registry = controller_with_request("HTTP_X_EXPO_TURBO_MODULES" => "v1;")
    expect(empty_registry.expo_turbo_client_supports?("future-module", ">= 1")).to be(false)

    ["v1;cart", "v1;cart=%ZZ", "v1;=1", "v1;cart=not-a-version"].each do |header|
      malformed = controller_with_request("HTTP_X_EXPO_TURBO_MODULES" => header)
      allow(malformed).to receive(:logger).and_return(double(warn: nil))

      expect { malformed.expo_turbo_client_modules }.not_to raise_error
      expect(malformed.expo_turbo_client_modules).to eq({})
      expect(malformed.expo_turbo_client_supports?("cart", ">= 0")).to be(false)
    end
  end

  it "supports comma-separated requirement clauses" do
    native = controller_with_request("HTTP_X_EXPO_TURBO_MODULES" => "v1;cart=2")
    web = controller_with_request

    expect(native.expo_turbo_client_supports?("cart", ">= 1, < 3")).to be(true)
    expect(native.expo_turbo_client_supports?("cart", ">= 1, < 2")).to be(false)
    expect(web.expo_turbo_client_supports?("cart", ">= 1, < 3")).to be(true)
    expect { native.expo_turbo_client_supports?("cart", ">= 1,") }.to raise_error(ArgumentError)
  end

  it "raises for invalid requirement queries before applying web fail-open behavior" do
    native = controller_with_request("HTTP_X_EXPO_TURBO_MODULES" => "v1;cart=2")
    web = controller_with_request

    [native, web].each do |controller|
      expect { controller.expo_turbo_client_supports?("cart", "") }.to raise_error(ArgumentError)
      expect { controller.expo_turbo_client_supports?("cart", "  ") }.to raise_error(ArgumentError)
      expect { controller.expo_turbo_client_supports?("cart", "not a requirement") }.to raise_error(ArgumentError)
      expect { controller.expo_turbo_client_supports?(:cart, ">= 1") }.to raise_error(ArgumentError)
    end
  end

  it "builds distinct conditional cache keys for documents and each valid Frame" do
    document = controller_with_request
    details = controller_with_request("HTTP_TURBO_FRAME" => "details")
    sidebar = controller_with_request("HTTP_TURBO_FRAME" => "sidebar")
    invalid = controller_with_request("HTTP_TURBO_FRAME" => "details\u0000invalid")

    expect(document.expo_turbo_cache_key("account")).to eq(["account", :expo_turbo, :document, :modules, :latest])
    expect(details.expo_turbo_cache_key("account")).to eq(["account", :expo_turbo, :frame, "details", :modules, :latest])
    expect(sidebar.expo_turbo_cache_key("account")).to eq(["account", :expo_turbo, :frame, "sidebar", :modules, :latest])
    expect(invalid.expo_turbo_cache_key("account")).to eq(["account", :expo_turbo, :document, :modules, :latest])
    expect(document.response.headers["Vary"]).to eq("Accept, Turbo-Frame, X-Expo-Turbo-Modules")
  end

  it "keeps document and Frame ETags distinct through Rails conditional GET" do
    document_etag = conditional_etag(controller_with_request)
    details_etag = conditional_etag(controller_with_request("HTTP_TURBO_FRAME" => "details"))
    sidebar_etag = conditional_etag(controller_with_request("HTTP_TURBO_FRAME" => "sidebar"))

    expect(document_etag).not_to eq(details_etag)
    expect(details_etag).not_to eq(sidebar_etag)
  end

  it "does not accept a document validator for a Frame response" do
    document_etag = conditional_etag(controller_with_request)
    frame = controller_with_request(
      "HTTP_TURBO_FRAME" => "details",
      "HTTP_IF_NONE_MATCH" => document_etag
    )

    frame.fresh_when etag: frame.expo_turbo_cache_key("account")

    expect(frame.response.status).not_to eq(304)
  end

  it "retains the host representation version in conditional validators" do
    first_version = conditional_etag(controller_with_request, representation: "accounts/details-v1")
    next_version = conditional_etag(controller_with_request, representation: "accounts/details-v2")

    expect(first_version).not_to eq(next_version)
  end

  it "builds distinct conditional validators for reported module versions" do
    first = conditional_etag(controller_with_request("HTTP_X_EXPO_TURBO_MODULES" => "v1;cart=1"))
    next_version = conditional_etag(controller_with_request("HTTP_X_EXPO_TURBO_MODULES" => "v1;cart=2"))

    expect(first).not_to eq(next_version)
  end

  it "keeps encoded module names unambiguous in Rails cache keys" do
    legitimate = controller_with_request("HTTP_X_EXPO_TURBO_MODULES" => "v1;a=1,b=2")
    slash_name = controller_with_request("HTTP_X_EXPO_TURBO_MODULES" => "v1;a%2F1%2Fb=2")

    legitimate_key = ActiveSupport::Cache.expand_cache_key(legitimate.expo_turbo_cache_variant)
    slash_name_key = ActiveSupport::Cache.expand_cache_key(slash_name.expo_turbo_cache_variant)

    expect(legitimate_key).not_to eq(slash_name_key)
    expect(conditional_etag(legitimate)).not_to eq(conditional_etag(slash_name))
  end

  it "canonicalizes module whitespace before it reaches cache keys" do
    canonical = controller_with_request("HTTP_X_EXPO_TURBO_MODULES" => "v1;cart=1")
    padded = controller_with_request("HTTP_X_EXPO_TURBO_MODULES" => "v1;%20cart%20=%20%201%20")

    expect(padded.expo_turbo_client_modules).to eq("cart" => "1")
    expect(padded.expo_turbo_cache_variant).to eq(canonical.expo_turbo_cache_variant)
  end

  it "merges the Expo Turbo cache variation without replacing existing Vary values" do
    controller = controller_with_request
    controller.response.set_header "Vary", "Accept-Encoding, turbo-frame"

    expect(controller.expo_turbo_vary!).to eq("Accept-Encoding, turbo-frame, Accept, X-Expo-Turbo-Modules")
    expect(controller.response.headers["Vary"]).to eq("Accept-Encoding, turbo-frame, Accept, X-Expo-Turbo-Modules")

    controller.response.set_header "Vary", "*"

    expect(controller.expo_turbo_vary!).to eq("*")
  end

  it "retains Rails' Accept cache variation when the request negotiated a format" do
    controller = controller_with_request("HTTP_ACCEPT" => ExpoTurbo::Rails::MIME_TYPE)

    controller.expo_turbo_vary!

    expect(controller.response.headers["Vary"]).to eq("Accept, Turbo-Frame, X-Expo-Turbo-Modules")
  end

  it "rejects a non-Stream response fragment before delivery" do
    stream_controller = Class.new(ActionController::API) do
      include ExpoTurbo::Rails::Controller

      expo_turbo_template_capabilities(components: {"DemoText" => {}})

      def show
        render turbo_stream: '<Demo:Text xmlns:Demo="urn:expo-demo">not a Stream</Demo:Text>'
      end
    end

    expect { dispatch(stream_controller) }
      .to raise_error(ExpoTurbo::Rails::TemplateError, /well-formed XML Stream fragments/)
  end

  it "validates Frame and Stream helper output against configured capabilities" do
    controller_class.expo_turbo_template_capabilities(components: {"DemoText" => {}})
    context = expo_turbo_view_context(controller_class)

    expect {
      context.turbo_frame_tag("details") { "<PrivateComponent/>".html_safe }
    }.to raise_error(ExpoTurbo::Rails::TemplateError, "Expo Turbo templates must use declared components and valid style tokens")
    expect {
      context.turbo_stream.append("details", "<PrivateComponent/>")
    }.to raise_error(ExpoTurbo::Rails::TemplateError, "Expo Turbo templates must use declared components and valid style tokens")
  end

  it "validates raw controller broadcast payloads against configured capabilities" do
    controller_class.expo_turbo_template_capabilities(components: {"DemoText" => {}})
    controller = controller_with_request
    payload = '<turbo-stream action="append" target="details"><template><PrivateComponent secret="value"/></template></turbo-stream>'

    expect {
      controller.broadcast_expo_turbo_stream_to("details", content: payload)
    }.to raise_error(ExpoTurbo::Rails::TemplateError, "Expo Turbo templates must use declared components and valid style tokens") { |error|
      expect(error.message).not_to include("PrivateComponent", "secret", "value")
    }
    expect {
      controller.broadcast_expo_turbo_stream_later_to("details", content: payload)
    }.to raise_error(ExpoTurbo::Rails::TemplateError, "Expo Turbo templates must use declared components and valid style tokens")
  end

  def controller_with_request(headers = {})
    controller = controller_class.new
    controller.request = ActionDispatch::TestRequest.create(headers)
    controller.response = ActionDispatch::TestResponse.new
    controller
  end

  def render_document(headers = {})
    dispatch(controller_class, headers: headers)
  end

  def conditional_etag(controller, representation: "accounts/details-v1")
    controller.fresh_when etag: controller.expo_turbo_cache_key("account", representation)
    controller.response.headers.fetch("ETag")
  end
end
