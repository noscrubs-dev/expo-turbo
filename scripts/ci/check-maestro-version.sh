#!/usr/bin/env bash

# Assert the Maestro CLI version the Android device lane runs against.
#
# expected_version below is this repository's single source of truth for that
# pin. scripts/ci/run-android-maestro.sh calls this in preflight, beside the
# root, passwordless-sudo, and /dev/kvm guards and before any install, build,
# emulator, Rails, or suite work, so a runner whose Maestro drifted costs
# seconds instead of a whole suite.
#
# The version is asserted rather than recorded because it decides flow
# semantics: Android hideKeyboard compiles to an unconditional BACK keyevent in
# 2.7.0, and scrollUntilVisible maps direction to a swipe that can collide with
# system gestures. Whoever updates the runner would otherwise change the CI
# contract with no diff, no review, and no failing build.
#
# On success the resolved version is the only thing on stdout, and the lane
# records that same value as its Maestro environment evidence, so the version
# asserted and the version reported are one measurement rather than two
# readings taken at opposite ends of the run. Every diagnostic goes to stderr.
#
# scripts/ci/check-maestro-version.test.ts drives this against a fake maestro
# on PATH, so matching, missing, and mismatched versions are proven without a
# device, an emulator, or KVM.

set -euo pipefail

readonly expected_version="2.7.0"
readonly install_hint="Install exactly ${expected_version} on the runner - see the Maintenance section of docs/android-device-ci.md."
readonly pin_hint="Changing the pin means editing scripts/ci/check-maestro-version.sh, updating docs/android-device-ci.md, and rerunning the full shared suite."

if ! command -v maestro >/dev/null 2>&1; then
  {
    echo "Maestro is not installed where this lane can reach it."
    echo "Expected: ${expected_version}"
    echo "Actual:   no maestro on PATH"
    echo "PATH:     ${PATH}"
    echo "$install_hint"
  } >&2
  exit 1
fi

reported=""
report_status=0

# stderr is folded into the captured output so a CLI that complains still shows
# what it said in the failure below, instead of scattering it through the job
# log ahead of the verdict.
set +e
reported="$(maestro --version 2>&1)"
report_status=$?
set -e

if [ "$report_status" -ne 0 ]; then
  {
    echo "'maestro --version' failed with exit status ${report_status}, so the installed CLI cannot be identified."
    echo "Expected: ${expected_version}"
    echo "Actual:   no version reported"
    echo "--- maestro --version output ---"
    printf '%s\n' "$reported"
    echo "$install_hint"
  } >&2
  exit 1
fi

# 2.7.0 reports a bare "2.7.0". Only a line that is entirely a version counts,
# so a trailing notice line does not read as a mismatch and a notice that
# names some other version cannot be read as the installed one. Output in any
# other shape fails closed and is reported verbatim below.
resolved="$(printf '%s\n' "$reported" | tr -d '\r' |
  grep -oE '^[0-9]+\.[0-9]+\.[0-9]+[0-9A-Za-z.+-]*$' | head -1 || true)"

if [ "$resolved" != "$expected_version" ]; then
  {
    echo "This runner has a Maestro the Android device lane is not pinned to."
    echo "Expected: ${expected_version}"
    echo "Actual:   ${resolved:-no version recognized}"
    echo "--- maestro --version output ---"
    printf '%s\n' "$reported"
    echo "$install_hint"
    echo "$pin_hint"
  } >&2
  exit 1
fi

printf '%s\n' "$resolved"
