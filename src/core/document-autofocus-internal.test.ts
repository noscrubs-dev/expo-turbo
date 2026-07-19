import { describe, expect, test } from "bun:test"

import { consumeDocumentAutofocus } from "./document-autofocus-internal"
import { parseExpoTurboDocument } from "./parser"
import { DocumentSession } from "./session"
import { dispatchTurboStreamFragment } from "./streams"

function sessionFor(xml: string): DocumentSession {
  return new DocumentSession(parseExpoTurboDocument(xml, { url: "https://example.test/document" }))
}

describe("document autofocus generations", () => {
  test("claims ordered stable-id application candidates once for the initial document", () => {
    const session = sessionFor(
      `<Gallery id="gallery" autofocus="">
        <Field autofocus="" />
        <Field id="first" autofocus="" />
        <turbo-frame id="nested" autofocus="">
          <Field id="nested-field" autofocus="false" />
        </turbo-frame>
        <template><Field id="template-field" autofocus="" /></template>
        <turbo-cable-stream-source id="source" autofocus="">
          <Field id="source-field" autofocus="" />
        </turbo-cable-stream-source>
      </Gallery>`,
    )

    expect(
      consumeDocumentAutofocus(session, session.tree.document, session.treeGeneration),
    ).toEqual(["id:gallery", "id:first", "id:nested-field"])
    expect(
      consumeDocumentAutofocus(session, session.tree.document, session.treeGeneration),
    ).toBeUndefined()
  })

  test("keeps a pending generation valid across unrelated in-place mutations", () => {
    const session = sessionFor(
      '<Gallery><Field id="candidate" autofocus="" /><Other id="other" /></Gallery>',
    )
    const document = session.tree.document

    session.setAttribute("id:other", "data-state", "changed")

    expect(consumeDocumentAutofocus(session, document, 0)).toEqual(["id:candidate"])
  })

  test("consumes a generation without focusing after candidate replacement or insertion", () => {
    {
      const session = sessionFor('<Gallery><Field id="candidate" autofocus="" /></Gallery>')
      const document = session.tree.document
      dispatchTurboStreamFragment(
        session,
        '<turbo-stream action="replace" target="candidate"><template><Field id="candidate" autofocus="" /></template></turbo-stream>',
      )

      expect(consumeDocumentAutofocus(session, document, 0)).toBeUndefined()
      expect(consumeDocumentAutofocus(session, document, 0)).toBeUndefined()
    }

    {
      const session = sessionFor(
        '<Gallery id="gallery"><Field id="first" autofocus="" /></Gallery>',
      )
      const document = session.tree.document
      dispatchTurboStreamFragment(
        session,
        '<turbo-stream action="append" target="gallery"><template><Field id="second" autofocus="" /></template></turbo-stream>',
      )

      expect(consumeDocumentAutofocus(session, document, 0)).toBeUndefined()
    }
  })

  test("does not let a stale rendered generation consume the current replacement", () => {
    const session = sessionFor('<Gallery><Field id="old" autofocus="" /></Gallery>')
    const oldDocument = session.tree.document
    session.replaceTree(
      parseExpoTurboDocument('<Gallery><Field id="new" autofocus="" /></Gallery>', {
        url: "https://example.test/new",
      }),
    )

    expect(consumeDocumentAutofocus(session, oldDocument, 0)).toBeUndefined()
    expect(consumeDocumentAutofocus(session, session.tree.document, 1)).toEqual(["id:new"])
  })

  test("stages a replacement before old-tree disposal callbacks can publish it", () => {
    const session = sessionFor('<Gallery><Field id="old" /></Gallery>')
    let observed: readonly string[] | undefined
    session.registerDisposal("id:old", () => {
      observed = consumeDocumentAutofocus(session, session.tree.document, session.treeGeneration)
    })

    session.replaceTree(
      parseExpoTurboDocument('<Gallery><Field id="new" autofocus="" /></Gallery>', {
        url: "https://example.test/new",
      }),
    )

    expect(observed).toEqual(["id:new"])
  })

  test("stages every whole-tree generation even when the same tree is reinstalled", () => {
    const session = sessionFor('<Gallery><Field id="candidate" autofocus="" /></Gallery>')
    const tree = session.tree

    expect(consumeDocumentAutofocus(session, tree.document, 0)).toEqual(["id:candidate"])
    session.replaceTree(tree)
    expect(session.treeGeneration).toBe(1)
    expect(consumeDocumentAutofocus(session, tree.document, 1)).toEqual(["id:candidate"])
  })

  test("consumes an empty generation before a later Stream inserts autofocus", () => {
    const session = sessionFor('<Gallery id="gallery" />')
    const document = session.tree.document

    expect(consumeDocumentAutofocus(session, document, 0)).toEqual([])
    dispatchTurboStreamFragment(
      session,
      '<turbo-stream action="append" target="gallery"><template><Field id="late" autofocus="" /></template></turbo-stream>',
    )
    expect(consumeDocumentAutofocus(session, document, 0)).toBeUndefined()
  })
})
