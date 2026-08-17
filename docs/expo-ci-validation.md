# Expo CI validation

The Expo example uses one two-stage dependency gate. Both stages run installed
local binaries from `example/expo`.

1. The base stage runs the exact locked `expo-doctor@1.20.2` binary with
   `EXPO_OFFLINE=1`. The Doctor check set and the Expo CLI package map are fixed
   by `example/expo/bun.lock`. A failure blocks pull requests, `main`, and
   release.
2. The live fresh stage removes `EXPO_OFFLINE` from its child environment and
   runs the installed Expo CLI as `expo install --check --json`. It is verified
   only when the exit status, exact JSON contract, and empty `stderr` agree.
   Valid live drift creates one sanitized GitHub warning on a pull request. The
   same drift writes bounded, HTML-safe package evidence to the step summary
   and blocks `main` or release.

The base stage is not a fully offline Doctor run. `EXPO_OFFLINE` changes the
child Expo CLI SDK-version lookup to its bundled package map. Expo Doctor's
schema check and React Native Directory check can still use the network.

The live stage fails closed when freshness is unavailable. A connection
fallback can return valid-looking bundled JSON and a warning on `stderr`. An
HTTP or protocol failure can return text instead of JSON. Any non-empty
`stderr`, invalid or extra JSON field, unexpected exit status, output above
64 KiB, or child timeout blocks all lanes. A Doctor timeout also stops the live
stage. Both children have a three-minute hard timeout. The two complete Expo
example jobs have a 45-minute timeout for frozen installs, checks, and exports.

The lock was regenerated with Bun 1.3.14 from the parent of `61bc0e8`, using
targeted updates for `expo` 57.0.14, `expo-constants` 57.0.12, and
`expo-router` 57.0.14. `expo-linking` 57.0.6 still declares
`expo-constants ~57.0.11`, so the manifest override references the direct
`expo-constants` range and avoids a stale nested copy. This `$expo-constants`
form also lets the pinned Doctor use `npm explain` without an override error.
The permitted Expo graph has 19 changed lock keys: 10 updates, six added nested
Expo config keys, and three removed nested keys. The
machine-readable inventory and the digest of all unchanged package entries are
in `scripts/ci/expo-lock-contract.json`; its test parses every package key and
requires the single `expo-constants@57.0.12` resolution.

Pull requests give early review evidence without blocking on verified live SDK
drift. Pushes to `main` are the early canary. Release is the hard boundary.
Unavailable freshness blocks all three lanes. There is no scheduled workflow
for this check.
