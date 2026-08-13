# frozen_string_literal: true

namespace :expo_turbo do
  desc "Report divergence between paired HTML and Expo Turbo templates (EXPO_TURBO_VIEW_PATHS overrides the roots)"
  task paired_templates: :environment do
    roots = ENV["EXPO_TURBO_VIEW_PATHS"].to_s.split(File::PATH_SEPARATOR).reject(&:empty?)
    roots = ExpoTurbo::Rails::PairedTemplates.default_roots if roots.empty?

    findings = ExpoTurbo::Rails::PairedTemplates.lint(roots)
    findings.each { |finding| warn(finding) }

    if findings.any?
      abort("#{findings.length} paired template #{(findings.length == 1) ? "divergence" : "divergences"}")
    end

    puts "No paired template divergence in #{roots.join(", ")}"
  end
end
