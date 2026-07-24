# expo-turbo

A host-neutral XML protocol runtime for Expo React Native and Rails, targeting
Turbo 8.0.23 semantics.

> [!IMPORTANT]
> `0.1.0` is launch-ready source, not a published stable release. The package,
> gem, standalone examples, automated conformance suite, and installed iOS and
> Android simulator Release audits are complete for the supported surface.
> Physical iOS/Android and manual assistive-technology evidence must still pass
> before the final candidate bytes are published to npm and RubyGems.

## Release status

| Area | Current status |
| --- | --- |
| TypeScript package | `0.1.0` with `prerelease` status; builds, packs, and clean-installs all six public entrypoints |
| Rails gem | `0.1.0`; builds and clean-installs against `turbo-rails` `2.0.10` and `2.0.23` |
| Protocol baseline | Turbo `8.0.23`; all 26 upstream functional-suite families classified |
| Native Release evidence | Installed iOS Simulator and Android Emulator builds pass the shared Maestro core flow |
| Stable publication | Not published; physical-device, accessibility, final-candidate, and registry verification gates remain |

See the
[machine-readable compatibility manifest](https://github.com/noscrubs-dev/expo-turbo/blob/main/protocol/compatibility-manifest.json)
and
[0.1.0 release-readiness checklist](https://github.com/noscrubs-dev/expo-turbo/blob/main/docs/release-readiness-0.1.0.md)
for the exact boundary.

## Install

The registry commands below become valid only after the stable `0.1.0` release
is announced:

```sh
bun add expo-turbo
bundle add expo_turbo-rails
```

Until then, use a checked-out source commit:

```sh
git clone https://github.com/noscrubs-dev/expo-turbo.git
cd expo-turbo
bun install --frozen-lockfile
bun run check
```

Start with the
[getting-started guide](https://github.com/noscrubs-dev/expo-turbo/blob/main/docs/getting-started.md),
then use the
[standalone Expo app](https://github.com/noscrubs-dev/expo-turbo/tree/main/example/expo)
and
[standalone Rails host](https://github.com/noscrubs-dev/expo-turbo/tree/main/example/rails)
as the canonical integration examples.

## Support checklist

A checked item is implemented and covered by the current public source and test
suite. “Native equivalent” means the protocol outcome is supported through
explicit native adapters; it does not claim browser DOM behavior.

### Protocol and runtime

- [x] Strict, namespace-aware UTF-8 XML documents
- [x] Ordered multi-root Turbo Stream fragments
- [x] Byte, depth, node, attribute, text, and Stream-action limits
- [x] DTD, entity-declaration, and processing-instruction rejection
- [x] Preserved mixed content, CDATA, entities, and `xml:space`
- [x] Addressable document tree with stable keys and unique-ID enforcement
- [x] Case-sensitive XML selectors for supported structural target queries
- [x] Deterministic diagnostics and redacted typed protocol errors

### React Native host

- [x] Zod-backed typed component, component-action, and custom Stream registries
- [x] Explicit attribute codecs, child slots, aliases, and capability hashes
- [x] `ExpoTurboProvider`, `ExpoTurboRoot`, boundaries, hooks, and scoped state
- [x] Small-slice external-store subscriptions and deterministic disposal
- [x] Semantic style-token and direction adapters
- [x] Host-owned focus, scroll, visibility, storage, navigation, and observability adapters
- [x] Accessible busy, pending, disabled, validation, retry, and announcement surfaces

### Visits, links, history, and Frames

- [x] Same-origin document and Frame GETs with Turbo request headers
- [x] Redirect, empty, authoritative error, wrong-MIME, malformed, abort, and supersession outcomes
- [x] `advance`, `replace`, and native `restore` visits
- [x] Ten-entry snapshot cache, previews, preloads, and touch-native press-in prefetch
- [x] Host-acknowledged history identity plus root-scroll restoration
- [x] Same-document and host-routed cross-document native anchors
- [x] Eager, lazy, nested, recurse, disabled, targeted, and programmatic Frames
- [x] Matching-Frame extraction, missing-Frame handling, redirects, and request epochs
- [x] Native Frame loading, busy/complete, autofocus, autoscroll, and refresh-morph equivalents

### Forms

- [x] Host-registered successful controls and submitter precedence
- [x] GET, URL-encoded, `text/plain`, and multipart request planning
- [x] Rails method normalization and nested/repeated parameter names
- [x] Constraint validation, async confirmation, duplicate prevention, and `submits-with`
- [x] Matching Frame, direct Stream, `303`, `422`, `4xx`/`5xx`, `201`, and `204` handling
- [x] Component-owned draft preservation through compatible morphs
- [x] Bounded host-provided Blob/file entries and native picker adapters
- [x] Installed Android Emulator multipart proof through the real Rails host
- [ ] Physical Android multipart proof

### Streams and morphing

- [x] `append`, `prepend`, `replace`, `update`, `remove`, `before`, and `after`
- [x] Exact `target`, structural `targets`, template cloning, and collision semantics
- [x] Per-action ordering, isolated failures, custom actions, and lifecycle hooks
- [x] Refresh debounce, request-ID suppression, replace/morph, and scroll policy
- [x] Compatible stable-ID and anonymous native reconciliation
- [x] Permanent application, Frame, and Cable-source preservation
- [x] Component preserve/reset policy and bounded focus restoration
- [x] Document, Frame, Stream, element, and attribute morph lifecycle equivalents

### Action Cable

- [x] Strict `actioncable-v1-json` wire codec and same-origin endpoint admission
- [x] One-socket WebSocket adapter with exact identifier refcounting
- [x] Welcome, confirmation, rejection, ping, disconnect, retry, and heartbeat handling
- [x] Lifecycle/reachability suspension, credential rotation, and bounded retry policy
- [x] Document- and Frame-aware reconciliation after reconnect
- [x] Public XML Stream namespaces and protected host-authorized subscriptions
- [x] Short-lived header-ticket, resource-grant, revocation, and rotation example
- [ ] Physical iOS/Android lifecycle, network, protected-Cable, and renderer-flush evidence

### Rails gem

- [x] Route-free Engine and opt-in `ExpoTurbo::Rails::Controller`
- [x] Distinct `application/vnd.expo-turbo+xml` document/Frame MIME type
- [x] Confined host-owned XML view roots and structural template validation
- [x] Component/style capability admission and duplicate-ID rejection
- [x] Frame, `dom_id`, cache-variation, and structural test helpers
- [x] All built-in Stream tags, sibling responses, immediate/queued broadcasts, and refresh debounce
- [x] Public and protected Action Cable source/channel/broadcast APIs
- [x] Rails/Action Cable 7.2–8.1 and `turbo-rails` 2.0.10–2.x dependency bounds
- [x] Real matrix coverage for `turbo-rails` `2.0.10` and `2.0.23`

### Conformance and release evidence

- [x] Shared TypeScript/Ruby protocol fixtures
- [x] All 26 pinned Turbo 8.0.23 functional-suite families classified
- [x] Executable official-Turbo differentials for the meaningful shared surface
- [x] Package, gem, Expo, Rails, boundary, security, and production-export gates
- [x] Installed iOS Simulator Release audit through real Rails
- [x] Installed signed Android Emulator Release audit through real Rails
- [x] Automated web WCAG 2.0/2.1 A/AA axe audit and accessibility-tree checks
- [x] Paired candidate build, clean installs, checksums, and provenance proof
- [ ] Physical iOS/Android conformance evidence
- [ ] Manual VoiceOver, TalkBack, and browser screen-reader evidence
- [ ] Final paired candidate from the final gated commit
- [ ] Stable npm/RubyGems publication and clean registry verification

## Explicit boundaries

Expo Turbo reuses Turbo's wire and server semantics; it is not a headless DOM
port of `@hotwired/turbo`.

- Browser DOM targets, bubbling/composed paths, `<head>`/script/CSS behavior,
  selection ranges, shadow DOM, hover, and physical repaint timing are N/A.
- Components, component actions, native styles, navigation/history mapping,
  focus/scroll/visibility handles, credentials, identity, origin policy, retry
  values, and product state belong to the Expo host.
- Routes, controllers, views, authorization, cache inputs, tenant policy,
  grants, and product broadcasts belong to the Rails host.
- Action Cable provides online delivery; missed-message correctness uses
  canonical reconciliation rather than durable replay.
- Offline mutation replay is outside the Turbo contract.
- Server XML can select only installed names and validated values. It cannot
  import or execute code.
- Expo Turbo has no JSON fallback and does not require migration of an existing
  renderer.

## Public entrypoints

| Import | Purpose |
| --- | --- |
| `expo-turbo` | Version/status constants and combined public surface |
| `expo-turbo/core` | Parser, tree/session, visits, Frames, forms, Streams, lifecycle, and errors |
| `expo-turbo/adapters` | Host-neutral adapter interfaces and provided transport helpers |
| `expo-turbo/react` | Provider, renderer, boundaries, and React hooks |
| `expo-turbo/registry` | Typed component/action registries and attribute codecs |
| `expo-turbo/testing` | Reserved testing boundary; no runtime APIs in `0.1.0` |
| `expo_turbo/rails` | Rails Engine, controller concern, helpers, broadcasts, and Cable integration |
| `expo_turbo/rails/testing` | Opt-in strict structural XML test helpers |

Deep source imports are unsupported.

## Compatibility

| Dependency | Supported or validated range |
| --- | --- |
| Node.js | `>= 20.12` |
| Bun source toolchain | `>= 1.3.14` |
| React peer | `>= 19.1` |
| Primary Expo example | Expo SDK 57, React Native 0.86, Hermes |
| Ruby | `>= 3.2` |
| Rails / Action Cable | `>= 7.2`, `< 8.2` |
| `turbo-rails` | `>= 2.0.10`, `< 3`; matrix pins `2.0.10` and `2.0.23` |
| Protocol baseline | Turbo `8.0.23` |

## Repository layout

- `src/` — public TypeScript package source.
- `rails/` — public `expo_turbo-rails` gem and non-route-owning Rails Engine.
- `example/expo/` — standalone native consumer and compatibility gallery.
- `example/rails/` — standalone Rails and Action Cable host.
- `protocol/` — compatibility manifest, contract, and shared fixtures.
- `docs/` — getting started, decisions, release readiness, and evidence.
- `.maestro/` — checked-in native interaction flows.

The repository root is the publishable TypeScript package. It is intentionally
not a package-manager workspace; both examples keep independent dependency
state.

## Development

Run the TypeScript package:

```sh
bun install --frozen-lockfile
bun run check
```

Run and build the Ruby gem:

```sh
cd rails
bundle install
bundle exec ruby "$(bundle show rake)/exe/rake"
bundle exec ruby "$(bundle show rake)/exe/rake" build
```

Install each example independently, then run both checks from the repository
root:

```sh
cd example/expo && bun install --frozen-lockfile
cd ../rails && bundle install
cd ../..
bun run examples:check
```

## Documentation

- [Getting started](https://github.com/noscrubs-dev/expo-turbo/blob/main/docs/getting-started.md)
- [Protocol and authoring contract](https://github.com/noscrubs-dev/expo-turbo/blob/main/protocol/README.md)
- [Compatibility manifest](https://github.com/noscrubs-dev/expo-turbo/blob/main/protocol/compatibility-manifest.json)
- [0.1.0 release readiness](https://github.com/noscrubs-dev/expo-turbo/blob/main/docs/release-readiness-0.1.0.md)
- [iOS Simulator Release evidence](https://github.com/noscrubs-dev/expo-turbo/blob/main/docs/ios-simulator-release-0.1.0.md)
- [Android Emulator Release evidence](https://github.com/noscrubs-dev/expo-turbo/blob/main/docs/android-emulator-release-0.1.0.md)
- [Web accessibility evidence](https://github.com/noscrubs-dev/expo-turbo/blob/main/docs/web-accessibility-0.1.0.md)
- [Changelog](https://github.com/noscrubs-dev/expo-turbo/blob/main/CHANGELOG.md)

The manual Release workflow defaults to a non-publishing paired candidate. Its
reviewer-gated publish mode may consume only a successful candidate for the
exact final `main` commit and must reuse the downloaded npm and gem bytes
without rebuilding them.

See
[CONTRIBUTING.md](https://github.com/noscrubs-dev/expo-turbo/blob/main/CONTRIBUTING.md)
before proposing changes and
[SECURITY.md](https://github.com/noscrubs-dev/expo-turbo/blob/main/SECURITY.md)
for private vulnerability reporting.

## License

MIT. See [LICENSE](./LICENSE) and [NOTICE.md](./NOTICE.md).
