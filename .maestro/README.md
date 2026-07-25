# Maestro device evidence

These flows exercise the installed standalone Expo example. They are device
interaction evidence rather than package CI. The shared contract inventory and
per-platform evidence live in [COVERAGE.md](./COVERAGE.md).

Keep selectors accessibility-visible and deterministic. Direct `device-test-*`
entries may reveal or mount the same production proof surface, but may not copy
the behavior, weaken assertions, or change runtime semantics. Run one flow at a
time until it is stable; stop immediately if the app crashes or Maestro escapes
to the launcher.

## Physical Android

Start the standalone Rails host, reverse its port to the connected device, and
install a release build compiled for the reversed origin:

```sh
cd example/rails
bin/rails server -b 0.0.0.0 -p 3001

adb -s <serial> reverse tcp:3001 tcp:3001

cd ../expo/android
NODE_ENV=production \
EXPO_PUBLIC_EXPO_TURBO_DEMO_ORIGIN=http://127.0.0.1:3001 \
./gradlew app:assembleRelease
adb -s <serial> install -r app/build/outputs/apk/release/app-release.apk
```

Run one shared flow:

```sh
MAESTRO_DRIVER_STARTUP_TIMEOUT=180000 \
  maestro --device <serial> test .maestro/release-live-frame-form.yaml
```

All normal `release-*.yaml` flows are shared across platforms. Android is the
current execution target; iOS remains `Not run` and must not be inferred from
Android evidence.

The picker flow additionally needs a fixture in Android Downloads:

```sh
adb -s <serial> push \
  .maestro/fixtures/expo-turbo-android-picked.txt \
  /sdcard/Download/expo-turbo-android-picked.txt
adb -s <serial> shell am broadcast \
  -a android.intent.action.MEDIA_SCANNER_SCAN_FILE \
  -d file:///sdcard/Download/expo-turbo-android-picked.txt
```

The Android picker flow is the sole platform-specific exception; see the
rationale in the coverage matrix.
