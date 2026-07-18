# Expo example

This private Expo SDK 57 application is the standalone native consumer and future compatibility gallery for `expo-turbo`. It owns its manifest and Bun lockfile, is not part of a package-manager workspace, and resolves the public package root through `file:../..`.

The app-lifetime Expo Turbo runtime/provider lives above the Expo Router Stack, and only the focused route attaches the history bridge and renders the document root. The bridge records managed restoration state in three namespaced string route params, repairs unmanaged or malformed metadata on the same route key, pushes advances, replaces focused params in place, rolls back failed writes to an exactly verified captured Router state, and translates pop/restored-state notifications into package traversal restoration. A same-document managed cold start adopts without fetching or writing. A different-document managed cold start gates the route behind one root-visitable, fragment-free exact GET, commits the exact `2xx`/`4xx`/`5xx` XML tree and managed history together without a Router write, and rejects redirects, empty/wrong-MIME/failed responses, changed route params, or focus loss before stale tree adoption. This proves logical route-param history and reload restoration rather than canonical route-path, preview, fragment, or scroll parity.

The current screen renders a small registered native component tree from XML and includes an editable native form with a host-owned Alert confirmation, registered terminal recovery boundary, host-owned static terminal announcements, interactive document links, a Frame-scoped link, a Stream update, and programmatic Frame visits. The form confirms its immutable proposal before busy/submitter state and the fixture request begin. Its first safe GET intentionally returns the wrong MIME type; the form boundary exposes the redacted terminal failure and an explicit retry that uses a fresh request ID, the exact submitter, and current edited values before the fixture succeeds with `204`. The host maps only the structured redacted terminal result to static copy: iOS queues polite `AccessibilityInfo` announcements, Android uses the native announcement API, and web keeps polite and assertive live regions mounted before changing their text. Plain same-origin links use the fixture document controller; the Frame-scoped link reuses the fixture Frame registry; and root-external or safe cross-origin links demonstrate the app-owned navigation adapter shared by the provider and Frame registry. The registry also receives the shared document controller so `_top` and promoted Frame visits use the same root policy. Its fixture-backed lazy Frame is wired through non-collapsible native window measurement against the root `ScrollView` viewport before following a bounded `recurse` intermediary; focused tests cover the offscreen/appearance contract, while physical-device evidence, nested scroll containers, and virtualized cells remain later gates. The renderer also exercises stable node subscriptions plus error containment. Inspector controls and real Rails mode land in later implementation gates.

Web uses the browser's settling confirmation dialog because react-native-web's `Alert` is a no-op. On iOS and Android, aborting a pending native Alert prevents any late answer from sending or reviving a request, but the platform Alert API cannot dismiss an already-visible dialog programmatically. A host that requires visual dismissal on navigation or supersession should inject a cancellable Modal-based adapter; that physical presentation/accessibility evidence remains unchecked.

## Run

```sh
cd ../..
bun install --frozen-lockfile
bun run build
cd example/expo
bun install --frozen-lockfile
bun run check
bun run start
```

The example install links its React into the local `file:../..` source checkout so the package and native app resolve one peer instance. Published package consumers use normal peer-dependency resolution and do not need this source-development link.

Start with Expo Go where supported. Release builds and physical iOS/Android evidence remain required before compatibility can be claimed.
