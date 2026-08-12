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

## Build a host

An adopting Expo application should:

1. Define application components with `attr()` declarations through
   `expo-turbo/registry`.
2. Render the high-level `ExpoTurbo` component from `expo-turbo/react` with
   the document URL, registry, fetch adapter, and optional navigation adapter.
3. Supply only the adapters the host needs: fetch, navigation/history,
   lifecycle/reachability, focus/scroll, styles, storage, observability, and
   optional Cable transport.
4. Render admitted XML through `ExpoTurboRoot`; never execute server-selected
   code or fall back to an unrelated JSON renderer.
5. Keep credentials, origin selection, identity rotation, retry policy, and
   product state in the host.

The package provides a credentialed default transport. It keeps protocol
headers from the request, returns XML `4xx` and `5xx` responses for normal
protocol handling, and applies the timeout to request hooks, the fetch,
response hooks, and response-body reads. Request hooks receive a frozen header
record and can return more headers. Response hooks receive frozen metadata
without access to the response body. A hook failure rejects the request with a
redacted `RequestError`.

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

Expo Router applications can use the optional bridge:

```tsx
import * as Linking from "expo-linking"
import { useExpoRouterAdapters } from "expo-turbo/expo-router"

function DocumentScreen() {
  const { history, navigation } = useExpoRouterAdapters({
    openExternal: (url) => Linking.openURL(url),
  })

  return (
    <ExpoTurbo
      url={documentUrl}
      registry={registry}
      fetch={fetchAdapter}
      history={history}
      navigation={navigation}
    />
  )
}
```

By default, an absolute document URL maps to its path, query, and fragment.
Supply `hrefForDocument(url)` when the app uses a catch-all or another route
space. Supply `openExternal(url)` for the host's real browser or native-link
hand-off. When it is absent, the compatibility fallback pushes the absolute URL
through Expo Router. This bridge supplies synchronous history writes and basic
navigation. Managed native traversal metadata, restoration event delivery, and
app-specific external-link policy remain host work.

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
  name: "store",
  version: "1.0.0",
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

The standard host path owns session, visit, Frame, form, refresh, state, and
disposal wiring:

```tsx
<ExpoTurbo
  url={documentUrl}
  registry={registry}
  fetch={fetchAdapter}
  history={historyAdapter}
  navigation={navigationAdapter}
  loading={<Loading />}
  onUnknownVocabulary={(event) => telemetry.capture("expo_turbo_vocabulary", event)}
  renderError={(error, retry) => <ErrorMessage error={error} retry={retry} />}
/>
```

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

Changing `url` performs a visit on the existing runtime. Without `history`, it
uses an ordinary visit; with `history`, it uses a replace visit so the host
router remains synchronized. Expo Turbo then owns history identity, snapshots,
and document/Frame coordination.

Use `createExpoTurboRuntime` when the host needs to control loading and
presentation separately. It accepts the same `history` adapter. Import the
individual primitives from `expo-turbo/core` only when custom runtime
composition is required.

Capability components that change server state outside a Turbo form can call
`useDocumentReload()` from `expo-turbo/react`. The returned async function
reloads the active document, so the component does not need a duplicated
`reload-href` attribute.

Use
[`example/expo/src/demo-registry.tsx`](../example/expo/src/demo-registry.tsx)
for registry and component patterns and
[`example/expo/src/demo-runtime.tsx`](../example/expo/src/demo-runtime.tsx) for
the complete provider, document, Frame, form, history, and Cable composition.

An adopting Rails application should:

1. Add `expo_turbo-rails` and `require "expo_turbo/rails"`.
2. Include `ExpoTurbo::Rails::Controller` only in controllers that emit Expo
   Turbo XML.
3. Configure a host-owned XML view root plus exact component and style-token
   capabilities. Prefer a generated registry manifest by writing
   `capabilityManifestJSON()` from component-free capability modules and
   passing its path as `manifest:` to `expo_turbo_template_capabilities`.
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
| `expo-turbo/expo-router` | Optional Expo Router navigation and history-write bridge |
| `expo-turbo/react` | Provider, renderer, boundaries, and React hooks |
| `expo-turbo/registry` | Typed component/action registries and attribute codecs |
| `expo-turbo/testing` | Reserved testing boundary; no runtime APIs in `0.1.7` |
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
