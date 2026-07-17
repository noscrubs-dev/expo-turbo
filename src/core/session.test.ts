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

  test("commits before reporting every disposal and stable-snapshot listener failure", () => {
    const document = session('<Gallery><Panel id="panel" /></Gallery>')
    const events: string[] = []
    document.registerDisposal("id:panel", () => {
      events.push("dispose")
      throw new Error("disposal failed")
    })
    let unsubscribeSecond: () => void = () => undefined
    document.subscribe("id:panel", () => {
      events.push("first")
      unsubscribeSecond()
      document.subscribe("id:panel", () => events.push("late"))
      throw new Error("listener failed")
    })
    unsubscribeSecond = document.subscribe("id:panel", () => events.push("second"))
    const replacement = parseExpoTurboDocument('<Gallery><Next id="next" /></Gallery>')

    let reported: unknown
    try {
      document.replaceTree(replacement)
    } catch (error) {
      reported = error
    }

    expect(reported).toBeInstanceOf(AggregateError)
    expect((reported as AggregateError).errors).toHaveLength(2)
    expect(events).toEqual(["dispose", "first", "second"])
    expect(document.tree).toBe(replacement)
    expect(document.revision).toBe(1)
    expect(document.treeGeneration).toBe(1)
  })

  test("uses one callback snapshot across every key in a tree replacement", () => {
    const document = session('<Gallery><First id="first" /><Second id="second" /></Gallery>')
    const events: string[] = []
    let unsubscribeSecond: () => void = () => undefined
    document.subscribe("id:first", () => {
      events.push("first")
      unsubscribeSecond()
      document.subscribe("id:second", () => events.push("late-second"))
      document.subscribe("id:third", () => events.push("third"))
    })
    unsubscribeSecond = document.subscribe("id:second", () => events.push("second"))

    document.replaceTree(parseExpoTurboDocument('<Gallery><Next id="next" /></Gallery>'))

    expect(events).toEqual(["first", "second"])
  })

  test("reports every disposal, reporter, and listener failure after commit", () => {
    const events: string[] = []
    const document = new DocumentSession(
      parseExpoTurboDocument('<Gallery><Panel id="panel"><Child id="child" /></Panel></Gallery>'),
      {
        onDisposalError(error) {
          events.push(`report:${error.context.target}`)
          throw new Error(`reporter failed for ${error.context.target}`)
        },
      },
    )
    document.registerDisposal("id:child", () => {
      events.push("dispose:child")
      throw new Error("child failed")
    })
    document.registerDisposal("id:panel", () => {
      events.push("dispose:panel")
      throw new Error("panel failed")
    })
    document.subscribe("id:panel", () => {
      events.push("listener:panel")
      throw new Error("listener failed")
    })
    document.subscribe("id:child", () => events.push("listener:child"))

    let reported: unknown
    try {
      document.replaceTree(parseExpoTurboDocument('<Gallery><Next id="next" /></Gallery>'))
    } catch (error) {
      reported = error
    }

    expect(reported).toBeInstanceOf(AggregateError)
    expect((reported as AggregateError).errors).toHaveLength(5)
    expect(
      (reported as AggregateError).errors.filter((error) => error instanceof TargetError),
    ).toHaveLength(0)
    expect(
      (reported as AggregateError).errors.filter(
        (error) => error instanceof Error && error.name === "DisposalError",
      ),
    ).toHaveLength(2)
    expect(events).toEqual([
      "dispose:child",
      "dispose:panel",
      "listener:panel",
      "listener:child",
      "report:id:child",
      "report:id:panel",
    ])
    expect(document.tree.getElementById("next")?.tagName).toBe("Next")
  })
})
