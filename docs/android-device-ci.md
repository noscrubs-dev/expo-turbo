# Android device CI

Expo Turbo runs its shared Maestro behavior suite on a headless Android
emulator without a paid device service. The runner lives in a dedicated KVM
virtual machine on NoScrubs' Dabba host.

## Security boundary

- GitHub-hosted `ubuntu-latest` runners execute all public and fork pull-request
  checks. Those jobs receive no private runner, KVM device, signing key, Docker
  socket, or private-network access.
- The self-hosted runner belongs to the `expo-turbo-android-trusted` organization
  runner group. GitHub restricts that group to this public repository and to
  `.github/workflows/android-device.yml` from `refs/heads/main`.
- The trusted workflow runs only after a push to protected `main`, or after a
  maintainer with write access dispatches the main-owned workflow. A dispatch
  may supply a branch, tag, or SHA to test, making that explicit maintainer
  action the approval boundary for non-main code.
- The runner has the unique `expo-turbo-android-trusted` label and capacity one.
  A label is routing metadata, not the security boundary; the workflow-restricted
  runner group is what prevents fork-authored workflows from selecting it.
- VM commands, Rails, the Android emulator, ADB, and Maestro run as `expo-ci`.
  That account has no sudo rule and belongs only to `expo-ci` and `kvm`.
- The workflow has read-only repository permission, does not persist checkout
  credentials, and receives no repository or organization secrets.

## Capacity and cadence

The initial VM allocation is four host-passthrough vCPUs, 8 GB RAM, and a
60 GB disk. One workflow runs at a time and queued runs are not canceled. The
lane runs after every protected-main push and may also be dispatched manually.
The workflow retains Rails, emulator, Android logcat, JUnit, environment, and
resource-sampling evidence for 14 days. Each Chrome bootstrap, bootstrap retry,
and full-suite attempt writes to a different directory under
`artifacts/android-device`. Maestro's test output contains screenshots,
hierarchy snapshots, and command records. Its debug output and the explicit
attempt log contain Maestro logs. Maestro 2.7.0 uses
`--flatten-debug-output`, so each unique debug directory contains its
`maestro.log` directly. The upload action keeps hidden-file upload disabled;
no Maestro log depends on the hidden `.maestro/tests` nesting. The same uploaded
tree contains Rails, emulator, resource, environment, reverse-tunnel, and
Android logcat device logs. The workflow uses `if: always()`, so this evidence
is uploaded after a test failure too.

The lane supplies `--test-output-dir` and `--debug-output` for every Maestro
command. It does not write Maestro's default global `~/.maestro/tests` tree,
so it does not prune that tree at lane entry. The guarded
`scripts/ci/prune-maestro-tests.sh` tool and its tests remain available for
legacy residue or for another command that uses the default tree.

The lane builds only the emulator's x86_64 release APK before starting the
emulator. This sequencing is intentional: an initial four-ABI build overlapping
the emulator exhausted 8 GB and the kernel killed QEMU. With the phases
separated, validation used at most 5,723 MB, retained at least 2,223 MB
available memory, and used 19,325 MB of the 60 GB disk. The VM therefore remains
at its initial size.

Resize the VM only after `resources.log` from a successful or failed run shows
sustained memory pressure, CPU saturation, or disk exhaustion. Do not infer a
need to resize from a single slow dependency download.

## Host and guest inventory

- Proxmox VM ID: `104`
- VM name: `expo-turbo-ci`
- Address: `10.77.0.24/24` on Dabba's existing `vmbr1`
- AVD: `expo-turbo-api35`
- Emulator serial: `emulator-5580`
- Android image: Google APIs API 35, x86_64
- Node.js: 20.19.2
- Java: OpenJDK 21
- Bun: 1.3.14
- Maestro: 2.7.0, pinned by `scripts/ci/check-maestro-version.sh` and asserted
  before every run

The VM is intentionally not a general-purpose build host. Do not add Docker,
deployment credentials, signing keys, product secrets, additional repositories,
or interactive developer workloads.

The runner bootstraps the emulator's bundled Chrome profile before the shared
suite so external-link assertions exercise the destination rather than Chrome's
first-run screen. After bootstrap, it restores the ADB reverse mapping and
requires a successful device-side request to the Rails `/up` endpoint before
starting Maestro. This changes only disposable emulator state.

## Recovery

The lane builds dependencies and the release APK once. If the first suite
attempt reports an explicit ADB or Maestro device-server loss, the runner
preserves the first attempt's logs and, when Maestro produced it before TERM or
KILL, its JUnit. The runner always preserves the attempt log, transport trigger,
Rails byte-range log, logcat, environment state, and Maestro debug output. It
then restarts and reprovisions a clean emulator and reruns the complete suite
once against the same APK. The failed flow does not need a zero-second duration.
Assertion failures, selector timeouts, app crashes, and a failed second attempt
remain failures. Before product flows start, Chrome bootstrap has one narrower
exception: any first bootstrap failure gets one retry. The runner first records
the current focus, focused app, resumed activity, and a bounded logcat window
for Chrome death or a Google Mobile Services ANR. These diagnostics are
best-effort and cannot block the retry. A missing probe writes a clear sentinel.
The runner reconnects offline ADB transports, proves stable ADB health,
validates Chrome, clears its half-written profile, and runs the same bootstrap
once. During both bootstrap calls, it verifies Android's global
`hide_error_dialogs` setting, saves its prior value, and sets it to `1` so an OS
crash or ANR dialog cannot cover Chrome. It restores and verifies the prior
value before any product flow. An unsupported setting or a failed restore fails
the lane. It does not use Chrome process liveness because Android can restart
Chrome in the background while the launcher remains in front. A second
bootstrap failure always fails the lane and preserves full attempt evidence.
This exception does not change the transport-only product-suite retry rule.

During each full-suite attempt, a live monitor checks the attempt log every
0.2 seconds. The runner creates or truncates the active log before monitor
startup. The first line contains a unique invocation token. The monitor reads
only lines after that marker. Before it stops the
process, it proves that the PID still has the captured parent and start time and
that the log still has the captured device and inode. It accepts only a full
line with an ADB offline, missing-device, or `DeviceServerDiedException`
signature. Product output that contains these words as part of a selector or
assertion does not match. The monitor records the matched line and all captured
identities, and then it stops only that Maestro process with the bounded stop
helper. This prevents later Rails flows from spending minutes on a reverse
mapping that the device lost. The normal retry decision still reads the saved
attempt log after the process exits, but only when marker and identity
validation succeeded. A marker or identity validation failure returns safety
status 70 and does not retry.

If the monitor cannot prove the initial process or log identity, the suite
also returns status 70 and does not retry. It writes
`maestro-monitor-startup-attempt-N.txt` with the diagnostic, the unproved PID,
and the available identity values. It never signals that PID. The trusted entry
supervisor owns the final process-group sweep and removes the unproved process
with the other lane processes.

The monitor does not require ADB to still report an offline device. ADB can
recover before the next poll, as it did in run `32143590467`. The fresh active
Maestro stream is the source for the device-server failure. The next emulator
attempt must still restore the reverse mapping and prove a device-side request
to Rails `/up` before Rails-backed flows can start.

The first bootstrap, its one bootstrap-only retry, suite attempt 1, the second
clean bootstrap, its one bootstrap-only retry, and suite attempt 2 have unique Maestro
logs, `--test-output-dir`, and `--debug-output` paths. Each suite attempt also
has separate emulator, logcat, Rails, environment, fixture-upload, and
media-scan logs. A retry cannot overwrite evidence from the event that caused
it.
`--flatten-debug-output` puts each `maestro.log` directly in its already
unique debug directory.

The console stream gets a two-second, condition-based drain window after
Maestro exits. If it does not exit in that bound, cleanup stops only the stream.
The complete saved attempt log remains authoritative.

## Failure and staleness alert

`.github/workflows/android-device-alert.yml` runs on GitHub-hosted
`ubuntu-latest`. It runs after the Android workflow completes and once per
hour. It does not use or wait for the self-hosted Android job. The workflow
re-fetches GitHub API state instead of trusting event data and manages one
deduplicated issue with the `android-device-ci-alert` label and a private body
marker. No extra secret is required. It uses `GITHUB_TOKEN` with only
`actions: read`, `contents: read`, and `issues: write`.

The completion trigger ignores runs whose fetched `head_branch` is not `main`.
The alert becomes red for `failure`, `timed_out`, or `startup_failure`. A
`cancelled` workflow becomes red only when an actual job ran for at least the
workflow's 90-minute timeout. This excludes superseded runs with no jobs and
shorter human cancellations. On the hourly check, a noncompleted run older
than three hours is red. Any completed result older than 24 hours is red when
`main` has a newer commit, including a short cancellation or another ignored
conclusion. A quiet repository does not get a stale alert.

On red, the workflow creates one issue or updates its body without repeated
comments. If duplicate marked issues exist, it keeps the lowest issue number
and closes the others. On recovery, it checks all bounded comment pages for a
fixed recovery marker written by `github-actions[bot]`, comments once with the
successful run URL, and closes all marked alert issues, with the lowest issue
number closed last. A failed close is retried without a second recovery comment.
The body keeps the red observation count and no more than ten sanitized
observations. Recovery is recorded by the bot comment. Its stored state uses a
strict base64url comment payload. A corrupt or prior format payload resets the
red count and records that fact.

A manual `workflow_dispatch` is always a dry run. It reads live state and logs
the planned operations, but its API client does not send `POST`, `PATCH`, or
`DELETE` requests. Use this before a workflow change or during operator triage.
To recover a red alert, repair the runner or product failure and run the full
Android workflow. A successful full run closes the alert automatically.

GitHub can disable scheduled workflows in a public repository after 60 days
with no repository activity. The completion trigger continues to cover new
Android runs, but an operator must re-enable the schedule if GitHub disables
it.

## Maintenance

The runner package and Android command-line tools are installed from checksummed
upstream archives. Android SDK packages are pinned in the provisioning record.
When changing a pinned tool, update this document and rerun the full shared
suite before accepting the change.

The Maestro CLI is pinned in the repository rather than in the runner image.
`scripts/ci/check-maestro-version.sh` holds the expected version, and
`scripts/ci/run-android-maestro.sh` asserts it in preflight beside the root,
passwordless-sudo, and `/dev/kvm` guards, before any install, build, emulator,
Rails, or suite work. A missing or different CLI therefore fails in seconds
with the expected and actual versions, instead of changing what the flows mean
with no diff and no failing build. `environment.txt` then records the version
preflight asserted instead of a second reading taken at cleanup, so a run that
fails part way through still reports the Maestro it was proven against. A run
that fails the pin itself writes no evidence and needs none: it prints the
expected and actual versions and stops. `scripts/ci/check-maestro-version.test.ts`
proves the matching, missing, and mismatched cases against a fake CLI, so the
guard is verified without a device.

Install exactly the pinned version on the runner, as `expo-ci`:

Save this strict block as a script and run the script; `set -euo pipefail` can close an interactive shell.

```sh
set -euo pipefail

readonly maestro_version="2.7.0"
readonly maestro_sha256="a4ccab6b604617e7aef6db4f885666056eabe5cfa32befaa3bc994041b8fcbb5"
readonly maestro_url="https://github.com/mobile-dev-inc/Maestro/releases/download/cli-${maestro_version}/maestro.zip"
readonly maestro_install="$HOME/.local/opt/maestro-${maestro_version}-${maestro_sha256}"
readonly maestro_link="$HOME/.local/bin/maestro"
maestro_tmp="$(mktemp -d)"
trap 'rm -rf -- "$maestro_tmp"' EXIT

maestro_reported_version() {
  local executable="$1"
  local reported=""
  local report_status=0

  set +e
  reported="$("$executable" --version 2>&1)"
  report_status=$?
  set -e
  if [ "$report_status" -ne 0 ]; then
    return "$report_status"
  fi

  local first_line="${reported%%$'\n'*}"
  first_line="${first_line%$'\r'}"
  printf '%s\n' "$first_line"
}

install -d "$HOME/.local/opt" "$HOME/.local/bin"

curl --fail --location --silent --show-error \
  --output "$maestro_tmp/maestro.zip" "$maestro_url"
printf '%s  %s\n' "$maestro_sha256" "$maestro_tmp/maestro.zip" |
  sha256sum --check --strict -
unzip -q "$maestro_tmp/maestro.zip" -d "$maestro_tmp/extracted"
test -d "$maestro_tmp/extracted/maestro"
test -x "$maestro_tmp/extracted/maestro/bin/maestro"
test "$(maestro_reported_version "$maestro_tmp/extracted/maestro/bin/maestro")" = "$maestro_version"

if [ -e "$maestro_link" ] && [ ! -L "$maestro_link" ]; then
  echo "Refusing to replace non-symlink path: $maestro_link" >&2
  exit 1
fi

if [ -e "$maestro_install" ] || [ -L "$maestro_install" ]; then
  if [ -L "$maestro_install" ] || [ ! -d "$maestro_install" ] ||
    [ ! -x "$maestro_install/bin/maestro" ] ||
    [ "$(maestro_reported_version "$maestro_install/bin/maestro")" != "$maestro_version" ]; then
    echo "Existing checksum-addressed Maestro install is invalid: $maestro_install" >&2
    exit 1
  fi
else
  mv "$maestro_tmp/extracted/maestro" "$maestro_install"
fi

ln -sfn "$maestro_install/bin/maestro" "$maestro_link"
test "$(maestro_reported_version "$maestro_link")" = "$maestro_version"
```

The URL and SHA-256 are the official `cli-2.7.0` GitHub release asset and its
`checksums_sha256.txt` value. The lane runs in a non-interactive shell and puts
`$HOME/.local/bin` first on `PATH`. The checksum gate runs before extraction.
The block verifies the extracted layout, executable, and version before it
moves the checksum-addressed directory or changes the symlink. A second run
reuses an exact valid install. An invalid or partial existing install fails
before the symlink changes.

Changing the Maestro version means editing the pin in
`scripts/ci/check-maestro-version.sh`, updating the inventory above, installing
that version on the runner, and rerunning the full shared suite before
accepting the change.

If the runner is unavailable, public PR checks remain unaffected. A device-lane
failure is classified as recoverable infrastructure only when the retained
Maestro output contains an explicit offline, missing-device, or
device-server-loss message. Flow duration does not affect this classification.
Assertion failures, selector timeouts, and app crashes are product failures and
are never hidden by an automatic retry.

To inspect legacy or default-tree Maestro cleanup without changing files, run:

```sh
scripts/ci/prune-maestro-tests.sh "$HOME/.maestro/tests" 12 dry-run
```

The Android lane does not call this pruner. The pruner fails closed unless the
root is absolute, is named `tests`, has a parent named `maestro` or `.maestro`,
is not a symlink, and the keep count is a canonical decimal from 1 through
9,999,999. The mode must also be valid. A missing safe root
succeeds. After retention, a root above 512 MB produces a warning but does not
cause broader deletion.

## Changelog

**2026-08-18**:

- Changed: A first-attempt device-server loss now starts one clean-emulator
  retry without a zero-second flow requirement. The pre-product Chrome
  bootstrap can retry any first failure once after focused evidence and a
  validated profile reset. Product flows still use the strict transport rule.
- Why: Run `32143590467`, attempt 2, lost the device server after five seconds.
  ADB recovered without its Rails reverse mapping, and eight later flows failed
  as product-shaped connection errors.
- Impact: The lane retries the proven transport fault once, proves device-side
  Rails access before the new suite, and keeps each attempt's command and
  runtime evidence. Assertions, selector timeouts, app crashes, and a failed
  second attempt still fail.
- Changed: The lane now stops an active suite attempt when its live log proves
  ADB or device-server loss.
- Why: Run `32143590467`, attempt 2, spent 15 minutes in failed flows after the
  first transport loss. The final-log classifier could not stop that work.
- Impact: Detection occurs during the failed attempt. A separate trigger file
  records the matched line and the active stream, process, and file identities.
  Stale logs, replaced logs, prior-attempt logs, and product text cannot stop
  the active process. Normal product failures still run to their normal Maestro
  result.
- Changed: The guarded retention tool remains for legacy or default-tree
  residue, but the Android lane no longer calls it.
- Why: Every lane command supplies explicit test and debug output directories,
  so the lane does not create the default global tree.
- Impact: The lane does not delete unrelated global state. The strict retention
  safeguards and their tests remain available where default output is used.
- Changed: A separate GitHub-hosted workflow now manages one GitHub issue for
  Android failure, timeout-shaped cancellation, and scheduled staleness.
- Why: The nonrequired self-hosted lane can remain red without blocking a merge
  or notifying an operator, and cancelled workflows can have no Android job.
- Impact: Real red states create or update one issue, recovery closes it, and
  manual dispatch proves the plan without an API write or a new secret.

**2026-08-17**:

- Changed: The Android lane now pins the Maestro CLI in the repository and
  asserts it in preflight, and records the asserted version as its Maestro
  evidence.
- Why: The job ran whichever Maestro was installed on the runner. Maestro
  decides flow semantics, so an update changed the CI contract with no diff and
  no failing build, and the version was recorded only after the suite, which a
  run that died early never reached.
- Impact: A missing or different CLI fails in seconds with expected and actual
  versions, before install, build, emulator, Rails, or suite work, and every
  run that reaches cleanup reports the version it was proven against.

**2026-07-31**:

- Changed: The Android lane now restores its Rails reverse tunnel after Chrome
  bootstrap and proves device-side `/up` access before the shared Maestro suite.
- Why: Run `30591581753` kept the emulator and Rails healthy but sent no app
  requests to Rails, so ten server-dependent flows failed over 21 minutes.
- Impact: A missing reverse tunnel is repaired before testing or fails early
  with a direct infrastructure error.
- Changed: The Android retry guard now recognizes Maestro's `device not found`
  transport error in addition to an explicit offline transport.
- Why: Run `30590112926` lost its Maestro device session after 13 flows, but the
  existing guard did not retry because the driver reported the device as
  missing instead of offline.
- Impact: Both equivalent lost-device error forms can trigger one clean
  emulator retry when they also cause zero-second cascade failures.

**2026-07-27**:

- Changed: The Android lane now restarts a clean emulator and retries the full
  Maestro suite once after a proven offline-ADB cascade, while reusing the
  already-built APK.
- Why: Run `30224788145` passed 10 flows before guest `adbd` terminated its
  transport; the remaining five failed at zero seconds even though QEMU stayed
  alive and host memory and disk remained healthy.
- Impact: Transient device transport loss can recover without rebuilding, while
  assertion failures and a failed retry still fail the workflow with evidence
  from both attempts.
