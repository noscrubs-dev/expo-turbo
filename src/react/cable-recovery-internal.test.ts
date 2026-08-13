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

  fire(): void {
    for (const [handle, callback] of [...this.timers]) {
      this.timers.delete(handle)
      callback()
    }
  }
}

interface HarnessOptions {
  /** Serve refreshes the way a snapshot restoration would: no request id. */
  readonly cached?: boolean
  readonly reject?: boolean
}

/**
 * A visit controller reduced to what the recovery reads. `refreshCurrent`
 * refuses whenever the requested document is not the active one, exactly as the
 * real controller does.
 */
function harness(options: HarnessOptions = {}) {
  const listeners = new Set<() => void>()
  const refreshed: string[] = []
  const errors: Error[] = []
  let status: "canceled" | "completed" | "failed" | "initialized" | "started" = "initialized"
  let active = BASE
  let networkId = 0

  const notify = () => {
    for (const listener of [...listeners]) listener()
  }

  const visits = {
    refreshCurrent: async (target: string) => {
      refreshed.push(target)
      if (options.reject) throw new Error("recovery transport refused")
      if (active !== target) return undefined
      if (options.cached) {
        // A snapshot restoration: the tree changed and no request was made, so
        // the report carries no request id. `requestedUrl` is included even
        // though the real restore report omits it, so that the request id is
        // the only thing separating this from a network commit — otherwise the
        // test would pass on the URL check and prove nothing about the
        // discriminator.
        status = "completed"
        notify()
        return { requestedUrl: target, status: "committed" as const, url: target }
      }
      networkId += 1
      status = "completed"
      notify()
      return {
        classification: "success" as const,
        redirected: false,
        requestId: `network-${networkId}`,
        requestedUrl: target,
        responseStatus: 200,
        status: "committed" as const,
        url: target,
      }
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
  const recovery = new CableDocumentRecovery(visits as never, clock, {
    attempts: 3,
    backoffFactor: 2,
    debounceMs: 1,
    onError: (error) => errors.push(error),
  })

  return {
    clock,
    errors,
    recovery,
    refreshed,
    goTo(url: string) {
      active = url
      status = "completed"
      notify()
    },
    settleVisit(next: "canceled" | "failed") {
      status = next
      notify()
    },
    startVisit() {
      status = "started"
      notify()
    },
  }
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

async function tick(h: ReturnType<typeof harness>, times = 1): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    h.clock.fire()
    await flush()
  }
}

describe("Cable document recovery", () => {
  test("discharges on a network refresh of the target", async () => {
    const h = harness()
    h.recovery.request({ baseUrl: BASE })
    expect(h.recovery.armed).toBe(true)

    await tick(h)

    expect(h.refreshed).toEqual([BASE])
    expect(h.recovery.armed).toBe(false)
  })

  test("does not accept a cache-served commit as a re-fetch", async () => {
    // A snapshot preview or restoration changes the tree without asking the
    // server, so it cannot discharge an obligation that exists precisely
    // because the server has news we missed.
    const h = harness({ cached: true })
    h.recovery.request({ baseUrl: BASE })

    await tick(h)

    expect(h.refreshed).toEqual([BASE])
    expect(h.recovery.armed).toBe(true)
  })

  test("stays armed when a navigation cancels the recovery and then fails", async () => {
    const h = harness()
    h.recovery.request({ baseUrl: BASE })
    h.startVisit()
    await tick(h)

    // A visit is in flight, so nothing was even attempted.
    expect(h.refreshed).toEqual([])
    h.settleVisit("failed")
    await flush()
    expect(h.recovery.armed).toBe(true)

    await tick(h)
    expect(h.refreshed).toEqual([BASE])
    expect(h.recovery.armed).toBe(false)
  })

  test("suspends rather than discharging while another document is active", async () => {
    const h = harness()
    h.recovery.request({ baseUrl: BASE })
    h.goTo(OTHER)
    await tick(h, 3)

    // Navigating away must not end the obligation: coming back can be served
    // from a snapshot, which would restore the very content that is stale.
    expect(h.recovery.armed).toBe(true)
  })

  test("resumes and recovers when the original document becomes active again", async () => {
    const h = harness()
    h.recovery.request({ baseUrl: BASE })
    h.goTo(OTHER)
    await tick(h, 2)
    expect(h.recovery.armed).toBe(true)

    h.goTo(BASE)
    await tick(h, 2)

    expect(h.refreshed.at(-1)).toBe(BASE)
    expect(h.recovery.armed).toBe(false)
  })

  test("does not spend the attempt budget on refusals", async () => {
    const h = harness()
    h.recovery.request({ baseUrl: BASE })
    h.goTo(OTHER)
    // Far more cycles than the three-attempt budget.
    await tick(h, 10)
    h.goTo(BASE)
    await tick(h, 2)

    // A refusal is not a failed attempt, so returning still recovers.
    expect(h.recovery.armed).toBe(false)
    expect(h.errors).toEqual([])
  })

  test("gives up after bounded backoff with exactly one report", async () => {
    const h = harness({ reject: true })
    h.recovery.request({ baseUrl: BASE })

    await tick(h, 12)

    expect(h.refreshed).toHaveLength(3)
    expect(h.recovery.armed).toBe(false)
    // One report per obligation, not one per attempt.
    expect(h.errors).toHaveLength(1)
    expect(h.errors[0]?.message).toContain("after 3 attempts")
  })

  test("coalesces rapid reconnects into one obligation", async () => {
    const h = harness()
    h.recovery.request({ baseUrl: BASE })
    h.recovery.request({ baseUrl: BASE })
    h.recovery.request({ baseUrl: BASE })

    await tick(h)

    expect(h.refreshed).toEqual([BASE])
  })

  test("cancels everything on disposal", async () => {
    const h = harness()
    h.recovery.request({ baseUrl: BASE })
    h.recovery.dispose()

    await tick(h, 3)

    expect(h.refreshed).toEqual([])
    expect(h.recovery.armed).toBe(false)
  })
})
