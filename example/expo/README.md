# Expo example

This private Expo SDK 57 application is the standalone native consumer and future compatibility gallery for `expo-turbo`. It owns its manifest and Bun lockfile, is not part of a package-manager workspace, and resolves the public package root through `file:../..`.

The current screen renders a small registered native component tree from XML and includes an editable native form with a host-owned Alert confirmation and registered terminal recovery boundary, interactive document links, a Frame-scoped link, a Stream update, and programmatic Frame visits. The form confirms its immutable proposal before busy/submitter state and the fixture request begin. Its first safe GET intentionally returns the wrong MIME type; the form boundary exposes the redacted terminal failure and an explicit retry that uses a fresh request ID, the exact submitter, and current edited values before the fixture succeeds with `204`. Plain same-origin links use the fixture document controller; the Frame-scoped link reuses the fixture Frame registry; and root-external or safe cross-origin links demonstrate the app-owned navigation adapter shared by the provider and Frame registry. The registry also receives the shared document controller so `_top` and promoted Frame visits use the same root policy. Its fixture-backed lazy Frame follows a bounded `recurse` intermediary, and the renderer exercises stable node subscriptions plus error containment. Inspector controls and real Rails mode land in later implementation gates.

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
