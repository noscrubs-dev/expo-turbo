import { describe, expect, test } from "bun:test"

import { StateError } from "./errors"
import { DocumentStateStore, type StateSnapshot } from "./state"

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
