# Device contract matrix

This is the inspectable union of user-visible contracts in the Expo example. A
row is shared unless its contract explicitly names a platform. Android and iOS
are evidence columns, not separate test families.

Status values are `Pass`, `Fail`, `Pending`, and `Not run`. A flow name is the
evidence locator; Android Maestro artifacts live under `~/.maestro/tests/`.
The physical-iOS execution used Appium/XCUITest and is recorded in
[the physical-iOS evidence document](../docs/ios-device-release-0.1.0.md).

The checked-in release flows form one union suite. Platform columns below record
executions of that same suite; they do not define different contract sets.

The historical totals below predate the issue #425 correction. The prior row 9
pass was false-green and is not current evidence. The new flow requires a real
Android and iOS run before row 9 can return to `Pass`.

| Platform execution | Device | Shared contracts | Atomic observations | Union suite result | Artifact |
| --- | --- | ---: | ---: | --- | --- |
| Android | OnePlus `65c6e2cf` | **71/71 Pass** | **115/115 Pass** | **15/15 flows Pass** | `2026-07-25_091034` |
| iOS | iPad mini (A17 Pro), iPadOS 26.5, `00008130-0011650A0C20001C` | **71/71 Pass** | **115/115 Pass** | **14/14 shared flows + Files provider Pass** | [2026-07-26 physical-iOS record](../docs/ios-device-release-0.1.0.md) |

| # | Shared user-visible contract | Android evidence | iOS evidence |
| ---: | --- | --- | --- |
| 1 | Release app boots to the Expo Turbo gallery | Pass — `release-gallery-static-action.yaml` | Pass — same shared flow; [physical iOS record](../docs/ios-device-release-0.1.0.md) |
| 2 | Package, protocol, and registry status is visible | Pass — `release-gallery-static-action.yaml` | Pass — same shared flow; [physical iOS record](../docs/ios-device-release-0.1.0.md) |
| 3 | XML static card renders | Pass — `release-gallery-static-action.yaml` | Pass — same shared flow; [physical iOS record](../docs/ios-device-release-0.1.0.md) |
| 4 | RTL inheritance and nested LTR/auto direction render | Pass — `release-gallery-static-action.yaml` | Pass — same shared flow; [physical iOS record](../docs/ios-device-release-0.1.0.md) |
| 5 | Typed component action records its validated XML message | Pass — `release-gallery-static-action.yaml` | Pass — same shared flow; [physical iOS record](../docs/ios-device-release-0.1.0.md) |
| 6 | Direct Stream update mutates the static renderer | Pass — `release-gallery-static-action.yaml`, artifact `2026-07-25_091034` | Pass — same shared flow; [physical iOS record](../docs/ios-device-release-0.1.0.md) |
| 7 | Stream completion is accessibility-visible | Pass — `release-gallery-static-action.yaml`, artifact `2026-07-25_091034` | Pass — same shared flow; [physical iOS record](../docs/ios-device-release-0.1.0.md) |
| 8 | Required native first-name field blocks empty submission | Pass — `release-gallery-native-form.yaml` | Pass — same shared flow; [physical iOS record](../docs/ios-device-release-0.1.0.md) |
| 9 | Actual invalid submit emits a React Native focus event after a prior blur | **Not run** — nine-cycle shared event-probe flow; Android native selector is an additional check | **Not run** — same shared event-probe flow; no iOS native-focused selector |
| 10 | Restoring a valid native first name re-enables submission | Pass — `release-gallery-native-form.yaml` | Pass — same shared flow; [physical iOS record](../docs/ios-device-release-0.1.0.md) |
| 11 | Host confirmation can cancel without sending a request | Pass — `release-gallery-native-form.yaml` | Pass — same shared flow; [physical iOS record](../docs/ios-device-release-0.1.0.md) |
| 12 | Host confirmation approval proceeds | Pass — `release-gallery-native-form.yaml` | Pass — same shared flow; [physical iOS record](../docs/ios-device-release-0.1.0.md) |
| 13 | Submitter exposes busy/submits-with state | Pass — `release-gallery-native-form.yaml` | Pass — same shared flow; [physical iOS record](../docs/ios-device-release-0.1.0.md) |
| 14 | Duplicate native submission is guarded | Pass — `release-gallery-native-form.yaml` | Pass — same shared flow; [physical iOS record](../docs/ios-device-release-0.1.0.md) |
| 15 | First safe preview GET exposes the intentional MIME failure | Pass — `release-gallery-native-form.yaml` | Pass — same shared flow; [physical iOS record](../docs/ios-device-release-0.1.0.md) |
| 16 | Form boundary exposes Retry after failure | Pass — `release-gallery-native-form.yaml` | Pass — same shared flow; [physical iOS record](../docs/ios-device-release-0.1.0.md) |
| 17 | Retry preserves current first-name/city/legend values | Pass — `release-gallery-native-form.yaml` | Pass — same shared flow; [physical iOS record](../docs/ios-device-release-0.1.0.md) |
| 18 | Retry completes with 204 and no tree replacement | Pass — `release-gallery-native-form.yaml` | Pass — same shared flow; [physical iOS record](../docs/ios-device-release-0.1.0.md) |
| 19 | Dismiss result clears terminal form state | Pass — `release-gallery-native-form.yaml` | Pass — same shared flow; [physical iOS record](../docs/ios-device-release-0.1.0.md) |
| 20 | Query document preserves repeated and empty parameters | Pass — `release-gallery-document-links.yaml` | Pass — same shared flow; [physical iOS record](../docs/ios-device-release-0.1.0.md) |
| 21 | Preload shows cached preview before canonical replacement | Pass — `release-gallery-document-links.yaml` | Pass — same shared flow; [physical iOS record](../docs/ios-device-release-0.1.0.md) |
| 22 | Press-in prefetch response is reused | Pass — `release-gallery-document-links.yaml` | Pass — same shared flow; [physical iOS record](../docs/ios-device-release-0.1.0.md) |
| 23 | Nested generic Router path preserves query metadata | Pass — `release-gallery-document-links.yaml` | Pass — same shared flow; [physical iOS record](../docs/ios-device-release-0.1.0.md) |
| 24 | Root fragment link reaches native anchor without a request | Pass — `release-gallery-document-links.yaml` | Pass — same shared flow; [physical iOS record](../docs/ios-device-release-0.1.0.md) |
| 25 | Replace action replaces the Router entry | Pass — `release-gallery-document-links.yaml` | Pass — same shared flow; [physical iOS record](../docs/ios-device-release-0.1.0.md) |
| 26 | Generated document-form link confirms and reaches typed failure UI | Pass — `release-gallery-document-links.yaml` | Pass — same shared flow; [physical iOS record](../docs/ios-device-release-0.1.0.md) |
| 27 | Cross-origin link delegates to the host adapter | Pass — `release-gallery-document-links.yaml` | Pass — same shared flow; [physical iOS record](../docs/ios-device-release-0.1.0.md) |
| 28 | Disabled document link remains noninteractive | Pass — `release-gallery-document-links.yaml` | Pass — same shared flow; [physical iOS record](../docs/ios-device-release-0.1.0.md) |
| 29 | Refresh Stream document commits canonical update and resets scroll | Pass — `release-gallery-refresh-history-controls.yaml` | Pass — same shared flow; [physical iOS record](../docs/ios-device-release-0.1.0.md) |
| 30 | Same-path replace morph commits and resets root scroll | Pass — `release-gallery-refresh-history-controls.yaml` | Pass — same shared flow; [physical iOS record](../docs/ios-device-release-0.1.0.md) |
| 31 | Root autofocus visit reveals and focuses its measured field | Pass — `release-gallery-refresh-history-controls.yaml`, artifact `2026-07-25_091034` | Pass — same shared flow; [physical iOS record](../docs/ios-device-release-0.1.0.md) |
| 32 | Native back restores cached document and root scroll checkpoint | Pass — `release-gallery-refresh-history-controls.yaml`, artifact `2026-07-25_091034` | Pass — same shared flow; [physical iOS record](../docs/ios-device-release-0.1.0.md) |
| 33 | Ordinary frame-scoped link commits the matching Frame | Pass — `release-gallery-frame-links.yaml` | Pass — same shared flow; [physical iOS record](../docs/ios-device-release-0.1.0.md) |
| 34 | Generated form promotes the mounted Frame through history without a competing Frame GET | Pass — `release-gallery-frame-promotion.yaml`, artifact `2026-07-25_091034` | Pass — same shared flow; [physical iOS record](../docs/ios-device-release-0.1.0.md) |
| 35 | In-Frame fragment link reaches its native anchor | Pass — `release-gallery-frame-links.yaml` | Pass — same shared flow; [physical iOS record](../docs/ios-device-release-0.1.0.md) |
| 36 | Document-to-named-Frame fragment reaches the same anchor | Pass — `release-gallery-frame-links.yaml`, artifact `2026-07-25_091034` | Pass — same shared flow; [physical iOS record](../docs/ios-device-release-0.1.0.md) |
| 37 | Preloaded Frame preview revalidates then reveals fragment | Pass — `release-gallery-frame-links.yaml` | Pass — same shared flow; [physical iOS record](../docs/ios-device-release-0.1.0.md) |
| 38 | Nested ScrollView anchor uses its declared container | Pass — `release-gallery-visibility.yaml` | Pass — same shared flow; [physical iOS record](../docs/ios-device-release-0.1.0.md) |
| 39 | Nested lazy Frame loads only after entering both clip regions | Pass — `release-gallery-visibility.yaml` | Pass — same shared flow; [physical iOS record](../docs/ios-device-release-0.1.0.md) |
| 40 | FlatList Frame one loads from native viewability | Pass — `release-gallery-visibility.yaml` | Pass — same shared flow; [physical iOS record](../docs/ios-device-release-0.1.0.md) |
| 41 | FlatList Frame two waits for swipe/viewability | Pass — `release-gallery-visibility.yaml` | Pass — same shared flow; [physical iOS record](../docs/ios-device-release-0.1.0.md) |
| 42 | Recycled FlatList Frame three uses its current ID | Pass — `release-gallery-visibility.yaml` | Pass — same shared flow; [physical iOS record](../docs/ios-device-release-0.1.0.md) |
| 43 | Preview lazy Frame loads, recurses, and autoscrolls | Pass — `release-gallery-visibility.yaml` | Pass — same shared flow; [physical iOS record](../docs/ios-device-release-0.1.0.md) |
| 44 | Programmatic Frame visit uses the shared controller | Pass — `release-gallery-refresh-history-controls.yaml` | Pass — same shared flow; [physical iOS record](../docs/ios-device-release-0.1.0.md) |
| 45 | Anonymous Cable panel initializes and connects | Pass — `release-live-cable.yaml` | Pass — same shared flow; [physical iOS record](../docs/ios-device-release-0.1.0.md) |
| 46 | HTTP sibling Streams update and append independently | Pass — `release-live-cable.yaml` | Pass — same shared flow; [physical iOS record](../docs/ios-device-release-0.1.0.md) |
| 47 | Local HTTP morph counter increments | Pass — `release-live-cable.yaml` | Pass — same shared flow; [physical iOS record](../docs/ios-device-release-0.1.0.md) |
| 48 | Rails HTTP morph preserves local component state | Pass — `release-live-cable.yaml` | Pass — same shared flow; [physical iOS record](../docs/ios-device-release-0.1.0.md) |
| 49 | Public Cable replace broadcasts XML | Pass — `release-live-cable.yaml` | Pass — same shared flow; [physical iOS record](../docs/ios-device-release-0.1.0.md) |
| 50 | Public refresh broadcast reconciles canonical document | Pass — `release-live-cable.yaml` | Pass — same shared flow; [physical iOS record](../docs/ios-device-release-0.1.0.md) |
| 51 | Background pauses anonymous Cable | Pass — `release-live-cable.yaml`, artifact `2026-07-25_091034` | Pass — same shared flow; [physical iOS record](../docs/ios-device-release-0.1.0.md) |
| 52 | Foreground reconnects, resubscribes, and reconciles once | Pass — `release-live-cable.yaml`, artifact `2026-07-25_091034` | Pass — same shared flow; [physical iOS record](../docs/ios-device-release-0.1.0.md) |
| 53 | Protected header-ticket Cable admits and connects | Pass — `release-protected-cable.yaml` | Pass — same shared flow; [physical iOS record](../docs/ios-device-release-0.1.0.md) |
| 54 | Protected broadcast replaces the message | Pass — `release-protected-cable.yaml` | Pass — same shared flow; [physical iOS record](../docs/ios-device-release-0.1.0.md) |
| 55 | Ticket rotation creates a recovered transport generation | Pass — `release-protected-cable.yaml` | Pass — same shared flow; [physical iOS record](../docs/ios-device-release-0.1.0.md) |
| 56 | Rotated old transport stops receiving | Pass — rotation recovered and one subsequent protected broadcast committed, `release-protected-cable.yaml`, artifact `2026-07-25_091034` | Pass — same shared flow; [physical iOS record](../docs/ios-device-release-0.1.0.md) |
| 57 | Ticket revocation disconnects/rejects prior admission | Pass — `release-protected-cable.yaml` | Pass — same shared flow; [physical iOS record](../docs/ios-device-release-0.1.0.md) |
| 58 | Fresh protected admission recovers after revocation | Pass — disconnect was visible, fresh admission recovered, and the next protected broadcast committed, `release-protected-cable.yaml`, artifact `2026-07-25_091034` | Pass — same shared flow; [physical iOS record](../docs/ios-device-release-0.1.0.md) |
| 59 | Canonical Rails document Refresh morph loads | Pass — `release-document-refresh-morph.yaml` | Pass — same shared flow; [physical iOS record](../docs/ios-device-release-0.1.0.md) |
| 60 | Document-refresh local counter increments | Pass — `release-document-refresh-morph.yaml` | Pass — same shared flow; [physical iOS record](../docs/ios-device-release-0.1.0.md) |
| 61 | Refresh Stream performs canonical GET/morph | Pass — `release-document-refresh-morph.yaml` | Pass — same shared flow; [physical iOS record](../docs/ios-device-release-0.1.0.md) |
| 62 | Compatible local identity survives document morph | Pass — `release-document-refresh-morph.yaml` | Pass — same shared flow; [physical iOS record](../docs/ios-device-release-0.1.0.md) |
| 63 | Originating request ID applies sibling status action | Pass — `release-document-refresh-morph.yaml` | Pass — same shared flow; [physical iOS record](../docs/ios-device-release-0.1.0.md) |
| 64 | Matching document Refresh Stream is suppressed | Pass — `release-document-refresh-morph.yaml` | Pass — same shared flow; [physical iOS record](../docs/ios-device-release-0.1.0.md) |
| 65 | Live Frame form returns authoritative matching 422 | Pass — `release-live-frame-form.yaml` | Pass — same shared flow; [physical iOS record](../docs/ios-device-release-0.1.0.md) |
| 66 | Local-draft 422 morph preserves compatible input | Pass — `release-live-frame-form.yaml` | Pass — same shared flow; [physical iOS record](../docs/ios-device-release-0.1.0.md) |
| 67 | Live Frame form supports 204, 303, and text/plain success | Pass — `release-live-frame-form.yaml` | Pass — same shared flow; [physical iOS record](../docs/ios-device-release-0.1.0.md) |
| 68 | Consent and plan validation/success paths complete | Pass — `release-live-form-secondary.yaml` | Pass — same shared flow; [physical iOS record](../docs/ios-device-release-0.1.0.md) |
| 69 | Nested Frame reload, pause/resume, and morph cascade complete | Pass — `release-live-frame-morph-contracts.yaml` | Pass — same shared flow; [physical iOS record](../docs/ios-device-release-0.1.0.md) |
| 70 | Built-in and selected attachments survive matching 422 | Pass — `release-frame-form-attachment-validation.yaml`; Android picker branch in `release-picker-form.android.yaml` | Pass — `release-frame-form-attachment-validation.yaml`; real Files-provider proof in the [physical iOS record](../docs/ios-device-release-0.1.0.md) |
| 71 | Attachment success/retry and user-visible loading/error recovery complete | Pass — `release-frame-form-attachment-validation.yaml`, artifact `2026-07-25_091034` | Pass — shared flow plus selected-file retry/success in the [physical iOS record](../docs/ios-device-release-0.1.0.md) |

## Inventory reconciliation

The source inventory contains 115 atomic observations. The matrix deliberately
groups related observations into 71 user-visible contracts so one interaction
is not counted several times. No inventory item is dropped:

| Matrix rows | Atomic inventory items |
| --- | --- |
| 1-4 | 1-4 |
| 5 | 6-8 |
| 6-7 | 9-10 |
| 8-19 | 11-22 |
| 20-28 | 23-25 and 29-34 |
| 29-32 | 26-28 and 35 |
| 33-44 | 36-47 |
| 45 | 48-49 |
| 46 | 50-51 |
| 47-51 | 52-56 |
| 52 | 57-58 |
| 53-57 | 59-63 |
| 58 | 64-65 |
| 59-64 | 66-72 |
| 65 | 82-85 |
| 66 | 86-87 |
| 67 | 88-91 |
| 68 | 99-106 |
| 69 | 73-81 |
| 70 | 92 and 94-97 |
| 71 | 93, 98, and 107-115 |

Atomic item 5 is the cross-cutting accessibility-visible boundary-state
contract. Its assertions are distributed through interaction rows and row 71,
and passes with the completed row 71 evidence.

The corrected row 9 flow proves a React Native focus event after each actual
`invalid; attempt N` result for nine blur-submit-focus cycles. Android also
checks the native selector before and after each submit. iOS uses the same event
probe because its retained native `focused` property is not a reliable oracle.
The checked-in React and static tests prove this contract locally, but no new
device result is recorded here yet. Spoken TalkBack and VoiceOver output remains
pending and is not proved by the visible error or focus event probe.

Current Android result: **71/71 grouped contracts Pass** and **115/115 atomic
observations Pass** on the OnePlus device in artifact `2026-07-25_091034`.
Current iOS result: **71/71 grouped contracts Pass** and **115/115 atomic
observations Pass** on the physical iPad in the
[2026-07-26 evidence record](../docs/ios-device-release-0.1.0.md).

The Android lane retains the 12 newest local Maestro timestamp directories at
entry. This retention does not remove uploaded workflow evidence and does not
change the 71 grouped contracts. A separate GitHub-hosted alert workflow
reports a failed or stale full-suite lane through one deduplicated GitHub
issue. A cancelled workflow is alertable only when its actual Android job
reaches the 90-minute workflow timeout. Superseded zero-job runs and shorter
human cancellations do not change this coverage record.

## Platform-specific exception

`release-picker-form.android.yaml` is the only checked-in platform-specific
Maestro flow. It drives Android DocumentsUI and a fixture under
`/sdcard/Download`. The shared multipart/retention contract remains row 70;
this file supplies its Android provider evidence. The physical-iOS run used an
Appium/XCUITest picker driver to select the fixture through the real Files
provider, retain it through two matching `422` responses, retry, and complete
the final multipart upload.
