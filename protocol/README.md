# Protocol

Shared compatibility manifests and cross-language fixtures will live here. The package remains pre-release and does not yet claim complete Turbo compatibility.

## State references

Component-action parameters resolve state references against the action's selected document, Frame, or form scope before Zod admission:

- `{"$state":"key"}` is an exact-value reference. It must contain only the `$state` key and may resolve to any value admitted by the action schema.
- `{{state:key}}` interpolates a scalar state value into a string. Structured values are rejected instead of being coerced to `[object Object]`.
- Arrays and plain objects resolve recursively. Object keys are never interpolated.

Missing/blank keys, malformed interpolation, ambiguous `$state` objects, cycles, unsupported object prototypes, and excessive depth are typed protocol failures. Resolution never falls through from a Frame/form scope to document or app-global state. Structured exact references must come from an explicit host codec; the package does not opportunistically `JSON.parse` arbitrary XML attributes.
