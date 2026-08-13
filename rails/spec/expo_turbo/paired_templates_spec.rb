# frozen_string_literal: true

require "fileutils"
require "spec_helper"
require "tmpdir"
require "expo_turbo/rails/paired_templates"

RSpec.describe ExpoTurbo::Rails::PairedTemplates do
  around do |example|
    Dir.mktmpdir { |directory| example.metadata[:root] = directory and example.run }
  end

  let(:root) { |example| example.metadata[:root] }

  def write(name, source)
    path = File.join(root, name)
    FileUtils.mkdir_p(File.dirname(path))
    File.write(path, source)
    path
  end

  def lint
    described_class.lint(root)
  end

  def reported(aspect)
    lint.select { |finding| finding.aspect == aspect }.map(&:value)
  end

  it "reports nothing for a pair that agrees" do
    write("demo/show.html.erb", %(<turbo-frame id="greeting" src="/g"><p id="text">Hi</p></turbo-frame>))
    write("demo/show.expo_turbo.erb", %(<turbo-frame id="greeting" src="/g"><DemoText id="text">Hi</DemoText></turbo-frame>))

    expect(lint).to be_empty
  end

  it "reports an id that only one side carries" do
    write("demo/show.html.erb", %(<p id="only-html">x</p>))
    write("demo/show.expo_turbo.erb", %(<DemoText id="only-native">x</DemoText>))

    expect(reported(:id)).to contain_exactly("only-html", "only-native")
  end

  it "reports a diverging Frame src" do
    write("demo/show.html.erb", %(<turbo-frame id="f" src="/browser"/>))
    write("demo/show.expo_turbo.erb", %(<turbo-frame id="f" src="/native"/>))

    expect(reported(:frame_src)).to contain_exactly("/browser", "/native")
  end

  it "reports a diverging form action and method" do
    write("demo/show.html.erb", %(<form action="/signups" method="post"><input name="email"/></form>))
    write("demo/show.expo_turbo.erb", %(<DemoForm action="/signup" method="get"><DemoFormInput name="email"/></DemoForm>))

    expect(reported(:form_action)).to contain_exactly("/signups", "/signup")
    expect(reported(:form_method)).to contain_exactly("post", "get")
  end

  it "reports a control name that only one side carries" do
    write("demo/show.html.erb", %(<form action="/x"><input name="email"/><input name="plan"/></form>))
    write("demo/show.expo_turbo.erb", %(<DemoForm action="/x"><DemoFormInput name="email"/></DemoForm>))

    expect(reported(:control_name)).to contain_exactly("plan")
  end

  it "reports a diverging data-turbo attribute" do
    write("demo/show.html.erb", %(<a id="l" href="/x" data-turbo-action="advance">Go</a>))
    write("demo/show.expo_turbo.erb", %(<DemoLink id="l" href="/x" data-turbo-action="replace">Go</DemoLink>))

    expect(reported(:data_turbo)).to contain_exactly("data-turbo-action=advance", "data-turbo-action=replace")
  end

  it "does not compare element names, because an alias is the point" do
    write("demo/show.html.erb", %(<p id="a">Hi</p>))
    write("demo/show.expo_turbo.erb", %(<DemoText id="a">Hi</DemoText>))

    expect(lint).to be_empty
  end

  # The comparison is textual, not a Ruby one: whitespace runs collapse to a
  # single space and the ends are trimmed, and nothing else is normalized.
  it "compares an ERB expression by its source, after collapsing whitespace runs" do
    write("demo/show.html.erb", %(<p id="<%=   dom_id(post,\n  :frame)   %>">x</p>))
    write("demo/show.expo_turbo.erb", %(<DemoText id="<%= dom_id(post, :frame) %>">x</DemoText>))

    expect(lint).to be_empty
  end

  it "reports two expressions that differ only in spacing inside the call" do
    write("demo/show.html.erb", %(<p id="<%= dom_id( post ) %>">x</p>))
    write("demo/show.expo_turbo.erb", %(<DemoText id="<%= dom_id(post) %>">x</DemoText>))

    expect(reported(:id)).to contain_exactly("«dom_id( post )»", "«dom_id(post)»")
  end

  it "reports a diverging ERB expression" do
    write("demo/show.html.erb", %(<p id="<%= dom_id(post) %>">x</p>))
    write("demo/show.expo_turbo.erb", %(<DemoText id="<%= dom_id(post, :frame) %>">x</DemoText>))

    expect(reported(:id)).to contain_exactly("«dom_id(post)»", "«dom_id(post, :frame)»")
  end

  it "reads every branch of a conditional, on both sides" do
    write("demo/show.html.erb", <<~ERB)
      <% if signed_in? %><p id="in">in</p><% else %><p id="out">out</p><% end %>
    ERB
    write("demo/show.expo_turbo.erb", <<~ERB)
      <% if signed_in? %><DemoText id="in">in</DemoText><% end %>
    ERB

    expect(reported(:id)).to contain_exactly("out")
  end

  it "ignores an ERB comment" do
    write("demo/show.html.erb", %(<%# id="ghost" %><p id="a">x</p>))
    write("demo/show.expo_turbo.erb", %(<DemoText id="a">x</DemoText>))

    expect(lint).to be_empty
  end

  it "counts a repeated value, so a duplicate on one side is a divergence" do
    write("demo/show.html.erb", %(<form action="/x"><input name="tag"/><input name="tag"/></form>))
    write("demo/show.expo_turbo.erb", %(<DemoForm action="/x"><DemoFormInput name="tag"/></DemoForm>))

    expect(reported(:control_name)).to contain_exactly("tag")
  end

  it "names the file and the line a divergence came from" do
    write("demo/show.html.erb", "<div>\n<p id=\"only-html\">x</p>\n</div>")
    write("demo/show.expo_turbo.erb", "<Gallery>\n</Gallery>")

    finding = lint.first

    expect(finding.path).to eq(File.join(root, "demo/show.html.erb"))
    expect(finding.line).to eq(2)
    expect(finding.counterpart_path).to eq(File.join(root, "demo/show.expo_turbo.erb"))
    expect(finding.to_s).to include("demo/show.html.erb:2", "id", "only-html")
  end

  it "pairs partials and pairs across different template handlers" do
    write("demo/_row.html.erb", %(<p id="row-html">x</p>))
    write("demo/_row.expo_turbo.builder", %(<DemoText id="row-native">x</DemoText>))

    expect(reported(:id)).to contain_exactly("row-html", "row-native")
  end

  it "ignores a template that has no counterpart" do
    write("demo/show.html.erb", %(<p id="lonely">x</p>))
    write("demo/other.expo_turbo.erb", %(<DemoText id="lonely-too">x</DemoText>))

    expect(lint).to be_empty
    expect(described_class.pairs(root)).to be_empty
  end

  it "ignores a locale or variant qualifier when it matches on both sides" do
    write("demo/show.en.html.erb", %(<p id="a">x</p>))
    write("demo/show.en.expo_turbo.erb", %(<DemoText id="b">x</DemoText>))

    expect(reported(:id)).to contain_exactly("a", "b")
  end

  it "reports an unreadable template instead of raising" do
    write("demo/show.expo_turbo.erb", %(<DemoText id="a">x</DemoText>))
    File.binwrite(File.join(root, "demo/show.html.erb"), "\xC3\x28<p id=\"a\">x</p>")

    findings = lint

    expect(findings.map(&:aspect)).to contain_exactly(:unreadable)
    expect(findings.first.path).to eq(File.join(root, "demo/show.html.erb"))
  end

  it "defaults to the application view root" do
    expect(described_class.default_roots).to eq([::Rails.root.join("app/views").to_s])
  end

  it "accepts several roots and skips a root that does not exist" do
    write("demo/show.html.erb", %(<p id="only-html">x</p>))
    write("demo/show.expo_turbo.erb", %(<DemoText id="a">x</DemoText>))

    expect(described_class.lint(root, File.join(root, "absent")).map(&:aspect))
      .to contain_exactly(:id, :id)
  end
end
