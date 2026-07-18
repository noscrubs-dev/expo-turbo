import { describe, expect, test } from "bun:test"
import { z } from "zod"

import { createStreamActionRegistry, defineStreamAction } from "./custom-stream-actions"
import { RegistryError, TargetError } from "./errors"
import { parseExpoTurboDocument } from "./parser"
import { DocumentSession, SessionCommitError } from "./session"
import { dispatchTurboStreamFragment, type StreamActionReport } from "./streams"
import { attributeValue, isElement } from "./tree"

function session(xml: string): DocumentSession {
  return new DocumentSession(parseExpoTurboDocument(xml))
}

function childIds(node: ReturnType<DocumentSession["tree"]["getElementById"]>): string[] {
  if (!node) return []
  return node.children.flatMap((child) => {
    if (!isElement(child)) return []
    const id = attributeValue(child, "id")
    return id ? [id] : []
  })
}

describe("Turbo Stream dispatcher", () => {
  test("applies ordered built-in actions and continues after an isolated action error", () => {
    const document = session(
      '<Gallery id="gallery"><Items id="items"><Item id="old"/><Item id="keep"/></Items><Marker id="marker"/><Victim id="victim"><Old /></Victim></Gallery>',
    )
    const reports = dispatchTurboStreamFragment(
      document,
      `<turbo-stream action="append" target="items"><template><Item id="old"/><Item id="new"/></template></turbo-stream>
       <turbo-stream action="unknown" target="items"><template><Item /></template></turbo-stream>
       <turbo-stream action="before" target="marker"><template><Item id="before"/></template></turbo-stream>
       <turbo-stream action="after" target="marker"><template><Item id="after"/></template></turbo-stream>
       <turbo-stream action="update" target="victim"><template><Replacement id="replacement"/></template></turbo-stream>
       <turbo-stream action="remove" target="marker"><template><Ignored /></template><template><AlsoIgnored /></template></turbo-stream>`,
    ).actions

    expect(reports.map((report) => report.status)).toEqual([
      "applied",
      "error",
      "applied",
      "applied",
      "applied",
      "applied",
    ])
    expect(childIds(document.tree.getElementById("items"))).toEqual(["keep", "old", "new"])
    expect(childIds(document.tree.getElementById("gallery"))).toEqual([
      "items",
      "before",
      "after",
      "victim",
    ])
    expect(childIds(document.tree.getElementById("victim"))).toEqual(["replacement"])
    expect(document.tree.getElementById("marker")).toBeUndefined()
  })

  test("propagates committed session-finalization failures and stops later siblings", () => {
    const document = session(
      '<Gallery><Target id="first"><Old /></Target><Target id="second"><Old /></Target></Gallery>',
    )
    const actionErrors: StreamActionReport[] = []
    document.subscribe("id:first", () => {
      throw new Error("listener details")
    })

    expect(() =>
      dispatchTurboStreamFragment(
        document,
        `<turbo-stream action="update" target="first"><template><Committed id="committed-first" /></template></turbo-stream>
         <turbo-stream action="update" target="second"><template><Stale id="stale-second" /></template></turbo-stream>`,
        { onActionError: (report) => actionErrors.push(report) },
      ),
    ).toThrow(SessionCommitError)
    expect(document.tree.getElementById("committed-first")).toBeDefined()
    expect(document.tree.getElementById("stale-second")).toBeUndefined()
    expect(actionErrors).toEqual([])
  })

  test("preserves update identity, replaces replace identity, and invalidates the stable snapshot", () => {
    const document = session('<Gallery><Panel id="panel"><Old id="old"/></Panel></Gallery>')
    const original = document.tree.getElementById("panel")
    const originalSnapshot = document.getNodeSnapshot("id:panel")
    let notifications = 0
    document.subscribe("id:panel", () => {
      notifications += 1
    })

    dispatchTurboStreamFragment(
      document,
      '<turbo-stream action="update" target="panel"><template><New id="child"/></template></turbo-stream>',
    )
    expect(document.tree.getElementById("panel")).toBe(original)
    const updatedSnapshot = document.getNodeSnapshot("id:panel")
    expect(updatedSnapshot).not.toBe(originalSnapshot)
    expect(updatedSnapshot?.identity).toBe(originalSnapshot?.identity)

    dispatchTurboStreamFragment(
      document,
      '<turbo-stream action="replace" target="panel"><template><Panel id="panel"><Final /></Panel></template></turbo-stream>',
    )
    expect(document.tree.getElementById("panel")).not.toBe(original)
    expect(document.getNodeSnapshot("id:panel")?.identity).not.toBe(originalSnapshot?.identity)
    expect(document.tree.getElementById("old")).toBeUndefined()
    expect(notifications).toBe(2)
  })

  test("isolates exact structural morph methods until native morph support exists", () => {
    const document = session(
      '<Gallery><Panel id="replace"><Old id="old-replace"/></Panel><Panel id="update"><Old id="old-update"/></Panel><Later id="later"/></Gallery>',
    )
    const originalReplace = document.tree.getElementById("replace")
    const originalUpdate = document.tree.getElementById("update")
    const reports = dispatchTurboStreamFragment(
      document,
      `<turbo-stream action="replace" target="replace" method="morph"><template><Panel id="replace"><New id="new-replace"/></Panel></template></turbo-stream>
       <turbo-stream action="update" target="update" method="morph"><template><New id="new-update"/></template></turbo-stream>
       <turbo-stream action="remove" target="later"/>`,
    ).actions

    expect(reports.map((report) => report.status)).toEqual(["error", "error", "applied"])
    expect(reports[0]?.error?.message).toContain("morph method")
    expect(reports[1]?.error?.message).toContain("morph method")
    expect(document.tree.getElementById("replace")).toBe(originalReplace)
    expect(document.tree.getElementById("update")).toBe(originalUpdate)
    expect(document.tree.getElementById("old-replace")).toBeDefined()
    expect(document.tree.getElementById("old-update")).toBeDefined()
    expect(document.tree.getElementById("new-replace")).toBeUndefined()
    expect(document.tree.getElementById("new-update")).toBeUndefined()
    expect(document.tree.getElementById("later")).toBeUndefined()
  })

  test("uses plain structural semantics for every non-morph method value", () => {
    const document = session(
      '<Gallery><Panel id="replace"><Old /></Panel><Panel id="update"><Old /></Panel></Gallery>',
    )
    const originalUpdate = document.tree.getElementById("update")
    const reports = dispatchTurboStreamFragment(
      document,
      `<turbo-stream action="replace" target="replace" method="MORPH"><template><Panel id="replace"><Final id="replaced"/></Panel></template></turbo-stream>
       <turbo-stream action="update" target="update" method=""><template><Final id="updated"/></template></turbo-stream>`,
    ).actions

    expect(reports.map((report) => report.status)).toEqual(["applied", "applied"])
    expect(document.tree.getElementById("replace")?.children.find(isElement)).toBe(
      document.tree.getElementById("replaced"),
    )
    expect(document.tree.getElementById("update")).toBe(originalUpdate)
    expect(document.tree.getElementById("update")?.children.find(isElement)).toBe(
      document.tree.getElementById("updated"),
    )
  })

  test("rejects duplicate payload ids before compound collision mutations", () => {
    for (const action of ["append", "prepend", "before", "after"] as const) {
      const isChildAction = action === "append" || action === "prepend"
      const document = session(
        isChildAction
          ? '<Gallery><List id="list"><Item id="same"/></List><Later id="later"/></Gallery>'
          : '<Gallery><Item id="same"/><Marker id="marker"/><Later id="later"/></Gallery>',
      )
      const original = document.tree.getElementById("same")
      const snapshot = document.getNodeSnapshot("id:same")
      const disposed: string[] = []
      document.registerDisposal("id:same", () => disposed.push(action))
      const target = isChildAction ? "list" : "marker"

      const reports = dispatchTurboStreamFragment(
        document,
        `<turbo-stream action="${action}" target="${target}"><template><Item id="same"/><Item id="same"/></template></turbo-stream>
         <turbo-stream action="remove" target="later"/>`,
      ).actions

      expect(reports.map((report) => report.status)).toEqual(["error", "applied"])
      expect(reports[0]?.error?.message).toContain("declared more than once")
      expect(document.tree.getElementById("same")).toBe(original)
      expect(document.getNodeSnapshot("id:same")).toBe(snapshot)
      expect(document.revision).toBe(1)
      expect(disposed).toEqual([])
    }
  })

  test("clones selector payload independently and gives target precedence over targets", () => {
    const document = session(
      '<Gallery><List id="first" class="group"/><List id="second" class="group"/></Gallery>',
    )
    const multi = dispatchTurboStreamFragment(
      document,
      '<turbo-stream action="append" targets=".group"><template><Item /></template></turbo-stream>',
    ).actions[0]
    const firstChild = document.tree.getElementById("first")?.children.find(isElement)
    const secondChild = document.tree.getElementById("second")?.children.find(isElement)

    expect(multi).toMatchObject({ appliedTargets: 2, matchedTargets: 2, status: "applied" })
    expect(firstChild).toBeDefined()
    expect(secondChild).toBeDefined()
    expect(firstChild).not.toBe(secondChild)
    expect(firstChild?.key).not.toBe(secondChild?.key)

    const precedence = dispatchTurboStreamFragment(
      document,
      '<turbo-stream action="append" target="first" targets=".group"><template><Chosen /></template></turbo-stream>',
    ).actions[0]
    expect(precedence).toMatchObject({ appliedTargets: 1, matchedTargets: 1 })
    expect(document.tree.getElementById("first")?.children.filter(isElement)).toHaveLength(2)
    expect(document.tree.getElementById("second")?.children.filter(isElement)).toHaveLength(1)

    const duplicateIds = dispatchTurboStreamFragment(
      document,
      '<turbo-stream action="append" targets=".group"><template><Item id="duplicated" /></template></turbo-stream>',
    ).actions[0]
    expect(duplicateIds?.status).toBe("error")
    expect(document.tree.getElementById("duplicated")).toBeUndefined()
  })

  test("matches absent-template and stale-target no-op semantics", () => {
    const document = session(
      '<Gallery><List id="append"/><List id="update"><Old /></List><List id="replace"/></Gallery>',
    )
    const reports = dispatchTurboStreamFragment(
      document,
      `<turbo-stream action="append" target="append"></turbo-stream>
       <turbo-stream action="update" target="update"></turbo-stream>
       <turbo-stream action="replace" target="replace"></turbo-stream>
       <turbo-stream action="remove" target="missing"></turbo-stream>`,
    ).actions

    expect(reports.map((report) => report.status)).toEqual(["noop", "applied", "applied", "noop"])
    expect(document.tree.getElementById("append")?.children).toHaveLength(0)
    expect(document.tree.getElementById("update")?.children).toHaveLength(0)
    expect(document.tree.getElementById("replace")).toBeUndefined()
  })

  test("allows sibling actions to reuse a payload id while the active document stays unique", () => {
    const document = session('<Gallery><List id="list"/></Gallery>')
    const reports = dispatchTurboStreamFragment(
      document,
      `<turbo-stream action="append" target="list"><template><Item id="same" /></template></turbo-stream>
       <turbo-stream action="replace" target="same"><template><Item id="same"><Final /></Item></template></turbo-stream>`,
    ).actions

    expect(reports.map((report) => report.status)).toEqual(["applied", "applied"])
    expect(document.tree.getElementById("same")?.children.filter(isElement)).toHaveLength(1)
  })

  test("matches first-template and relative sibling-collision behavior", () => {
    const document = session('<Gallery><Item id="same"/><Item id="other"/></Gallery>')
    const reports = dispatchTurboStreamFragment(
      document,
      `<turbo-stream action="before" target="same"><template><Replacement id="same"/></template></turbo-stream>
       <turbo-stream action="append" target="other"><NotTemplate/><template><Ignored /></template></turbo-stream>`,
    ).actions

    expect(reports.map((report) => report.status)).toEqual(["applied", "error"])
    expect(document.tree.getElementById("same")).toBeUndefined()
    expect(document.tree.getElementById("other")?.children).toHaveLength(0)
  })

  test("reports invalid selectors and duplicate ids without poisoning later siblings", () => {
    const document = session(
      '<Gallery><Node id="existing"/><List id="list"/><Node id="remove-me"/></Gallery>',
    )
    const errors: StreamActionReport[] = []
    const reports = dispatchTurboStreamFragment(
      document,
      `<turbo-stream action="append" targets="["><template><Item /></template></turbo-stream>
       <turbo-stream action="append" target="list"><template><Node id="existing"/></template></turbo-stream>
       <turbo-stream action="remove" target="remove-me"></turbo-stream>`,
      { onActionError: (report) => errors.push(report) },
    ).actions

    expect(reports.map((report) => report.status)).toEqual(["error", "error", "applied"])
    expect(reports[0]?.error).toBeInstanceOf(TargetError)
    expect(errors).toHaveLength(2)
    expect(document.tree.getElementById("list")?.children).toHaveLength(0)
    expect(document.tree.getElementById("remove-me")).toBeUndefined()
  })

  test("dispatches registered custom actions with typed params, targets, and template payload", () => {
    const document = session('<Gallery><Notice id="notice"/></Gallery>')
    const calls: string[] = []
    const announce = defineStreamAction({
      action: "announce",
      handler: ({ params, session: activeSession, targets, template }) => {
        calls.push(`${params.message}:${params.priority}:${template.length}`)
        for (const target of targets) {
          activeSession.setAttribute(target.key, "data-announcement", params.message)
        }
      },
      schema: z.object({ message: z.string().min(1), priority: z.coerce.number().int() }),
    })
    const customActions = createStreamActionRegistry(announce)

    const report = dispatchTurboStreamFragment(
      document,
      '<turbo-stream action="announce" target="notice" data-message="Ready" data-priority="2"><template><Badge/></template></turbo-stream>',
      { customActions },
    ).actions[0]

    expect(report).toMatchObject({
      action: "announce",
      appliedTargets: 1,
      matchedTargets: 1,
      status: "applied",
    })
    expect(calls).toEqual(["Ready:2:1"])
    const notice = document.tree.getElementById("notice")
    expect(notice).toBeDefined()
    expect(notice && attributeValue(notice, "data-announcement")).toBe("Ready")
    expect(customActions.actions).toEqual(["announce"])
  })

  test("isolates custom action validation and handler failures from later siblings", () => {
    const document = session('<Gallery><Notice id="notice"/><Victim id="victim"/></Gallery>')
    const announce = defineStreamAction({
      action: "announce",
      handler: ({ params }) => {
        if (params.message === "explode") throw new Error("host action failed")
      },
      schema: z.object({ message: z.string().min(1) }),
    })
    const reports = dispatchTurboStreamFragment(
      document,
      `<turbo-stream action="announce" data-message="" />
       <turbo-stream action="announce" data-message="ok" data-unknown="rejected" />
       <turbo-stream action="announce" data-message="explode" />
       <turbo-stream action="remove" target="victim" />`,
      { customActions: createStreamActionRegistry(announce) },
    ).actions

    expect(reports.map((report) => report.status)).toEqual(["error", "error", "error", "applied"])
    expect(reports.slice(0, 3).every((report) => report.error?.code === "action")).toBe(true)
    expect(document.tree.getElementById("victim")).toBeUndefined()
  })

  test("rejects reserved and duplicate custom action ownership", () => {
    expect(() =>
      defineStreamAction({ action: "remove", handler: () => undefined, schema: z.object({}) }),
    ).toThrow(RegistryError)

    const first = defineStreamAction({
      action: "announce",
      handler: () => undefined,
      schema: z.object({}),
    })
    const duplicate = defineStreamAction({
      action: "announce",
      handler: () => undefined,
      schema: z.object({}),
    })
    expect(() => createStreamActionRegistry(first, duplicate)).toThrow(/Duplicate Stream action/)
  })
})
