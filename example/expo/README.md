# Expo example

This private Expo SDK 57 application is the standalone native consumer and future compatibility gallery for `expo-turbo`. It owns its manifest and Bun lockfile, is not part of a package-manager workspace, and resolves the public package root through `file:../..`.

The current screen renders a small registered native component tree from XML and exercises stable node subscriptions plus renderer error containment. Fixture transport, inspector controls, mutations, and real Rails mode land in later implementation gates.

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
