import { describe, expect, test } from "bun:test"

import { type DisposalError, TargetError } from "./errors"
import { parseExpoTurboDocument } from "./parser"
import { DocumentSession } from "./session"
import { dispatchTurboStreamFragment } from "./streams"

function session(xml: string): DocumentSession {
  return new DocumentSession(parseExpoTurboDocument(xml))
}

describe("document subtree disposal", () => {
  test("runs descendant hooks before parent hooks exactly once", () => {
    const document = session('<Gallery><Panel id="panel"><Child id="child"/></Panel></Gallery>')
    const events: string[] = []
    document.registerDisposal("id:panel", () => events.push("panel"))
    document.registerDisposal("id:child", () => events.push("child"))

    dispatchTurboStreamFragment(document, '<turbo-stream action="remove" target="panel"/>')
    dispatchTurboStreamFragment(document, '<turbo-stream action="remove" target="panel"/>')

    expect(events).toEqual(["child", "panel"])
  })

  test("disposes replaced identity even when the stable key is reused", () => {
    const document = session('<Gallery><Panel id="panel"><Old/></Panel></Gallery>')
    const disposed: string[] = []
    document.registerDisposal("id:panel", () => disposed.push("old"))

    dispatchTurboStreamFragment(
      document,
      '<turbo-stream action="replace" target="panel"><template><Panel id="panel"><New/></Panel></template></turbo-stream>',
    )
    document.registerDisposal("id:panel", () => disposed.push("new"))
    dispatchTurboStreamFragment(document, '<turbo-stream action="remove" target="panel"/>')

    expect(disposed).toEqual(["old", "new"])
  })

  test("supports explicit unregister and reports hook errors after all cleanup runs", () => {
    const errors: DisposalError[] = []
    const document = new DocumentSession(
      parseExpoTurboDocument('<Gallery><Panel id="panel"><Child id="child"/></Panel></Gallery>'),
      { onDisposalError: (error) => errors.push(error) },
    )
    const events: string[] = []
    const unregister = document.registerDisposal("id:child", () => events.push("unregistered"))
    unregister()
    document.registerDisposal("id:child", () => {
      events.push("broken")
      throw new Error("cleanup failed")
    })
    document.registerDisposal("id:panel", () => events.push("parent"))

    dispatchTurboStreamFragment(document, '<turbo-stream action="remove" target="panel"/>')

    expect(events).toEqual(["broken", "parent"])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ code: "disposal", context: { target: "id:child" } })
    expect(document.tree.getElementById("panel")).toBeUndefined()
    expect(() => document.registerDisposal("id:panel", () => undefined)).toThrow(TargetError)
  })
})
