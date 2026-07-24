# Expo Turbo 0.1.0 Android Emulator Release evidence

This record covers the public source baseline
`6668d48c45a0df70105482a17abb7070b354ce6b` on 2026-07-24. It is emulator
evidence, not physical-device or stable-release evidence.

## Build and host

The root package was built before the example's independent install. The
standalone app was then compiled as a signed Android `Release` APK with the
standalone Rails origin embedded for the Android emulator:

```sh
bun run build
cd example/expo
bun install --frozen-lockfile
cd android
EXPO_PUBLIC_EXPO_TURBO_DEMO_ORIGIN=http://10.0.2.2:3100 \
  ./gradlew app:assembleRelease
```

The build succeeded with Expo SDK 57, React Native 0.86, Hermes, and no Metro
development server. The standalone Rails 8.1.3 host served the compiled origin
on port 3100 with Redis available.

## Maestro-only interaction

The APK was installed with `adb`; every UI interaction and assertion used
Maestro 2.7.0 against the headless Pixel 2 / Android 13 emulator:

```sh
adb install -r \
  android/app/build/outputs/apk/release/app-release.apk

maestro --device emulator-5554 \
  test .maestro/release-gallery-smoke.yaml

maestro --device emulator-5554 \
  test .maestro/release-android-frame-form.yaml

adb push .maestro/fixtures/expo-turbo-android-picked.txt \
  /sdcard/Download/expo-turbo-android-picked.txt
adb shell am broadcast \
  -a android.intent.action.MEDIA_SCANNER_SCAN_FILE \
  -d file:///sdcard/Download/expo-turbo-android-picked.txt
maestro --device emulator-5554 \
  test .maestro/release-android-picker-form.yaml
```

The first gallery-smoke attempt lost Maestro's Android device server after the
fresh emulator boot. Repeating the same Maestro flow against the healthy device
passed. The multipart flows now scroll directly to their actionable controls
instead of requiring an intermediate heading to be centered. `adb` was used
only to install the APK, prepare the checked-in picker fixture, and inspect
logs/device state; it did not perform UI interaction.

## Result

- `release-gallery-smoke.yaml` passed the installed gallery and mounted-Frame
  assertions.
- `release-android-frame-form.yaml` submitted the example-owned fallback Blob,
  received matching Rails `422` XML, and retained the attachment for retry.
- `release-android-picker-form.yaml` selected the checked-in text file through
  Android Files, received matching Rails `422` XML, and retained that selected
  file for retry.

Physical iOS and Android device testing, VoiceOver/TalkBack evidence, broader
Android behavior coverage, and stable registry publication remain open.
