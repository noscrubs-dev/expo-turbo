import { describe, expect, test } from "bun:test"

import {
  consumeDocumentRefreshScroll,
  prepareDocumentRefreshScroll,
} from "./document-refresh-scroll-internal"
import { parseExpoTurboDocument } from "./parser"
import { DocumentSession } from "./session"

function tree(id: string) {
  return parseExpoTurboDocument(`<Screen id="${id}" />`, {
    url: `https://example.test/${id}`,
  })
}

describe("document refresh scroll coordination", () => {
  test("binds one prepared reset to its exact authoritative document generation", () => {
    const session = new DocumentSession(tree("initial"))
    const next = tree("next")

    prepareDocumentRefreshScroll(session)
    session.replaceTree(next)

    expect(consumeDocumentRefreshScroll(session, next.document, 0)).toBe(false)
    expect(consumeDocumentRefreshScroll(session, next.document, session.treeGeneration)).toBe(true)
    expect(consumeDocumentRefreshScroll(session, next.document, session.treeGeneration)).toBe(false)
  })

  test("does not carry a reset through a later document generation", () => {
    const session = new DocumentSession(tree("initial"))
    const next = tree("next")

    prepareDocumentRefreshScroll(session)
    session.replaceTree(next)
    session.replaceTree(tree("later"))

    expect(consumeDocumentRefreshScroll(session, next.document, 1)).toBe(false)
  })
})
