# Expo example

This private Expo SDK 57 application is the standalone native consumer and future compatibility gallery for `expo-turbo`. It owns its manifest and Bun lockfile, is not part of a package-manager workspace, and resolves the public package root through `file:../..`.

The current screen proves only the independent Expo Router/Metro/package boundary. Protocol scenarios, fixture transport, inspector controls, and real Rails mode land in later implementation gates.

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

Start with Expo Go where supported. Release builds and physical iOS/Android evidence remain required before compatibility can be claimed.
