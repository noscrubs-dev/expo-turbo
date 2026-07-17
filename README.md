# expo-turbo

Turbo-compatible XML, Frames, Streams, and Action Cable adapters for Expo React Native and Rails.

> [!IMPORTANT]
> This repository implements an early XML tree, typed registry, React renderer with opt-in Frame lifecycle, and Rails XML foundation. It does not yet implement or claim complete Turbo compatibility, and no package has been published.

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
- [x] Shared text normalization with inherited `xml:space`, explicit `default` reset, preserved CDATA, collapsed XML whitespace, and deterministic fixture/diagnostic serialization.
- [x] Addressable mixed-content tree with deterministic keys, unique ID lookup, parent links, Frame/source indexes, comments, and CDATA.
- [x] Case-sensitive XML selector queries for lists, tags, IDs, classes, attributes, combinators, and structural pseudo-selectors without stale-result caching.
- [x] Typed component/module registry composition, Zod prop admission, explicit attribute codecs, child policies, aliases/deprecations, duplicate ownership errors, and deterministic capabilities.
- [x] Typed component-action definitions/modules with Zod params, injected state, provider-backed React invocation, serialized execution, and ordered `onSuccess`/`onError`/`onEnd` lifecycle.
- [x] Document-scoped external state store with stable per-key snapshots, fine-grained subscriptions, no-op suppression, component-action sharing, React bindings, and provider-unmount disposal.
- [x] Core identity-bound Frame/form state-scope registry with child-update preservation, replacement/removal cleanup, explicit disposal, and stable-ID reuse isolation.
- [x] React Frame/form state inheritance with automatic Frame boundaries, explicit form boundaries, nearest-scope bindings/actions, update preservation, and replacement cleanup.
- [x] Bounded typed state-reference decoding with exact `{"$state":"key"}` values, `{{state:key}}` scalar interpolation, recursive arrays/objects, nearest-scope action admission, and typed failures.
- [x] Bounded semantic style adapters with schema-owned `style-tokens`, frozen capability manifests, token/group/component limits, deterministic precedence, explicit React resolution, and an example-owned native corpus.
- [x] Deterministic descendant-first subtree disposal hooks with identity-safe replacement handling, explicit unregister, typed cleanup errors, and once-only registered-component cleanup on logical or React unmount.
- [x] Typed logical event bus with serial dispatch, cancellable notifications, nested pause/resume, stable listener snapshots, unsubscribe, and post-failure queue recovery.
- [x] Static React protocol renderer with stable `useSyncExternalStore` node snapshots, update-preserving component identity, same-ID replacement remounts, isolated subtree updates, registered error surfaces, mixed children, and non-rendering protocol nodes.
- [x] Ordered Turbo Stream fragment dispatch for `append`, `prepend`, `replace`, `update`, `remove`, `before`, and `after`, including target/selector precedence, transactional ID-collision preflight, payload cloning, no-ops, and isolated action errors.
- [x] Typed custom Stream-action registry with reserved/duplicate ownership checks, Zod-validated `data-*` parameters, shared target/template resolution, synchronous app-installed handlers, and isolated failures.
- [x] Exact Turbo Frame response extraction with mounted-wrapper preservation, redirected `src`, child replacement, embedded Stream execution/consumption, and typed missing-frame failures.
- [x] Same-origin Frame GET loader with Expo Turbo headers/MIME enforcement, `204` handling, redirected URL ownership, explicit cancellation, and per-frame late-response suppression.
- [x] Frame target resolution for submitter/element/default precedence, named Frames, `_self`, `_parent`, and `_top`, including page promotion when the selected Frame is unavailable or disabled.
- [x] Identity-bound observable Frame controller with eager `src` loading, explicit lazy/manual loading, same-source reload, stable busy/complete state, and cancellation/rebinding on disable, source removal, same-ID wrapper replacement, or disconnect.
- [x] Opt-in React Frame lifecycle wiring that connects mounted controllers, subscribes to lifecycle state, eagerly loads sources, and cancels/disposes requests when a Frame subtree unmounts.
- [x] Host-rendered Frame GET lifecycle and accessibility binding with a stable boundary, nearest-Frame hook, frozen native busy state, nested scoping, error containment, same-ID replacement rebinding, and no synthetic XML attributes.
- [x] Injected lazy-Frame visibility lifecycle that observes while mounted, loads on first visibility, stops observing when the request starts, and reports automatic-load failures.
- [x] Bounded Frame `recurse` extraction with whitespace-token matching, same-origin intermediary GETs, independent request IDs, redirected-base resolution, URL-loop/depth rejection, and canonical source ownership.
- [x] Shared programmatic Frame visit API for current, named, `_self`, `_parent`, and `_top` targets, with same-source reload plus explicit top-level/external navigation delegation.
- [x] Route-free Rails Engine, distinct Expo Turbo XML MIME type, confined host-owned `.xml.erb` rendering, and exact `turbo-rails` 2.0.10/2.0.23 test matrix.
- [x] Independently installed Expo and Rails examples in public CI, including a native component tree rendered from XML in the Expo gallery.

### In progress / not yet supported

- [ ] Document-visit and form-submission loading/accessibility surfaces, delayed visit progress, pending submitter behavior, and physical accessibility evidence.
- [ ] Visits, snapshot cache, restoration history, progress, and preload/prefetch.
- [ ] Concrete native visibility registration for ordinary layout, `ScrollView`, and virtualized `FlatList` cells; promoted Frame history, autofocus, autoscroll, and scroll adapters.
- [ ] Native forms, successful-control serialization, uploads, validation, redirects, and `422` rendering.
- [ ] Concrete visit/request/frame/form/Stream/morph lifecycle event families, refresh Stream actions, morph mode, and renderer flush timing.
- [ ] Native morphing and state/permanent-node preservation.
- [ ] Action Cable transport, protected subscriptions, reconnect, and canonical refresh reconciliation.
- [ ] Complete standalone compatibility gallery, differential conformance suite, and physical iOS/Android evidence.
- [ ] Stable npm/RubyGems publication. No registry release is supported yet.

## TypeScript API boundaries

The root package and explicit `expo-turbo/core`, `expo-turbo/adapters`, and `expo-turbo/registry` subpaths expose the current version, errors, inspector, parser, deterministic diagnostic serializer, typed logical events and state-reference resolution, addressable tree/session/state with subtree disposal, selectors, structural and custom Stream dispatch, Frame target/request/recurse/controller/visit APIs, semantic style adapters, typed component/component-action/custom-Stream-action registries, codecs, and host-adapter contracts. `expo-turbo/react` exposes the provider, root renderer, typed component-action/document/scoped-state/style/disposal hooks, explicit form state boundaries, automatic Frame state inheritance, host-defined Frame boundaries, the nearest-Frame binding hook, node and Frame lifecycle subscription hooks, and error surface. `expo-turbo/testing` remains a reserved module boundary and intentionally exports no runtime APIs yet. Deep source imports are unsupported.

The adapter surface is host-neutral. Core source does not import Expo Router, an Action Cable client, an app API client, or private application hooks.

## Status and compatibility

The intended baseline is Turbo 8.0.23, Rails/Action Cable 8.1.3, and `turbo-rails` 2.0.23, with the gem also testing `turbo-rails` 2.0.10 compatibility. Those targets are planning constraints until the public conformance suite proves them.

## License

MIT. See [LICENSE](./LICENSE) and [NOTICE.md](./NOTICE.md).
