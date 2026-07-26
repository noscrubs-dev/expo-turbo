# Expo Turbo 0.1.0 release record

This record identifies the exact frozen candidate published as the stable
`0.1.0` npm package and Ruby gem. Manual accessibility evidence remains
explicitly deferred and is not claimed by the release.

See the current [0.1.0 release-readiness checklist](./release-readiness-0.1.0.md)
for the complete support boundary.

| Field | Value |
| --- | --- |
| Public candidate commit | `338bf95fc52d0c56fd90565872f20e3b72bc16bc` |
| Candidate workflow | [run 30222494157](https://github.com/noscrubs-dev/expo-turbo/actions/runs/30222494157) |
| npm publication | [run 30222848693](https://github.com/noscrubs-dev/expo-turbo/actions/runs/30222848693) |
| RubyGems recovery and registry verification | [run 30223181456](https://github.com/noscrubs-dev/expo-turbo/actions/runs/30223181456) |
| Source tag and release | [`v0.1.0`](https://github.com/noscrubs-dev/expo-turbo/releases/tag/v0.1.0) |
| npm artifact | `expo-turbo-0.1.0.tgz` |
| npm SHA-256 | `0814752eeef9be1e1e6f02454834f59faaa71fac8a4224e4dbf1920e7b5eb0e7` |
| Ruby artifact | `expo_turbo-rails-0.1.0.gem` |
| Ruby SHA-256 | `0391be55f742cdf2fecd24efd33f8b05a6eb14a12df018d91b6f6e9444076342` |

The workflow built both artifacts from the exact public commit, installed each
in a clean consumer, ran the root package, gem matrix, Expo example, and Rails
example gates, bound its OIDC identity to `main` and the protected `release`
environment, and emitted an offline GitHub provenance bundle.

Independent verification downloaded candidate run `30222494157`, matched both
SHA-256 checksums, verified both GitHub attestations, imported all six public
entrypoints in a clean Node consumer, and loaded the gem in clean Bundler
consumers with `turbo-rails` `2.0.10` and `2.0.23`.

Publication run `30222848693` published the exact npm tarball with provenance
before RubyGems rejected the initial bootstrap credential. Recovery run
`30223181456` used the pending RubyGems trusted publisher to publish the exact
frozen gem and then downloaded both registry artifacts and matched their
candidate checksums. Its final GitHub-release step was denied to the workflow
token; the authenticated maintainer CLI created `v0.1.0` at the candidate
commit with the unchanged package, gem, manifest, checksums, and provenance
assets. Fresh registry consumers then repeated the six Node imports, npm
signature/attestation audit, and both Bundler matrix loads.

The follow-up automation fix reserves the immutable tag and an exact-asset
draft GitHub release while the normal publication workflow still runs at the
candidate commit. The draft becomes public only after both registries verify.
A gem-only recovery therefore edits the already-bound draft instead of asking
GitHub's workflow token to create a release at an older workflow-changing
commit. Disposable Actions
[run 30223932177](https://github.com/noscrubs-dev/expo-turbo/actions/runs/30223932177)
verified that the workflow token can create the tag, create and edit the draft
release, and remove both cleanly.

The later physical Android and iOS union suites completed public device
conformance. Manual accessibility evidence remains explicitly deferred and is
not claimed by the `0.1.0` compatibility surface. Product-host adoption remains
a separate future project and is not a public-release prerequisite.
