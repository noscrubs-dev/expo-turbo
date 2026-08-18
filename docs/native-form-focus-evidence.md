# Native form invalid-focus evidence

GitHub issue #425 identified a false-green Android assertion. The old flow left
the first-name field focused before submit, so it did not prove that an invalid
submission moved focus. No product focus defect was reproduced. The renderer,
form transport, navigation, morph, and production focus behavior are unchanged.

The device-test fixture now starts without first-name autofocus. Its visible
focus probe starts at `unobserved` and changes only from the React Native
`TextInput` `onFocus` and `onBlur` events. It does not read the example's
logical focus registry. Its visible submit proof changes only after the submit
handler starts a real form submission and the result resolves.

`.maestro/release-gallery-native-form.yaml` runs nine explicit cycles. Each
cycle proves this order:

1. A neutral heading tap produces the React Native `blurred` event.
2. The form is ready, and no confirmation, loading, failure, or success result
   is visible.
3. The flow reasserts `blurred; revision 2N` immediately before the submit tap.
4. The submit path synchronously focuses the invalid control, and the same
   React Native event probe reports `focused; revision 2N+1`.
5. The real submission promise then resolves as `invalid; attempt N`.
6. `First name is required` is visible, and no confirmation or loading state
   appeared.

The paired evidence for attempt N is `blurred; revision 2N`, `focused;
revision 2N+1`, and `invalid; attempt N`. The invalid result does not cause
focus. It records the result of the same submit attempt after the synchronous
focus work.

The example app has one reveal authority for a focused form field. After
`keyboardDidShow`, it records the Android keyboard viewport, remeasures the
root scroll container and all registered fields. `remeasure()` without a field
ID measures every field. The measurement callbacks call `flushActive`, which
performs the reveal. The container does not call React Native's pre-IME native
keyboard reveal helper.
Each form field registers its complete wrapper as the measure target. The
measured rectangle includes the label, input, focus probe, and validation
error. Each field rectangle is paired with the root offset from when its
measurement started. A programmatic scroll also updates the cached root offset
before it calls the native scroll method. Thus, callbacks from one remeasurement
cannot add the same correction two times while `onScroll` is delayed. Native
scroll completion and later user scrolls still use `onScroll` to report their
actual offsets.

Android also checks Maestro's native `focused:false` and `focused:true`
selectors. These selectors are additional evidence, not the shared oracle.
iOS uses the same React Native event probe because retained iOS artifacts show
that Maestro's iOS `focused` property is not a reliable oracle.

Local React tests and static mutation tests prove the instrumentation and flow
contract. A real Android and iOS device run is still required to prove the nine
cycles on devices. Spoken TalkBack and VoiceOver output also remains pending;
visible error text and focus events do not prove what a screen reader spoke.
