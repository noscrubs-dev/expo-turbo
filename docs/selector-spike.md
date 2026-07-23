# Selector adapter spike

Status: selected and implemented. A bounded official Turbo 8.0.23 browser
differential now covers the selected structural selector surface inside real
Stream actions; broader differential and physical-device evidence remain
release gates.

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

The standalone Expo bundle probe now calls the public selector API. Web, iOS,
and Android exports therefore exercise the exact selected ESM/Metro graph. The
development-only browser differential executes official
`@hotwired/turbo@8.0.23` against the same initial markup and Stream messages as
the Expo tree. It compares full normalized outcomes for child/adjacent,
class/ID/attribute, selector-list, and structural pseudo selectors after live
ID-collision mutations with result caching disabled. The remaining complete
differential matrix and physical release-device run remain conformance gates.
