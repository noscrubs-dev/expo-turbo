# Expo Turbo 0.1.0 iOS Simulator Release evidence

This record covers the public source baseline
`359388727f499b1ea111d787ff5edd75b03af0ab` on 2026-07-24. It is simulator
evidence, not physical-device or stable-release evidence.

## Build and host

The root package was built before the example's independent install. The
standalone app was then compiled as an iOS Simulator `Release` build with the
standalone Rails origin embedded:

```sh
bun run build
cd example/expo
bun install --frozen-lockfile
EXPO_PUBLIC_EXPO_TURBO_DEMO_ORIGIN=http://127.0.0.1:3100 \
  xcodebuild \
  -workspace ios/ExpoTurboCompatibility.xcworkspace \
  -scheme ExpoTurboCompatibility \
  -configuration Release \
  -sdk iphonesimulator \
  -destination 'platform=iOS Simulator,id=C29D25F3-C0E6-4480-9A9C-423266E91DD2' \
  -derivedDataPath ios/build/current-main-release \
  CODE_SIGNING_ALLOWED=NO \
  build
```

The build succeeded with Expo SDK 57, React Native 0.86, Hermes, and no Metro
development server. The standalone Rails 8.1.3 host served the compiled origin
on port 3100 with Redis available.

## Maestro-only interaction

The app was installed with `simctl`; every UI interaction and assertion used
Maestro 2.7.0 against the booted iPhone 17 Pro / iOS 26.5 simulator:

```sh
xcrun simctl install \
  C29D25F3-C0E6-4480-9A9C-423266E91DD2 \
  ios/build/current-main-release/Build/Products/Release-iphonesimulator/ExpoTurboCompatibility.app

maestro --device C29D25F3-C0E6-4480-9A9C-423266E91DD2 \
  test .maestro/release-gallery-smoke.yaml

maestro --device C29D25F3-C0E6-4480-9A9C-423266E91DD2 \
  test .maestro/release-ios-live-frame-morph.yaml

MAESTRO_DRIVER_STARTUP_TIMEOUT=180000 \
  maestro --device C29D25F3-C0E6-4480-9A9C-423266E91DD2 \
  test .maestro/release-ios-live-frame-form.yaml
```

The first form-flow attempt stopped before executing the flow because Maestro's
iOS XCTest driver exceeded its default startup timeout. The documented timeout
override allowed the same flow to start normally. No AppleScript, `osascript`,
macOS pointer/keyboard automation, or other UI-control mechanism was used.

## Result

- `release-gallery-smoke.yaml` passed the installed gallery and mounted-Frame
  assertions.
- `release-ios-live-frame-morph.yaml` passed the Rails outer morph and
  renderer-acknowledged inner canonical reload.
- `release-ios-live-frame-form.yaml` passed authoritative `422`, state-preserving
  `204`, and adapter-followed canonical `303` behavior.

Physical iOS and Android device testing, VoiceOver/TalkBack evidence, and stable
registry publication remain open.
