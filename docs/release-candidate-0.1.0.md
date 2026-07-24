# Expo Turbo 0.1.0 candidate

This is a non-publishing candidate record. It does not announce a stable
release, reserve a registry version, or close the remaining compatibility
gates.

See the current [0.1.0 release-readiness checklist](./release-readiness-0.1.0.md)
before using this historical candidate evidence.

| Field | Value |
| --- | --- |
| Public commit | `17aec4f906d53dc71cf4778befd44c6f3c54b98b` |
| Release workflow | [run 30057454059](https://github.com/noscrubs-dev/expo-turbo/actions/runs/30057454059) |
| npm artifact | `expo-turbo-0.1.0.tgz` |
| npm SHA-256 | `fd9fe01156095fdabfd6dfc602322374d89615aeed7356264632eb3b822ac04f` |
| Ruby artifact | `expo_turbo-rails-0.1.0.gem` |
| Ruby SHA-256 | `e948f53c37d089fde793936dc34be9cda5b3c4c78f08b9ba097fcff8e6fcaf3b` |

The workflow built both artifacts from the exact public commit, installed each
in a clean consumer, ran the root package, gem matrix, Expo example, and Rails
example gates, bound its OIDC identity to `main` and the protected `release`
environment, and emitted an offline GitHub provenance bundle.

After downloading the `release-candidate` artifact, both files matched
`SHA256SUMS`, and `gh attestation verify --bundle provenance.jsonl --repo
noscrubs-dev/expo-turbo` admitted each artifact for the exact `main` source
digest. A fresh npm consumer installed the tarball and imported all six public
entrypoints with Node. The exact gem unpacked with version `0.1.0`; the
workflow's clean Bundler consumers loaded it against both `turbo-rails`
`2.0.10` and `2.0.23`.

Run `30056741302` from commit `7edec2e` is explicitly rejected: independent
Node verification found extensionless ESM directory imports that Bun had
accepted. PR #372 fixed those imports, added NodeNext compilation, and changed
the release clean consumer to Node before replacement run `30057454059`.

Stable npm/RubyGems publication remains prohibited until the compatibility
manifest's public conformance, physical-device, and accessibility evidence is
complete. Product-host adoption is a separate future project and is not a
public-release prerequisite. Merging this evidence record advances `main`, so
run `30057454059` becomes the latest independently verified pipeline proof
rather than the publishable candidate. The final gated commit must produce a
new candidate, and stable publication must reuse that later run's exact frozen
bytes.
