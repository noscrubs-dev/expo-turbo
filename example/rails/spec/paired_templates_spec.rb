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

      findings = ExpoTurbo::Rails::PairedTemplates.lint([*roots, directory])

      expect(findings.map(&:value)).to contain_exactly("drifted", "original")
    end
  end

  it "keeps the shared greeting screen out of the paired set, because it is one file" do
    pairs = ExpoTurbo::Rails::PairedTemplates.pairs(roots).map(&:name)

    expect(pairs).not_to include("api/expo_turbo/demo/shared_greetings/show")
  end
end
