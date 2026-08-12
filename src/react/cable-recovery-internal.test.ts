import { describe, expect, test } from "bun:test"

import type { ClockAdapter } from "../adapters/index.js"
import { CableDocumentRecovery } from "./cable-recovery-internal.js"

const BASE = "https://example.test/document"
const OTHER = "https://example.test/next"

class ManualClock implements ClockAdapter {
  private next = 1
  readonly timers = new Map<number, () => void>()

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number)
  }

  now(): number {
    return 0
  }

  setTimeout(callback: () => void): unknown {
    const handle = this.next++
    this.timers.set(handle, callback)
    return handle
  }

  /** Fires every currently scheduled timer. */
  fire(): void {
    for (const [handle, callback] of [...this.timers]) {
      this.timers.delete(handle)
      callback()
    }
  }
}

/**
 * A visit controller and session reduced to exactly what the invariant reads:
 * whether a visit is running, what document is active, and how many times it
 * has been committed.
 */
function harness(options: { readonly refuse?: boolean; readonly reject?: boolean } = {}) {
  const listeners = new Set<() => void>()
  const treeListeners = new Set<() => void>()
  const refreshed: string[] = []
  const errors: Error[] = []
  let status: "canceled" | "completed" | "failed" | "initialized" | "started" = "initialized"
  let url = BASE
  let generation = 1

  const notify = () => {
    for (const listener of [...listeners]) listener()
    for (const listener of [...treeListeners]) listener()
  }

  const session = {
    subscribeTreeState(listener: () => void) {
      treeListeners.add(listener)
      return () => treeListeners.delete(listener)
    },
    get tree() {
      return { document: { url } }
    },
    get treeGeneration() {
      return generation
    },
  }

  const visits = {
    refreshCurrent: async (target: string) => {
      refreshed.push(target)
      if (options.reject) throw new Error("recovery transport refused")
      if (options.refuse) return undefined
      // A real refresh commits the document it targeted.
      generation += 1
      url = target
      status = "completed"
      notify()
      return { status: "committed" as const }
    },
    get state() {
      return { status }
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }

  const clock = new ManualClock()
  const recovery = new CableDocumentRecovery(session as never, visits as never, clock, {
    debounceMs: 0,
    onError: (error) => errors.push(error),
  })

  return {
    clock,
    errors,
    recovery,
    refreshed,
    /** A visit that ends the way the argument says, without committing. */
    settleVisit(next: "canceled" | "completed" | "failed", committedUrl?: string) {
      status = next
      if (next === "completed" && committedUrl !== undefined) {
        generation += 1
        url = committedUrl
      }
      notify()
    },
    startVisit() {
      status = "started"
      notify()
    },
  }
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe("Cable document recovery", () => {
  test("stays armed when a navigation cancels the recovery and then fails", async () => {
    // The round-5 sequence: the recovery GET is dispatched and then cancelled by
    // a navigation, which returns a result rather than `undefined`, and the
    // navigation itself then fails. Nothing re-fetched the document.
    const h = harness({ refuse: true })
    h.recovery.request({ baseUrl: BASE })
    h.clock.fire()
    await flush()

    expect(h.refreshed).toEqual([BASE])
    h.startVisit()
    h.settleVisit("failed")
    await flush()

    expect(h.recovery.armed).toBe(true)
    h.clock.fire()
    await flush()
    expect(h.refreshed).toEqual([BASE, BASE])
  })

  test("drops only once the document has actually been re-fetched", async () => {
    const h = harness()
    h.recovery.request({ baseUrl: BASE })
    expect(h.recovery.armed).toBe(true)

    h.clock.fire()
    await flush()

    // The refresh committed the target document, which is the whole obligation.
    expect(h.refreshed).toEqual([BASE])
    expect(h.recovery.armed).toBe(false)
  })

  test("drops when the app has moved to a different document", async () => {
    const h = harness({ refuse: true })
    h.recovery.request({ baseUrl: BASE })
    h.startVisit()
    h.settleVisit("completed", OTHER)
    await flush()

    // That document was fetched fresh with its own subscriptions, so there is
    // nothing left to recover. Asserted on `armed`, not on request count: a
    // retained recovery would be invisible in the requests because the URL
    // guard suppresses the GET.
    expect(h.recovery.armed).toBe(false)
    h.clock.fire()
    await flush()
    expect(h.refreshed).toEqual([])
  })

  test("stays armed through a visit that fails without committing", async () => {
    const h = harness({ refuse: true })
    h.recovery.request({ baseUrl: BASE })
    h.startVisit()
    h.settleVisit("canceled")
    await flush()

    expect(h.recovery.armed).toBe(true)
  })

  test("gives up loudly rather than retrying a failing recovery forever", async () => {
    const h = harness({ reject: true })
    h.recovery.request({ baseUrl: BASE })

    for (let attempt = 0; attempt < 10; attempt += 1) {
      h.clock.fire()
      await flush()
    }

    // Bounded: three attempts, each reported, then one final report and done.
    expect(h.refreshed).toHaveLength(3)
    expect(h.recovery.armed).toBe(false)
    expect(h.errors).toHaveLength(4)
    expect(h.errors.at(-1)?.message).toContain("gave up")
  })

  test("coalesces rapid reconnects for one document into a single obligation", async () => {
    const h = harness()
    h.recovery.request({ baseUrl: BASE })
    h.recovery.request({ baseUrl: BASE })
    h.recovery.request({ baseUrl: BASE })
    h.clock.fire()
    await flush()

    expect(h.refreshed).toEqual([BASE])
  })

  test("cancels everything on disposal", async () => {
    const h = harness({ refuse: true })
    h.recovery.request({ baseUrl: BASE })
    h.recovery.dispose()
    h.clock.fire()
    await flush()

    expect(h.refreshed).toEqual([])
    expect(h.recovery.armed).toBe(false)
  })
})
