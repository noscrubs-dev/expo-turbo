# frozen_string_literal: true

require "action_controller/api"
require "fileutils"
require "tmpdir"
require "spec_helper"

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
