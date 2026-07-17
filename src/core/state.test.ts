import { describe, expect, test } from "bun:test"

import { StateError } from "./errors"
import { parseExpoTurboDocument } from "./parser"
import { DocumentSession } from "./session"
import { DocumentStateScopes, DocumentStateStore, type StateSnapshot } from "./state"

describe("document state store", () => {
  test("keeps snapshots stable and notifies only the changed key", () => {
    const state = new DocumentStateStore({ count: 1, other: "ready" })
    const countBefore = state.getSnapshot<number>("count")
    const otherBefore = state.getSnapshot<string>("other")
    let countNotifications = 0
    let otherNotifications = 0
    state.subscribe("count", () => {
      countNotifications += 1
    })
    state.subscribe("other", () => {
      otherNotifications += 1
    })

    state.set("count", 2)
    expect(state.getSnapshot<number>("count")).not.toBe(countBefore)
    expect(state.getSnapshot<number>("count")).toMatchObject({ value: 2 })
    expect(state.getSnapshot<string>("other")).toBe(otherBefore)
    expect({ countNotifications, otherNotifications }).toEqual({
      countNotifications: 1,
      otherNotifications: 0,
    })

    const countAfter = state.getSnapshot<number>("count")
    state.set("count", 2)
    expect(state.getSnapshot<number>("count")).toBe(countAfter)
    expect(countNotifications).toBe(1)

    state.delete("count")
    expect(state.getSnapshot("count").value).toBeUndefined()
    expect(countNotifications).toBe(2)
  })

  test("publishes one terminal disposed snapshot and rejects later access", () => {
    const state = new DocumentStateStore({ status: "active" })
    const snapshots: StateSnapshot[] = []
    state.subscribe("status", () => snapshots.push(state.getSnapshot("status")))

    state.dispose()
    state.dispose()

    expect(state.isDisposed).toBe(true)
    expect(snapshots).toHaveLength(1)
    const disposedSnapshot = snapshots[0]
    expect(disposedSnapshot).toBeDefined()
    if (!disposedSnapshot) throw new Error("disposed snapshot was not published")
    expect(disposedSnapshot).toMatchObject({ disposed: true, value: undefined })
    expect(state.getSnapshot("status")).toBe(disposedSnapshot)
    expect(() => state.get("status")).toThrow(StateError)
    expect(() => state.set("status", "late")).toThrow(StateError)
    expect(() => state.subscribe("status", () => undefined)).toThrow(StateError)
  })

  test("fails closed for blank keys", () => {
    const state = new DocumentStateStore()
    expect(() => state.get(" ")).toThrow(StateError)
    expect(() => state.getSnapshot("")).toThrow(StateError)
  })
})

describe("node state scopes", () => {
  test("preserves a Frame scope across child updates and disposes it on replacement", () => {
    const session = new DocumentSession(
      parseExpoTurboDocument(
        '<Gallery><turbo-frame id="frame"><DemoText>Before</DemoText></turbo-frame></Gallery>',
      ),
    )
    const scopes = new DocumentStateScopes(session)
    const frame = session.tree.getElementById("frame")
    if (!frame) throw new Error("frame fixture is missing")
    const scope = scopes.scopeFor(frame.key, "frame", { draft: "kept" })

    const response = parseExpoTurboDocument(
      '<turbo-frame id="frame"><DemoText>After</DemoText></turbo-frame>',
    ).getElementById("frame")
    if (!response) throw new Error("response fixture is missing")
    session.mutate((tree) => tree.replaceChildrenWithClones(frame, response.children))

    expect(scopes.scopeFor(frame.key, "frame")).toBe(scope)
    expect(scope.state.get("draft")).toBe("kept")
    expect(scope.state.isDisposed).toBe(false)

    session.mutate((tree) => tree.replaceNodeWithClones(frame, [response]))
    expect(scope.state.isDisposed).toBe(true)

    const replacement = session.tree.getElementById("frame")
    if (!replacement) throw new Error("replacement fixture is missing")
    const replacementScope = scopes.scopeFor(replacement.key, "frame")
    expect(replacementScope).not.toBe(scope)
    expect(replacementScope.state.get("draft")).toBeUndefined()
  })

  test("supports form scopes, explicit disposal, and registry disposal", () => {
    const session = new DocumentSession(
      parseExpoTurboDocument('<Gallery><DemoForm id="form"/><DemoForm id="other"/></Gallery>'),
    )
    const scopes = new DocumentStateScopes(session)
    const form = session.tree.getElementById("form")
    const other = session.tree.getElementById("other")
    if (!form || !other) throw new Error("form fixtures are missing")

    const formScope = scopes.scopeFor(form.key, "form", { dirty: true })
    expect(() => scopes.scopeFor(form.key, "frame")).toThrow(StateError)
    session.mutate((tree) => tree.removeNode(form))
    expect(formScope.state.isDisposed).toBe(true)

    const otherScope = scopes.scopeFor(other.key, "form")
    scopes.disposeScope(other.key)
    expect(otherScope.state.isDisposed).toBe(true)
    const recreated = scopes.scopeFor(other.key, "form")
    scopes.dispose()
    scopes.dispose()
    expect(recreated.state.isDisposed).toBe(true)
    expect(scopes.isDisposed).toBe(true)
    expect(() => scopes.scopeFor(other.key, "form")).toThrow(StateError)
  })

  test("fails closed for nodes outside the active document", () => {
    const session = new DocumentSession(parseExpoTurboDocument("<Gallery/>"))
    const scopes = new DocumentStateScopes(session)
    expect(() => scopes.scopeFor("missing", "form")).toThrow(StateError)
    expect(() => scopes.disposeScope("missing")).toThrow(StateError)
  })
})
