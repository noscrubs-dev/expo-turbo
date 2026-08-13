# frozen_string_literal: true

require "rails_helper"
require "tmpdir"
require "expo_turbo/rails/paired_templates"

# The lint runs in CI here, over this application's real views. It is not a
# runtime check: nothing in a request path loads PairedTemplates.
RSpec.describe "paired demo templates" do
  let(:roots) { ExpoTurbo::Rails::PairedTemplates.default_roots }

  it "reports no divergence between any paired template in this app" do
    findings = ExpoTurbo::Rails::PairedTemplates.lint(roots)

    expect(findings.map(&:to_s)).to be_empty
  end

  # The demo has no pair left to lint, so the assertion above would pass on an
  # empty repository too. This one proves the lint can still see divergence
  # here, by handing it a pair built from this application's own markup.
  it "still reports divergence in a pair placed under the same roots" do
    Dir.mktmpdir do |directory|
      File.write(File.join(directory, "show.html.erb"), %(<p id="drifted">x</p>))
      File.write(File.join(directory, "show.expo_turbo.erb"), %(<DemoText id="original">x</DemoText>))

      finding = ExpoTurbo::Rails::PairedTemplates.lint([*roots, directory]).first

      expect(finding.aspect).to eq(:id)
      expect(finding.value).to eq("drifted")
      expect(finding.counterpart_value).to eq("original")
    end
  end

  # Run against this application's real shared template rather than a fixture:
  # a copy of it agrees with itself, and a copy whose id drifted is reported.
  it "reports drift in a copy of the shared greeting template" do
    shared = Rails.root.join("app/views/api/expo_turbo/demo/shared_greetings/show.html.erb").read
    drifted = shared.sub("demo-shared-greeting-text", "renamed-by-mistake")
    expect(drifted).not_to eq(shared)

    Dir.mktmpdir do |directory|
      File.write(File.join(directory, "agrees.html.erb"), shared)
      File.write(File.join(directory, "agrees.expo_turbo.erb"), shared)
      File.write(File.join(directory, "drifts.html.erb"), shared)
      File.write(File.join(directory, "drifts.expo_turbo.erb"), drifted)

      findings = ExpoTurbo::Rails::PairedTemplates.lint([directory])

      expect(findings.map(&:aspect)).to contain_exactly(:id)
      expect(findings.first.path).to end_with("drifts.html.erb")
      expect(findings.first.value).to eq("demo-shared-greeting-text")
      expect(findings.first.counterpart_value).to eq("renamed-by-mistake")
    end
  end

  it "keeps the shared greeting screen out of the paired set, because it is one file" do
    pairs = ExpoTurbo::Rails::PairedTemplates.pairs(roots).map(&:name)

    expect(pairs).not_to include("api/expo_turbo/demo/shared_greetings/show")
  end
end
