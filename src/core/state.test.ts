import { describe, expect, test } from "bun:test"

import { StateError } from "./errors"
import { parseExpoTurboDocument } from "./parser"
import { DocumentSession } from "./session"
import {
  DocumentStateScopes,
  DocumentStateStore,
  resolveStateReferences,
  type StateReferenceInput,
  type StateSnapshot,
} from "./state"

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
    expect(() => state.subscribe("status", () => undefined)).not.toThrow()
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

describe("state references", () => {
  test("resolves exact values and scalar interpolation through nested arrays and objects", () => {
    const exact = Object.freeze({ enabled: true, values: [1, 2] })
    const state = new DocumentStateStore({
      count: 3,
      exact,
      name: "Ada",
      ready: true,
    })

    const resolved = resolveStateReferences(
      {
        exact: { $state: "exact" },
        nested: ["Hello {{state:name}}", { copy: "{{state:count}}/{{state:ready}}" }],
      },
      state,
    ) as { exact: unknown; nested: unknown[] }

    expect(resolved.exact).toBe(exact)
    expect(resolved.nested).toEqual(["Hello Ada", { copy: "3/true" }])

    const tuple = ["{{state:name}}", { $state: "count" }] satisfies StateReferenceInput<
      readonly [string, number]
    >
    expect(resolveStateReferences(tuple, state)).toEqual(["Ada", 3])
    // @ts-expect-error State-reference inputs preserve the source tuple's arity.
    const oversizedTuple: StateReferenceInput<readonly [string, number]> = ["Ada", 3, 4]
    expect(oversizedTuple).toHaveLength(3)
  })

  test("keeps resolution confined to the selected store", () => {
    const documentState = new DocumentStateStore({ value: "document" })
    const scopedState = new DocumentStateStore({ value: "form" })

    expect(resolveStateReferences({ $state: "value" }, documentState)).toBe("document")
    expect(resolveStateReferences({ $state: "value" }, scopedState)).toBe("form")
  })

  test("rejects missing, malformed, ambiguous, structured, cyclic, and excessive references", () => {
    const state = new DocumentStateStore({ structured: { private: true } })
    expect(() => resolveStateReferences({ $state: "missing" }, state)).toThrow(StateError)
    expect(() => resolveStateReferences("{{state:missing", state)).toThrow(StateError)
    expect(() => resolveStateReferences("{{state}}", state)).toThrow(StateError)
    expect(() => resolveStateReferences("{{state key}}", state)).toThrow(StateError)
    expect(() => resolveStateReferences("{{state.key}}", state)).toThrow(StateError)
    expect(() => resolveStateReferences({ $state: "structured", extra: true }, state)).toThrow(
      StateError,
    )
    expect(() => resolveStateReferences("{{state:structured}}", state)).toThrow(StateError)

    const cyclic: unknown[] = []
    cyclic.push(cyclic)
    expect(() => resolveStateReferences(cyclic, state)).toThrow(StateError)
    expect(() => resolveStateReferences([["deep"]], state, { maxDepth: 1 })).toThrow(StateError)
    expect(() => resolveStateReferences({}, state, { maxDepth: 0 })).toThrow(StateError)
  })

  test("rejects prototype and hidden-property exact-reference lookalikes", () => {
    const state = new DocumentStateStore({ safe: "resolved" })
    class ReferenceLookalike {
      readonly $state = "safe"
    }
    const arrayLookalike: unknown[] & { $state?: string } = []
    arrayLookalike.$state = "safe"
    const hiddenLookalike = { $state: "safe" }
    Object.defineProperty(hiddenLookalike, "hidden", { value: true })
    const symbolLookalike = { $state: "safe", [Symbol("hidden")]: true }
    const accessorLookalike = Object.defineProperty({}, "$state", {
      enumerable: true,
      get: () => {
        throw new Error("accessor must not run")
      },
    })

    expect(() => resolveStateReferences(new ReferenceLookalike(), state)).toThrow(StateError)
    expect(() => resolveStateReferences(arrayLookalike, state)).toThrow(StateError)
    expect(() => resolveStateReferences(hiddenLookalike, state)).toThrow(StateError)
    expect(() => resolveStateReferences(symbolLookalike, state)).toThrow(StateError)
    expect(() => resolveStateReferences(accessorLookalike, state)).toThrow(StateError)
  })
})
