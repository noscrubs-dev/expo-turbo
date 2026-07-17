# Protocol

Shared compatibility manifests and cross-language fixtures will live here. The package remains pre-release and does not yet claim complete Turbo compatibility.

## State references

Component-action parameters resolve state references against the action's selected document, Frame, or form scope before Zod admission:

- `{"$state":"key"}` is an exact-value reference. It must contain only the `$state` key and may resolve to any value admitted by the action schema.
- `{{state:key}}` interpolates a scalar state value into a string. Structured values are rejected instead of being coerced to `[object Object]`.
- Arrays and plain objects resolve recursively. Object keys are never interpolated.

Missing/blank keys, malformed interpolation, ambiguous `$state` objects, cycles, unsupported object prototypes, and excessive depth are typed protocol failures. Resolution never falls through from a Frame/form scope to document or app-global state. Structured exact references must come from an explicit host codec; the package does not opportunistically `JSON.parse` arbitrary XML attributes.

## Semantic styles

Styling is component-schema-owned. A component may bind an explicit whitespace-separated `style-tokens` attribute with `tokenListCodec`; XML `class` remains structural selector metadata and is never forwarded as native `className`.

A host `StyleAdapter` exposes a frozen deterministic token manifest and resolves only app-compiled semantic definitions. Components create a style hook from that exact adapter with `createComponentStyleHook`, which binds the native style type and verifies the provider uses the same adapter. Resolution uses the component's canonical registered tag, including when XML uses an alias, and rejects unknown, repeated, excessive, same-group conflicting, and component-inapplicable tokens. The standalone Expo corpus demonstrates tone, spacing, layout, safe-area, and host-platform variants without accepting arbitrary React Native style objects or dynamic Tailwind/NativeWind values.

Style composition is deterministic: component defaults are lowest priority, admitted independent token groups compose in authored order, explicit schema-owned semantic props override tokens, and local transient native state such as pressed/disabled remains the component's highest-priority layer. Unsupported input raises a typed props failure inside the registered component error boundary; it is never ignored or normalized into a fallback class.

## Mutation identity and cleanup

Stable XML IDs provide addressability; they do not make two different tree nodes or document sessions the same runtime instance. A Turbo Stream `update` preserves its target node, component state, Frame controller, and target-owned scope while replacing children. `replace` and append/prepend/before/after ID-collision replacement create a new node identity even when the authored ID and tag are reused. React remounts that instance, old disposal hooks run exactly once, and a same-ID Frame wrapper cancels its old request/controller before the replacement can connect. Frame requests also carry exact node and controller ownership, so a retained stale controller can neither cancel a replacement request nor commit a late response into the replacement wrapper.

Built-in compound Stream actions validate every payload ID, including repeated IDs within one template, before removing collision nodes. A rejected action therefore leaves the active tree, revision, snapshots, scopes, and disposal registrations unchanged while later sibling Stream actions may continue. This preflight guarantee applies to the built-in dispatcher; arbitrary host mutations and custom Stream handlers must not mutate and then throw as though they were transactional.

Registered component cleanup runs on logical subtree removal/replacement and on ordinary React/provider unmount. Cleanup is identity-bound and once-only, so a logical mutation followed by React reconciliation cannot dispose the same resource twice.

## Document GET transport

`DocumentRequestLoader` is a host-neutral transport and tree-replacement primitive for a mounted `DocumentSession`; the observable lifecycle controller is layered on it below. It is not a navigation, history, or cache controller. It resolves relative sources against the active document URL and permits only credential-free, same-origin HTTP(S) request and final-response URLs. Document GETs advertise the Expo Turbo MIME type and send protocol, runtime, request-ID, and optional capability headers without a `Turbo-Frame` header.

After the fetch adapter follows redirects, the response's final URL becomes the parsed document URL. Valid XML responses are classified as `success` (`2xx`), `client-error` (`4xx`), or `server-error` (`5xx`) and replace the active tree only after MIME validation and a complete parse. A valid `4xx` or `5xx` XML document still commits as authoritative server output while retaining its distinct classification for the visit controller.

A `204` response and a blank `201` response are deliberate native empty outcomes that preserve the current tree and URL; they are not a claim of exact browser Drive GET behavior. Raw `3xx` responses, missing or cross-origin final URLs, wrong MIME types, malformed XML, and transport failures reject with typed errors without replacing the current tree.

Explicit cancellation, supersession by a newer loader request, or any intervening session-tree replacement prevents the stale response from committing and produces a canceled outcome. Tree ownership uses a monotonic generation, so restoring an earlier tree object does not revive an earlier request. `cancel(owner)` affects only a request started with that exact owner, while `cancel()` cancels the loader's current request. Disposal failures raised after tree replacement remain visible even though the new tree already owns the session.

This primitive does not implement navigation actions, root-scoped visitability, lifecycle events, snapshot/history restoration, preload/prefetch, or form submission. The separate visit controller below owns the currently supported loading and accessibility state.

## Document visit lifecycle and native accessibility

`DocumentVisitController` gives one mounted document session an identity-safe observable GET lifecycle. Its immutable snapshot moves from `initialized` to `started`, then to exactly one of `completed`, `failed`, or `canceled`. `busy` becomes true immediately at `started`. `progressVisible` becomes true only after the injected clock reaches `DOCUMENT_VISIT_PROGRESS_DELAY_MS` (500 ms) and is cleared on every terminal path.

A committed success document, `204`, or empty `201` completes the visit. A valid `4xx` or `5xx` XML error document commits first and then fails the visit. Network, MIME, parse, and pre-commit policy errors fail while preserving the prior tree. Explicit cancellation and supersession are `canceled`, never request errors. Epoch, request-owner, and session-generation checks prevent stale requests or cleared timers from publishing into a newer visit. A session finalization error after a successful commit remains observable while the lifecycle records `completed`; the equivalent error after an authoritative `4xx`/`5xx` commit records `failed`.

React hosts inject the controller through `documentController`, may supply a `documentComponent` boundary, and can read the nearest binding with `useExpoTurboDocument()`. The binding exposes the frozen controller snapshot plus a frozen `{ busy }` accessibility state for an actual native boundary. Controller ticks preserve the boundary and do not remount unchanged registered children. The controller remains host-owned across React unmount and Strict Mode effect replay; React subscribes and reports errors but never silently cancels it. State and error observers are snapshotted and isolated; hosts can provide `onObserverError` to surface observer failures without changing the visit's request result, and an unhandled observer failure is rethrown on a microtask.

This slice does not claim `advance`/`replace`/`restore` navigation, redirect history replacement, cache previews/restoration, lifecycle-event parity, form submission ownership, live announcements, browser progress-bar animation, or physical-device accessibility evidence.

## Top-level document-link activation

`useExpoTurboDocumentLink(href)` lets an app-owned registered component expose a plain top-level native link without adding React Native or a host router to the package. The hook requires the host-injected `DocumentVisitController` and returns a stable activation callback without subscribing the component to visit-state ticks. Activation delegates the unchanged `href` to that shared controller, so relative URL resolution, credential-free same-origin HTTP(S) admission, request headers, cancellation, response classification, and latest-visit ownership use the document GET contracts above.

The activation callback is bound to the exact registered protocol node that created it. It rechecks node identity at press time and fails closed after replacement/removal even if a deterministic key is reused. Frame ancestry, fragment-bearing URLs, the closest `data-turbo="false"` opt-out, and disabled/target/action/method/Stream/confirmation metadata also reject instead of being silently reinterpreted as a document GET. Every hook-level rejection occurs before a fetch and does not cancel a valid visit already owned by the controller. The example registry supplies the actual `Pressable`, link accessibility role, pending state, styling, and visible failure handling; those remain host responsibilities.

This is only top-level in-session document replacement. Frame capture and named targets, `_top`, external or explicit opt-out delegation, root-location restrictions, fragment/anchor navigation and scrolling, router/history actions, disabled/method/Stream/confirmation metadata, click/visit lifecycle events, snapshot restoration, and preload/prefetch remain unsupported. In Turbo 8.0.23, method and Stream links enter the form-submission path, so this hook does not silently reinterpret them as ordinary document GETs.

## Frame loading and native accessibility

A connected Frame exposes its immutable controller snapshot through a host-defined `frameComponent` boundary and `useExpoTurboFrame()`. The hook resolves the nearest connected Frame, so nested Frames receive independent bindings and components outside a Frame receive `undefined`. The default boundary remains a Fragment.

`busy` becomes true immediately while a Frame GET owns the controller and false on every terminal path. `complete` means only that the Frame is not currently loading; it is true after success, an empty `204`, failure, or cancellation. Hosts must inspect `status` and `hasBeenLoaded` when the terminal result matters. This slice covers Frame GET activity only. Document visits, targeted form submissions, delayed visual progress, submitter state, and live announcements remain separate contracts.

The binding includes a frozen `{ busy }` accessibility state for a host to pass to an actual native boundary. The package does not import React Native, infer that a disabled Frame makes all descendants inaccessible, announce server-authored status, or mutate `busy`, `complete`, or `aria-busy` into the logical XML tree. Controller-state changes preserve the boundary and current children; only boundary or nearest-Frame consumers rerender until a protocol mutation actually replaces children. Host boundary failures use the same registered Frame error surface as other protocol nodes.

## Programmatic Frame visits

`FrameControllerRegistry.visit(url, { frame, ... })` resolves through the shared interaction-style Frame target rules. A credential-free, fragment-free same-origin HTTP(S) URL targeting a Frame reuses that Frame's controller and loader; visiting its current `src` reloads it. A same-origin top/promoted target delegates to `NavigationAdapter.visit`, while a credential-free cross-origin HTTP(S) URL delegates to `openExternal`.

URL admission happens before target dispatch, any host-adapter call, or any Frame request/source ownership change. Invalid, non-HTTP(S), credential-bearing, fragment-bearing, or invalid-document URLs fail as redacted `TargetError`s and invoke neither navigation nor fetch, so a rejected visit cannot cancel or replace an already-loading Frame source.

This host-invoked API does not wire XML link/form capture, Turbo root visitability, fragment/anchor behavior, arbitrary external schemes, router/history state, or exact browser `Turbo.visit(url, { frame })` behavior. Those remain separate contracts.
