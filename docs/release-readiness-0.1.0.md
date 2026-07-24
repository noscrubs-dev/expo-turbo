# Expo Turbo 0.1.0 release readiness

This is the human-readable launch checklist for the first coordinated
`expo-turbo` npm package and `expo_turbo-rails` Ruby gem release. The
[compatibility manifest](../protocol/compatibility-manifest.json) remains the
machine-readable source of truth.

## Ready

- [x] TypeScript package and runtime versions are `0.1.0`; public status is
  `prerelease` until stable publication.
- [x] Ruby gem version is `0.1.0`.
- [x] Six public ESM/TypeScript entrypoints build, pack, and import in a clean
  Node consumer.
- [x] The gem builds and clean-installs with `turbo-rails` `2.0.10` and
  `2.0.23`.
- [x] Root package, gem matrix, standalone Expo app, standalone Rails host,
  protocol fixtures, boundaries, and production exports pass.
- [x] All 26 Turbo 8.0.23 functional-suite families have an explicit Exact,
  Native equivalent, and/or N/A disposition.
- [x] Installed iOS Simulator and signed Android Emulator Release builds pass
  the shared Maestro core-interaction flow.
- [x] Android Emulator Release flows pass fallback-Blob and native Files-picker
  multipart submission through the real Rails host.
- [x] The web gallery passes the automated WCAG 2.0/2.1 A/AA axe audit and
  accessibility-tree naming checks.
- [x] A paired non-publishing candidate was clean-installed, checksummed, and
  attested; its Node ESM failure was fixed and the replacement proof passed.
- [x] Candidate and stable release automation builds paired artifacts, verifies
  provenance/checksums, and separates non-publishing from reviewer-gated
  publication.
- [x] Public contribution, security, code-of-conduct, changelog, license, and
  release-evidence documentation exists.

## Required before stable publication

- [ ] Run the release gallery and multipart proof on a physical Android device.
- [ ] Run the required lifecycle, network, protected-Cable, renderer-flush, and
  Frame-reconciliation proofs on physical iOS and Android devices.
- [ ] Complete manual VoiceOver, TalkBack, and browser screen-reader
  speech/navigation checks.
- [ ] Commit the resulting evidence and close the five `incomplete` manifest
  entries: `forms.android-multipart`, `cable.production-auth-device`,
  `accessibility.physical-evidence`, `release.device-conformance`, and
  `release.registry-publication`.
- [ ] Run a new non-publishing candidate workflow from the final gated `main`
  commit.
- [ ] Independently download and verify the final npm tarball and gem,
  checksums, provenance, clean Node imports, and both clean Bundler consumers.
- [ ] Approve stable publication of those exact frozen bytes—without rebuilding
  them—to npm and RubyGems.
- [ ] Verify registry downloads, metadata, checksums, versions, source tag,
  GitHub release, protocol version, and public commit all agree.

## Publication rule

The previous
[candidate](./release-candidate-0.1.0.md) proves the release machinery but is
not publishable because later evidence commits advanced `main`. Stable
publication must consume a successful candidate produced from the final gated
commit and must reuse that candidate's exact npm and gem bytes.

Product-specific routes, views, credentials, identity/tenant policy, and
NoScrubs integration are adopter work. They do not block the independently
publishable package and gem.

## Launch handoff

When every item above is checked:

1. Run the reviewer-gated stable publication workflow with the final successful
   candidate run ID.
2. Confirm npm and RubyGems expose version `0.1.0`.
3. Confirm the immutable `v0.1.0` source tag and GitHub release point to the
   candidate commit.
4. Replace the pre-publication notices in the repository and package READMEs
   with the stable release date and registry links.
5. Announce only the support surface described by the compatibility manifest;
   keep browser-only N/A behavior and host-owned product policy explicit.
