# Maestro device evidence

These flows exercise the standalone Expo example through either Expo Go or an
installed release build. They are interaction evidence rather than package CI.
Keep selectors accessibility-visible and deterministic; deeply nested live
panels use `device-test-*` routes that mount the same production proof component
without copying or changing its runtime behavior.

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

Run the installed-app suite:

```sh
MAESTRO_DRIVER_STARTUP_TIMEOUT=180000 \
  maestro --device <serial> test .maestro/release-android-live-form-contracts.yaml
MAESTRO_DRIVER_STARTUP_TIMEOUT=180000 \
  maestro --device <serial> test .maestro/release-android-live-form-secondary.yaml
MAESTRO_DRIVER_STARTUP_TIMEOUT=180000 \
  maestro --device <serial> test .maestro/release-android-live-frame-morph.yaml
MAESTRO_DRIVER_STARTUP_TIMEOUT=180000 \
  maestro --device <serial> test .maestro/release-android-document-refresh-morph.yaml
MAESTRO_DRIVER_STARTUP_TIMEOUT=180000 \
  maestro --device <serial> test .maestro/release-android-live-cable.yaml
MAESTRO_DRIVER_STARTUP_TIMEOUT=180000 \
  maestro --device <serial> test .maestro/release-android-protected-cable.yaml
```

The live-form flow covers the real Rails `422` local-draft morph, `204`
no-content preservation, text/plain canonical `303`, consent validation and
success, and plan validation and success. The Frame flow covers reload morph,
ordinary morph renderer selection, and paused/resumed before-frame-render. The
document flow proves local component state survives a Rails Refresh morph and
that an originating request ID suppresses its duplicate refresh. Cable flows
cover sibling HTTP Streams, HTTP morph state, public broadcasts, canonical
refresh, protected broadcasts, credential rotation/recovery, and revocation.

The picker flow additionally needs a fixture in Android Downloads:

```sh
adb -s <serial> push \
  .maestro/fixtures/expo-turbo-android-picked.txt \
  /sdcard/Download/expo-turbo-android-picked.txt
adb -s <serial> shell am broadcast \
  -a android.intent.action.MEDIA_SCANNER_SCAN_FILE \
  -d file:///sdcard/Download/expo-turbo-android-picked.txt
```

## Expo Go

Start Metro from `example/expo` on the port named by the flow:

```sh
bun run start -- --lan --port 8082
maestro --device <device-id> test \
  -e EXPO_URL=exp://<metro-lan-address>:8082/--/demo \
  .maestro/gallery-smoke.yaml
```
