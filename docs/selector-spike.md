# Selector adapter spike

Status: in progress. This is adapter evidence, not a final selector selection.

`css-select@7.0.0` accepts a small package-owned adapter for the mutable xmldom tree. The
comparison harness runs with `xmlMode: true`, explicit case preservation, and
`cacheResults: false`. It covers selector lists, tag/ID/class/data attributes, child and adjacent
sibling combinators, structural pseudo-classes, document order, mutation visibility, invalid
syntax, and namespaced-selector rejection.

The adapter surface is feasible and does not require a browser DOM. Selection remains gated on the
parser decision, production Hermes evidence, differential target fixtures, and an explicit reject
list for browser-state, pseudo-element, shadow-DOM, and namespaced selector syntax.

The standalone Expo bundle probe imports the exact candidate so web, iOS, and Android exports also
exercise its ESM/Metro graph. A physical release-device run remains required before selection.
