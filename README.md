# expo-turbo

Host-neutral XML protocol runtime foundation for Expo React Native and Rails, targeting Turbo 8.0.23 semantics.

> [!IMPORTANT]
> This repository implements an early XML tree, typed registry, React renderer with opt-in document/Frame lifecycle, and Rails XML foundation. It does not yet implement or claim complete Turbo compatibility, and no package has been published.

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

A checked item is implemented and covered by the public test suite in the current source snapshot. It does not imply complete Turbo compatibility; the package remains pre-release until the full conformance and physical-device gates pass.

### Available now

- [x] Public-source ESM package with explicit `core`, `adapters`, `react`, `registry`, and `testing` exports.
- [x] Host-neutral fetch, form-confirmation, form-announcement, navigation, Cable, lifecycle, visibility, focus, scroll, style, storage, observability, clock, and request-ID adapter contracts.
- [x] Typed protocol errors, pinned version baselines, and an injected development inspector.
- [x] Strict, namespace-aware XML documents and ordered multi-root Turbo Stream fragment parsing.
- [x] Pre-parse byte/depth/DOCTYPE/processing-instruction guards plus node, attribute, text, and Stream-action limits.
- [x] Shared text normalization with inherited `xml:space`, explicit `default` reset, preserved CDATA, collapsed XML whitespace, and deterministic fixture/diagnostic serialization.
- [x] Addressable mixed-content tree with deterministic keys, unique ID lookup, parent links, Frame/source indexes, comments, and CDATA.
- [x] Case-sensitive XML selector queries for lists, tags, IDs, classes, attributes, combinators, and structural pseudo-selectors without stale-result caching.
- [x] Typed component/module registry composition, Zod prop admission, explicit attribute codecs, child policies, aliases/deprecations, duplicate ownership errors, and deterministic capabilities.
- [x] Typed component-action definitions/modules with Zod params, injected state, provider-backed React invocation, serialized execution, and ordered `onSuccess`/`onError`/`onEnd` lifecycle.
- [x] Document-scoped external state store with stable per-key snapshots, fine-grained subscriptions, no-op suppression, component-action sharing, React bindings, and Strict Mode replay-safe provider-unmount disposal.
- [x] Core identity-bound Frame/form state-scope registry with child-update preservation, replacement/removal cleanup, explicit disposal, and stable-ID reuse isolation.
- [x] React Frame/form state inheritance with automatic Frame boundaries, explicit form boundaries, nearest-scope bindings/actions, update preservation, and replacement cleanup.
- [x] Host-neutral, identity-bound registry for the caller-admitted string-entry subset: enabled named values, checked checkables, and prefiltered ordered multi-values in XML order; repeated/empty entries are preserved, the activated submitter follows Turbo 8.0.23's append-last ordering, and exact-node cleanup follows control or form removal/replacement.
- [x] Explicit React form ownership and live native control registration with current-value updates, registration-bound submitter selection, nearest-form isolation, Strict Mode replay safety, and Stream child-update/same-ID replacement cleanup.
- [x] Pure immutable form request planning from raw form/submitter metadata and successful string entries: credential-free same-origin HTTP(S) action resolution; submitter/form action, method, and enctype precedence; GET Stream opt-in and automatic unsafe Stream headers; GET query replacement; URL-encoded unsafe bodies; Rails `_method` normalization; submitter-entry consistency; and shared protocol headers. Explicit action fragments and unsafe `text/plain`/multipart bodies fail closed.
- [x] Immutable active-form request planning in core and React from current form/submitter attributes, registration-bound submitter identity, live XML-ordered entries, and caller-supplied protocol metadata/signal; it performs no fetch, destination targeting, pending UI, validation, or response handling.
- [x] Atomic active-form submission proposals in core and React with Turbo 8.0.23 submitter/form/Frame target precedence, distinct inside/outside-Frame blank and missing-target behavior, top-level named-Frame capture, internally derived `Turbo-Frame` metadata, browser-target rejection, and hidden exact form/submitter/destination/tree-generation identity; proposals perform no fetch or request-ownership change.
- [x] Caller-scoped form request execution lanes that admit only planner-issued requests, create the owning abort signal before planning, forward the exact request once, supersede only within that lane, settle cancellation even when an adapter ignores the signal, suppress late fetch/body results, enforce credential-free same-origin final URLs and negotiated MIME, and return frozen unapplied `xml`, `stream`, `empty`, or `canceled` candidates with `2xx`/`4xx`/`5xx` classification. Candidate creation does not resolve a destination or mutate the active tree.
- [x] Destination-aware form request ownership through `FormSubmissionController`: exact proposals are re-admitted before ownership, document and exact-Frame lanes are shared with GET loaders across instances, pre-admission failures cannot cancel an incumbent, shared-destination supersession remains owner-safe, an explicit same-form supersede can change destinations safely, distinct Frames remain concurrent, and the exact request is fetched once.
- [x] Canonical ownership-safe form response disposition through `FormSubmissionController`: the exact lease is retained and rechecked before staged mutations, and reentrant supersession stops and reports undispatched actions; negotiated Streams dispatch for `2xx`/`4xx`/`5xx`; successful matching-Frame, origin-Frame error, or document Expo XML, including authoritative server-rendered `422`, commits without refetch; ordinary `204`/blank-`201` are no-ops while adapter-followed empty Frame redirects update `src`; successful documents adopt the validated final URL, adapter-followed Frame XML updates `src`, and top-level `4xx`/`5xx` preserve the active document URL; unsafe nonredirect document `200`, invalid responses, or stale candidates cannot begin mutation.
- [x] Session-shared exact-form submission activity in core and React: observable busy state tied to the immutable planner-issued request; atomic rapid-duplicate prevention by default with an explicit same-form `supersede` override; pending/effective-disabled state plus nonempty raw `data-turbo-submits-with` presentation for only the activated submitter; and deterministic cleanup on success, failure, abort, form removal, or final mounted React form-scope/provider unmount before document, Frame, or Stream response application. Strict Mode replay and multiple providers share exact-form ownership; headless callers cancel explicitly. The standalone Expo example exercises this path.
- [x] Host-injected async native form confirmation through `FormSubmissionController`: the immutable proposal captures submitter-first `data-turbo-confirm` by attribute presence, including empty and whitespace values; confirmation receives a cancellation signal and must return a literal boolean; visible busy/submitter state, destination ownership, and fetch begin only after acceptance. Denial, duplicate prevention, explicit cancellation, replacement/removal, final form-scope/provider unmount, adapter failure, and stale or superseded approval cannot send or revive a request. The standalone Expo example supplies a native Alert adapter plus a settling browser-confirm fallback.
- [x] Exact-form terminal submission reporting and host-rendered recovery in core and React: a session-shared frozen snapshot distinguishes applied, empty, canceled, uncommitted failure, and committed-with-error outcomes only after busy/submitter cleanup; exact-attempt settlement prevents stale or superseded work from overwriting newer truth. A provider-registered form boundary can dismiss results or explicitly retry only a safely retryable failure with a fresh request ID; retry reuses the exact live submitter and replans from current registered values, while `retryFailure` refuses unsafe or already-committed outcomes.
- [x] Host-injected exact-form terminal live announcements in React: each new non-`none` redacted terminal revision is offered to the adapter at most once per exact form only after busy and activated-submitter cleanup; initial or cleared state, pre-start denial, stale or superseded settlement, Strict Mode replay, multiple providers, removal, and same-key replacement do not duplicate or leak an announcement. Hosts own localized copy and platform delivery; the standalone Expo example maps the contract to React Native `AccessibilityInfo` and persistent polite/assertive web live regions.
- [x] Bounded typed state-reference decoding with exact `{"$state":"key"}` values, `{{state:key}}` scalar interpolation, recursive arrays/objects, nearest-scope action admission, and typed failures.
- [x] Bounded semantic style adapters with schema-owned `style-tokens`, frozen capability manifests, token/group/component limits, deterministic precedence, explicit React resolution, and an example-owned native corpus.
- [x] Deterministic descendant-first subtree disposal hooks with identity-safe replacement handling, explicit unregister, typed cleanup errors, and once-only registered-component cleanup on logical or React unmount.
- [x] Typed logical event bus with serial dispatch, cancellable notifications, nested pause/resume, stable listener snapshots, unsubscribe, and post-failure queue recovery.
- [x] Static React protocol renderer with stable `useSyncExternalStore` node snapshots, update-preserving component identity, same-ID replacement remounts, isolated subtree updates, registered error surfaces, mixed children, and non-rendering protocol nodes.
- [x] Ordered Turbo Stream fragment dispatch for `append`, `prepend`, `replace`, `update`, `remove`, `before`, and `after`, including target/selector precedence, transactional ID-collision preflight, payload cloning, no-ops, and isolated action errors.
- [x] Typed custom Stream-action registry with reserved/duplicate ownership checks, Zod-validated `data-*` parameters, shared target/template resolution, synchronous app-installed handlers, and isolated failures.
- [x] Document GET loader with shared Expo Turbo headers, credential-free same-origin HTTP(S) request/final-URL enforcement, MIME validation, parse-before-replace handling for valid `2xx`/`4xx`/`5xx` XML, explicit `204`/empty-`201`/canceled outcomes, owner-aware cancellation, and generation-safe stale-response suppression.
- [x] Observable document GET visit lifecycle with `initialized`/`started`/`completed`/`failed`/`canceled` snapshots, immediate busy accessibility, Turbo's 500 ms delayed visual progress, authoritative error-document classification, host-owned React binding, owner-safe cancellation, and stale timer/request suppression.
- [x] App-owned plain top-level native document links through `useExpoTurboDocumentLink`, with same-origin GET admission and latest-visit ownership delegated to the observable document controller plus fail-closed stale, fragment, and unsupported-metadata activation.
- [x] Host-injected link delegation for credential-free cross-origin HTTP(S) and the closest `data-turbo="false"`, with nested opt-in override, absolute URL delivery, awaited adapter failures, frozen typed results, and no document-controller ownership changes.
- [x] Turbo 8.0.23 root visitability for top-level advance visits and coordinator-wired promoted native visits, using document-scoped `data-turbo-root` (default `/`), the exact path-prefix and case-sensitive extension policy, pre-ownership host delegation, and native pre-commit successful-redirect reclassification against the response root. Interactive links are classified before Frame capture, while direct Frame `src` and programmatic Frame loads remain root-agnostic.
- [x] Exact Turbo Frame response extraction with mounted-wrapper preservation, redirected `src`, child replacement, embedded Stream execution/consumption, and typed missing-frame failures.
- [x] Same-origin Frame GET loader with Expo Turbo headers/MIME enforcement, `204` handling, redirected URL ownership, explicit cancellation, and per-frame late-response suppression.
- [x] Frame target resolution for submitter/element/Frame-default/current-Frame precedence, named Frames, `_self`, `_parent`, and `_top`, with missing named targets falling back to the current Frame and `_top`, unavailable `_parent`, or disabled Frame targets promoting to the owning document.
- [x] Identity-bound observable Frame controller with eager `src` loading, explicit lazy/manual loading, same-source reload, stable busy/complete state, and cancellation/rebinding on disable, source removal, same-ID wrapper replacement, or disconnect.
- [x] Opt-in React Frame lifecycle wiring that connects mounted controllers, subscribes to lifecycle state, eagerly loads sources, and cancels/disposes requests when a Frame subtree unmounts.
- [x] Host-rendered Frame GET lifecycle and accessibility binding with a stable boundary, nearest-Frame hook, frozen native busy state, nested scoping, error containment, same-ID replacement rebinding, and no synthetic XML attributes.
- [x] Injected lazy-Frame visibility lifecycle that observes while mounted, loads on first visibility, stops observing when the request starts, and reports automatic-load failures.
- [x] Bounded Frame `recurse` extraction with whitespace-token matching, same-origin intermediary GETs, independent request IDs, redirected-base resolution, URL-loop/depth rejection, and canonical source ownership.
- [x] Shared programmatic Frame visit API for current, named, `_self`, `_parent`, and `_top` targets, with credential-free, fragment-free HTTP(S) admission, same-origin Frame loading and same-source reload, plus awaited owning-document or cross-origin host-navigation delegation whose failures preserve Frame request/source ownership.
- [x] Unless the closest `data-turbo` setting opts out, root-visitable registered native links inside the nearest Frame and top-level links whose non-`_top` target identifies an active enabled Frame enter the shared Frame visit path, including Frame-default/element target precedence, `_self`, `_parent`, `_top`, current-Frame fallback for a missing named target, and isolated Frame/document request ownership. Top-level `_top`, missing, and disabled targets follow ordinary top-level activation; opted-out links delegate through host navigation.
- [x] Route-free Rails Engine, distinct Expo Turbo XML MIME type, confined host-owned `.xml.erb` rendering, and exact `turbo-rails` 2.0.10/2.0.23 test matrix.
- [x] Independently installed Expo and Rails examples in public CI, including a native component tree rendered from XML in the Expo gallery.

### In progress / not yet supported

- [ ] Physical iOS VoiceOver, Android TalkBack, and browser screen-reader evidence for form busy state, submitter pending/disabled and submits-with presentation, confirmation, terminal-result announcements, retry, and dismissal.
- [ ] Remaining Turbo link/navigation behavior: host-router URL/history synchronization, explicit `replace`/`restore` visits, fragment/anchor navigation and scrolling, disabled/method/Stream/confirmation/action metadata, explicit non-HTTP scheme policies, snapshot cache/restoration, and preload/prefetch.
- [ ] Concrete native visibility registration for ordinary layout, `ScrollView`, and virtualized `FlatList` cells; promoted Frame history, autofocus, autoscroll, and scroll adapters.
- [ ] Remaining successful-control semantics: disabled fieldset/option inheritance, external form ownership, datalist ancestry, files, image coordinates, `_charset_`, `dirname`, and form-associated custom elements.
- [ ] Rails `text/plain` decoding plus native multipart/upload transport.
- [ ] Morph-aware `422` native field-state preservation and form-driven snapshot/history invalidation.
- [ ] Native constraint validation and invalid-control focus behavior.
- [ ] Concrete visit/request/frame/form/Stream/morph lifecycle event families and form-request mutation hooks, plus refresh Stream actions, morph mode, and renderer flush timing.
- [ ] Native morphing and state/permanent-node preservation.
- [ ] Action Cable transport, protected subscriptions, reconnect, and canonical refresh reconciliation.
- [ ] Complete standalone compatibility gallery, differential conformance suite, and physical iOS/Android evidence.
- [ ] Stable npm/RubyGems publication. No registry release is supported yet.

## TypeScript API boundaries

The root package and explicit `expo-turbo/core`, `expo-turbo/adapters`, and `expo-turbo/registry` subpaths expose the current version, errors, inspector, parser, deterministic diagnostic serializer, typed logical events and state-reference resolution, addressable tree/session/state with subtree disposal, host-owned document-scoped identity-bound form controls, successful string-entry collection, immutable active-form request planning, atomic destination-aware submission proposals, session-shared exact-form submission activity and terminal reporting, safe fresh-request recovery, duplicate/supersede policy, host-injected async form confirmation and exact-terminal announcement adapters, caller-scoped execution with classified unapplied form-response candidates, shared-destination form submission with canonical response application, selectors, structural and custom Stream dispatch, document GET loading with controlled pre-commit admission, root-aware visit control, Frame target/request/recurse/controller/programmatic-visit APIs, semantic style adapters, typed component/component-action/custom-Stream-action registries, codecs, and host-adapter contracts. `expo-turbo/react` exposes the provider, root renderer, typed component-action/document/scoped-state/style/disposal hooks, explicit form ownership and live control registration/collection/planning/proposal hooks, observable form activity, terminal result state, a host-defined form boundary, safe explicit retry, an at-most-once host announcement attempt per terminal revision, exact activated-submitter pending/effective-disabled/submits-with presentation with replay-safe final-scope cancellation, document-tree native-link activation with document-load, Frame-visit, or delegated-navigation results, explicit form state boundaries, automatic Frame state inheritance, host-defined document and Frame boundaries, nearest-document/Frame binding hooks, node and lifecycle subscription hooks, and error surface. `expo-turbo/testing` remains a reserved module boundary and intentionally exports no runtime APIs yet. Deep source imports are unsupported.

Non-canceled form-response reports expose `responseUrl` as the validated final transport URL. That field does not imply that the active document URL or a Frame `src` adopted it. Applied document and direct Stream reports expose `streams.interrupted`; applied Frame reports expose `frame.streams.interrupted`; empty and canceled reports have no Stream report. Read these variant-specific fields with `applicationDestination` and the application/status fields to determine canonical session state.

The adapter surface is host-neutral. Core source does not import Expo Router, an Action Cable client, an app API client, or private application hooks.

## Status and compatibility

The intended baseline is Turbo 8.0.23, Rails/Action Cable 8.1.3, and `turbo-rails` 2.0.23, with the gem also testing `turbo-rails` 2.0.10 compatibility. Those targets are planning constraints until the public conformance suite proves them.

## License

MIT. See [LICENSE](./LICENSE) and [NOTICE.md](./NOTICE.md).
