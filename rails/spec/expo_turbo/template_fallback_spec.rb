# frozen_string_literal: true

require "action_controller/api"
require "spec_helper"
require "support/rendering"

# One template can serve both audiences. Rails finds it through ordinary
# lookup: the Expo Turbo format is tried first and `.html.erb` answers when no
# Expo Turbo template exists. The format Rails selected, not the extension of
# the file that answered, decides the media type, the helper branch, and
# whether the protocol admits the result.
RSpec.describe "Expo Turbo template fallback" do
  include ExpoTurboSpecRendering

  let(:controller_class) do
    Class.new(ActionController::API) do
      def self.name = "ExpoTurboFallbackSpecController"

      expo_turbo_template_capabilities(components: {"Screen" => {children: "nodes"}, "Text" => {children: "text"}})

      def show
        render "specs/show"
      end
    end
  end

  it "answers an Expo Turbo request from an HTML template when no Expo Turbo template exists" do
    with_templates(controller_class, "specs/show.html.erb" => %(<Screen id="a"><Text id="b">shared</Text></Screen>)) do
      status, _headers, body = dispatch(controller_class)

      expect(status).to eq(200)
      expect(body).to eq(%(<Screen id="a"><Text id="b">shared</Text></Screen>))
    end
  end

  it "labels an HTML template that answered an Expo Turbo request with the Expo Turbo media type" do
    with_templates(controller_class, "specs/show.html.erb" => %(<Screen id="a"/>)) do
      _status, headers, _body = dispatch(controller_class)

      expect(headers["Content-Type"]).to eq("#{ExpoTurbo::Rails::MIME_TYPE}; charset=utf-8")
    end
  end

  it "admits an HTML template that answered an Expo Turbo request against the protocol vocabulary" do
    with_templates(controller_class, "specs/show.html.erb" => "<div>HTML</div>") do
      expect { dispatch(controller_class) }.to raise_error(
        ExpoTurbo::Rails::TemplateError,
        "Expo Turbo templates must use declared components and valid style tokens"
      )
    end
  end

  it "rejects ill-formed XML from an HTML template that answered an Expo Turbo request" do
    with_templates(controller_class, "specs/show.html.erb" => %(<Screen id="a"><br></Screen>)) do
      expect { dispatch(controller_class) }.to raise_error(
        ExpoTurbo::Rails::TemplateError,
        "Expo Turbo templates must render well-formed UTF-8 XML"
      )
    end
  end

  it "prefers the Expo Turbo template over the HTML template when both exist" do
    with_templates(
      controller_class,
      "specs/show.html.erb" => %(<Screen id="html"/>),
      "specs/show.expo_turbo.erb" => %(<Screen id="expo"/>)
    ) do
      _status, _headers, body = dispatch(controller_class)

      expect(body).to eq(%(<Screen id="expo"/>))
    end
  end

  it "prefers the Expo Turbo partial over the HTML partial of the same name" do
    with_templates(
      controller_class,
      "specs/show.expo_turbo.erb" => %(<Screen id="a"><%= render partial: "specs/row" %></Screen>),
      "specs/_row.html.erb" => %(<Text id="html">html</Text>),
      "specs/_row.expo_turbo.erb" => %(<Text id="expo">expo</Text>)
    ) do
      _status, _headers, body = dispatch(controller_class)

      expect(body).to eq(%(<Screen id="a"><Text id="expo">expo</Text></Screen>))
    end
  end

  it "answers an Expo Turbo render from an HTML partial when no Expo Turbo partial exists" do
    with_templates(
      controller_class,
      "specs/show.expo_turbo.erb" => %(<Screen id="a"><%= render partial: "specs/row" %></Screen>),
      "specs/_row.html.erb" => %(<Text id="html">html</Text>)
    ) do
      _status, _headers, body = dispatch(controller_class)

      expect(body).to eq(%(<Screen id="a"><Text id="html">html</Text></Screen>))
    end
  end

  it "leaves an HTML request on the HTML template, unlabelled and unadmitted" do
    with_templates(controller_class, "specs/show.html.erb" => "<div>HTML</div>") do
      status, headers, body = dispatch(controller_class, headers: {"HTTP_ACCEPT" => "text/html"})

      expect(status).to eq(200)
      expect(headers["Content-Type"]).to eq("text/html; charset=utf-8")
      expect(body).to eq("<div>HTML</div>")
    end
  end

  it "takes the Expo Turbo helper branch inside an HTML template that answered an Expo Turbo request" do
    with_templates(controller_class, "specs/show.html.erb" => %(<%= turbo_frame_tag "" %>)) do
      expect { dispatch(controller_class) }.to raise_error(ActionView::Template::Error) { |error|
        expect(error.cause).to be_a(ExpoTurbo::Rails::TemplateError)
        expect(error.message).to eq("Expo Turbo Frame id must be a nonblank UTF-8 string without control characters")
      }
    end
  end

  it "leaves the same helper on its turbo-rails branch for an HTML request" do
    with_templates(controller_class, "specs/show.html.erb" => %(<%= turbo_frame_tag "" %>)) do
      _status, _headers, body = dispatch(controller_class, headers: {"HTTP_ACCEPT" => "text/html"})

      expect(body).to eq(%(<turbo-frame id=""></turbo-frame>))
    end
  end

  it "falls back for an explicit respond_to branch" do
    respond_to_controller = Class.new(ActionController::API) do
      include ActionController::MimeResponds

      def self.name = "ExpoTurboFallbackSpecRespondToController"

      expo_turbo_template_capabilities(components: {"Screen" => {children: "nodes"}})

      def show
        respond_to do |format|
          format.html { render "specs/show" }
          format.expo_turbo { render "specs/show" }
        end
      end
    end

    with_templates(respond_to_controller, "specs/show.html.erb" => %(<Screen id="a"/>)) do
      status, headers, body = dispatch(respond_to_controller)

      expect(status).to eq(200)
      expect(headers["Content-Type"]).to eq("#{ExpoTurbo::Rails::MIME_TYPE}; charset=utf-8")
      expect(body).to eq(%(<Screen id="a"/>))
    end
  end

  # An .html template that answered keeps its own format at the front of
  # lookup, because ActionView prepends the format of the template it found.
  # The partials of a shared HTML template are therefore the HTML partials.
  it "renders the HTML partial from inside a shared HTML template" do
    with_templates(
      controller_class,
      "specs/show.html.erb" => %(<Screen id="a"><%= render partial: "specs/row" %></Screen>),
      "specs/_row.html.erb" => %(<Text id="r">html</Text>),
      "specs/_row.expo_turbo.erb" => %(<Text id="r">expo</Text>)
    ) do
      _status, headers, body = dispatch(controller_class)

      expect(headers["Content-Type"]).to eq("#{ExpoTurbo::Rails::MIME_TYPE}; charset=utf-8")
      expect(body).to eq(%(<Screen id="a"><Text id="r">html</Text></Screen>))
    end
  end

  # A format-neutral template answers either audience without narrowing
  # lookup, so its partials still follow the format Rails selected.
  it "serves both audiences from a format-neutral template and keeps partial lookup on the request format" do
    with_templates(
      controller_class,
      "specs/show.erb" => %(<Screen id="a"><%= render partial: "specs/row" %></Screen>),
      "specs/_row.html.erb" => %(<Text id="r">html</Text>),
      "specs/_row.expo_turbo.erb" => %(<Text id="r">expo</Text>)
    ) do
      _status, native_headers, native_body = dispatch(controller_class)
      _status, html_headers, html_body = dispatch(controller_class, headers: {"HTTP_ACCEPT" => "text/html"})

      expect(native_headers["Content-Type"]).to eq("#{ExpoTurbo::Rails::MIME_TYPE}; charset=utf-8")
      expect(native_body).to eq(%(<Screen id="a"><Text id="r">expo</Text></Screen>))
      expect(html_headers["Content-Type"]).to eq("text/html; charset=utf-8")
      expect(html_body).to eq(%(<Screen id="a"><Text id="r">html</Text></Screen>))
    end
  end

  # Rails annotates .html templates in development, and those annotations now
  # reach a native client. They are XML comments, which the protocol carries as
  # comment nodes, so the response still parses and is still admitted. The cost
  # is that a development response names server paths to a native client, which
  # is the same exposure a browser already has.
  it "admits an HTML template that ActionView annotated" do
    previous = ActionView::Base.annotate_rendered_view_with_filenames
    ActionView::Base.annotate_rendered_view_with_filenames = true

    with_templates(
      controller_class,
      "specs/show.html.erb" => %(<Screen id="a"><%= render partial: "specs/row" %></Screen>),
      "specs/_row.html.erb" => %(<Text id="r">x</Text>)
    ) do
      status, headers, body = dispatch(controller_class)

      expect(status).to eq(200)
      expect(headers["Content-Type"]).to eq("#{ExpoTurbo::Rails::MIME_TYPE}; charset=utf-8")
      expect(body).to include("<!-- BEGIN ", "specs/show.html.erb")
      expect(ExpoTurbo::Rails::XmlFragments.parse_document(body).root.name).to eq("Screen")
    end
  ensure
    ActionView::Base.annotate_rendered_view_with_filenames = previous
  end

  it "keeps a separate view tree working through prepend_view_path" do
    Dir.mktmpdir do |directory|
      native_root = File.join(directory, "native_views")
      FileUtils.mkdir_p(File.join(native_root, "specs"))
      File.write(File.join(native_root, "specs", "show.expo_turbo.erb"), %(<Screen id="separate-tree"/>))

      with_templates(controller_class, "specs/show.html.erb" => "<div>HTML</div>") do
        controller_class.prepend_view_path(native_root)
        _status, _headers, body = dispatch(controller_class)

        expect(body).to eq(%(<Screen id="separate-tree"/>))
      end
    end
  end

  describe "with the fallback disabled" do
    before { controller_class.expo_turbo_html_template_fallback = false }

    it "cannot select an HTML template for an Expo Turbo render" do
      with_templates(controller_class, "specs/show.html.erb" => %(<Screen id="a"/>)) do
        expect { dispatch(controller_class) }.to raise_error(ActionView::MissingTemplate)
      end
    end

    it "still renders an HTML request from the HTML template" do
      with_templates(controller_class, "specs/show.html.erb" => "<div>HTML</div>") do
        _status, headers, body = dispatch(controller_class, headers: {"HTTP_ACCEPT" => "text/html"})

        expect(headers["Content-Type"]).to eq("text/html; charset=utf-8")
        expect(body).to eq("<div>HTML</div>")
      end
    end
  end
end
