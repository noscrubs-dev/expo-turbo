# XML parser spike

Status: selected for implementation. Release admission still requires the physical-device and adversarial-memory gates.

The first bounded spike compares `@xmldom/xmldom@0.9.10` with
`fast-xml-parser@5.10.1` ordered mode plus its validator. The fixture exercises exact tag
case, mixed text/element order, namespace resolution, comments, CDATA, attributes, parser
locations, mutation primitives, malformed input, undeclared prefixes, document types, and a
nesting limit.

## Current evidence

| Concern | `@xmldom/xmldom` | `fast-xml-parser` ordered mode |
| --- | --- | --- |
| Mixed content, comments, CDATA | Preserved as DOM nodes | Preserved with explicit ordered-mode options |
| Namespace URI resolution | Built in | Prefixes remain names; URI resolution would be package-owned |
| Mutable tree operations | Clone/append/insert/replace primitives are built in | A mutable indexed tree would be package-owned |
| Malformed tags/duplicate attributes | Strict error callback rejects them | Separate validation rejects them with line/column context |
| Undeclared prefixes | Strict parse rejects them | Bundled validator admits them |
| DTD/processing-instruction policy | Produces nodes that protocol preflight must reject | Validator admits DTD input; protocol preflight must reject it |
| Structural depth | Requires a package-owned preflight/budget | `maxNestedTags` can stop parsing before the ordered tree completes |

`@xmldom/xmldom@0.9.10` is the runtime dependency. The package converts its strict,
namespace-aware result into the public addressable protocol tree and owns a preflight scanner for
byte/depth/DTD/processing-instruction limits before xmldom allocates its result. Post-parse node,
attribute, cumulative-text, and Stream-action limits close the remaining structural boundary.
`fast-xml-parser` remains a development-only differential fixture dependency.

The standalone Expo app now imports the public parser/tree/selector API rather than either
candidate directly. Static web, iOS, and Android exports exercise the selected transitive runtime
graph and produce Hermes bytecode without Node polyfills. Production release-device builds and
adversarial memory measurements remain conformance gates.
