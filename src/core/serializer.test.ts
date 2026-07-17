import { describe, expect, test } from "bun:test"

import { parseExpoTurboDocument, parseTurboStreamFragment } from "./parser"
import { serializeExpoTurboTree } from "./serializer"
import { nodeTextContent } from "./tree"

describe("canonical Expo Turbo tree serializer", () => {
  test("sorts attributes, escapes values, and preserves comments and CDATA", () => {
    const tree = parseExpoTurboDocument(
      '<Gallery z="last" a="&quot;&amp;&lt;&gt;"><DemoText>Tom &amp; &lt;friends&gt;</DemoText><!--note--><![CDATA[raw <text>]]></Gallery>',
    )

    const serialized = serializeExpoTurboTree(tree)

    expect(serialized).toBe(
      '<Gallery a="&quot;&amp;&lt;&gt;" z="last"><DemoText>Tom &amp; &lt;friends&gt;</DemoText><!--note--><![CDATA[raw <text>]]></Gallery>',
    )
    expect(nodeTextContent(parseExpoTurboDocument(serialized).document)).toBe(
      "Tom & <friends>raw <text>",
    )
  })

  test("serializes ordered Stream fragments without exposing the private parser wrapper", () => {
    const fragment = parseTurboStreamFragment(
      '<turbo-stream target="items" action="remove"/><turbo-stream action="refresh"/>',
    )

    expect(serializeExpoTurboTree(fragment)).toBe(
      '<turbo-stream action="remove" target="items"/><turbo-stream action="refresh"/>',
    )
  })
})
