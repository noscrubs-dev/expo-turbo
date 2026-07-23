import { describe, expect, test } from "bun:test"
import { z } from "zod"

import { createStreamActionRegistry, defineStreamAction } from "./custom-stream-actions"
import { RegistryError, TargetError } from "./errors"
import { FormControlRegistry } from "./forms"
import { parseExpoTurboDocument, parseTurboStreamFragment } from "./parser"
import { DocumentSession, SessionCommitError } from "./session"
import { DocumentStateScopes } from "./state"
import {
  dispatchGuardedTurboStreamElements,
  dispatchTurboStreamFragment,
  type StreamActionReport,
} from "./streams"
import { attributeValue, isElement, type ProtocolElement } from "./tree"

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
  test("applies ordered built-in actions and continues after an isolated action error", async () => {
    const document = session(
      '<Gallery id="gallery"><Items id="items"><Item id="old"/><Item id="keep"/></Items><Marker id="marker"/><Victim id="victim"><Old /></Victim></Gallery>',
    )
    const reports = (
      await dispatchTurboStreamFragment(
        document,
        `<turbo-stream action="append" target="items"><template><Item id="old"/><Item id="new"/></template></turbo-stream>
       <turbo-stream action="unknown" target="items"><template><Item /></template></turbo-stream>
       <turbo-stream action="before" target="marker"><template><Item id="before"/></template></turbo-stream>
       <turbo-stream action="after" target="marker"><template><Item id="after"/></template></turbo-stream>
       <turbo-stream action="update" target="victim"><template><Replacement id="replacement"/></template></turbo-stream>
       <turbo-stream action="remove" target="marker"><template><Ignored /></template><template><AlsoIgnored /></template></turbo-stream>`,
      )
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

  test("propagates committed session-finalization failures and stops later siblings", async () => {
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

  test("preserves update identity, replaces replace identity, and invalidates the stable snapshot", async () => {
    const document = session('<Gallery><Panel id="panel"><Old id="old"/></Panel></Gallery>')
    const original = document.tree.getElementById("panel")
    const originalSnapshot = document.getNodeSnapshot("id:panel")
    let notifications = 0
    document.subscribe("id:panel", () => {
      notifications += 1
    })

    await dispatchTurboStreamFragment(
      document,
      '<turbo-stream action="update" target="panel"><template><New id="child"/></template></turbo-stream>',
    )
    expect(document.tree.getElementById("panel")).toBe(original)
    const updatedSnapshot = document.getNodeSnapshot("id:panel")
    expect(updatedSnapshot).not.toBe(originalSnapshot)
    expect(updatedSnapshot?.identity).toBe(originalSnapshot?.identity)

    await dispatchTurboStreamFragment(
      document,
      '<turbo-stream action="replace" target="panel"><template><Panel id="panel"><Final /></Panel></template></turbo-stream>',
    )
    expect(document.tree.getElementById("panel")).not.toBe(original)
    expect(document.getNodeSnapshot("id:panel")?.identity).not.toBe(originalSnapshot?.identity)
    expect(document.tree.getElementById("old")).toBeUndefined()
    expect(notifications).toBe(2)
  })

  test("supports identity-safe outer and child morph only for exact targets", async () => {
    const document = session(
      '<Gallery><Panel id="replace"><Old id="old-replace"/></Panel><Panel id="update"><Old id="old-update"/></Panel><Later id="later"/></Gallery>',
    )
    const originalReplace = document.tree.getElementById("replace")
    const originalUpdate = document.tree.getElementById("update")
    const reports = (
      await dispatchTurboStreamFragment(
        document,
        `<turbo-stream action="replace" target="replace" method="morph"><template><Panel id="replace"><New id="new-replace"/></Panel></template></turbo-stream>
       <turbo-stream action="update" target="update" method="morph"><template><New id="new-update"/></template></turbo-stream>
       <turbo-stream action="remove" target="later"/>`,
      )
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

  test("ignores formatting whitespace around an outer morph root", async () => {
    const document = session('<Gallery><Panel id="probe"><Before /></Panel></Gallery>')
    const probe = document.tree.getElementById("probe")
    if (!probe) throw new Error("outer morph probe is missing")

    const report = (
      await dispatchTurboStreamFragment(
        document,
        `<turbo-stream action="replace" target="probe" method="morph"><template><Panel id="probe"><After /></Panel>
</template></turbo-stream>`,
      )
    ).actions[0]

    expect(report).toMatchObject({ appliedTargets: 1, matchedTargets: 1, status: "applied" })
    expect(document.tree.getElementById("probe")).toBe(probe)
    expect(document.tree.getElementById("probe")?.children[0]).toMatchObject({ tagName: "After" })
  })

  test("retains compatible outer morph ownership while reconciling attributes and children", async () => {
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

    const report = (
      await dispatchTurboStreamFragment(
        document,
        '<turbo-stream action="replace" target="form" method="morph"><template><DemoForm id="form" tone="accent"><DemoInput id="email" tone="accent"/><DemoText id="copy">After</DemoText></DemoForm></template></turbo-stream>',
      )
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

  test("retains compatible nested IDs and host form/state ownership during child morph", async () => {
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

    const report = (
      await dispatchTurboStreamFragment(
        document,
        '<turbo-stream action="update" target="form" method="morph"><template><DemoInput id="email" tone="accent"/><DemoText id="copy">After</DemoText><DemoError id="email-error">Required</DemoError></template></turbo-stream>',
      )
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

  test("retains matched permanent application subtrees while morphing surrounding siblings", async () => {
    const document = session(
      '<Gallery><DemoForm id="form" tone="before"><DemoInput id="editable" tone="before"/><DemoPanel id="permanent" data-turbo-permanent="" tone="kept"><DemoInput id="locked" value="current"/></DemoPanel><DemoText id="copy" tone="before"/></DemoForm></Gallery>',
    )
    const form = document.tree.getElementById("form")
    const permanent = document.tree.getElementById("permanent")
    const locked = document.tree.getElementById("locked")
    const editable = document.tree.getElementById("editable")
    if (!form || !permanent || !locked || !editable) throw new Error("morph fixture is missing")
    const permanentSnapshot = document.getNodeSnapshot(permanent.key)
    let disposals = 0
    document.registerDisposal(permanent.key, () => {
      disposals += 1
    })
    document.registerDisposal(locked.key, () => {
      disposals += 1
    })

    const childReport = (
      await dispatchTurboStreamFragment(
        document,
        '<turbo-stream action="update" target="form" method="morph"><template><DemoText id="copy" tone="after"/><DemoPanel id="permanent" data-turbo-permanent="" tone="incoming"><DemoInput id="locked" value="incoming"/></DemoPanel><DemoInput id="editable" tone="after"/></template></turbo-stream>',
      )
    ).actions[0]
    const afterChildMorph = document.tree.getElementById("form")
    const afterChildPermanent = document.tree.getElementById("permanent")
    const afterChildLocked = document.tree.getElementById("locked")
    const afterChildEditable = document.tree.getElementById("editable")
    if (!afterChildMorph || !afterChildPermanent || !afterChildLocked || !afterChildEditable) {
      throw new Error("child morph result is missing")
    }

    expect(childReport).toMatchObject({ appliedTargets: 1, status: "applied" })
    expect(afterChildPermanent).toBe(permanent)
    expect(afterChildLocked).toBe(locked)
    expect(afterChildEditable).toBe(editable)
    expect(document.getNodeSnapshot(permanent.key)?.identity).toBe(permanentSnapshot?.identity)
    expect(attributeValue(afterChildPermanent, "tone")).toBe("kept")
    expect(attributeValue(afterChildLocked, "value")).toBe("current")
    expect(attributeValue(afterChildEditable, "tone")).toBe("after")
    expect(childIds(afterChildMorph)).toEqual(["copy", "permanent", "editable"])

    const outerReport = (
      await dispatchTurboStreamFragment(
        document,
        '<turbo-stream action="replace" target="form" method="morph"><template><DemoForm id="form" tone="outer"><DemoPanel id="permanent" data-turbo-permanent="" tone="incoming-again"><DemoInput id="locked" value="incoming-again"/></DemoPanel><DemoInput id="editable" tone="outer"/><DemoText id="copy" tone="outer"/></DemoForm></template></turbo-stream>',
      )
    ).actions[0]
    const afterOuterMorph = document.tree.getElementById("form")
    const afterOuterPermanent = document.tree.getElementById("permanent")
    const afterOuterLocked = document.tree.getElementById("locked")
    if (!afterOuterMorph || !afterOuterPermanent || !afterOuterLocked) {
      throw new Error("outer morph result is missing")
    }

    expect(outerReport).toMatchObject({ appliedTargets: 1, status: "applied" })
    expect(afterOuterMorph).toBe(form)
    expect(afterOuterPermanent).toBe(permanent)
    expect(afterOuterLocked).toBe(locked)
    expect(attributeValue(afterOuterMorph, "tone")).toBe("outer")
    expect(attributeValue(afterOuterPermanent, "tone")).toBe("kept")
    expect(attributeValue(afterOuterLocked, "value")).toBe("current")
    expect(childIds(afterOuterMorph)).toEqual(["permanent", "editable", "copy"])
    expect(disposals).toBe(0)
  })

  test("reorders compatible IDs, retains anonymous ordinals, and remounts incompatible children", async () => {
    const document = session(
      '<Gallery><DemoForm id="form"><DemoInput id="first"/><DemoText>Unkeyed</DemoText><DemoInput id="second"/></DemoForm></Gallery>',
    )
    const first = document.tree.getElementById("first")
    const second = document.tree.getElementById("second")
    const unkeyed = document.tree.getElementById("form")?.children[1]
    if (!first || !second || !unkeyed) throw new Error("morph fixture is missing")
    const scope = new DocumentStateScopes(document).scopeFor(first.key, "form", { draft: "first" })

    await dispatchTurboStreamFragment(
      document,
      '<turbo-stream action="update" target="form" method="morph"><template><DemoInput id="second"/><DemoText>Replacement</DemoText><DemoText id="first"/></template></turbo-stream>',
    )
    const form = document.tree.getElementById("form")
    const currentFirst = document.tree.getElementById("first")
    const currentSecond = document.tree.getElementById("second")

    expect(currentSecond).toBe(second)
    expect(currentFirst).not.toBe(first)
    expect(scope.state.isDisposed).toBe(true)
    expect(form?.children[1]).toBe(unkeyed)
    expect(form?.children[1]?.kind === "element" && attributeValue(form.children[1], "tone")).toBe(
      undefined,
    )
    expect(form?.children.map((child) => child.key)).toEqual([second.key, unkeyed.key, first.key])
  })

  test("matches anonymous application siblings by exact shape ordinal", async () => {
    const document = session(
      '<Gallery><DemoPanel id="panel"><Row tone="first"><Label>One</Label></Row><Divider/><Row tone="second"><Label>Two</Label></Row></DemoPanel></Gallery>',
    )
    const panel = document.tree.getElementById("panel")
    const first = panel?.children[0]
    const divider = panel?.children[1]
    const second = panel?.children[2]
    const firstLabel = first?.kind === "element" ? first.children[0] : undefined
    const secondLabel = second?.kind === "element" ? second.children[0] : undefined
    if (!first || !divider || !second || !firstLabel || !secondLabel) {
      throw new Error("anonymous morph fixture is missing")
    }

    await dispatchTurboStreamFragment(
      document,
      '<turbo-stream action="update" target="panel" method="morph"><template><Row tone="updated-first"><Label>One updated</Label></Row><Row tone="updated-second"><Label>Two updated</Label></Row><Divider/></template></turbo-stream>',
    )

    const current = document.tree.getElementById("panel")
    const currentFirst = current?.children[0]
    const currentSecond = current?.children[1]
    const currentDivider = current?.children[2]
    expect(currentFirst).toBe(first)
    expect(currentSecond).toBe(second)
    expect(currentDivider).toBe(divider)
    expect(currentFirst?.kind === "element" && currentFirst.children[0]).toBe(firstLabel)
    expect(currentSecond?.kind === "element" && currentSecond.children[0]).toBe(secondLabel)
    expect(currentFirst?.kind === "element" && attributeValue(currentFirst, "tone")).toBe(
      "updated-first",
    )
    expect(currentSecond?.kind === "element" && attributeValue(currentSecond, "tone")).toBe(
      "updated-second",
    )
  })

  test("structurally replaces protocol-wrapper descendants during child morph", async () => {
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

    await dispatchTurboStreamFragment(
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

  test("remounts an incompatible replacement subtree without retaining its descendant IDs", async () => {
    const document = session(
      '<Gallery><DemoPanel id="panel"><Old id="root"><DemoGroup id="before"><DemoInput id="field"/></DemoGroup></Old></DemoPanel></Gallery>',
    )
    const root = document.tree.getElementById("root")
    const field = document.tree.getElementById("field")
    if (!root || !field) throw new Error("morph fixture is missing")
    const scope = new DocumentStateScopes(document).scopeFor(field.key, "form", { draft: "old" })

    const report = (
      await dispatchTurboStreamFragment(
        document,
        '<turbo-stream action="update" target="panel" method="morph"><template><New id="root"><DemoGroup id="after"><DemoInput id="field"/></DemoGroup></New></template></turbo-stream>',
      )
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

  test("rejects unsupported child morph boundaries atomically and continues later Streams", async () => {
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
        name: "unmatched active permanent node",
        stream:
          '<turbo-stream action="update" target="form" method="morph"><template><DemoGroup id="left"><DemoInput id="field"/></DemoGroup><DemoGroup id="right"/></template></turbo-stream>',
        permanent: true,
      },
      {
        name: "unmatched permanent payload node",
        stream:
          '<turbo-stream action="update" target="form" method="morph"><template><DemoGroup id="left"><DemoInput id="field"/></DemoGroup><DemoGroup id="right"/><DemoText id="incoming-permanent" data-turbo-permanent=""/></template></turbo-stream>',
      },
      {
        name: "permanent payload node without an id",
        stream:
          '<turbo-stream action="update" target="form" method="morph"><template><DemoGroup id="left"><DemoInput id="field"/></DemoGroup><DemoGroup id="right"/><DemoText data-turbo-permanent=""/></template></turbo-stream>',
      },
      {
        name: "nested permanent payload node",
        permanent: true,
        stream:
          '<turbo-stream action="update" target="form" method="morph"><template><DemoGroup id="left"><DemoInput id="field"/></DemoGroup><DemoGroup id="right"/><DemoText id="permanent" data-turbo-permanent=""><DemoText id="nested" data-turbo-permanent=""/></DemoText></template></turbo-stream>',
      },
      {
        name: "permanent protocol payload node",
        stream:
          '<turbo-stream action="update" target="form" method="morph"><template><turbo-frame id="incoming-frame" data-turbo-permanent=""><DemoText/></turbo-frame></template></turbo-stream>',
      },
      {
        name: "permanent Stream envelope",
        stream:
          '<turbo-stream action="update" target="form" method="morph" data-turbo-permanent=""><template><DemoGroup id="left"><DemoInput id="field"/></DemoGroup><DemoGroup id="right"/></template></turbo-stream>',
      },
      {
        name: "permanent template envelope",
        stream:
          '<turbo-stream action="update" target="form" method="morph"><template data-turbo-permanent=""><DemoGroup id="left"><DemoInput id="field"/></DemoGroup><DemoGroup id="right"/></template></turbo-stream>',
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
      const reports = (
        await dispatchTurboStreamFragment(
          document,
          `${fixtureCase.stream}<turbo-stream action="remove" target="later"/>`,
        )
      ).actions

      expect(reports[0]?.status, fixtureCase.name).toBe("error")
      expect(document.tree.getElementById("form")).toBe(form)
      expect(document.getNodeSnapshot("id:form"), fixtureCase.name).toBe(before)
      expect(document.revision, fixtureCase.name).toBe(1)
      expect(document.tree.getElementById("later"), fixtureCase.name).toBeUndefined()
    }
  })

  test("rejects omitted permanent ancestor paths before child morph commits", async () => {
    for (const wrapper of [
      '<DemoGroup id="path"><DemoText id="permanent" data-turbo-permanent=""/></DemoGroup>',
      '<DemoGroup><DemoText id="permanent" data-turbo-permanent=""/></DemoGroup>',
    ]) {
      const document = session(
        `<Gallery><DemoForm id="form">${wrapper}</DemoForm><Later id="later"/></Gallery>`,
      )
      const form = document.tree.getElementById("form")
      const permanent = document.tree.getElementById("permanent")
      if (!form || !permanent) throw new Error("permanent fixture is missing")
      const before = document.getNodeSnapshot(form.key)

      const reports = (
        await dispatchTurboStreamFragment(
          document,
          '<turbo-stream action="update" target="form" method="morph"><template><DemoText id="next"/></template></turbo-stream><turbo-stream action="remove" target="later"/>',
        )
      ).actions

      expect(reports.map((report) => report.status)).toEqual(["error", "applied"])
      expect(document.tree.getElementById("form")).toBe(form)
      expect(document.tree.getElementById("permanent")).toBe(permanent)
      expect(document.getNodeSnapshot(form.key)).toBe(before)
      expect(document.tree.getElementById("later")).toBeUndefined()
    }
  })

  test("rejects unsupported outer morph boundaries atomically and continues later Streams", async () => {
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
        name: "permanent replacement root",
        stream:
          '<turbo-stream action="replace" target="form" method="morph"><template><DemoForm id="form" data-turbo-permanent=""><DemoGroup id="left"><DemoInput id="field"/></DemoGroup><DemoGroup id="right"/></DemoForm></template></turbo-stream>',
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
      const reports = (
        await dispatchTurboStreamFragment(
          document,
          `${fixtureCase.stream}<turbo-stream action="remove" target="later"/>`,
        )
      ).actions

      expect(reports[0]?.status, fixtureCase.name).toBe("error")
      expect(document.tree.getElementById("form")).toBe(form)
      expect(document.getNodeSnapshot("id:form"), fixtureCase.name).toBe(before)
      expect(document.revision, fixtureCase.name).toBe(1)
      expect(document.tree.getElementById("later"), fixtureCase.name).toBeUndefined()
    }
  })

  test("uses plain structural semantics for every non-morph method value", async () => {
    const document = session(
      '<Gallery><Panel id="replace"><Old /></Panel><Panel id="update"><Old /></Panel></Gallery>',
    )
    const originalUpdate = document.tree.getElementById("update")
    const reports = (
      await dispatchTurboStreamFragment(
        document,
        `<turbo-stream action="replace" target="replace" method="MORPH"><template><Panel id="replace"><Final id="replaced"/></Panel></template></turbo-stream>
       <turbo-stream action="update" target="update" method=""><template><Final id="updated"/></template></turbo-stream>`,
      )
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

  test("rejects duplicate payload ids before compound collision mutations", async () => {
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

      const reports = (
        await dispatchTurboStreamFragment(
          document,
          `<turbo-stream action="${action}" target="${target}"><template><Item id="same"/><Item id="same"/></template></turbo-stream>
         <turbo-stream action="remove" target="later"/>`,
        )
      ).actions

      expect(reports.map((report) => report.status)).toEqual(["error", "applied"])
      expect(reports[0]?.error?.message).toContain("declared more than once")
      expect(document.tree.getElementById("same")).toBe(original)
      expect(document.getNodeSnapshot("id:same")).toBe(snapshot)
      expect(document.revision).toBe(1)
      expect(disposed).toEqual([])
    }
  })

  test("clones selector payload independently and gives target precedence over targets", async () => {
    const document = session(
      '<Gallery><List id="first" class="group"/><List id="second" class="group"/></Gallery>',
    )
    const multi = (
      await dispatchTurboStreamFragment(
        document,
        '<turbo-stream action="append" targets=".group"><template><Item /></template></turbo-stream>',
      )
    ).actions[0]
    const firstChild = document.tree.getElementById("first")?.children.find(isElement)
    const secondChild = document.tree.getElementById("second")?.children.find(isElement)

    expect(multi).toMatchObject({ appliedTargets: 2, matchedTargets: 2, status: "applied" })
    expect(firstChild).toBeDefined()
    expect(secondChild).toBeDefined()
    expect(firstChild).not.toBe(secondChild)
    expect(firstChild?.key).not.toBe(secondChild?.key)

    const precedence = (
      await dispatchTurboStreamFragment(
        document,
        '<turbo-stream action="append" target="first" targets=".group"><template><Chosen /></template></turbo-stream>',
      )
    ).actions[0]
    expect(precedence).toMatchObject({ appliedTargets: 1, matchedTargets: 1 })
    expect(document.tree.getElementById("first")?.children.filter(isElement)).toHaveLength(2)
    expect(document.tree.getElementById("second")?.children.filter(isElement)).toHaveLength(1)

    const duplicateIds = (
      await dispatchTurboStreamFragment(
        document,
        '<turbo-stream action="append" targets=".group"><template><Item id="duplicated" /></template></turbo-stream>',
      )
    ).actions[0]
    expect(duplicateIds?.status).toBe("error")
    expect(document.tree.getElementById("duplicated")).toBeUndefined()
  })

  test("matches absent-template and stale-target no-op semantics", async () => {
    const document = session(
      '<Gallery><List id="append"/><List id="update"><Old /></List><List id="replace"/></Gallery>',
    )
    const reports = (
      await dispatchTurboStreamFragment(
        document,
        `<turbo-stream action="append" target="append"></turbo-stream>
       <turbo-stream action="update" target="update"></turbo-stream>
       <turbo-stream action="replace" target="replace"></turbo-stream>
       <turbo-stream action="remove" target="missing"></turbo-stream>`,
      )
    ).actions

    expect(reports.map((report) => report.status)).toEqual(["noop", "applied", "applied", "noop"])
    expect(document.tree.getElementById("append")?.children).toHaveLength(0)
    expect(document.tree.getElementById("update")?.children).toHaveLength(0)
    expect(document.tree.getElementById("replace")).toBeUndefined()
  })

  test("allows sibling actions to reuse a payload id while the active document stays unique", async () => {
    const document = session('<Gallery><List id="list"/></Gallery>')
    const reports = (
      await dispatchTurboStreamFragment(
        document,
        `<turbo-stream action="append" target="list"><template><Item id="same" /></template></turbo-stream>
       <turbo-stream action="replace" target="same"><template><Item id="same"><Final /></Item></template></turbo-stream>`,
      )
    ).actions

    expect(reports.map((report) => report.status)).toEqual(["applied", "applied"])
    expect(document.tree.getElementById("same")?.children.filter(isElement)).toHaveLength(1)
  })

  test("matches first-template and relative sibling-collision behavior", async () => {
    const document = session('<Gallery><Item id="same"/><Item id="other"/></Gallery>')
    const reports = (
      await dispatchTurboStreamFragment(
        document,
        `<turbo-stream action="before" target="same"><template><Replacement id="same"/></template></turbo-stream>
       <turbo-stream action="append" target="other"><NotTemplate/><template><Ignored /></template></turbo-stream>`,
      )
    ).actions

    expect(reports.map((report) => report.status)).toEqual(["applied", "error"])
    expect(document.tree.getElementById("same")).toBeUndefined()
    expect(document.tree.getElementById("other")?.children).toHaveLength(0)
  })

  test("reports invalid selectors and duplicate ids without poisoning later siblings", async () => {
    const document = session(
      '<Gallery><Node id="existing"/><List id="list"/><Node id="remove-me"/></Gallery>',
    )
    const errors: StreamActionReport[] = []
    const reports = (
      await dispatchTurboStreamFragment(
        document,
        `<turbo-stream action="append" targets="["><template><Item /></template></turbo-stream>
       <turbo-stream action="append" target="list"><template><Node id="existing"/></template></turbo-stream>
       <turbo-stream action="remove" target="remove-me"></turbo-stream>`,
        { onActionError: (report) => errors.push(report) },
      )
    ).actions

    expect(reports.map((report) => report.status)).toEqual(["error", "error", "applied"])
    expect(reports[0]?.error).toBeInstanceOf(TargetError)
    expect(errors).toHaveLength(2)
    expect(document.tree.getElementById("list")?.children).toHaveLength(0)
    expect(document.tree.getElementById("remove-me")).toBeUndefined()
  })

  test("dispatches registered custom actions with typed params, targets, and template payload", async () => {
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

    const report = (
      await dispatchTurboStreamFragment(
        document,
        '<turbo-stream action="announce" target="notice" data-message="Ready" data-priority="2"><template><Badge/></template></turbo-stream>',
        { customActions },
      )
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

  test("isolates custom action validation and handler failures from later siblings", async () => {
    const document = session('<Gallery><Notice id="notice"/><Victim id="victim"/></Gallery>')
    const announce = defineStreamAction({
      action: "announce",
      handler: ({ params }) => {
        if (params.message === "explode") throw new Error("host action failed")
      },
      schema: z.object({ message: z.string().min(1) }),
    })
    const reports = (
      await dispatchTurboStreamFragment(
        document,
        `<turbo-stream action="announce" data-message="" />
       <turbo-stream action="announce" data-message="ok" data-unknown="rejected" />
       <turbo-stream action="announce" data-message="explode" />
       <turbo-stream action="remove" target="victim" />`,
        { customActions: createStreamActionRegistry(announce) },
      )
    ).actions

    expect(reports.map((report) => report.status)).toEqual(["error", "error", "error", "applied"])
    expect(reports.slice(0, 3).every((report) => report.error?.code === "action")).toBe(true)
    expect(document.tree.getElementById("victim")).toBeUndefined()
  })

  test("awaits asynchronous custom actions before dispatching the next sibling", async () => {
    const document = session('<Gallery><Victim id="victim"/></Gallery>')
    const order: string[] = []
    const announce = defineStreamAction({
      action: "announce",
      async handler({ params }) {
        order.push(`start:${params.message}`)
        await Promise.resolve()
        order.push(`end:${params.message}`)
      },
      schema: z.object({ message: z.string() }),
    })

    const report = await dispatchTurboStreamFragment(
      document,
      `<turbo-stream action="announce" data-message="first" />
       <turbo-stream action="announce" data-message="second" />
       <turbo-stream action="remove" target="victim" />`,
      { customActions: createStreamActionRegistry(announce) },
    )

    expect(report.actions.map((action) => action.status)).toEqual(["applied", "applied", "applied"])
    expect(order).toEqual(["start:first", "end:first", "start:second", "end:second"])
    expect(document.tree.getElementById("victim")).toBeUndefined()
  })

  test("cancels an awaited custom action that loses ownership before mutation", async () => {
    const document = session('<Gallery><Victim id="victim"/></Gallery>')
    let active = true
    const action = defineStreamAction({
      action: "wait",
      async handler() {
        await Promise.resolve()
        active = false
      },
      schema: z.object({}),
    })
    const streams = parseTurboStreamFragment(
      '<turbo-stream action="wait" target="victim" />',
    ).document.children.filter(
      (node): node is ProtocolElement => isElement(node) && node.kind === "stream",
    )

    const report = await dispatchGuardedTurboStreamElements(
      document,
      streams,
      { customActions: createStreamActionRegistry(action) },
      { shouldContinue: () => active },
    )

    expect(report).toMatchObject({ interrupted: true })
    expect(report.actions.map((entry) => entry.status)).toEqual(["canceled"])
    expect(document.tree.getElementById("victim")).toBeDefined()
  })

  test("rejects reserved and duplicate custom action ownership", async () => {
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
