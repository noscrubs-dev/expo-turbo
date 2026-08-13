import type { ClockAdapter } from "../adapters/index.js"
import type { DocumentRefreshRequest } from "../core/document-refresh-controller.js"
import { DOCUMENT_REFRESH_DEBOUNCE_MS } from "../core/document-refresh-controller.js"
import type { DocumentVisitController } from "../core/document-visit-controller.js"
import { RequestError, StateError } from "../core/errors.js"

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
 * anything, so a result can only ever affect the obligation that started it.
 * A second reconnect for the same URL installs a different record, which is why
 * an old in-flight refresh can neither discharge the new obligation nor spend
 * its attempt budget: there is no field to compare and therefore no comparison
 * to forget.
 *
 * The timer is per record for the same reason. A shared timer let one
 * document's exhaustion clear another document's pending attempt, leaving it
 * armed with nothing scheduled and no report.
 */
interface RecoveryObligation {
  attempts: number
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
 * The invariant, stated for the mount it protects: **while a document is still
 * mounted it stops owing recovery only on a genuine fresh re-fetch of that
 * document, or on an explicit terminal report.** Exactly four paths end an
 * obligation:
 *
 * 1. a refresh report for that URL carrying a request id — fresh by
 *    construction, because the URL is claimed `cache: "no-store"` for as long
 *    as it owes recovery and `refreshCurrent` reaches neither the snapshot
 *    cache nor the prefetch cache;
 * 2. the attempt budget running out, reported once;
 * 3. refusal past `maxDocuments`, reported as it happens;
 * 4. `dispose()`, which is not really an ending — it is the end of the mounted
 *    document the obligation existed to protect, so there is nothing left to be
 *    stale and nothing for a report to act on.
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
    if (!existing && this.obligations.size >= this.maxDocuments) {
      // Refused, not evicted, and loudly: the documents already owing recovery
      // keep owing it, and the one that could not be admitted is the one this
      // call names, so the caller needs no URL in the report to know which
      // document stays stale.
      this.report(
        new RequestError(
          `Cable reconnect recovery refused this document because ${this.maxDocuments} others already owe recovery; it stays stale until something else refreshes it`,
          { method: "GET" },
        ),
      )
      return
    }
    // A reconnect for one document must never erase an obligation for another:
    // the second document's recovery would silently take the first's place and
    // the first would show stale content for the rest of the session.
    //
    // A repeat for the same document is a *new* obligation with fresh evidence.
    // Its attempt budget starts over, rapid reconnects coalesce, and — because
    // the record is the identity — the previous record's in-flight refresh can
    // no longer touch it. The freshness claim is deliberately not released and
    // re-taken: the URL owes origin bytes continuously across the handover.
    if (existing?.handle !== undefined) this.clock.clearTimeout(existing.handle)
    const obligation: RecoveryObligation = {
      attempts: 0,
      handle: undefined,
      lastError: undefined,
      pending: false,
      url: target,
    }
    this.obligations.set(target, obligation)
    if (!existing) this.freshness?.claim(target)
    this.watch()
    this.schedule(obligation)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const obligation of [...this.obligations.values()]) this.end(obligation)
    // `end` drops the subscription once the map empties; this covers a disposal
    // with nothing armed, where the map was already empty.
    this.unwatch()
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
        // active one, or a visit was already running. Costing an attempt for it
        // would burn the budget while the user is simply reading another
        // screen.
        if (result === undefined) return
        if (isNetworkDocumentCommit(result, target)) {
          this.end(obligation)
          return
        }
        this.failedAttempt(obligation, undefined)
      },
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
      const attempts = obligation.attempts
      const cause = obligation.lastError
      this.end(obligation)
      this.report(
        new RequestError(
          `Cable reconnect recovery could not refresh the document after ${attempts} attempts`,
          { method: "GET" },
          cause ? { cause } : undefined,
        ),
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
