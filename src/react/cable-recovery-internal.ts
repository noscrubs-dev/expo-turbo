import type { ClockAdapter } from "../adapters/index.js"
import type { DocumentRefreshRequest } from "../core/document-refresh-controller.js"
import { DOCUMENT_REFRESH_DEBOUNCE_MS } from "../core/document-refresh-controller.js"
import type { DocumentVisitController } from "../core/document-visit-controller.js"
import type { CableRecoveryAbandonmentReason } from "../core/errors.js"
import { CableRecoveryAbandonedError, RequestError, StateError } from "../core/errors.js"

/**
 * Marks a document URL as needing origin bytes. While a URL is claimed, the
 * runtime tags outgoing requests for it `cache: "no-store"`, which is what
 * makes the recovery's own refresh fresh by construction instead of fresh by
 * inference.
 */
export interface CableRecoveryFreshness {
  claim(url: string): void
  release(url: string): void
}

export interface CableDocumentRecoveryOptions {
  readonly attempts?: number
  readonly backoffFactor?: number
  readonly debounceMs?: number
  readonly documents?: number
  readonly freshness?: CableRecoveryFreshness
  readonly maxDelayMs?: number
  readonly onError?: (error: Error) => void
}

type RecoveryVisits = Pick<DocumentVisitController, "refreshCurrent" | "state" | "subscribe">

/**
 * Five attempts spread by the backoff below span roughly a minute, because a
 * Cable reconnect only means the websocket came back — HTTP may need longer.
 */
export const CABLE_RECOVERY_MAX_ATTEMPTS = 5
export const CABLE_RECOVERY_BACKOFF_FACTOR = 4
export const CABLE_RECOVERY_MAX_DELAY_MS = 30_000
/**
 * How many documents may owe recovery at once. Obligations are per document, so
 * a user cycling through screens on a flaky connection would otherwise retain
 * one entry per document for the life of the session.
 *
 * Passing this **refuses the new obligation** rather than evicting an existing
 * one. Refusal keeps the map honest: a document that is armed stays armed, so
 * `armedFor` never starts lying about one that was quietly dropped. It also
 * puts the report on the document in the request that just arrived, which is
 * information the caller already holds — an eviction report would have to name
 * a URL, and `ExpoTurboErrorContext` carries no URL by design.
 *
 * The cost is that the refused document is the newest, which is usually the one
 * on screen. Re-arming a URL already in the map never refuses, so a document
 * that already owes recovery keeps recovering.
 */
export const CABLE_RECOVERY_MAX_DOCUMENTS = 8

function canonical(url: string): string {
  try {
    return new URL(url).toString()
  } catch {
    return url
  }
}

/**
 * True only for a report that this recovery's own refresh of `target` was
 * applied.
 *
 * `requestId` rules out the internal cache paths — a snapshot restore or
 * preview produces a `DocumentSnapshotRestoreReport`, `{ status, url }`, with
 * no request id anywhere in it. It does **not** on its own prove the bytes came
 * from the origin, because the loader mints the id before calling the fetch
 * adapter; that is what `cache: "no-store"` on the request handles. `empty`
 * counts alongside `committed` because a `204` is still the server being asked
 * and answering "nothing changed".
 */
function isNetworkDocumentCommit(result: unknown, target: string): boolean {
  if (!result || typeof result !== "object") return false
  const report = result as Readonly<{
    requestId?: unknown
    requestedUrl?: unknown
    status?: unknown
  }>
  if (report.status !== "committed" && report.status !== "empty") return false
  if (typeof report.requestId !== "string" || report.requestId === "") return false
  return typeof report.requestedUrl === "string" && canonical(report.requestedUrl) === target
}

/**
 * One document's outstanding recovery.
 *
 * The record *is* the identity token. Every callback closes over the record it
 * was started for and checks `obligations.get(url) === record` before changing
 * anything, so a result can only ever affect the obligation that started it,
 * and a callback from an obligation that has already ended changes nothing.
 *
 * The record lives for as long as the *document* owes recovery, not for as long
 * as one reconnect does. A second reconnect for the same document does not
 * install a second obligation, because the duty is the same duty: fetch this
 * document from the origin. What a reconnect does change is `epoch`.
 *
 * `epoch` is what a reconnect means for a refresh already in flight. That
 * refresh was issued before the newest gap, so its response may have been
 * generated before the broadcasts that gap swallowed: it cannot be allowed to
 * discharge the obligation. It still reached the transport, so it still costs
 * one attempt — otherwise a connection that flaps once per in-flight refresh
 * would make the terminal report unreachable while issuing unbounded requests.
 *
 * `attempts` deliberately survives a reconnect for the same reason. Resetting
 * it let a flapping connection consume the budget and reset it forever, so the
 * document could neither recover nor report — in exactly the weak-signal
 * condition this component exists for.
 *
 * The timer is per record. A shared timer let one document's exhaustion clear
 * another document's pending attempt, leaving it armed with nothing scheduled
 * and no report. A reconnect does not restart a timer that is already pending,
 * for the mirror-image reason: reconnects arriving faster than the debounce
 * would push the attempt out forever.
 */
interface RecoveryObligation {
  attempts: number
  epoch: number
  handle: unknown
  lastError: Error | undefined
  /** At most one attempt in flight per obligation, structurally. */
  pending: boolean
  readonly url: string
}

/**
 * Document recovery after an Action Cable reconnect.
 *
 * Everything broadcast while the socket was down was missed, so the document
 * has to be re-fetched. Deriving "done" from visit outcomes failed twice, and
 * deriving it from the session's tree generation failed too: a generation bump
 * means the tree changed, and a snapshot preview or restoration changes the
 * tree with no request at all.
 *
 * The invariant: **a document stops owing recovery only on a genuine fresh
 * re-fetch of that document, or on a report that names it.** Exactly four paths
 * end an obligation, and every one of them is one of those two:
 *
 * 1. a refresh report for that URL carrying a request id — fresh by
 *    construction, because the URL is claimed `cache: "no-store"` for as long
 *    as it owes recovery and `refreshCurrent` reaches neither the snapshot
 *    cache nor the prefetch cache;
 * 2. the attempt budget running out;
 * 3. refusal past `maxDocuments`;
 * 4. `dispose()`.
 *
 * 2, 3 and 4 all report a `CableRecoveryAbandonedError` carrying the document's
 * canonical URL and the reason. Disposal reports like the rest of them: the
 * runtime keeps its session and tree after `dispose()`, so the document it was
 * showing stays displayable with its recovery silently removed, which is the
 * staleness this component exists to prevent rather than an exemption from it.
 *
 * Consequences worth stating, because both are deliberate:
 *
 * - Navigating away does **not** discharge the recovery. It suspends it: the
 *   refresh is refused while another document is active, and a refusal costs
 *   no attempt. Returning to the document resumes it, which is what keeps a
 *   cached restoration of stale content from ending the obligation.
 * - Only this component's own refresh discharges it. Another visit that happens
 *   to re-fetch the document merely makes one later refresh redundant, which is
 *   a wasted request rather than stale content.
 */
export class CableDocumentRecovery {
  private disposed = false
  private unsubscribe: (() => void) | undefined
  /** One obligation per canonical document URL. */
  private readonly obligations = new Map<string, RecoveryObligation>()
  private readonly backoffFactor: number
  private readonly debounceMs: number
  private readonly freshness: CableRecoveryFreshness | undefined
  private readonly maxAttempts: number
  private readonly maxDelayMs: number
  private readonly maxDocuments: number
  private readonly onError: ((error: Error) => void) | undefined

  constructor(
    private readonly visits: RecoveryVisits,
    private readonly clock: ClockAdapter,
    options: CableDocumentRecoveryOptions = {},
  ) {
    this.backoffFactor = options.backoffFactor ?? CABLE_RECOVERY_BACKOFF_FACTOR
    this.debounceMs = options.debounceMs ?? DOCUMENT_REFRESH_DEBOUNCE_MS
    this.maxAttempts = options.attempts ?? CABLE_RECOVERY_MAX_ATTEMPTS
    this.freshness = options.freshness
    this.maxDelayMs = options.maxDelayMs ?? CABLE_RECOVERY_MAX_DELAY_MS
    this.maxDocuments = options.documents ?? CABLE_RECOVERY_MAX_DOCUMENTS
    this.onError = options.onError
    if (!Number.isFinite(this.debounceMs) || this.debounceMs < 0) {
      throw new RequestError("Cable recovery debounce must be a non-negative number")
    }
    if (!Number.isInteger(this.maxAttempts) || this.maxAttempts < 1) {
      throw new RequestError("Cable recovery attempts must be a positive integer")
    }
    if (!Number.isInteger(this.maxDocuments) || this.maxDocuments < 1) {
      throw new RequestError("Cable recovery documents must be a positive integer")
    }
  }

  /** Whether any document still owes a recovery fetch. */
  get armed(): boolean {
    return this.obligations.size > 0
  }

  /** Whether this specific document still owes a recovery fetch. */
  armedFor(url: string): boolean {
    return this.obligations.has(canonical(url))
  }

  request(request: DocumentRefreshRequest): void {
    if (this.disposed) throw new StateError("Cable document recovery is disposed")
    if (!request || typeof request.baseUrl !== "string" || request.baseUrl === "") {
      throw new StateError("Cable document recovery requires a base URL")
    }
    const target = canonical(request.baseUrl)
    const existing = this.obligations.get(target)
    if (existing) {
      // The same document owing recovery again is the same duty, not a new one.
      // Neither its attempt budget nor its pending timer is reset, because a
      // connection that flaps faster than either would otherwise starve both the
      // refresh and the terminal report. What the reconnect does change is the
      // epoch, which retires any refresh already in flight: that request was
      // issued before this gap, so its bytes cannot answer for it.
      existing.epoch += 1
      this.watch()
      // Only when nothing is already on its way. A suspended obligation — one
      // whose last attempt was refused because another document is active — has
      // neither, and a reconnect is the right moment to try it again.
      if (existing.handle === undefined && !existing.pending) this.schedule(existing)
      return
    }
    if (this.obligations.size >= this.maxDocuments) {
      // Refused, not evicted: the documents already owing recovery keep owing
      // it, so `armedFor` never stops being true for one that was quietly
      // dropped. The report names the document that could not be admitted,
      // because a host cannot refresh a document the report will not name.
      this.abandon(
        target,
        "capacity",
        `Cable reconnect recovery refused a document because ${this.maxDocuments} others already owe recovery; it stays stale until something else refreshes it`,
        undefined,
      )
      return
    }
    // A reconnect for one document must never erase an obligation for another:
    // the second document's recovery would silently take the first's place and
    // the first would show stale content for the rest of the session.
    const obligation: RecoveryObligation = {
      attempts: 0,
      epoch: 0,
      handle: undefined,
      lastError: undefined,
      pending: false,
      url: target,
    }
    this.obligations.set(target, obligation)
    this.freshness?.claim(target)
    this.watch()
    this.schedule(obligation)
  }

  dispose(): void {
    if (this.disposed) return
    // Reported, not silently dropped. `runtime.dispose()` keeps its session and
    // tree — it cancels the controller and the loader, it does not tear the
    // document down — and `ExpoTurbo` disposes a runtime whenever a
    // runtime-defining input changes, while the document that runtime rendered
    // can still be on screen. A document left displayable with its recovery
    // removed is the silent staleness this component exists to prevent, so
    // disposal ends obligations the same way exhaustion does: loudly, by name.
    //
    // `disposed` is set before the reports, not after. Reporting hands control
    // to the host, and an obligation armed after this point would sit in the
    // map with `owns` false for the rest of the session: never fired, never
    // reported. `end` finds its record through the map rather than through
    // `owns`, so closing that window costs nothing.
    this.disposed = true
    for (const obligation of [...this.obligations.values()]) {
      this.abandon(
        obligation.url,
        "disposed",
        "Cable reconnect recovery was disposed before this document was refreshed; it stays stale until something else refreshes it",
        obligation,
      )
    }
    // `end` drops the subscription once the map empties; this covers a disposal
    // with nothing armed, where the map was already empty.
    this.unwatch()
  }

  /**
   * The only way a document stops owing recovery without having been re-fetched.
   * It ends the obligation and reports it by name in one place, so an ending
   * cannot be added later that forgets to say which document it abandoned.
   */
  private abandon(
    url: string,
    reason: CableRecoveryAbandonmentReason,
    message: string,
    obligation: RecoveryObligation | undefined,
  ): void {
    const cause = obligation?.lastError
    if (obligation) this.end(obligation)
    this.report(
      new CableRecoveryAbandonedError(message, url, reason, cause ? { cause } : undefined),
    )
  }

  /** Whether this record is still the live obligation for its document. */
  private owns(obligation: RecoveryObligation): boolean {
    return !this.disposed && this.obligations.get(obligation.url) === obligation
  }

  /**
   * Ends one obligation. Every exit routes through here, so the no-store claim
   * is released exactly once per document and only this obligation's own timer
   * is cleared.
   */
  private end(obligation: RecoveryObligation): void {
    if (this.obligations.get(obligation.url) !== obligation) return
    this.obligations.delete(obligation.url)
    if (obligation.handle !== undefined) this.clock.clearTimeout(obligation.handle)
    obligation.handle = undefined
    this.freshness?.release(obligation.url)
    if (this.obligations.size === 0) this.unwatch()
  }

  private backoffDelay(obligation: RecoveryObligation): number {
    const scaled = this.debounceMs * this.backoffFactor ** obligation.attempts
    return Math.min(scaled, this.maxDelayMs)
  }

  private schedule(obligation: RecoveryObligation): void {
    if (!this.owns(obligation)) return
    if (obligation.handle !== undefined) this.clock.clearTimeout(obligation.handle)
    obligation.handle = this.clock.setTimeout(() => {
      obligation.handle = undefined
      this.fire(obligation)
    }, this.backoffDelay(obligation))
  }

  private fire(obligation: RecoveryObligation): void {
    if (!this.owns(obligation) || obligation.pending) return
    // A visit in flight may be about to re-fetch this document itself; the
    // watcher calls back when it settles. Leaving the obligation with no timer
    // is deliberate — that is the suspended state, and it is not an ending.
    if (this.visits.state.status === "started") return
    this.attempt(obligation)
  }

  private attempt(obligation: RecoveryObligation): void {
    const target = obligation.url
    const epoch = obligation.epoch
    obligation.pending = true
    let refresh: Promise<unknown>
    try {
      refresh = this.visits.refreshCurrent(target, "replace", "preserve")
    } catch (error) {
      obligation.pending = false
      this.failedAttempt(obligation, error)
      return
    }
    void refresh.then(
      (result) => {
        obligation.pending = false
        if (!this.owns(obligation)) return
        // `undefined` is a refusal, not an attempt: this document is not the
        // active one, or a visit was already running. No request was made, so
        // costing an attempt for it would burn the budget while the user is
        // simply reading another screen.
        if (result === undefined) return
        // A reconnect landed while this was in flight. The request went out
        // before that gap, so whatever it returned may predate the broadcasts
        // the gap swallowed and cannot discharge the obligation. It did reach
        // the transport, so it still costs an attempt.
        if (obligation.epoch !== epoch) {
          this.failedAttempt(obligation, undefined)
          return
        }
        if (isNetworkDocumentCommit(result, target)) {
          this.end(obligation)
          return
        }
        this.failedAttempt(obligation, undefined)
      },
      // A failure counts whatever the epoch: a GET that reached the transport
      // and failed is the evidence the budget exists to bound.
      (error: unknown) => {
        obligation.pending = false
        this.failedAttempt(obligation, error)
      },
    )
  }

  private failedAttempt(obligation: RecoveryObligation, error: unknown): void {
    if (!this.owns(obligation)) return
    if (error !== undefined) {
      obligation.lastError =
        error instanceof Error ? error : new RequestError("Cable recovery failed")
    }
    obligation.attempts += 1
    if (obligation.attempts >= this.maxAttempts) {
      // One report per obligation, not one per attempt: a reconnect that needs
      // retrying is ordinary, and only the permanent failure is actionable.
      this.abandon(
        obligation.url,
        "exhausted",
        `Cable reconnect recovery could not refresh a document after ${obligation.attempts} attempts`,
        obligation,
      )
      return
    }
    this.schedule(obligation)
  }

  private watch(): void {
    if (this.disposed) return
    this.unsubscribe ??= this.visits.subscribe(() => {
      if (this.disposed || this.visits.state.status === "started") return
      // Resume the obligations whose attempt was swallowed by a visit that was
      // in flight when their timer fired. One with a timer already pending, or
      // an attempt already in flight, is left alone: re-arming it here would
      // let a burst of visit events restart its wait forever.
      for (const obligation of [...this.obligations.values()]) {
        if (obligation.handle === undefined && !obligation.pending) this.schedule(obligation)
      }
    })
  }

  private unwatch(): void {
    const unsubscribe = this.unsubscribe
    this.unsubscribe = undefined
    unsubscribe?.()
  }

  private report(error: Error): void {
    if (!this.onError) {
      queueMicrotask(() => {
        throw error
      })
      return
    }
    try {
      this.onError(error)
    } catch (reporterError) {
      queueMicrotask(() => {
        throw new AggregateError([error, reporterError], "Cable recovery reporter failed")
      })
    }
  }
}
