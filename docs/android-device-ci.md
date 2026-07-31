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
resource-sampling evidence for 14 days.

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
- Maestro: 2.7.0

The VM is intentionally not a general-purpose build host. Do not add Docker,
deployment credentials, signing keys, product secrets, additional repositories,
or interactive developer workloads.

The runner bootstraps the emulator's bundled Chrome profile before the shared
suite so external-link assertions exercise the destination rather than Chrome's
first-run screen. After bootstrap, it restores the ADB reverse mapping and
requires a successful device-side request to the Rails `/up` endpoint before
starting Maestro. This changes only disposable emulator state.

## Recovery

The lane builds dependencies and the release APK once. If Maestro then reports
an explicit offline or missing ADB device together with zero-second cascade
failures, the runner preserves the first attempt's logs and JUnit, restarts and
reprovisions a clean emulator, and reruns the complete suite once against the
same APK. Assertion-only failures, app crashes, and a failed second attempt
remain failures.

## Maintenance

The runner package and Android command-line tools are installed from checksummed
upstream archives. Android SDK packages are pinned in the provisioning record.
When changing a pinned tool, update this document and rerun the full shared
suite before accepting the change.

If the runner is unavailable, public PR checks remain unaffected. A device-lane
failure is classified as recoverable infrastructure only when the retained
Maestro output contains an explicit offline or missing ADB device and the
remaining flows collapse into zero-second failures. Assertion failures and app
crashes are product failures and are never hidden by an automatic retry.

## Changelog

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
