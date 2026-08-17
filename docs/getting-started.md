# Getting started

Expo Turbo is a host-neutral XML protocol runtime. The TypeScript package owns
the native document tree, typed component registry, React renderer, visits,
Frames, forms, Streams, and injected adapter contracts. The Rails gem owns
opt-in XML rendering, Frame and Stream helpers, template validation, and public
or protected Action Cable boundaries. Applications retain responsibility for
components, navigation, authentication, network policy, accessibility delivery,
and product routes.

## Requirements

- Node.js 20.12 or newer
- Bun 1.3.14 or newer for source development
- React 19.1 or newer
- Expo Router 6 or newer when using `expo-turbo/expo-router`
- Ruby 3.2 or newer for the Rails gem
- Rails/Action Cable 7.2 through 8.1
- `turbo-rails` 2.0.10 through 2.x

Expo SDK 57, React Native 0.86, Hermes, Rails 8.1.3, and
`turbo-rails` 2.0.23 are the standalone example's validated primary stack.

## Install

Install the stable packages:

```sh
bun add expo-turbo
bundle add expo_turbo-rails
```

Before publication, clone the repository and exercise the exact source:

```sh
git clone https://github.com/noscrubs-dev/expo-turbo.git
cd expo-turbo
bun install --frozen-lockfile
bun run check
```

Do not treat the prior candidate artifacts as installable releases. The
[candidate record](./release-candidate-0.1.0.md) is verification evidence only
and its bytes have been superseded by later commits.

## Run the standalone stack

The examples deliberately keep independent dependency state; the repository is
not a package-manager workspace.

```sh
# Terminal 1: Rails and Action Cable
cd example/rails
bundle install
bin/rails server -p 3001

# Terminal 2: Expo
cd example/expo
bun install --frozen-lockfile
EXPO_PUBLIC_EXPO_TURBO_DEMO_ORIGIN=http://127.0.0.1:3001 bun start
```

Use a device-reachable Rails origin instead of `127.0.0.1` on physical devices.
The [Expo example guide](../example/expo/README.md) documents fixture and live
Rails modes; the [Rails example guide](../example/rails/README.md) documents
Redis, reset, readiness, and test commands.

## Quickstart

Adopting Expo Turbo costs one component. Put it in a catch-all Expo Router
route and the mounted pathname becomes the document path:

```tsx
// app/[...path].tsx
import { ExpoTurboApp } from "expo-turbo/expo"

import { registry } from "../registry"

export default function Screen() {
  return <ExpoTurboApp origin="https://example.com" registry={registry} />
}
```

That is the whole native side. `ExpoTurboApp` owns the document URL, the Expo
Router history and navigation bridge, the credentialed transport, the runtime
and its disposal, a loading spinner, and a retryable error surface. The only
work left is declaring your components, which the next section covers.

The document path follows the mounted route, search parameters included, so
`/orders?page=2` requests `/orders?page=2`. Pass `path` when the document is not
the mounted route, such as `path="/orders"`.

Search parameters come from a private Expo Router hook. If a future Expo Router
stops exposing it, `ExpoTurboApp` renders its error surface and asks for an
explicit `path` rather than falling back to the bare pathname: `/orders` and
`/orders?customer=42` are different documents, and nothing can tell a route that
has no query from one whose query it cannot see. Quietly serving the wrong
content is the one outcome worth failing over.

### Adapters

Everything else is an adapter, and `adapters` is the single escape hatch. Each
key has three states:

| State | Meaning |
| --- | --- |
| absent | Use the packaged default, when the key has one |
| an object | Use exactly this adapter |
| `null` | Explicitly off, even where a default exists |

```tsx
<ExpoTurboApp
  origin="https://example.com"
  registry={registry}
  adapters={{
    fetch: createDefaultFetchAdapter({ onRequest: authHeaders }),
    documentLinks: null,
    focus: focusRegistry,
  }}
/>
```

| Adapter | Default |
| --- | --- |
| `fetch` | `createDefaultFetchAdapter()` |
| `history`, `navigation` | The Expo Router bridge |
| `documentAnnouncements`, `formAnnouncements` | `AccessibilityInfo` announcements |
| `documentLinks` | `Linking.openURL` |
| `documentAutomaticPreloadPolicy`, `documentPrefetchPolicy` | Same-origin URLs only |
| `autofocus`, `autofocusScroll`, `cable`, `documentAnchorScroll`, `documentHistoryScroll`, `documentRefreshScroll`, `focus`, `frameAutoscroll`, `styles` | None |

The keys with no default need host-owned native node references, a real scroll
container, application style tokens, or — for `cable` — a socket, endpoint, and
credential policy, so the package cannot supply one. For those keys `null` and
absent behave identically; they are listed so an application can supply its own
without leaving `ExpoTurboApp`. Supplying `cable` is what enables
`turbo-cable-stream-source`; the runtime owns the subscription registry and
releases it on unmount.

Cable delivers Stream actions, `refresh` included, for as long as the socket is
up. It does **not** recover the document after a reconnect: anything broadcast
while the socket was down stays missing, so a mounted document can be stale
after a dropped connection. Refresh it yourself on reconnect if that matters for
your screens — `useDocumentReload()` from `expo-turbo/react` does it. Recovery
is tracked in [pull request 418](https://github.com/noscrubs-dev/expo-turbo/pull/418).

Supply `focus` once. When the object also satisfies `AutofocusAdapter`, the
library hands the same instance to form validation and to the renderer, so an
application never keeps two owners of one adapter in step by hand.

`clock`, `requestIds`, and `restorationIds` are not adapters at all: the
runtime has always owned them internally.

### Loading and error surfaces

`ExpoTurboApp` renders a spinner while a document loads and a retryable error
card when one fails. Development builds name the error, because that is the
only reader who can act on a `ContentTypeError`. Release builds show one fixed
sentence instead, and `onError` receives the same error object the surface was
given, so a release build still has a diagnostic path:

```tsx
<ExpoTurboApp
  origin="https://example.com"
  registry={registry}
  onError={(error, report) => telemetry.captureException(error, { extra: report })}
/>
```

The second argument says what the failure cost, and it is the same value the
library switches on to decide whether to raise the surface at all:

| `report.severity` | What failed | On screen |
| --- | --- | --- |
| `speculative` | A press-in prefetch or an automatic preload — a request whose whole purpose was to be discardable | Nothing changes |
| `background` | An accessory to a render that already succeeded: an accessibility announcement, autofocus, a scroll adapter | Nothing changes |
| `document` | The mounted document, or the navigation the user asked for | The error card replaces the document |

Only `document` replaces the document. Every failure used to, so a prefetch that
failed while the user pressed a link replaced the screen they were already
reading — and the unmount that came with it released every live
`turbo-cable-stream-source` subscription on that screen.

`report.nodeKey` is the protocol node the failure belongs to. It is absent only
for a configuration failure, which belongs to no node.

Be precise about what that error is. Expo Turbo redacts transport causes on
purpose: a socket or DNS failure is reported as
`RequestError("Document request failed")` and the underlying cause is **not**
attached, so `onError` alone will not tell you why the network call failed.
Its `context` carries the typed protocol detail — method, status, content type,
parse location — which is what distinguishes a `ContentTypeError` from a
`RequestError` from a `StateError`. For the underlying transport cause, observe
it where it is still in hand, in your own fetch adapter:

```ts
createDefaultFetchAdapter({
  onResponse: ({ status, url }) => telemetry.captureBreadcrumb({ status, url }),
})
```

One error deserves the same precision. When a document renders nothing at all
— every element unrecognised, or the only component that could have rendered
declining to — Expo Turbo replaces the document with a blank-root surface and
reports `StateError("Expo Turbo document root has no renderable fallback")`.
The message names the **condition**, not the **cause**, and it stays fixed so
trackers group on it. Which tag failed to render is reported separately, on
`onUnknownVocabulary`. A host debugging a blank screen has to read both:

```tsx
<ExpoTurboApp
  origin="https://example.com"
  registry={registry}
  onError={(error, report) => telemetry.captureException(error, { extra: report })}
  onUnknownVocabulary={(event) => telemetry.captureMessage("unknown vocabulary", event)}
/>
```

A blank screen is a **state with a duration**, so the operative question is
which screens go blank, for how long, on which app build. `report.blank`
answers all three:

| Field | Meaning |
| --- | --- |
| `documentUrl` | The screen, as of when the blank started |
| `runtimeVersion` | The installed Expo Turbo build |
| `since` | `Date.now()` when the blank started |
| `attempt` | 1-based ordinal of this report inside that blank |

`documentUrl` and `runtimeVersion` also ride on the error's own `context`, so a
host that forwards only the bare error still gets them.

While a document stays blank, `onError` fires again on every session revision
that wakes the root — so a Cable-driven stream of Streams trying to recover a
blank document produces one report per revision, not one per document. Every
one of them carries the same `since` and a rising `attempt`, so a single
surviving report states how long the document has been blank so far. Reports
are deliberately **not** deduplicated: a blank has no identity beyond the state
itself. Filter on `attempt` if you want edge-only telemetry, and read
`onUnknownVocabulary` for what actually failed.

Two documents behave differently and are worth knowing rather than discovering.
A document blank because its tree contains nothing the registry can render
reports **once**: its verdict holds and the guard is never re-raised. And a
document that recovers and goes blank again reports the new blank, as a new
interval with a new `since`.

The falling edge is on the renderer. `ExpoTurboProvider` takes
`onDocumentBlankRecovery`, which fires once when a blank document produces
output again, carrying the interval it closes plus `until`; `until - since` is
how long the screen was blank. It fires only while the provider stays mounted,
so a host whose boundary replaces the provider on the first report — which
`ExpoTurbo` and `ExpoTurboApp` do, because a blank document is a `document`
failure — has ended the document rather than recovered it, and gets no event.

```tsx
<ExpoTurboProvider
  onDocumentBlankRecovery={(event) =>
    telemetry.captureMessage("blank recovered", { ...event, ms: event.until - event.since })
  }
  {...rest}
/>
```

`onUnknownVocabulary` is the channel that names *which* vocabulary failed. Each
unrecognised element reports through its own boundary, independently of the
blank-root surface. Neither channel is a complete record of every blank, though
— a document can reach a blank state without re-raising at all — so a host that
must detect emptiness itself should check the rendered tree rather than rely on
these callbacks alone.

Pass `loading` or `renderError` to replace either surface.

### Transport

The packaged transport is credentialed. It keeps protocol headers from the
request, returns XML `4xx` and `5xx` responses for normal protocol handling,
and applies the timeout to request hooks, the fetch, response hooks, and
response-body reads. Request hooks receive a frozen header record and can
return more headers. Response hooks receive frozen metadata without access to
the response body. A hook failure rejects the request with a redacted
`RequestError`.

```ts
import { createDefaultFetchAdapter } from "expo-turbo/adapters"

const fetchAdapter = createDefaultFetchAdapter({
  onRequest: async () => {
    const token = await authToken()
    return token ? { Authorization: `Bearer ${token}` } : undefined
  },
  onResponse: async ({ headers }) => {
    await invalidateQueriesFromHeaders(headers)
  },
  timeoutMs: 30_000,
})
```

## Declare components

Define registry attributes next to their wire codecs in a file that does not
import React Native components:

```ts
import {
  attr,
  defineCapabilityModule,
  defineComponentDefinition,
  numberCodec,
  presenceCodec,
  stringCodec,
} from "expo-turbo/registry"
import { z } from "zod"

export const priceDefinition = defineComponentDefinition({
  attributes: {
    disabled: attr(presenceCodec).default(false),
    heading: attr(stringCodec, z.string().min(1)).prop("title"),
    "original-price": attr(numberCodec),
    subtitle: attr(stringCodec).optional(),
  },
  children: "none",
  tag: "Price",
})

export const storeCapabilities = defineCapabilityModule({
  components: [priceDefinition],
  name: "@example/store",
})
```

Bind the native renderer only in the runtime file:

```tsx
import {
  bindComponent,
  createRegistry,
  defineComponentModule,
} from "expo-turbo/registry"

import { priceDefinition, storeCapabilities } from "./component-definitions"

const price = bindComponent(priceDefinition, Price)
const registry = createRegistry(
  defineComponentModule({
    ...storeCapabilities,
    components: [price],
  }),
)
```

The component-free file can generate the Rails manifest in plain Node or Bun:

```ts
import { writeFile } from "node:fs/promises"
import { capabilityManifestJSON } from "expo-turbo/registry"

import { storeCapabilities } from "./component-definitions"

await writeFile(
  "config/expo_turbo_manifest.json",
  capabilityManifestJSON(storeCapabilities),
)
```

`attr()` uses the codec schema and derives the component Zod object. It changes
hyphenated XML names to camel-case prop names, such as `original-price` to
`originalPrice`. Use `.prop()` for a different prop name, `.optional()` for an
optional prop, `.default()` for a default value, and `.deprecated()` for a
deprecation warning and capability metadata. A custom codec must supply a
matching schema as the second `attr()` argument. The explicit component
`schema` form remains available when one object schema must validate
relationships between multiple props.

## Advanced composition

`ExpoTurboApp` is the documented path. The lower layers stay public for hosts
that need them, and each one gives up something the layer above supplies.

`ExpoTurbo` from `expo-turbo/react` is the same runtime without the Expo
Router, transport, and surface defaults. It owns session, visit, Frame, form,
refresh, state, and disposal wiring, but the host supplies the URL and every
adapter:

```tsx
<ExpoTurbo
  url={documentUrl}
  registry={registry}
  actions={componentActions}
  fetch={fetchAdapter}
  history={historyAdapter}
  navigation={navigationAdapter}
  loading={<Loading />}
  onUnknownVocabulary={(event) => telemetry.capture("expo_turbo_vocabulary", event)}
  renderError={(error, retry) => <ErrorMessage error={error} retry={retry} />}
/>
```

`actions` is optional on both `ExpoTurbo` and `ExpoTurboApp`. Pass a
`ComponentActionRegistry` only when registered components call
`useComponentAction`. The runtime builds the existing action runner with its
own document state store and sends it to the provider. Action names do not
become component capability identities, and a host with no actions does not
need an empty registry or other configuration.

The high-level runtime also builds the document and Frame preloaders. A
committed press-in document prefetch and an exact Frame preload share their
one-use response caches with the corresponding live request loader, so the
later visit does not send a duplicate request. Automatic document preload keeps
its existing preview-then-revalidation behavior. Hosts that compose
`ExpoTurboProvider` directly still choose whether to supply either preloader.

`renderError` is **required** on `ExpoTurbo`. A host-neutral component has no
primitives to draw with, so it can neither invent a failure surface nor throw:
an unhandled render throw is fatal on both React Native platforms, which is
worse than the blank screen it would be replacing. Making the surface the
host's decision at compile time is what keeps a failed document from being
either. Pass `renderError={() => null}` to deliberately render nothing.

`useExpoRouterAdapters` builds the Expo Router history and navigation adapters
directly. It returns one identity for the life of the mount, so inline option
callbacks are safe:

```tsx
import * as Linking from "expo-linking"
import { useExpoRouterAdapters } from "expo-turbo/expo-router"

function DocumentScreen() {
  const { history, navigation } = useExpoRouterAdapters({
    openExternal: (url) => Linking.openURL(url),
  })

  return <ExpoTurbo history={history} navigation={navigation} {...rest} />
}
```

By default, an absolute document URL maps to its path, query, and fragment.
Supply `hrefForDocument(url)` when the app uses a catch-all or another route
space. Supply `openExternal(url)` for the host's real browser or native-link
hand-off. When it is absent, the compatibility fallback pushes the absolute URL
through Expo Router. This bridge supplies synchronous history writes and basic
navigation. Managed native traversal metadata, restoration event delivery, and
app-specific external-link policy remain host work.

These adapters and the optional action registry are the runtime's identity.
`ExpoTurbo` replaces its whole runtime when `actions`, `fetch`, `history`,
`navigation`, `focus`, or `registry` changes identity, so build them outside
render or memoize them; an object rebuilt on every render refetches without
bound.

`createExpoTurboRuntime` suits a host that controls loading and presentation
separately. It exposes `documentPreloader` and `framePreloader`, plus `actions`
when an action registry was supplied. `ExpoTurboProvider` with `ExpoTurboRoot`
suits a host that composes the renderer itself. Import individual primitives
from `expo-turbo/core` only when custom runtime composition is required.

A host that shares one runtime across screens can use
`useExpoTurboDisposable(runtime)` to reference-count it. It disposes one
microtask after the last claim is released, so a StrictMode double-mount, a
Fast Refresh cycle, or a route swap hands the runtime over instead of tearing
it down.

Components passed through `boundaries` render inside the document but are
authored by the host, so they routinely read host contexts. Neither
`ExpoTurboApp` nor `ExpoTurbo` mounts a provider between the host tree and the
renderer, so anything wrapped around them stays an ancestor of those
components.

## Vocabulary tolerance

Installed clients can have an older component vocabulary than the server. An
unknown component becomes a transparent wrapper, so its children still render.
An unknown attribute is ignored while known attributes continue to decode. If
an optional attribute value cannot decode, its default or optional value is
used. If a required value cannot decode, the component also becomes a
transparent wrapper.

Each tolerated case calls `onUnknownVocabulary` after the fallback commits. The
frozen event identifies the tag, optional attribute, node key, document URL,
and failure kind. `nodeKey` and `tag` always describe the same element: the one
the issue was found on. Development builds also write one warning. Production builds
stay silent apart from the callback. Callback failures do not change document
state.

`data-*` attributes are shared protocol metadata, not component vocabulary.
They stay available through `protocol.data` and never report as unknown.

A `form` association whose owner tag is unknown reports the owner as an unknown
component instead of failing the control. The association is inert: the control
still renders, and its binding still answers state, validity, and
`successfulEntries()`, but `submit()`, `requestPlan()`, `submissionProposal()`,
and `retryFailure()` raise a `RegistryError` and `shouldInterceptSubmission()`
answers `false`. `action`, `method`, and `enctype` on a tag this client cannot
interpret must never become a request, so a submission deferred with
`afterCommit` is also rejected when the owner tag stops being known before the
queued submission runs. The association becomes live as soon as a known form
owner occupies that node key.

A component that calls one of the refused methods *while rendering* does not
raise the document error surface. That node renders nothing, the way an unknown
tag with no children does, and the gap reports through `onUnknownVocabulary`.
The node renders again once a known form owner occupies the node key. A dropped
node counts as no output for the blank-root guard above, so a refusal that
empties a document root still reaches the error surface rather than showing a
silent blank screen. That case is detected from what the commit produced rather
than predicted from the tree, so its error surface appears one commit after the
refusal; a root that cannot render anything at all is still decided while
rendering and never shows an empty frame.

A `form` value that points at a known component which is not a declared form
owner remains an error, because that is a document defect rather than a
vocabulary gap. Unknown attributes on the owner are still reported first, and
an unknown attribute on a form owner is reported even when the document never
renders that owner.

Form ownership stays declared, so an association failure is still a failure: a
missing, blank, or undeclared target fails closed exactly as before. What
changed is that a failure a host could previously only see as a bare `onError`
now carries evidence when vocabulary was involved.

When a control has no form scope and the render path unwrapped an ancestor
because of vocabulary — a tag this build does not have, or one whose required
attributes or child shape it could not decode — the failure also reports
through `onUnknownVocabulary`. The event describes the **unwrapped element** in
`nodeKey` and `tag`, exactly like every other vocabulary event, and carries the
control's key in `failureNodeKey`. That key is the one `onError` receives, so
the two can be correlated.

Read the event as exactly this and no more:

> this control's form association failed, **and** unknown or undecodable
> vocabulary was unwrapped above it

It is **not** a claim that the unwrapped element was the control's form owner.
An installed client does not have the tag, so a new layout wrapper and a new
form owner are indistinguishable to it; a document with a genuine orphan under
a new wrapper reports the same event. `kind` still separates the causes.
`component` means this build could not construct the element at all: either it
does not have the tag, or the props and children it received did not match the
component it does have. `attribute-decode` means an attribute value it could not
read.

What the signal does guarantee is silence when there is no vocabulary involved.
A control orphaned in a fully known document reports nothing, and neither does
a `form` value naming an id that does not exist — even when the document
contains unknown vocabulary elsewhere, because the rule reads the association's
own ancestry rather than the document at large. Unwrapping never breaks a real
ownership chain either: a control under a declared owner resolves through an
unwrapped ancestor, and a declared owner that unwraps keeps its form scope, so
both render and report nothing.

Tolerance must not silently show an empty screen. When a tolerated fallback
leaves no structurally renderable content, Expo Turbo protects each root kind:

| Root | Behavior |
| --- | --- |
| Document | The document error surface receives a `StateError` |
| Frame | The response is rejected, and the mounted Frame keeps its content |
| Stream | The action becomes a no-op, and later actions still apply |

A registered component always counts as renderable output, even when its own
component returns `null`. An empty response that carries no vocabulary
diagnostic keeps its existing native behavior.

`createRegistry()` supplies this behavior. A custom registry passed to
`ExpoTurboProvider` must implement `decodeForRender()`; `resolve()` stays
optional, and direct `decode()` calls stay strict.

Changing the document path performs a visit on the existing runtime. Without
`history`, it uses an ordinary visit; with `history`, it uses a replace visit
so the host router remains synchronized. Expo Turbo then owns history identity,
snapshots, and document/Frame coordination.

### Client compatibility

The runtime sends one generated `X-Expo-Turbo-Client` descriptor. It contains
the protocol version, runtime version, and a `sha256-128` digest of the canonical
registry. The ordered vocabulary revision stays in `expo-turbo.lock.json`; it
never goes on the wire. Gate the exact feature where the Rails template uses it:

```erb
<% if expo_turbo_client_supports_component?("NewCartTag") %>
  <NewCartTag />
<% end %>
```

Use `expo_turbo_client_supports_attribute?("CartRow", "quantity")` for an
attribute. Numeric revision requirements remain available through
`expo_turbo_client_revision_satisfies?` as an escape hatch. The legacy
`expo_turbo_client_supports?(module, requirement)` helper reads only the 0.2
modules header and raises for a resolved descriptor. A native request with a
missing, malformed, or unknown descriptor fails closed. A non-native request
keeps the web assumption that it supports the current vocabulary.

The descriptor-path error from `expo_turbo_client_supports?` does not appear in
browser or other non-native request tests. Those requests fail open and the
stale module gate returns `true`. Before deployment, search the templates for
`expo_turbo_client_supports?` and replace each descriptor-era gate. A passing
web test suite does not prove that this migration is complete.

Generate the manifest with `capabilityManifestJSON()` and configure Rails with
both paths:

```ruby
expo_turbo_template_capabilities(
  manifest: Rails.root.join("config/expo_turbo_manifest.json"),
  lockfile: Rails.root.join("expo-turbo.lock.json")
)
```

The repository example produces both artifacts with
`cd example/expo && bun run capabilities:write`. It reads
`DEMO_REGISTRY.capabilityManifestJSON()`, writes the manifest, and changes only
the digest of the one current unpublished lock record. It refuses missing or
duplicate current records and published records. It does not create or rewrite
release history. `bun run capabilities:check` is the read-only CI gate.

Without `lockfile:`, the gem warns when a native descriptor arrives and all
gates fail closed. Deploy the 0.3 gem before the 0.3 client. The new gem reads
the old modules header, but the old gem cannot read the new descriptor.
Within descriptor version 1, the gem rejects every field that is not in the
current field set. A future client must wait until the gem accepts a new field.
This is the reason for gem-first deployment: the server learns the grammar
before a client sends it.

Capability components that change server state outside a Turbo form can call
`useDocumentReload()` from `expo-turbo/react`. The returned async function
reloads the active document, so the component does not need a duplicated
`reload-href` attribute.

Use
[`example/expo/src/app/api/expo_turbo/demo/document.tsx`](../example/expo/src/app/api/expo_turbo/demo/document.tsx)
for the whole zero-configuration entrypoint,
[`example/expo/src/demo-registry.tsx`](../example/expo/src/demo-registry.tsx)
for registry and component patterns, and
[`example/expo/src/demo-runtime.tsx`](../example/expo/src/demo-runtime.tsx) for
the hand-composed provider, document, Frame, form, history, and Cable wiring
that advanced composition looks like.

An adopting Rails application should:

1. Add `expo_turbo-rails` and `require "expo_turbo/rails"`.
2. Include `ExpoTurbo::Rails::Controller` only in controllers that emit Expo
   Turbo XML.
3. Configure a host-owned XML view root plus exact component and style-token
   capabilities. Prefer a generated registry manifest by writing
   `capabilityManifestJSON()` from component-free capability modules and
   passing its path as `manifest:` and the checked-in compatibility lock as
   `lockfile:` to `expo_turbo_template_capabilities`.
4. Own every route, authorization rule, cache input, credential, and product
   view in the host.
5. Use the gem's Frame, Stream, structural test, and optional protected Cable
   APIs without changing existing HTML Turbo behavior.

The complete Rails API and examples are in the
[gem README](../rails/README.md).

## Public entrypoints

| Import | Purpose |
| --- | --- |
| `expo-turbo` | Version/status constants and the combined public surface |
| `expo-turbo/core` | Parser, tree/session, visits, Frames, forms, Streams, lifecycle, and errors |
| `expo-turbo/adapters` | Host-neutral adapter interfaces and provided transport helpers |
| `expo-turbo/expo` | `ExpoTurboApp`, the zero-configuration Expo entrypoint, and its surfaces |
| `expo-turbo/expo-router` | Optional Expo Router navigation and history-write bridge |
| `expo-turbo/react` | Provider, renderer, boundaries, and React hooks |
| `expo-turbo/registry` | Typed component/action registries and attribute codecs |
| `expo-turbo/testing` | Reserved testing boundary; no runtime APIs in `0.3.0` |
| `expo_turbo/rails` | Rails Engine, controller concern, helpers, broadcasts, and Cable integration |
| `expo_turbo/rails/testing` | Opt-in strict structural XML test helpers |

## Before production adoption

- Read the [protocol contract](../protocol/README.md).
- Check the [support checklist](../README.md#support-checklist) and
  [compatibility manifest](../protocol/compatibility-manifest.json).
- Implement host-specific auth, navigation, lifecycle, accessibility, and error
  presentation explicitly.
- Exercise the host's exact release build and real Rails origin on both
  platforms.
- Treat missing targets as ordinary no-ops. Report tolerated unknown components
  and attributes through `onUnknownVocabulary`. Surface malformed XML, unknown
  actions, invalid shared protocol values, missing Frames, and rejected required
  subscriptions through the normal error path.
- Keep legacy runtimes separate; Expo Turbo does not define a JSON fallback.
