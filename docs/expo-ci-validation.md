# Expo CI validation

The Expo example uses one two-stage dependency gate. Both stages run installed
local binaries from `example/expo`.

1. The base stage runs the exact locked `expo-doctor@1.20.2` binary with
   `EXPO_OFFLINE=1`. The Doctor check set and the Expo CLI package map are fixed
   by `example/expo/bun.lock`. A failure blocks pull requests, `main`, and
   release.
2. The fresh stage runs the installed Expo CLI as
   `expo install --check --json`. It reads current SDK package advice. Valid
   drift creates a GitHub warning on a pull request. The same drift writes the
   package evidence to the step summary and blocks `main` or release.

The base stage is not a fully offline Doctor run. `EXPO_OFFLINE` changes the
child Expo CLI SDK-version lookup to its bundled package map. Expo Doctor's
schema check and React Native Directory check can still use the network.

The fresh stage also has a network limit. A connection failure can make Expo
CLI use its bundled package map. An HTTP or protocol failure can return text
instead of the JSON contract. The wrapper accepts only the documented JSON
shape. It blocks invalid output, an unknown workflow lane, and any exit-zero
result that does not prove `upToDate: true`.

Pull requests give early review evidence without blocking on new valid SDK
advice. Pushes to `main` are the early canary. Release is the hard boundary.
There is no scheduled workflow for this check.
