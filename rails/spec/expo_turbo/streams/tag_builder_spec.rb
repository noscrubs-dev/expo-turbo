# frozen_string_literal: true

require "action_controller/api"
require "fileutils"
require "tmpdir"
require "spec_helper"
require "expo_turbo/rails/testing"

RSpec.describe ExpoTurbo::Rails::Streams::TagBuilder do
  let(:controller_class) do
    Class.new(ActionController::API) do
      include ExpoTurbo::Rails::Controller
    end
  end

  def stream
    controller_class.new.expo_turbo_stream
  end

  it "emits canonical built-in target and selector Stream tags" do
    expect(stream.append("items", "<DemoItem id=\"appended\"/>").to_s)
      .to eq('<turbo-stream action="append" target="items"><template><DemoItem id="appended"/></template></turbo-stream>')
    expect(stream.prepend("items", "<DemoItem id=\"prepended\"/>").to_s)
      .to eq('<turbo-stream action="prepend" target="items"><template><DemoItem id="prepended"/></template></turbo-stream>')
    expect(stream.before("marker", "<DemoItem id=\"before\"/>").to_s)
      .to eq('<turbo-stream action="before" target="marker"><template><DemoItem id="before"/></template></turbo-stream>')
    expect(stream.after("marker", "<DemoItem id=\"after\"/>").to_s)
      .to eq('<turbo-stream action="after" target="marker"><template><DemoItem id="after"/></template></turbo-stream>')
    expect(stream.replace("panel", "<DemoPanel id=\"panel\"/>", method: :morph).to_s)
      .to eq('<turbo-stream method="morph" action="replace" target="panel"><template><DemoPanel id="panel"/></template></turbo-stream>')
    expect(stream.update("panel", "<DemoText>Updated</DemoText>", method: :morph).to_s)
      .to eq('<turbo-stream method="morph" action="update" target="panel"><template><DemoText>Updated</DemoText></template></turbo-stream>')
    expect(stream.remove("panel").to_s).to eq('<turbo-stream action="remove" target="panel"></turbo-stream>')
    expect(stream.refresh(request_id: "request-1").to_s)
      .to eq('<turbo-stream request-id="request-1" action="refresh"></turbo-stream>')
    expect(stream.append_all(".item", "<DemoItem/>").to_s)
      .to eq('<turbo-stream action="append" targets=".item"><template><DemoItem/></template></turbo-stream>')
    expect(stream.prepend_all(".item", "<DemoItem/>").to_s)
      .to eq('<turbo-stream action="prepend" targets=".item"><template><DemoItem/></template></turbo-stream>')
    expect(stream.before_all(".item", "<DemoItem/>").to_s)
      .to eq('<turbo-stream action="before" targets=".item"><template><DemoItem/></template></turbo-stream>')
    expect(stream.after_all(".item", "<DemoItem/>").to_s)
      .to eq('<turbo-stream action="after" targets=".item"><template><DemoItem/></template></turbo-stream>')
    expect(stream.replace_all(".item", "<DemoItem/>", method: :morph).to_s)
      .to eq('<turbo-stream method="morph" action="replace" targets=".item"><template><DemoItem/></template></turbo-stream>')
    expect(stream.update_all(".item", "<DemoItem/>", method: :morph).to_s)
      .to eq('<turbo-stream method="morph" action="update" targets=".item"><template><DemoItem/></template></turbo-stream>')
    expect(stream.remove_all(".item").to_s).to eq('<turbo-stream action="remove" targets=".item"></turbo-stream>')
  end

  it "captures block content without switching to HTML rendering" do
    rendered = stream.update("message") { '<DemoText id="captured">Captured</DemoText>'.html_safe }

    expect(rendered.to_s)
      .to eq('<turbo-stream action="update" target="message"><template><DemoText id="captured">Captured</DemoText></template></turbo-stream>')
  end

  it "emits structurally parseable XML Stream template payloads" do
    document = ExpoTurbo::Rails::Testing.parse_stream_fragment(
      stream.append("items", '<Demo:Item xmlns:Demo="urn:expo-demo" id="item-1">Saved</Demo:Item>').to_s
    )
    element = document.at_xpath("/expo-turbo-test-root/turbo-stream")

    expect(element["action"]).to eq("append")
    expect(element["target"]).to eq("items")
    expect(element.at_xpath("./template/Demo:Item", "Demo" => "urn:expo-demo")&.text).to eq("Saved")
  end

  it "rejects malformed template markup from raw content, blocks, and partials" do
    expect { stream.append("items", "<Demo:Item/>") }
      .to raise_error(ExpoTurbo::Rails::TemplateError) { |error| expect(error.message).not_to include("Demo:Item") }
    expect { stream.append("items", "<DemoItem/>", xmlns: "urn:expo-test") }
      .to raise_error(ExpoTurbo::Rails::TemplateError, /well-formed UTF-8 XML/)
    expect { stream.append("items") { "<Demo:Item/>".html_safe } }
      .to raise_error(ExpoTurbo::Rails::TemplateError, /well-formed UTF-8 XML/)

    Dir.mktmpdir do |directory|
      root = File.join(directory, "expo_turbo")
      FileUtils.mkdir_p(root)
      File.write(File.join(root, "_item.xml.erb"), "<Demo:Item/>")
      controller_class.expo_turbo_view_root(root)

      expect { stream.append("items", partial: "item") }
        .to raise_error(ExpoTurbo::Rails::TemplateError, /well-formed UTF-8 XML/)
    end
  end

  it "preserves inline xml:space content from XML partials" do
    Dir.mktmpdir do |directory|
      root = File.join(directory, "expo_turbo")
      FileUtils.mkdir_p(root)
      File.write(
        File.join(root, "_message.xml.erb"),
        '<DemoText xml:space="preserve"><%= message %></DemoText>'
      )
      controller_class.expo_turbo_view_root(root)

      rendered = stream.append("messages", partial: "message", locals: {message: "first\r\nsecond\rthird"})
      text = ExpoTurbo::Rails::Testing.parse_stream_fragment(rendered.to_s).at_xpath("//DemoText")

      expect(text["xml:space"]).to eq("preserve")
      expect(text.text).to eq("first\nsecond\nthird")
    end
  end

  it "uses keyword content as template markup for every template-bearing action" do
    actions = {
      append: ["items", "target"],
      append_all: [".item", "targets"],
      prepend: ["items", "target"],
      prepend_all: [".item", "targets"],
      before: ["marker", "target"],
      before_all: [".item", "targets"],
      after: ["marker", "target"],
      after_all: [".item", "targets"],
      replace: ["panel", "target"],
      replace_all: [".item", "targets"],
      update: ["panel", "target"],
      update_all: [".item", "targets"]
    }

    actions.each do |name, (destination, destination_attribute)|
      action = name.to_s.delete_suffix("_all")

      expect(stream.public_send(name, destination, content: '<DemoItem id="keyword"/>').to_s)
        .to eq("<turbo-stream action=\"#{action}\" #{destination_attribute}=\"#{destination}\"><template><DemoItem id=\"keyword\"/></template></turbo-stream>")
    end

    expect(stream.replace("panel", content: "<DemoPanel/>", method: :morph).to_s)
      .to eq('<turbo-stream method="morph" action="replace" target="panel"><template><DemoPanel/></template></turbo-stream>')

    expect(stream.append("items", **{"content" => '<DemoItem id="string-key"/>'}).to_s)
      .to eq('<turbo-stream action="append" target="items"><template><DemoItem id="string-key"/></template></turbo-stream>')
    expect(stream.append_all(".item", **{"content" => '<DemoItem id="string-key"/>'}).to_s)
      .to eq('<turbo-stream action="append" targets=".item"><template><DemoItem id="string-key"/></template></turbo-stream>')
  end

  it "rejects ambiguous template content sources" do
    expect { stream.append("items", "<DemoItem/>", content: "<OtherItem/>") }
      .to raise_error(ArgumentError, /positional content or keyword content/)
    expect { stream.append("items", content: "<DemoItem/>", partial: "item") }
      .to raise_error(ArgumentError, /content, a block, or a partial/)
    expect { stream.append("items", content: "<DemoItem/>") { "<OtherItem/>" } }
      .to raise_error(ArgumentError, /content, a block, or a partial/)
    expect { stream.append("items", "<DemoItem/>") { "<OtherItem/>" } }
      .to raise_error(ArgumentError, /content, a block, or a partial/)
    expect { stream.append("items", partial: "item") { "<OtherItem/>" } }
      .to raise_error(ArgumentError, /content, a block, or a partial/)
    expect { stream.append("items", content: "<DemoItem/>", **{"content" => "<OtherItem/>"}) }
      .to raise_error(ArgumentError, /keyword content once/)
  end

  it "rejects keyword content on actions without a template" do
    expect { stream.remove("item", content: "<DemoItem/>") }
      .to raise_error(ArgumentError, /template-bearing Stream actions/)
    expect { stream.remove_all(".item", content: "<DemoItem/>") }
      .to raise_error(ArgumentError, /template-bearing Stream actions/)
    expect { stream.refresh(request_id: "request-1", content: "<DemoItem/>") }
      .to raise_error(ArgumentError, /template-bearing Stream actions/)
    expect { stream.remove("item", **{"content" => "<DemoItem/>"}) }
      .to raise_error(ArgumentError, /template-bearing Stream actions/)
    expect { stream.remove_all(".item", **{"content" => "<DemoItem/>"}) }
      .to raise_error(ArgumentError, /template-bearing Stream actions/)
    expect { stream.refresh(**{"content" => "<DemoItem/>"}) }
      .to raise_error(ArgumentError, /template-bearing Stream actions/)
  end

  it "renders only confined host XML partials" do
    Dir.mktmpdir do |directory|
      root = File.join(directory, "expo_turbo")
      FileUtils.mkdir_p(root)
      File.write(File.join(root, "_item.xml.erb"), '<DemoText id="<%= item_id %>"><%= label %></DemoText>')
      File.write(File.join(root, "_item.html.erb"), "<div>HTML fallback</div>")

      controller_class.expo_turbo_view_root(root)

      expect(stream.append("items", partial: "item", locals: {item_id: "item-1", label: "XML only"}).to_s)
        .to eq('<turbo-stream action="append" target="items"><template><DemoText id="item-1">XML only</DemoText></template></turbo-stream>')
    end
  end

  it "rejects an empty target and partial traversal" do
    expect { stream.append("", "<DemoItem/>") }.to raise_error(ArgumentError, /target must be present/)

    Dir.mktmpdir do |directory|
      root = File.join(directory, "expo_turbo")
      FileUtils.mkdir_p(root)
      File.write(File.join(directory, "_outside.xml.erb"), "<Outside/>")
      controller_class.expo_turbo_view_root(root)

      expect { stream.append("items", partial: "../outside") }
        .to raise_error(ExpoTurbo::Rails::TemplateError, /outside the configured view root/)
    end
  end
end
