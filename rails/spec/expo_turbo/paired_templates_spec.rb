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

  it "does not compare element names, because an alias is the point" do
    write("demo/show.html.erb", %(<p id="a">Hi</p>))
    write("demo/show.expo_turbo.erb", %(<DemoText id="a">Hi</DemoText>))

    expect(lint).to be_empty
  end

  # Each of these passed the value-set comparison this replaced. Two elements
  # exchanging their targets left every global set identical, so the lint
  # reported clean on exactly the divergence it exists to catch.
  describe "divergence that keeps the same values" do
    it "reports two Frames that exchanged their src" do
      write("demo/show.html.erb", %(<turbo-frame id="one" src="/alpha"/><turbo-frame id="two" src="/beta"/>))
      write("demo/show.expo_turbo.erb", %(<turbo-frame id="one" src="/beta"/><turbo-frame id="two" src="/alpha"/>))

      expect(lint.map(&:to_s)).to contain_exactly(
        a_string_including("#one", "src", "/alpha", "/beta"),
        a_string_including("#two", "src", "/beta", "/alpha")
      )
    end

    it "reports two forms that exchanged their action and method" do
      write("demo/show.html.erb", %(<form id="a" action="/x" method="post"/><form id="b" action="/y" method="get"/>))
      write("demo/show.expo_turbo.erb", %(<DemoForm id="a" action="/y" method="get"/><DemoForm id="b" action="/x" method="post"/>))

      expect(reported(:action)).to contain_exactly("/x", "/y")
      expect(reported(:method)).to contain_exactly("post", "get")
    end

    it "reports a control name that moved to another element" do
      write("demo/show.html.erb", %(<form id="f"><input id="one" name="email"/><input id="two" name="plan"/></form>))
      write("demo/show.expo_turbo.erb", %(<DemoForm id="f"><DemoFormInput id="one" name="plan"/><DemoFormInput id="two" name="email"/></DemoForm>))

      expect(reported(:name)).to contain_exactly("email", "plan")
    end

    it "reports a Turbo data attribute that moved to another element" do
      write("demo/show.html.erb", %(<a id="one" data-turbo-action="advance">A</a><a id="two">B</a>))
      write("demo/show.expo_turbo.erb", %(<DemoLink id="one">A</DemoLink><DemoLink id="two" data-turbo-action="advance">B</DemoLink>))

      findings = lint

      expect(findings.map(&:aspect)).to contain_exactly(:data_turbo, :data_turbo)
      expect(findings.map(&:element)).to contain_exactly("#one", "#two")
    end

    it "reports two ids that were exchanged between elements" do
      write("demo/show.html.erb", %(<turbo-frame id="one" src="/alpha"/><turbo-frame id="two" src="/beta"/>))
      write("demo/show.expo_turbo.erb", %(<turbo-frame id="two" src="/alpha"/><turbo-frame id="one" src="/beta"/>))

      expect(reported(:src)).to contain_exactly("/alpha", "/beta")
    end
  end

  # `method` used to be collected only alongside `action`, so a form that
  # relies on the route for its target reported nothing at all.
  it "reports a method that diverges with no action anywhere" do
    write("demo/show.html.erb", %(<form id="a" method="post"><input name="e"/></form>))
    write("demo/show.expo_turbo.erb", %(<DemoForm id="a" method="get"><DemoFormInput name="e"/></DemoForm>))

    expect(reported(:method)).to contain_exactly("post")
    expect(lint.first.counterpart_value).to eq("get")
  end

  it "reports a method that only one side carries" do
    write("demo/show.html.erb", %(<form id="a" method="post"/>))
    write("demo/show.expo_turbo.erb", %(<DemoForm id="a"/>))

    finding = lint.first

    expect(finding.aspect).to eq(:method)
    expect(finding.value).to eq("post")
    expect(finding.counterpart_value).to be_nil
    expect(finding.to_s).to include("absent")
  end

  describe "how elements are paired" do
    it "pairs by id even when the elements sit in a different order" do
      write("demo/show.html.erb", %(<turbo-frame id="one" src="/alpha"/><turbo-frame id="two" src="/beta"/>))
      write("demo/show.expo_turbo.erb", %(<turbo-frame id="two" src="/beta"/><turbo-frame id="one" src="/alpha"/>))

      expect(lint).to be_empty
    end

    it "pairs by document order when neither side carries an id" do
      write("demo/show.html.erb", %(<form action="/x"/>))
      write("demo/show.expo_turbo.erb", %(<DemoForm action="/y"/>))

      expect(reported(:action)).to contain_exactly("/x")
    end

    it "still compares ids that differ, by falling back to document order" do
      write("demo/show.html.erb", %(<p id="only-html">x</p>))
      write("demo/show.expo_turbo.erb", %(<DemoText id="only-native">x</DemoText>))

      expect(reported(:id)).to contain_exactly("only-html")
      expect(lint.first.counterpart_value).to eq("only-native")
    end

    it "reports an element that has no counterpart at all" do
      write("demo/show.html.erb", %(<form id="f"><input name="email"/><input name="plan"/></form>))
      write("demo/show.expo_turbo.erb", %(<DemoForm id="f"><DemoFormInput name="email"/></DemoForm>))

      findings = lint

      expect(findings.map(&:aspect)).to contain_exactly(:element)
      expect(findings.first.value).to include("plan")
      expect(findings.first.to_s).to include("no counterpart")
    end

    it "ignores an element that carries nothing worth comparing" do
      write("demo/show.html.erb", %(<div><section><p id="a">x</p></section></div>))
      write("demo/show.expo_turbo.erb", %(<Gallery><DemoText id="a">x</DemoText></Gallery>))

      expect(lint).to be_empty
    end
  end

  it "compares an ERB expression by its source, after collapsing whitespace runs" do
    write("demo/show.html.erb", %(<p id="<%=   dom_id(post,\n  :frame)   %>">x</p>))
    write("demo/show.expo_turbo.erb", %(<DemoText id="<%= dom_id(post, :frame) %>">x</DemoText>))

    expect(lint).to be_empty
  end

  it "reports two expressions that differ only in spacing inside the call" do
    write("demo/show.html.erb", %(<p id="<%= dom_id( post ) %>">x</p>))
    write("demo/show.expo_turbo.erb", %(<DemoText id="<%= dom_id(post) %>">x</DemoText>))

    expect(reported(:id)).to contain_exactly("«dom_id( post )»")
  end

  it "reads every branch of a conditional, on both sides" do
    write("demo/show.html.erb", <<~ERB)
      <% if signed_in? %><p id="in">in</p><% else %><p id="out">out</p><% end %>
    ERB
    write("demo/show.expo_turbo.erb", <<~ERB)
      <% if signed_in? %><DemoText id="in">in</DemoText><% end %>
    ERB

    findings = lint

    expect(findings.map(&:aspect)).to contain_exactly(:element)
    expect(findings.first.value).to include("out")
  end

  it "ignores an ERB comment" do
    write("demo/show.html.erb", %(<%# id="ghost" %><p id="a">x</p>))
    write("demo/show.expo_turbo.erb", %(<DemoText id="a">x</DemoText>))

    expect(lint).to be_empty
  end

  it "names the file and the line a divergence came from" do
    write("demo/show.html.erb", "<div>\n<p id=\"only-html\">x</p>\n</div>")
    write("demo/show.expo_turbo.erb", "<Gallery>\n</Gallery>")

    finding = lint.first

    expect(finding.path).to eq(File.join(root, "demo/show.html.erb"))
    expect(finding.line).to eq(2)
    expect(finding.counterpart_path).to eq(File.join(root, "demo/show.expo_turbo.erb"))
    expect(finding.to_s).to include("demo/show.html.erb:2", "only-html")
  end

  it "sorts findings so a CI report reads the same way twice" do
    write("demo/show.html.erb", %(<turbo-frame id="b" src="/b2"/>\n<turbo-frame id="a" src="/a2"/>))
    write("demo/show.expo_turbo.erb", %(<turbo-frame id="a" src="/a1"/>\n<turbo-frame id="b" src="/b1"/>))

    expect(lint.map(&:line)).to eq([1, 2])
    expect(lint.map(&:to_s)).to eq(described_class.lint(root).map(&:to_s))
  end

  it "pairs partials and pairs across different template handlers" do
    write("demo/_row.html.erb", %(<p id="row-html">x</p>))
    write("demo/_row.expo_turbo.builder", %(<DemoText id="row-native">x</DemoText>))

    expect(reported(:id)).to contain_exactly("row-html")
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

    expect(reported(:id)).to contain_exactly("a")
  end

  it "reports an unreadable template instead of raising" do
    write("demo/show.expo_turbo.erb", %(<DemoText id="a">x</DemoText>))
    File.binwrite(File.join(root, "demo/show.html.erb"), "\xC3\x28<p id=\"a\">x</p>")

    findings = lint

    expect(findings.map(&:aspect)).to contain_exactly(:unreadable)
    expect(findings.first.path).to eq(File.join(root, "demo/show.html.erb"))
  end

  it "ignores a directory whose name looks like a template" do
    FileUtils.mkdir_p(File.join(root, "demo/show.html.erb"))
    write("demo/show.expo_turbo.erb", %(<DemoText id="a">x</DemoText>))

    expect(lint).to be_empty
    expect(described_class.pairs(root)).to be_empty
  end

  it "defaults to the application view root" do
    expect(described_class.default_roots).to eq([::Rails.root.join("app/views").to_s])
  end

  it "accepts several roots and skips a root that does not exist" do
    write("demo/show.html.erb", %(<p id="only-html">x</p>))
    write("demo/show.expo_turbo.erb", %(<DemoText id="a">x</DemoText>))

    expect(described_class.lint(root, File.join(root, "absent")).map(&:aspect))
      .to contain_exactly(:id)
  end
end
