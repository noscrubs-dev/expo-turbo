import { describe, expect, test } from "bun:test"
import { z } from "zod"

import { createStreamActionRegistry, defineStreamAction } from "./custom-stream-actions"
import { RegistryError, TargetError } from "./errors"
import { FormControlRegistry } from "./forms"
import { parseExpoTurboDocument } from "./parser"
import { DocumentSession, SessionCommitError } from "./session"
import { DocumentStateScopes } from "./state"
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

  test("supports identity-safe outer and child morph only for exact targets", () => {
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

    expect(reports.map((report) => report.status)).toEqual(["applied", "applied", "applied"])
    expect(document.tree.getElementById("replace")).toBe(originalReplace)
    expect(document.tree.getElementById("update")).toBe(originalUpdate)
    expect(document.tree.getElementById("old-replace")).toBeUndefined()
    expect(document.tree.getElementById("old-update")).toBeUndefined()
    expect(document.tree.getElementById("new-replace")).toBeDefined()
    expect(document.tree.getElementById("new-update")).toBeDefined()
    expect(document.tree.getElementById("later")).toBeUndefined()
  })

  test("retains compatible outer morph ownership while reconciling attributes and children", () => {
    const document = session(
      '<Gallery><DemoForm id="form" legacy="remove" tone="muted"><DemoInput id="email" tone="muted"/><DemoText id="copy">Before</DemoText></DemoForm></Gallery>',
    )
    const form = document.tree.getElementById("form")
    const email = document.tree.getElementById("email")
    if (!form || !email) throw new Error("outer morph fixture is missing")
    const formSnapshot = document.getNodeSnapshot(form.key)
    const emailSnapshot = document.getNodeSnapshot(email.key)
    const scopes = new DocumentStateScopes(document)
    const formScope = scopes.scopeFor(form.key, "form", { draft: "kept" })
    const controls = new FormControlRegistry(document, form.key)
    controls.register(email.key, { kind: "value", name: "email", value: "ada@example.test" })

    const report = dispatchTurboStreamFragment(
      document,
      '<turbo-stream action="replace" target="form" method="morph"><template><DemoForm id="form" tone="accent"><DemoInput id="email" tone="accent"/><DemoText id="copy">After</DemoText></DemoForm></template></turbo-stream>',
    ).actions[0]
    const currentForm = document.tree.getElementById("form")
    const currentEmail = document.tree.getElementById("email")
    if (!currentForm || !currentEmail) throw new Error("outer-morphed nodes are missing")

    expect(report).toMatchObject({ appliedTargets: 1, matchedTargets: 1, status: "applied" })
    expect(currentForm).toBe(form)
    expect(currentEmail).toBe(email)
    expect(document.getNodeSnapshot(form.key)?.identity).toBe(formSnapshot?.identity)
    expect(document.getNodeSnapshot(email.key)?.identity).toBe(emailSnapshot?.identity)
    expect(attributeValue(currentForm, "tone")).toBe("accent")
    expect(attributeValue(currentForm, "legacy")).toBeUndefined()
    expect(attributeValue(currentEmail, "tone")).toBe("accent")
    expect(scopes.scopeFor(form.key, "form")).toBe(formScope)
    expect(formScope.state.get("draft")).toBe("kept")
    expect(formScope.state.isDisposed).toBe(false)
    expect(controls.successfulEntries()).toEqual([{ name: "email", value: "ada@example.test" }])
  })

  test("retains compatible nested IDs and host form/state ownership during child morph", () => {
    const document = session(
      '<Gallery><DemoForm id="form"><DemoInput id="email" tone="muted"/><DemoText id="copy">Before</DemoText></DemoForm></Gallery>',
    )
    const form = document.tree.getElementById("form")
    const email = document.tree.getElementById("email")
    if (!form || !email) throw new Error("morph fixture is missing")
    const emailSnapshot = document.getNodeSnapshot(email.key)
    const scopes = new DocumentStateScopes(document)
    const scope = scopes.scopeFor(email.key, "form", { draft: "kept" })
    const controls = new FormControlRegistry(document, form.key)
    controls.register(email.key, { kind: "value", name: "email", value: "ada@example.test" })

    const report = dispatchTurboStreamFragment(
      document,
      '<turbo-stream action="update" target="form" method="morph"><template><DemoInput id="email" tone="accent"/><DemoText id="copy">After</DemoText><DemoError id="email-error">Required</DemoError></template></turbo-stream>',
    ).actions[0]
    const currentEmail = document.tree.getElementById("email")
    if (!currentEmail) throw new Error("morphed email is missing")

    expect(report).toMatchObject({ appliedTargets: 1, matchedTargets: 1, status: "applied" })
    expect(currentEmail).toBe(email)
    expect(document.getNodeSnapshot(email.key)?.identity).toBe(emailSnapshot?.identity)
    expect(attributeValue(currentEmail, "tone")).toBe("accent")
    expect(scopes.scopeFor(email.key, "form")).toBe(scope)
    expect(scope.state.get("draft")).toBe("kept")
    expect(scope.state.isDisposed).toBe(false)
    expect(controls.successfulEntries()).toEqual([{ name: "email", value: "ada@example.test" }])
    expect(document.tree.getElementById("email-error")).toBeDefined()
  })

  test("reorders compatible IDs while remounting unkeyed and incompatible children", () => {
    const document = session(
      '<Gallery><DemoForm id="form"><DemoInput id="first"/><DemoText>Unkeyed</DemoText><DemoInput id="second"/></DemoForm></Gallery>',
    )
    const first = document.tree.getElementById("first")
    const second = document.tree.getElementById("second")
    const unkeyed = document.tree.getElementById("form")?.children[1]
    if (!first || !second || !unkeyed) throw new Error("morph fixture is missing")
    const scope = new DocumentStateScopes(document).scopeFor(first.key, "form", { draft: "first" })

    dispatchTurboStreamFragment(
      document,
      '<turbo-stream action="update" target="form" method="morph"><template><DemoInput id="second"/><DemoText>Replacement</DemoText><DemoText id="first"/></template></turbo-stream>',
    )
    const form = document.tree.getElementById("form")
    const currentFirst = document.tree.getElementById("first")
    const currentSecond = document.tree.getElementById("second")

    expect(currentSecond).toBe(second)
    expect(currentFirst).not.toBe(first)
    expect(scope.state.isDisposed).toBe(true)
    expect(form?.children[1]).not.toBe(unkeyed)
    expect(form?.children.map((child) => child.key)).toEqual([
      second.key,
      expect.any(String),
      first.key,
    ])
  })

  test("structurally replaces protocol-wrapper descendants during child morph", () => {
    const document = session(
      '<Gallery><DemoPanel id="panel"><turbo-frame id="frame"><DemoInput id="field"/></turbo-frame><turbo-cable-stream-source id="source" channel="DemoChannel"/></DemoPanel></Gallery>',
    )
    const frame = document.tree.getElementById("frame")
    const field = document.tree.getElementById("field")
    const source = document.tree.getElementById("source")
    if (!frame || !field || !source) throw new Error("morph fixture is missing")
    const disposed: string[] = []
    document.registerDisposal(frame.key, () => disposed.push("frame"))
    document.registerDisposal(source.key, () => disposed.push("source"))

    dispatchTurboStreamFragment(
      document,
      '<turbo-stream action="update" target="panel" method="morph"><template><turbo-frame id="frame"><DemoInput id="field" tone="accent"/></turbo-frame><turbo-cable-stream-source id="source" channel="UpdatedChannel"/></template></turbo-stream>',
    )
    const currentFrame = document.tree.getElementById("frame")
    const currentField = document.tree.getElementById("field")
    const currentSource = document.tree.getElementById("source")
    if (!currentFrame || !currentField || !currentSource) {
      throw new Error("morphed protocol wrapper is missing")
    }

    expect(currentFrame).not.toBe(frame)
    expect(currentField).not.toBe(field)
    expect(currentSource).not.toBe(source)
    expect(attributeValue(currentField, "tone")).toBe("accent")
    expect(attributeValue(currentSource, "channel")).toBe("UpdatedChannel")
    expect(disposed).toEqual(["frame", "source"])
  })

  test("remounts an incompatible replacement subtree without retaining its descendant IDs", () => {
    const document = session(
      '<Gallery><DemoPanel id="panel"><Old id="root"><DemoGroup id="before"><DemoInput id="field"/></DemoGroup></Old></DemoPanel></Gallery>',
    )
    const root = document.tree.getElementById("root")
    const field = document.tree.getElementById("field")
    if (!root || !field) throw new Error("morph fixture is missing")
    const scope = new DocumentStateScopes(document).scopeFor(field.key, "form", { draft: "old" })

    const report = dispatchTurboStreamFragment(
      document,
      '<turbo-stream action="update" target="panel" method="morph"><template><New id="root"><DemoGroup id="after"><DemoInput id="field"/></DemoGroup></New></template></turbo-stream>',
    ).actions[0]
    const currentRoot = document.tree.getElementById("root")
    const currentField = document.tree.getElementById("field")
    if (!currentRoot || !currentField) throw new Error("morphed replacement subtree is missing")

    expect(report).toMatchObject({ appliedTargets: 1, status: "applied" })
    expect(currentRoot).not.toBe(root)
    expect(currentField).not.toBe(field)
    expect(document.tree.getElementById("before")).toBeUndefined()
    expect(document.tree.getElementById("after")).toBeDefined()
    expect(scope.state.isDisposed).toBe(true)
  })

  test("rejects unsupported child morph boundaries atomically and continues later Streams", () => {
    const fixture = (permanent = false) =>
      session(
        `<Gallery><Outside id="outside"/><DemoForm id="form"><DemoGroup id="left"><DemoInput id="field"/></DemoGroup><DemoGroup id="right"/>${permanent ? '<DemoText id="permanent" data-turbo-permanent=""/>' : ""}</DemoForm><turbo-frame id="frame"><DemoText id="frame-child"/></turbo-frame><Later id="later"/></Gallery>`,
      )
    const cases: readonly {
      readonly name: string
      readonly permanent?: boolean
      readonly stream: string
    }[] = [
      {
        name: "selector",
        stream:
          '<turbo-stream action="update" targets="DemoForm" method="morph"><template><DemoText/></template></turbo-stream>',
      },
      {
        name: "Frame target",
        stream:
          '<turbo-stream action="update" target="frame" method="morph"><template><DemoText/></template></turbo-stream>',
      },
      {
        name: "permanent active node",
        stream:
          '<turbo-stream action="update" target="form" method="morph"><template><DemoGroup id="left"><DemoInput id="field"/></DemoGroup><DemoGroup id="right"/><DemoText id="permanent" data-turbo-permanent=""/></template></turbo-stream>',
        permanent: true,
      },
      {
        name: "permanent payload node",
        stream:
          '<turbo-stream action="update" target="form" method="morph"><template><DemoGroup id="left"><DemoInput id="field"/></DemoGroup><DemoGroup id="right"/><DemoText data-turbo-permanent=""/></template></turbo-stream>',
      },
      {
        name: "external id",
        stream:
          '<turbo-stream action="update" target="form" method="morph"><template><DemoInput id="outside"/></template></turbo-stream>',
      },
      {
        name: "reparented id",
        stream:
          '<turbo-stream action="update" target="form" method="morph"><template><DemoGroup id="left"/><DemoGroup id="right"><DemoInput id="field"/></DemoGroup></template></turbo-stream>',
      },
      {
        name: "reparented id through an unkeyed wrapper",
        stream:
          '<turbo-stream action="update" target="form" method="morph"><template><DemoGroup id="left"><DemoGroup><DemoInput id="field"/></DemoGroup></DemoGroup><DemoGroup id="right"/></template></turbo-stream>',
      },
    ]

    for (const fixtureCase of cases) {
      const document = fixture(fixtureCase.permanent)
      const form = document.tree.getElementById("form")
      const before = document.getNodeSnapshot("id:form")
      const reports = dispatchTurboStreamFragment(
        document,
        `${fixtureCase.stream}<turbo-stream action="remove" target="later"/>`,
      ).actions

      expect(reports[0]?.status, fixtureCase.name).toBe("error")
      expect(document.tree.getElementById("form")).toBe(form)
      expect(document.getNodeSnapshot("id:form"), fixtureCase.name).toBe(before)
      expect(document.revision, fixtureCase.name).toBe(1)
      expect(document.tree.getElementById("later"), fixtureCase.name).toBeUndefined()
    }
  })

  test("rejects unsupported outer morph boundaries atomically and continues later Streams", () => {
    const fixture = (permanent = false) =>
      session(
        `<Gallery><Outside id="outside"/><DemoForm id="form"${permanent ? ' data-turbo-permanent=""' : ""}><DemoGroup id="left"><DemoInput id="field"/></DemoGroup><DemoGroup id="right"/></DemoForm><turbo-frame id="frame"><DemoText id="frame-child"/></turbo-frame><Later id="later"/></Gallery>`,
      )
    const cases: readonly {
      readonly name: string
      readonly permanent?: boolean
      readonly stream: string
    }[] = [
      {
        name: "selector",
        stream:
          '<turbo-stream action="replace" targets="DemoForm" method="morph"><template><DemoForm id="form"/></template></turbo-stream>',
      },
      {
        name: "empty root",
        stream:
          '<turbo-stream action="replace" target="form" method="morph"><template/></turbo-stream>',
      },
      {
        name: "multiple roots",
        stream:
          '<turbo-stream action="replace" target="form" method="morph"><template><DemoForm id="form"/><DemoText/></template></turbo-stream>',
      },
      {
        name: "non-element root",
        stream:
          '<turbo-stream action="replace" target="form" method="morph"><template>replacement</template></turbo-stream>',
      },
      {
        name: "different root id",
        stream:
          '<turbo-stream action="replace" target="form" method="morph"><template><DemoForm id="different"/></template></turbo-stream>',
      },
      {
        name: "incompatible root shape",
        stream:
          '<turbo-stream action="replace" target="form" method="morph"><template><DemoGroup id="form"/></template></turbo-stream>',
      },
      {
        name: "Frame target",
        stream:
          '<turbo-stream action="replace" target="frame" method="morph"><template><turbo-frame id="frame"><DemoText/></turbo-frame></template></turbo-stream>',
      },
      {
        name: "permanent active node",
        permanent: true,
        stream:
          '<turbo-stream action="replace" target="form" method="morph"><template><DemoForm id="form"><DemoGroup id="left"><DemoInput id="field"/></DemoGroup><DemoGroup id="right"/></DemoForm></template></turbo-stream>',
      },
      {
        name: "permanent payload node",
        stream:
          '<turbo-stream action="replace" target="form" method="morph"><template><DemoForm id="form"><DemoGroup id="left"><DemoInput id="field"/></DemoGroup><DemoGroup id="right"/><DemoText data-turbo-permanent=""/></DemoForm></template></turbo-stream>',
      },
      {
        name: "external id",
        stream:
          '<turbo-stream action="replace" target="form" method="morph"><template><DemoForm id="form"><DemoInput id="outside"/></DemoForm></template></turbo-stream>',
      },
      {
        name: "reparented id",
        stream:
          '<turbo-stream action="replace" target="form" method="morph"><template><DemoForm id="form"><DemoGroup id="left"/><DemoGroup id="right"><DemoInput id="field"/></DemoGroup></DemoForm></template></turbo-stream>',
      },
    ]

    for (const fixtureCase of cases) {
      const document = fixture(fixtureCase.permanent)
      const form = document.tree.getElementById("form")
      const before = document.getNodeSnapshot("id:form")
      const reports = dispatchTurboStreamFragment(
        document,
        `${fixtureCase.stream}<turbo-stream action="remove" target="later"/>`,
      ).actions

      expect(reports[0]?.status, fixtureCase.name).toBe("error")
      expect(document.tree.getElementById("form")).toBe(form)
      expect(document.getNodeSnapshot("id:form"), fixtureCase.name).toBe(before)
      expect(document.revision, fixtureCase.name).toBe(1)
      expect(document.tree.getElementById("later"), fixtureCase.name).toBeUndefined()
    }
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
