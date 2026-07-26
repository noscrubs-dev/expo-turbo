# Expo Turbo 0.1.0 physical iOS Release evidence

This record covers public `main` commit
`7c06971ab37812d0ad4c313ea7a0486466355336` on 2026-07-26. It is physical
device evidence for the standalone Expo app and Rails host, not manual
VoiceOver evidence or stable-registry publication evidence.

## Device, build, and host

- Device: iPad mini (A17 Pro), model `iPad16,1`
- iPadOS: `26.5` (`23F77`)
- Device UDID: `00008130-0011650A0C20001C`
- Xcode: `26.6` (`17F113`)
- Driver: Appium `3.6.0`, XCUITest driver `12.1.0`, and WebDriverAgent
- Signing team: No Scrubs `3DL6F6ACQK`

The app was compiled as an installed-device `Release` build with the standalone
Rails origin embedded and no Metro development server:

```sh
cd example/expo/ios
EXPO_PUBLIC_EXPO_TURBO_DEMO_ORIGIN=http://MacBook-Pro-5.local:3001 \
  xcodebuild \
  -workspace ExpoTurboCompatibility.xcworkspace \
  -scheme ExpoTurboCompatibility \
  -configuration Release \
  -destination 'id=00008130-0011650A0C20001C' \
  -derivedDataPath /tmp/expo-turbo-ios-provider-derived \
  DEVELOPMENT_TEAM=3DL6F6ACQK \
  CODE_SIGN_STYLE=Automatic \
  'CODE_SIGN_IDENTITY=Apple Development' \
  build
```

The signed app was installed with `devicectl`. The standalone Rails host served
the compiled origin on port `3001` with Redis available.

## Physical-device interaction

Maestro does not drive physical iOS devices, so Appium/XCUITest executed the
same 14 checked-in shared release flows through their accessibility-visible
selectors and assertions. The adapter translated the existing launch, deep
link, tap, text input, scroll, swipe, wait, visibility, and screenshot commands
to XCUITest without changing the contract inventory or app behavior.

CoreDevice was used only to install and launch the signed app, deliver deep
links when physical iOS did not forward a nested custom URL reliably, and place
the picker fixture in the app container. It did not perform UI interaction.

## Shared-suite result

All 14 shared flows passed:

- gallery static actions and native form behavior;
- document links, refresh/history, and Frame links/promotion;
- nested visibility and virtualized Frame loading;
- public and protected Action Cable, including lifecycle, ticket rotation,
  revocation, recovery, and renderer flush;
- document and Frame morph/reconciliation behavior;
- live primary and secondary forms; and
- built-in attachment validation, matching `422` retention, retry, and success.

That is the complete shared matrix: **71/71 grouped contracts** and **115/115
atomic observations** passed on the physical iPad.

## iOS Files-provider proof

For the provider-specific proof, the generated ignored iOS app configuration
temporarily enabled `UIFileSharingEnabled` and
`LSSupportsOpeningDocumentsInPlace`. This exposed the standalone host app's
Documents container in Files without changing package or gem source.

`expo-turbo-ios-picked.txt` was copied into that container. XCUITest then:

1. opened the real iOS Files picker;
2. navigated through **On My iPad** and the **Expo Turbo Compatibility** app
   container;
3. selected `expo-turbo-ios-picked.txt`;
4. submitted it to the standalone Rails host;
5. observed two intentional matching `422` responses while the selected
   filename and retry surface remained available; and
6. completed the final multipart upload successfully.

The local evidence directory is `/tmp/expo-turbo-ipad-evidence`; its final
picker screenshot is `release-picker-form-ios-submit-passed.png`.

## Remaining release boundary

Physical iOS device conformance and the standalone protected-Cable device proof
are complete. Manual VoiceOver, TalkBack, and browser screen-reader
speech/navigation remain explicitly pending. The final frozen candidate and
stable npm/RubyGems publication also remain open.
