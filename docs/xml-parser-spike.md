# XML parser spike

Status: in progress. This is comparison evidence, not a runtime parser selection or compatibility claim.

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

The mutable namespace-aware DOM is presently the stronger runtime shape. That is not yet a
selection: the spike still needs a production Hermes bundle, adversarial memory measurements,
and selector-adapter evidence. The package must also preflight byte/DTD/processing-instruction
limits before either candidate allocates its full result.

Both exact candidate versions are also imported by the standalone Expo app's bundle probe. Static
web, iOS, and Android exports exercise this path; the native exports produce Hermes bytecode
bundles without Node polyfills. A production Hermes device build remains the selection gate.
