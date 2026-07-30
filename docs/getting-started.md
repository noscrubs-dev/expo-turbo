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

Define registry attributes next to their wire codecs:

```tsx
import {
  attr,
  defineComponent,
  numberCodec,
  presenceCodec,
  stringCodec,
} from "expo-turbo/registry"
import { z } from "zod"

const price = defineComponent({
  attributes: {
    disabled: attr(presenceCodec).default(false),
    heading: attr(stringCodec, z.string().min(1)).prop("title"),
    "original-price": attr(numberCodec),
    subtitle: attr(stringCodec).optional(),
  },
  children: "none",
  component: Price,
  tag: "Price",
})
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
  renderError={(error, retry) => <ErrorMessage error={error} retry={retry} />}
/>
```

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
   `registry.capabilityManifestJSON()` and passing its path as `manifest:` to
   `expo_turbo_template_capabilities`.
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
| `expo-turbo/testing` | Reserved testing boundary; no runtime APIs in `0.1.5` |
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
- Treat missing targets as ordinary no-ops, but surface malformed XML, unknown
  components/actions, missing Frames, and rejected required subscriptions.
- Keep legacy runtimes separate; Expo Turbo does not define a JSON fallback.
