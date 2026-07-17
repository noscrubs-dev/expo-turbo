# Protocol

Shared compatibility manifests and cross-language fixtures will live here. The package remains pre-release and does not yet claim complete Turbo compatibility.

## State references

Component-action parameters resolve state references against the action's selected document, Frame, or form scope before Zod admission:

- `{"$state":"key"}` is an exact-value reference. It must contain only the `$state` key and may resolve to any value admitted by the action schema.
- `{{state:key}}` interpolates a scalar state value into a string. Structured values are rejected instead of being coerced to `[object Object]`.
- Arrays and plain objects resolve recursively. Object keys are never interpolated.

Missing/blank keys, malformed interpolation, ambiguous `$state` objects, cycles, unsupported object prototypes, and excessive depth are typed protocol failures. Resolution never falls through from a Frame/form scope to document or app-global state. Structured exact references must come from an explicit host codec; the package does not opportunistically `JSON.parse` arbitrary XML attributes.

## Semantic styles

Styling is component-schema-owned. A component may bind an explicit whitespace-separated `style-tokens` attribute with `tokenListCodec`; XML `class` remains structural selector metadata and is never forwarded as native `className`.

A host `StyleAdapter` exposes a frozen deterministic token manifest and resolves only app-compiled semantic definitions. Components create a style hook from that exact adapter with `createComponentStyleHook`, which binds the native style type and verifies the provider uses the same adapter. Resolution uses the component's canonical registered tag, including when XML uses an alias, and rejects unknown, repeated, excessive, same-group conflicting, and component-inapplicable tokens. The standalone Expo corpus demonstrates tone, spacing, layout, safe-area, and host-platform variants without accepting arbitrary React Native style objects or dynamic Tailwind/NativeWind values.

Style composition is deterministic: component defaults are lowest priority, admitted independent token groups compose in authored order, explicit schema-owned semantic props override tokens, and local transient native state such as pressed/disabled remains the component's highest-priority layer. Unsupported input raises a typed props failure inside the registered component error boundary; it is never ignored or normalized into a fallback class.
