# Device contract matrix

This is the inspectable union of user-visible contracts in the Expo example. A
row is shared unless its contract explicitly names a platform. Android and iOS
are evidence columns, not separate test families.

Status values are `Pass`, `Fail`, `Pending`, and `Not run`. A flow name is the
evidence locator; Maestro's timestamped artifacts live under
`~/.maestro/tests/`.

| # | Shared user-visible contract | Android evidence | iOS evidence |
| ---: | --- | --- | --- |
| 1 | Release app boots to the Expo Turbo gallery | Pass — `release-gallery-static-action.yaml` | Not run |
| 2 | Package, protocol, and registry status is visible | Pass — `release-gallery-static-action.yaml` | Not run |
| 3 | XML static card renders | Pass — `release-gallery-static-action.yaml` | Not run |
| 4 | RTL inheritance and nested LTR/auto direction render | Pass — `release-gallery-static-action.yaml` | Not run |
| 5 | Typed component action records its validated XML message | Pass — `release-gallery-static-action.yaml` | Not run |
| 6 | Direct Stream update mutates the static renderer | Pass — prior installed-release evidence | Not run |
| 7 | Stream completion is accessibility-visible | Pass — prior installed-release evidence | Not run |
| 8 | Required native first-name field blocks empty submission | Pass — `release-gallery-native-form.yaml` | Not run |
| 9 | Invalid native field is focused and announced | Pass — `release-gallery-native-form.yaml` | Not run |
| 10 | Restoring a valid native first name re-enables submission | Pass — `release-gallery-native-form.yaml` | Not run |
| 11 | Host confirmation can cancel without sending a request | Pass — `release-gallery-native-form.yaml` | Not run |
| 12 | Host confirmation approval proceeds | Pass — `release-gallery-native-form.yaml` | Not run |
| 13 | Submitter exposes busy/submits-with state | Pass — `release-gallery-native-form.yaml` | Not run |
| 14 | Duplicate native submission is guarded | Pass — `release-gallery-native-form.yaml` | Not run |
| 15 | First safe preview GET exposes the intentional MIME failure | Pass — `release-gallery-native-form.yaml` | Not run |
| 16 | Form boundary exposes Retry after failure | Pass — `release-gallery-native-form.yaml` | Not run |
| 17 | Retry preserves current first-name/city/legend values | Pass — `release-gallery-native-form.yaml` | Not run |
| 18 | Retry completes with 204 and no tree replacement | Pass — `release-gallery-native-form.yaml` | Not run |
| 19 | Dismiss result clears terminal form state | Pass — `release-gallery-native-form.yaml` | Not run |
| 20 | Query document preserves repeated and empty parameters | Pass — `release-gallery-document-links.yaml` | Not run |
| 21 | Preload shows cached preview before canonical replacement | Pass — `release-gallery-document-links.yaml` | Not run |
| 22 | Press-in prefetch response is reused | Pass — `release-gallery-document-links.yaml` | Not run |
| 23 | Nested generic Router path preserves query metadata | Pass — `release-gallery-document-links.yaml` | Not run |
| 24 | Root fragment link reaches native anchor without a request | Pass — `release-gallery-document-links.yaml` | Not run |
| 25 | Replace action replaces the Router entry | Pass — `release-gallery-document-links.yaml` | Not run |
| 26 | Generated document-form link confirms and reaches typed failure UI | Pass — `release-gallery-document-links.yaml` | Not run |
| 27 | Cross-origin link delegates to the host adapter | Pass — `release-gallery-document-links.yaml` | Not run |
| 28 | Disabled document link remains noninteractive | Pass — `release-gallery-document-links.yaml` | Not run |
| 29 | Refresh Stream document commits canonical update and resets scroll | Pass — `release-gallery-refresh-history-controls.yaml` | Not run |
| 30 | Same-path replace morph commits and resets root scroll | Pass — `release-gallery-refresh-history-controls.yaml` | Not run |
| 31 | Root autofocus visit reveals and focuses its measured field | Fail — focused input remains behind the Android keyboard, `release-gallery-refresh-history-controls.yaml`, artifact `2026-07-25_075230` | Not run |
| 32 | Native back restores cached document and root scroll checkpoint | Pending | Not run |
| 33 | Ordinary frame-scoped link commits the matching Frame | Pass — `release-gallery-frame-links.yaml` | Not run |
| 34 | Generated form promotes the mounted Frame through history without a competing Frame GET | Pass — cleaned direct-entry `release-gallery-frame-promotion.yaml`, artifact `2026-07-25_071005` | Not run |
| 35 | In-Frame fragment link reaches its native anchor | Pass — `release-gallery-frame-links.yaml` | Not run |
| 36 | Document-to-named-Frame fragment reaches the same anchor | Pass — prior installed-release evidence | Not run |
| 37 | Preloaded Frame preview revalidates then reveals fragment | Pass — `release-gallery-frame-links.yaml` | Not run |
| 38 | Nested ScrollView anchor uses its declared container | Pass — `release-gallery-visibility.yaml` | Not run |
| 39 | Nested lazy Frame loads only after entering both clip regions | Pass — `release-gallery-visibility.yaml` | Not run |
| 40 | FlatList Frame one loads from native viewability | Pass — `release-gallery-visibility.yaml` | Not run |
| 41 | FlatList Frame two waits for swipe/viewability | Pass — `release-gallery-visibility.yaml` | Not run |
| 42 | Recycled FlatList Frame three uses its current ID | Pass — `release-gallery-visibility.yaml` | Not run |
| 43 | Preview lazy Frame loads, recurses, and autoscrolls | Pass — `release-gallery-visibility.yaml` | Not run |
| 44 | Programmatic Frame visit uses the shared controller | Pass — `release-gallery-refresh-history-controls.yaml` | Not run |
| 45 | Anonymous Cable panel initializes and connects | Pass — `release-live-cable.yaml` | Not run |
| 46 | HTTP sibling Streams update and append independently | Pass — `release-live-cable.yaml` | Not run |
| 47 | Local HTTP morph counter increments | Pass — `release-live-cable.yaml` | Not run |
| 48 | Rails HTTP morph preserves local component state | Pass — `release-live-cable.yaml` | Not run |
| 49 | Public Cable replace broadcasts XML | Pass — `release-live-cable.yaml` | Not run |
| 50 | Public refresh broadcast reconciles canonical document | Pass — `release-live-cable.yaml` | Not run |
| 51 | Background pauses anonymous Cable | Pending — the app backgrounds, but the paused surface is not observable while Android owns the foreground, artifact `2026-07-25_075541` | Not run |
| 52 | Foreground reconnects, resubscribes, and reconciles once | Pending — the anonymous panel did not expose recovery within 60 seconds after the physical background cycle, artifact `2026-07-25_075541` | Not run |
| 53 | Protected header-ticket Cable admits and connects | Pass — `release-protected-cable.yaml` | Not run |
| 54 | Protected broadcast replaces the message | Pass — `release-protected-cable.yaml` | Not run |
| 55 | Ticket rotation creates a recovered transport generation | Pass — `release-protected-cable.yaml` | Not run |
| 56 | Rotated old transport stops receiving | Pass — rotation recovered and one subsequent protected broadcast committed, `release-protected-cable.yaml`, artifact `2026-07-25_075421` | Not run |
| 57 | Ticket revocation disconnects/rejects prior admission | Pass — `release-protected-cable.yaml` | Not run |
| 58 | Fresh protected admission recovers after revocation | Pass — disconnect was visible, fresh admission recovered, and the next protected broadcast committed, `release-protected-cable.yaml`, artifact `2026-07-25_075421` | Not run |
| 59 | Canonical Rails document Refresh morph loads | Pass — `release-document-refresh-morph.yaml` | Not run |
| 60 | Document-refresh local counter increments | Pass — `release-document-refresh-morph.yaml` | Not run |
| 61 | Refresh Stream performs canonical GET/morph | Pass — `release-document-refresh-morph.yaml` | Not run |
| 62 | Compatible local identity survives document morph | Pass — `release-document-refresh-morph.yaml` | Not run |
| 63 | Originating request ID applies sibling status action | Pass — `release-document-refresh-morph.yaml` | Not run |
| 64 | Matching document Refresh Stream is suppressed | Pass — `release-document-refresh-morph.yaml` | Not run |
| 65 | Live Frame form returns authoritative matching 422 | Pass — `release-live-frame-form.yaml` | Not run |
| 66 | Local-draft 422 morph preserves compatible input | Pass — `release-live-frame-form.yaml` | Not run |
| 67 | Live Frame form supports 204, 303, and text/plain success | Pass — `release-live-frame-form.yaml` | Not run |
| 68 | Consent and plan validation/success paths complete | Pass — `release-live-form-secondary.yaml` | Not run |
| 69 | Nested Frame reload, pause/resume, and morph cascade complete | Pass — `release-live-frame-morph-contracts.yaml` | Not run |
| 70 | Built-in and selected attachments survive matching 422 | Pass — `release-frame-form-attachment-validation.yaml`; Android picker branch in `release-picker-form.android.yaml` | Not run |
| 71 | Attachment success/retry and user-visible loading/error recovery complete | Pending | Not run |

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
so it remains incomplete while row 71 is pending.

Current Android result: **66/71 Pass, 1/71 Fail, 4/71 Pending**. The unresolved
rows are 31, 32, 51, 52, and 71. Strictly propagating those row states back to
the inventory gives **98/115 covered** and **17/115 not fully passing**.
iOS remains **0/71 run** and must be recorded separately when a physical device
is available.

## Platform-specific exception

`release-picker-form.android.yaml` is the only platform-specific flow. It drives
Android DocumentsUI and a fixture under `/sdcard/Download`. The shared
multipart/retention contract remains row 70; this file supplies only its Android
provider evidence. An iOS provider interaction will require an objectively
different picker driver when an iOS device is available.
