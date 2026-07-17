# Selector adapter spike

Status: selected for implementation. Release admission still requires differential and physical-device evidence.

`css-select@7.0.0` accepts a small package-owned adapter for the mutable xmldom tree. The
comparison harness runs with `xmlMode: true`, explicit case preservation, and
`cacheResults: false`. It covers selector lists, tag/ID/class/data attributes, child and adjacent
sibling combinators, structural pseudo-classes, document order, mutation visibility, invalid
syntax, and namespaced-selector rejection.

`css-select@7.0.0` is the runtime dependency behind the package-owned protocol-tree adapter. The
adapter does not require a browser DOM, retains case-sensitive XML behavior, and observes every
tree mutation because result caching is disabled. Invalid and namespaced selector syntax is
wrapped in a typed target error; browser-state, pseudo-element, and shadow-DOM syntax remains
unsupported.

The standalone Expo bundle probe now calls the public selector API. Web, iOS, and Android exports
therefore exercise the exact selected ESM/Metro graph. Differential browser target fixtures and a
physical release-device run remain conformance gates.
