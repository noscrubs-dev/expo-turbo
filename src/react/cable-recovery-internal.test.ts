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

/**
 * A clock with a real timeline, for the scenarios where the interval between
 * reconnects is the whole point. `ManualClock` fires every timer regardless of
 * its delay, so it cannot show a timer that is reset before it ever comes due.
 */
class VirtualClock implements ClockAdapter {
  private next = 1
  private time = 0
  private readonly timers = new Map<number, { callback: () => void; dueAt: number }>()

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number)
  }

  now(): number {
    return this.time
  }

  setTimeout(callback: () => void, delayMs = 0): unknown {
    const handle = this.next++
    this.timers.set(handle, { callback, dueAt: this.time + Math.max(0, delayMs) })
    return handle
  }

  /** Advances the timeline in `stepMs` slices, running whatever comes due. */
  async advance(ms: number, stepMs = 25): Promise<void> {
    const target = this.time + ms
    while (this.time < target) {
      this.time = Math.min(target, this.time + stepMs)
      for (const [handle, timer] of [...this.timers]) {
        if (timer.dueAt > this.time) continue
        this.timers.delete(handle)
        timer.callback()
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    }
  }
}

interface HarnessOptions {
  /** Which document the visit controller considers active. */
  readonly active?: string
  readonly attempts?: number
  readonly backoffFactor?: number
  readonly debounceMs?: number
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
  /** Use a real timeline instead of the fire-everything manual clock. */
  readonly virtual?: boolean
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

  const clock = options.virtual ? new VirtualClock() : new ManualClock()
  const recovery = new CableDocumentRecovery(visits as never, clock, {
    attempts: options.attempts ?? 3,
    backoffFactor: options.backoffFactor ?? 2,
    debounceMs: options.debounceMs ?? 1,
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
  const clock = h.clock as ManualClock
  for (let index = 0; index < times; index += 1) {
    clock.fire()
    await flush()
  }
}

/**
 * Reconnects every `everyMs` for `forMs`, the way a phone on a weak signal
 * does. This is the condition the feature exists for, so the component has to
 * both recover and report under it.
 */
async function flap(
  h: ReturnType<typeof harness>,
  url: string,
  options: Readonly<{ everyMs: number; forMs: number }>,
): Promise<number> {
  const clock = h.clock as VirtualClock
  let reconnects = 0
  for (let elapsed = 0; elapsed < options.forMs; elapsed += options.everyMs) {
    h.recovery.request({ baseUrl: url })
    reconnects += 1
    await clock.advance(options.everyMs)
  }
  return reconnects
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

  test("still refreshes while the connection keeps flapping", async () => {
    // A phone on a weak signal reconnects faster than the debounce. If a
    // reconnect resets the pending timer, the timer never comes due and the
    // recovery never issues a single request — in the exact condition the
    // feature exists for. Reinstate the timer reset in `request` and this
    // fails with `refreshed` empty.
    const h = harness({ debounceMs: 150, virtual: true })

    const reconnects = await flap(h, BASE, { everyMs: 100, forMs: 10_000 })

    expect(reconnects).toBe(100)
    expect(h.refreshed.length).toBeGreaterThan(0)
    expect(h.refreshed[0]).toBe(BASE)
    // It discharged on the first successful refresh and later reconnects armed
    // it again, so the flapping never left it stuck.
    expect(h.errors).toEqual([])
  })

  test("still reports when the connection flaps faster than the attempt budget", async () => {
    // The worse half of the same defect: real GETs are being made and failing,
    // and resetting the attempt count on every reconnect means the budget is
    // consumed and reset rather than never started, so the terminal report is
    // unreachable. Reinstate `attempts: 0` on re-arm and this fails with
    // `errors` empty and the document still armed.
    const h = harness({
      attempts: 3,
      debounceMs: 150,
      failFor: [BASE],
      virtual: true,
    })

    await flap(h, BASE, { everyMs: 500, forMs: 10_000 })

    expect(h.refreshed.length).toBeGreaterThanOrEqual(3)
    expect(h.errors.length).toBeGreaterThanOrEqual(1)
    expect(h.errors[0]?.message).toContain("after 3 attempts")
    // Asserts the absence of the second route: the report is not an artifact of
    // the flapping stopping, because reconnects continued for the full window.
    expect(h.errors[0]).toMatchObject({ documentUrl: BASE, reason: "exhausted" })
  })

  test("cannot discharge on a refresh a newer reconnect superseded", async () => {
    // A reconnect while a refresh is in flight means that refresh was issued
    // before the gap it would have to cover, so its bytes may predate the
    // broadcasts that gap swallowed and cannot end the obligation. Drop the
    // epoch check and this fails: the pre-gap commit discharges it.
    const h = harness({ attempts: 2, hold: [BASE] })

    h.recovery.request({ baseUrl: BASE })
    await tick(h)
    h.recovery.request({ baseUrl: BASE })
    h.settle(0, "network")
    await flush()

    expect(h.recovery.armedFor(BASE)).toBe(true)
    expect(h.errors).toEqual([])

    // It still cost a budget slot, because it did reach the transport. With a
    // two-attempt budget one more settled attempt exhausts it — which is what
    // keeps a connection that flaps once per in-flight refresh from issuing
    // unbounded requests and never reporting.
    await tick(h)
    h.settle(1, "reject")
    await flush()

    expect(h.errors).toHaveLength(1)
    expect(h.errors[0]?.message).toContain("after 2 attempts")
    expect(h.errors[0]).toMatchObject({ documentUrl: BASE, reason: "exhausted" })
  })

  test("discharges on a refresh no reconnect superseded", async () => {
    // Asserts the absence of the second route for the test above: the epoch
    // check does not simply block every discharge in that fixture.
    const h = harness({ attempts: 2, hold: [BASE] })

    h.recovery.request({ baseUrl: BASE })
    await tick(h)
    h.settle(0, "network")
    await flush()

    expect(h.recovery.armedFor(BASE)).toBe(false)
    expect(h.errors).toEqual([])
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

  test("charges a failure to the budget whichever reconnect issued it", async () => {
    // The budget bounds *requests that reached the transport*, not requests
    // belonging to the newest reconnect. Excusing a superseded failure is what
    // made the terminal report unreachable while a flapping connection issued
    // real, failing GETs: reconnect during flight, excuse the failure, repeat.
    //
    // Restore `attempts: 0` on re-arm, or stop counting a superseded failure,
    // and this fails: the third rejection no longer exhausts the budget.
    const h = harness({ attempts: 3, failFor: [BASE], hold: [BASE] })

    h.recovery.request({ baseUrl: BASE })
    await tick(h)
    // A reconnect retires the in-flight attempt, then it fails anyway.
    h.recovery.request({ baseUrl: BASE })
    h.settle(0, "reject")
    await flush()
    expect(h.errors).toEqual([])

    await tick(h)
    h.settle(1, "reject")
    await flush()
    expect(h.errors).toEqual([])
    expect(h.recovery.armedFor(BASE)).toBe(true)

    await tick(h)
    h.settle(2, "reject")
    await flush()

    // Three failed GETs, three attempts, one report — the reconnect in the
    // middle changed neither the count nor the fact that it ends loudly.
    expect(h.refreshed).toHaveLength(3)
    expect(h.errors).toHaveLength(1)
    expect(h.errors[0]?.message).toContain("after 3 attempts")
    expect(h.errors[0]).toMatchObject({ documentUrl: BASE, reason: "exhausted" })
    expect(h.recovery.armedFor(BASE)).toBe(false)
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
    // same silent staleness as one that ends without a fresh fetch — and named,
    // because a host cannot refresh a document the report will not identify.
    expect(h.errors).toHaveLength(1)
    expect(h.errors[0]?.message).toContain("2 others")
    expect(h.errors[0]).toMatchObject({
      documentUrl: "https://example.test/three",
      reason: "capacity",
    })
    // The URL stays out of `message`, which is the part that reaches logs
    // wholesale; a host has to read the typed property to get it.
    expect(h.errors[0]?.message).not.toContain("example.test")
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

  test("reports every obligation it still owed when disposed", async () => {
    // Disposal is not an exemption from the invariant. `runtime.dispose()`
    // keeps its session and tree — it cancels the controller and the loader,
    // it does not tear the document down — and `ExpoTurbo` disposes a runtime
    // whenever a runtime-defining input changes, while the document that
    // runtime rendered can still be on screen. Ending these silently leaves a
    // displayable document stale with nothing left to fix it.
    //
    // Drop the reports from `dispose` and this fails with `errors` empty.
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
    // One report per document still owed, each naming its own document.
    expect(h.errors).toHaveLength(2)
    expect(h.errors.map((error) => (error as { documentUrl?: string }).documentUrl).sort()).toEqual(
      [BASE, OTHER].sort(),
    )
    for (const error of h.errors) expect(error).toMatchObject({ reason: "disposed" })
  })

  test("reports nothing when disposed with nothing owed", async () => {
    // Asserts the absence of the second route for the test above: disposal
    // itself is not what produces a report, so a host is not trained to ignore
    // the channel by an error on every unmount.
    const h = harness()

    h.recovery.request({ baseUrl: BASE })
    await tick(h)
    expect(h.recovery.armed).toBe(false)

    h.recovery.dispose()

    expect(h.errors).toEqual([])
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
