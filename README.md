# expo-turbo

Turbo-compatible XML, Frames, Streams, and Action Cable adapters for Expo React Native and Rails.

> [!IMPORTANT]
> This repository implements an early XML tree, typed registry, static React renderer, and Rails XML foundation. It does not yet implement or claim complete Turbo compatibility, and no package has been published.

## Repository layout

- `src/` — public TypeScript package source.
- `rails/` — public `expo_turbo-rails` gem and non-route-owning Rails Engine.
- `example/expo/` — standalone native consumer and compatibility gallery.
- `example/rails/` — standalone Rails and Action Cable host.
- `protocol/` — shared protocol manifest and conformance fixtures.
- `docs/` — public architecture, compatibility, and release guidance.

The repository root is the publishable TypeScript package. It is intentionally not a package-manager workspace; both example applications keep independent dependency state.

## Development

The TypeScript package requires Bun 1.3.14 or newer:

```sh
bun install
bun run check
```

The Ruby scaffold requires Ruby 3.2 or newer:

```sh
cd rails
bundle install
bundle exec ruby "$(bundle show rake)/exe/rake"
bundle exec ruby "$(bundle show rake)/exe/rake" build
```

Install each example independently, then run both checks from the repository root:

```sh
cd example/expo && bun install --frozen-lockfile
cd ../rails && bundle install
cd ../..
bun run examples:check
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) before proposing changes.

## Support checklist

A checked item is implemented and covered by the public test suite at the current commit. It does not imply complete Turbo compatibility; the package remains pre-release until the full conformance and physical-device gates pass.

### Available now

- [x] Public ESM package with explicit `core`, `adapters`, `react`, `registry`, and `testing` exports.
- [x] Host-neutral fetch, navigation, Cable, lifecycle, visibility, focus, scroll, style, storage, observability, clock, and request-ID adapter contracts.
- [x] Typed protocol errors, pinned version baselines, and an injected development inspector.
- [x] Strict, namespace-aware XML documents and ordered multi-root Turbo Stream fragment parsing.
- [x] Pre-parse byte/depth/DOCTYPE/processing-instruction guards plus node, attribute, text, and Stream-action limits.
- [x] Addressable mixed-content tree with deterministic keys, unique ID lookup, parent links, Frame/source indexes, comments, and CDATA.
- [x] Case-sensitive XML selector queries for lists, tags, IDs, classes, attributes, combinators, and structural pseudo-selectors without stale-result caching.
- [x] Typed component/module registry composition, Zod prop admission, explicit attribute codecs, child policies, aliases/deprecations, duplicate ownership errors, and deterministic capabilities.
- [x] Static React protocol renderer with stable `useSyncExternalStore` node snapshots, isolated subtree updates, registered error surfaces, mixed children, and non-rendering protocol nodes.
- [x] Ordered Turbo Stream fragment dispatch for `append`, `prepend`, `replace`, `update`, `remove`, `before`, and `after`, including target/selector precedence, ID collision rules, payload cloning, no-ops, and isolated action errors.
- [x] Exact Turbo Frame response extraction with mounted-wrapper preservation, redirected `src`, child replacement, embedded Stream execution/consumption, and typed missing-frame failures.
- [x] Same-origin Frame GET loader with Expo Turbo headers/MIME enforcement, `204` handling, redirected URL ownership, explicit cancellation, and per-frame late-response suppression.
- [x] Frame target resolution for submitter/element/default precedence, named Frames, `_self`, `_parent`, and `_top`, including page promotion when the selected Frame is unavailable or disabled.
- [x] Observable Frame controller with eager `src` loading, explicit lazy/manual loading, same-source reload, stable busy/complete state, and cancellation on disable, source removal/replacement, or disconnect.
- [x] Route-free Rails Engine, distinct Expo Turbo XML MIME type, confined host-owned `.xml.erb` rendering, and exact `turbo-rails` 2.0.10/2.0.23 test matrix.
- [x] Independently installed Expo and Rails examples in public CI, including a native component tree rendered from XML in the Expo gallery.

### In progress / not yet supported

- [ ] Whitespace normalization and canonical XML/tree serialization.
- [ ] Typed component-action and custom Stream-action registries.
- [ ] Renderer-backed component state scopes, style adapters, loading/accessibility hooks, and full mutation cleanup.
- [ ] Visits, snapshot cache, restoration history, progress, and preload/prefetch.
- [ ] Automatic lazy visibility, recurse extraction, promoted Frame history, autofocus, visibility registration, autoscroll, and scroll adapters.
- [ ] Native forms, successful-control serialization, uploads, validation, redirects, and `422` rendering.
- [ ] Refresh Stream actions, morph mode, lifecycle hooks, and renderer flush timing.
- [ ] Native morphing and state/permanent-node preservation.
- [ ] Action Cable transport, protected subscriptions, reconnect, and canonical refresh reconciliation.
- [ ] Complete standalone compatibility gallery, differential conformance suite, and physical iOS/Android evidence.
- [ ] Stable npm/RubyGems publication. No registry release is supported yet.

## TypeScript API boundaries

The root package and explicit `expo-turbo/core`, `expo-turbo/adapters`, and `expo-turbo/registry` subpaths expose the current version, errors, inspector, parser, addressable tree/session, selectors, structural Stream dispatcher, Frame target/request/controller APIs, typed component registry, codecs, and host-adapter contracts. `expo-turbo/react` exposes the provider, static root renderer, node subscription hook, and error surface. `expo-turbo/testing` remains a reserved module boundary and intentionally exports no runtime APIs yet. Deep source imports are unsupported.

The adapter surface is host-neutral. Core source does not import Expo Router, an Action Cable client, an app API client, or private application hooks.

## Status and compatibility

The intended baseline is Turbo 8.0.23, Rails/Action Cable 8.1.3, and `turbo-rails` 2.0.23, with the gem also testing `turbo-rails` 2.0.10 compatibility. Those targets are planning constraints until the public conformance suite proves them.

## License

MIT. See [LICENSE](./LICENSE) and [NOTICE.md](./NOTICE.md).
