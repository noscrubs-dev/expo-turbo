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
  /** Which document the visit controller considers active. */
  readonly active?: string
  readonly attempts?: number
  /** Serve refreshes the way a snapshot restoration would: no request id. */
  readonly cached?: boolean
  readonly documents?: number
  /** Refreshes of these URLs reject, whether or not the document is active. */
  readonly failFor?: readonly string[]
  readonly freshness?: { claim(url: string): void; release(url: string): void }
  /**
   * Refreshes of these URLs stay in flight until the test settles them by hand,
   * which is the only way to interleave one document's result with another
   * document's arming.
   */
  readonly hold?: readonly string[]
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
  const held = new Set(options.hold ?? [])
  const failing = new Set(options.failFor ?? [])
  const pending: Array<{
    reject: (error: Error) => void
    resolve: (value: unknown) => void
    url: string
  }> = []
  let status: "canceled" | "completed" | "failed" | "initialized" | "started" = "initialized"
  let active = options.active ?? BASE
  let networkId = 0
  let notifications = 0

  const notify = () => {
    notifications += 1
    for (const listener of [...listeners]) listener()
  }

  const networkReport = (target: string) => {
    networkId += 1
    return {
      classification: "success" as const,
      redirected: false,
      requestId: `network-${networkId}`,
      requestedUrl: target,
      responseStatus: 200,
      status: "committed" as const,
      url: target,
    }
  }

  // A snapshot restoration: the tree changed and no request was made, so the
  // report carries no request id. `requestedUrl` is included even though the
  // real restore report omits it, so that the request id is the only thing
  // separating this from a network commit — otherwise the test would pass on
  // the URL check and prove nothing about the discriminator.
  const cachedReport = (target: string) => ({
    requestedUrl: target,
    status: "committed" as const,
    url: target,
  })

  const visits = {
    refreshCurrent: (target: string): Promise<unknown> => {
      refreshed.push(target)
      if (held.has(target)) {
        return new Promise((resolve, reject) => {
          pending.push({ reject, resolve, url: target })
        })
      }
      if (options.reject || failing.has(target)) {
        return Promise.reject(new Error("recovery transport refused"))
      }
      if (active !== target) return Promise.resolve(undefined)
      status = "completed"
      notify()
      return Promise.resolve(options.cached ? cachedReport(target) : networkReport(target))
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
    attempts: options.attempts ?? 3,
    backoffFactor: 2,
    debounceMs: 1,
    ...(options.documents === undefined ? {} : { documents: options.documents }),
    ...(options.freshness ? { freshness: options.freshness } : {}),
    onError: (error) => errors.push(error),
  })

  return {
    clock,
    errors,
    pending,
    recovery,
    refreshed,
    goTo(url: string) {
      active = url
      status = "completed"
      notify()
    },
    /** How many visit-state notifications the controller has published. */
    get notifications() {
      return notifications
    },
    /**
     * Settles one held refresh the way the real controller does: it publishes
     * the visit state change first and settles the promise after, so a test
     * cannot accidentally depend on the opposite order.
     */
    settle(index: number, outcome: "cached" | "network" | "reject") {
      const entry = pending[index]
      if (!entry) throw new Error(`no held refresh at index ${index}`)
      status = outcome === "reject" ? "failed" : "completed"
      notify()
      if (outcome === "reject") entry.reject(new Error("recovery transport refused"))
      else entry.resolve(outcome === "cached" ? cachedReport(entry.url) : networkReport(entry.url))
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
    // A standard cause chain, so a tool walking `.cause` still reaches the
    // transport failure rather than only a summary.
    expect((h.errors[0] as { cause?: unknown })?.cause).toBeInstanceOf(Error)
    expect((h.errors[0] as { cause?: Error })?.cause?.message).toBe("recovery transport refused")
  })

  test("keeps a suspended obligation when a second document reconnects", async () => {
    const releases: string[] = []
    const h = harness({
      freshness: { claim: () => undefined, release: (url) => releases.push(url) },
    })

    // A reconnects and arms, then the user navigates away and A suspends.
    h.recovery.request({ baseUrl: BASE })
    h.goTo(OTHER)
    await tick(h)
    expect(h.recovery.armedFor(BASE)).toBe(true)

    // B reconnects while A is suspended. With one global target this replaces
    // A outright — releasing its freshness claim and resetting its state — and
    // A can then show stale snapshot content for the rest of the session.
    h.recovery.request({ baseUrl: OTHER })
    await tick(h)

    expect(h.recovery.armedFor(OTHER)).toBe(false)
    expect(h.recovery.armedFor(BASE)).toBe(true)
    expect(releases).toEqual([OTHER])

    // Returning to A still recovers it.
    h.goTo(BASE)
    await tick(h, 2)
    expect(h.recovery.armedFor(BASE)).toBe(false)
    expect(h.refreshed.filter((url) => url === BASE)).not.toEqual([])
  })

  test("leaves another document's timer running when one document exhausts", async () => {
    // Revert the per-obligation timer to one shared timer and this fails at the
    // last two assertions: `stop()` clears the shared handle on A's exhaustion,
    // which is the handle B is waiting on, so B stays armed with nothing
    // scheduled and is never refreshed again.
    const h = harness({ active: OTHER, attempts: 2, failFor: [BASE], hold: [BASE] })

    h.recovery.request({ baseUrl: BASE })
    await tick(h)
    h.settle(0, "reject")
    await flush()

    // A is one failure into a two-attempt budget, with its retry scheduled.
    await tick(h)
    expect(h.refreshed).toEqual([BASE, BASE])

    // B arms while A's second attempt is still in flight, so B's timer is the
    // most recently scheduled one — the one a shared handle would be pointing
    // at when A exhausts.
    h.recovery.request({ baseUrl: OTHER })
    const settled = h.notifications

    h.settle(1, "reject")
    await flush()

    expect(h.errors).toHaveLength(1)
    expect(h.errors[0]?.message).toContain("after 2 attempts")
    expect(h.recovery.armedFor(BASE)).toBe(false)
    expect(h.recovery.armedFor(OTHER)).toBe(true)
    // B has not been refreshed yet, so whatever happens next is B's own timer
    // and not a leftover attempt.
    expect(h.refreshed).toEqual([BASE, BASE])

    // Asserts the absence of the second route: a later visit event would re-arm
    // B through the watcher and hide a cleared timer entirely. Exactly one
    // notification happened here, A's own failure, and none after it.
    expect(h.notifications).toBe(settled + 1)

    await tick(h)

    expect(h.refreshed).toEqual([BASE, BASE, OTHER])
    expect(h.recovery.armedFor(OTHER)).toBe(false)
  })

  test("does not let an old in-flight refresh discharge a re-armed obligation", async () => {
    // Revert the record-identity check to a bare `obligations.has(url)` and
    // this fails: the first reconnect's result releases the second reconnect's
    // obligation, so the document stays stale with no fresh fetch and no
    // report — the silent staleness the component exists to prevent.
    const h = harness({ hold: [BASE] })

    h.recovery.request({ baseUrl: BASE })
    await tick(h)
    expect(h.refreshed).toEqual([BASE])

    // A second reconnect for the same document while the first refresh is still
    // in flight. That refresh was issued before the news this obligation is
    // about, so it cannot answer for it.
    h.recovery.request({ baseUrl: BASE })
    h.settle(0, "network")
    await flush()

    expect(h.recovery.armedFor(BASE)).toBe(true)

    // Asserts the absence of the second route: the obligation is not stuck
    // armed because this fixture can never discharge one. The re-armed
    // obligation's own refresh discharges it normally.
    await tick(h)
    expect(h.refreshed).toEqual([BASE, BASE])
    h.settle(1, "network")
    await flush()

    expect(h.recovery.armedFor(BASE)).toBe(false)
    expect(h.errors).toEqual([])
  })

  test("does not let an old in-flight failure spend a re-armed attempt budget", async () => {
    // Revert the record-identity check and this fails at the mid-point
    // assertions: the stale rejection counts against the new obligation, so it
    // gives up after two of its own attempts instead of three and reports while
    // it still had budget left.
    const h = harness({ attempts: 3, failFor: [BASE], hold: [BASE] })

    h.recovery.request({ baseUrl: BASE })
    await tick(h)
    h.recovery.request({ baseUrl: BASE })

    // The superseded attempt fails. It must not touch the new obligation.
    h.settle(0, "reject")
    await flush()
    expect(h.errors).toEqual([])

    // Two attempts of the new obligation's own budget.
    await tick(h)
    h.settle(1, "reject")
    await flush()
    await tick(h)
    h.settle(2, "reject")
    await flush()

    // Still armed with one attempt left. A consumed budget would already have
    // reported by now.
    expect(h.errors).toEqual([])
    expect(h.recovery.armedFor(BASE)).toBe(true)

    await tick(h)
    h.settle(3, "reject")
    await flush()

    expect(h.errors).toHaveLength(1)
    expect(h.errors[0]?.message).toContain("after 3 attempts")
    expect(h.recovery.armedFor(BASE)).toBe(false)
    // One refresh before the re-arm and the new obligation's own three.
    expect(h.refreshed).toHaveLength(4)
  })

  test("refuses a new obligation past the cap instead of evicting an armed one", async () => {
    // Revert to least-recently-requested eviction and this fails: `one` is
    // released and disarmed, so a document that was owed a fresh fetch silently
    // stops being owed one while `three` takes its place.
    const releases: string[] = []
    const h = harness({
      active: "https://example.test/elsewhere",
      documents: 2,
      freshness: { claim: () => undefined, release: (url) => releases.push(url) },
    })

    h.recovery.request({ baseUrl: "https://example.test/one" })
    h.recovery.request({ baseUrl: "https://example.test/two" })
    h.recovery.request({ baseUrl: "https://example.test/three" })

    // The refused document is the one that could not be admitted, and every
    // document already owing recovery still owes it.
    expect(h.recovery.armedFor("https://example.test/three")).toBe(false)
    expect(h.recovery.armedFor("https://example.test/one")).toBe(true)
    expect(h.recovery.armedFor("https://example.test/two")).toBe(true)
    // Asserts the absence of the second route: nothing was released, so
    // `three` being unarmed cannot be an eviction that happened to land on it.
    expect(releases).toEqual([])

    // Reported as it happens, because an obligation that never starts is the
    // same silent staleness as one that ends without a fresh fetch.
    expect(h.errors).toHaveLength(1)
    expect(h.errors[0]?.message).toContain("refused this document")
    expect(h.errors[0]?.message).toContain("2 others")
  })

  test("admits a repeat reconnect for a document already at the cap", async () => {
    const h = harness({ active: "https://example.test/elsewhere", documents: 2 })

    h.recovery.request({ baseUrl: "https://example.test/one" })
    h.recovery.request({ baseUrl: "https://example.test/two" })
    // The map does not grow, so there is nothing to refuse.
    h.recovery.request({ baseUrl: "https://example.test/one" })

    expect(h.errors).toEqual([])
    expect(h.recovery.armedFor("https://example.test/one")).toBe(true)
    expect(h.recovery.armedFor("https://example.test/two")).toBe(true)
  })

  test("releases every obligation on disposal", async () => {
    const releases: string[] = []
    const h = harness({
      freshness: { claim: () => undefined, release: (url) => releases.push(url) },
    })

    h.goTo("https://example.test/elsewhere")
    h.recovery.request({ baseUrl: BASE })
    h.recovery.request({ baseUrl: OTHER })
    h.recovery.dispose()

    expect(releases.sort()).toEqual([BASE, OTHER].sort())
    expect(h.recovery.armed).toBe(false)
  })

  test("claims and releases document freshness around the obligation", async () => {
    const claims: string[] = []
    const releases: string[] = []
    const h = harness({
      freshness: {
        claim: (url) => claims.push(url),
        release: (url) => releases.push(url),
      },
    })

    h.recovery.request({ baseUrl: BASE })
    // Claimed while owed: the loader mints a request id before it ever calls
    // the adapter, so nothing in the report can prove the bytes were fresh.
    // Demanding origin bytes is what makes it true rather than inferred.
    expect(claims).toEqual([BASE])
    expect(releases).toEqual([])

    await tick(h)

    expect(h.recovery.armed).toBe(false)
    expect(releases).toEqual([BASE])
  })

  test("keeps the freshness claim unbroken across a re-arm", async () => {
    const claims: string[] = []
    const releases: string[] = []
    const h = harness({
      freshness: { claim: (url) => claims.push(url), release: (url) => releases.push(url) },
    })

    h.recovery.request({ baseUrl: BASE })
    h.recovery.request({ baseUrl: BASE })

    // The document owes origin bytes continuously across the handover. A
    // release-then-claim would open a window in which a GET for it could be
    // served from a cache.
    expect(releases).toEqual([])
    expect(claims).toEqual([BASE])
  })

  test("releases freshness when the obligation is abandoned", async () => {
    const releases: string[] = []
    const h = harness({
      freshness: { claim: () => undefined, release: (url) => releases.push(url) },
    })

    h.recovery.request({ baseUrl: BASE })
    h.recovery.dispose()

    // A claim that outlived its obligation would force uncached GETs of that
    // document for the rest of the session.
    expect(releases).toEqual([BASE])
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
