# Expo Turbo 0.1.0 web accessibility evidence

This record covers the standalone Expo gallery's web accessibility surface. It
does not substitute for VoiceOver, TalkBack, physical-device, or manual
assistive-technology evidence.

## Environment

- source: this evidence commit, with implementation parent `f6579c1`
- browser: Google Chrome `150.0.7871.130`
- audit engine: axe-core `4.10.2`
- rules: WCAG 2.0 A/AA and WCAG 2.1 A/AA
- route: Expo web development server `/demo`

## Automated result

The final axe run reported 22 passing rule groups, zero violations, and zero
incomplete reviews. Chrome's accessibility tree exposed 454 non-ignored nodes,
including 28 buttons, links, and textboxes; every interactive node had a
nonblank computed accessible name. The document had the explicit title
`Expo Turbo compatibility gallery`. Document, Frame, and terminal form summaries
used named `group` roles, and the form surface used a named `form` role.

The initial audit found and the implementation parent fixed:

- a missing document title
- insufficient disabled-field label/input contrast caused by whole-container opacity
- labeled generic status and form containers without valid ARIA roles

## Interactive result

The rendered web form was exercised through the browser accessibility surface:

1. Clearing `First name` and submitting focused that exact textbox and populated
   the polite live region with `First name is required`.
2. Restoring a value and accepting the browser confirmation produced the
   deliberate first transport failure and populated the assertive live region
   with the redacted recovery message.
3. Retrying from current values, accepting the second confirmation, and
   receiving the fixture `204` preserved the input value and populated the
   polite live region with `Form submission complete. Nothing changed.`

Physical iOS VoiceOver, Android TalkBack, and manual browser screen-reader
speech/navigation remain open release evidence.
