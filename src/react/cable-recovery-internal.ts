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
 * one entry per document for the life of the session. Passing this evicts the
 * least recently requested obligation — and reports it, because an obligation
 * that ends without a fresh fetch has to end loudly.
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
 * Document recovery after an Action Cable reconnect.
 *
 * Everything broadcast while the socket was down was missed, so the document
 * has to be re-fetched. Deriving "done" from visit outcomes failed twice, and
 * deriving it from the session's tree generation failed too: a generation bump
 * means the tree changed, and a snapshot preview or restoration changes the
 * tree with no request at all.
 *
 * The invariant is unchanged — **the recovery stays armed until the document it
 * needs has actually been re-fetched** — but it is now attached to an
 * observation only a network round trip can produce: a refresh report for the
 * target URL carrying a request id. Caches cannot mint one.
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
interface RecoveryObligation {
  attempts: number
  lastError: Error | undefined
  /** Monotonic, for least-recently-requested eviction. */
  sequence: number
}

export class CableDocumentRecovery {
  private disposed = false
  private handle: unknown
  private requestSequence = 0
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
    // A reconnect for one document must never erase a suspended obligation for
    // another: the second document's recovery would silently take the first's
    // place and the first would show stale content for the rest of the session.
    // A repeat for the same document is the same obligation with fresh
    // evidence, so its attempt budget starts over and rapid reconnects coalesce.
    this.obligations.set(target, {
      attempts: 0,
      lastError: undefined,
      sequence: ++this.requestSequence,
    })
    this.freshness?.claim(target)
    this.evictExcess(target)
    this.watch()
    this.schedule(this.debounceMs, true)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const target of [...this.obligations.keys()]) this.release(target)
    this.stop()
  }

  /**
   * Ends one obligation. Every exit routes through here so the no-store claim
   * is released exactly once per document.
   */
  private release(target: string): void {
    if (!this.obligations.delete(target)) return
    this.freshness?.release(target)
  }

  private stop(): void {
    if (this.handle !== undefined) this.clock.clearTimeout(this.handle)
    this.handle = undefined
    if (this.obligations.size > 0) return
    const unsubscribe = this.unsubscribe
    this.unsubscribe = undefined
    unsubscribe?.()
  }

  private evictExcess(keep: string): void {
    while (this.obligations.size > this.maxDocuments) {
      let oldest: string | undefined
      let oldestSequence = Number.POSITIVE_INFINITY
      for (const [target, obligation] of this.obligations) {
        if (target === keep) continue
        if (obligation.sequence < oldestSequence) {
          oldest = target
          oldestSequence = obligation.sequence
        }
      }
      if (oldest === undefined) return
      const evicted = this.obligations.get(oldest)
      this.release(oldest)
      // Reported, not dropped: an obligation ending without a fresh fetch is
      // exactly the silent staleness this component exists to prevent.
      this.report(
        new RequestError(
          `Cable reconnect recovery abandoned a document after ${this.maxDocuments} others needed recovery`,
          { method: "GET" },
          evicted?.lastError ? { cause: evicted.lastError } : undefined,
        ),
      )
    }
  }

  private schedule(delayMs: number, reset: boolean): void {
    if (this.disposed || this.obligations.size === 0) return
    if (this.handle !== undefined) {
      if (!reset) return
      this.clock.clearTimeout(this.handle)
    }
    this.handle = this.clock.setTimeout(() => this.fire(), delayMs)
  }

  private backoffDelay(): number {
    let lowest = 0
    for (const obligation of this.obligations.values()) {
      lowest = lowest === 0 ? obligation.attempts : Math.min(lowest, obligation.attempts)
    }
    const scaled = this.debounceMs * this.backoffFactor ** lowest
    return Math.min(scaled, this.maxDelayMs)
  }

  private fire(): void {
    this.handle = undefined
    if (this.disposed || this.obligations.size === 0) return
    // A visit in flight may be about to re-fetch one of these itself; the
    // watcher calls back when it settles.
    if (this.visits.state.status === "started") return

    // Every armed document is attempted. `refreshCurrent` refuses the ones that
    // are not active without issuing a request, so at most one of these reaches
    // the network and the rest cost nothing.
    for (const target of [...this.obligations.keys()]) this.attempt(target)
  }

  private attempt(target: string): void {
    let refresh: Promise<unknown>
    try {
      refresh = this.visits.refreshCurrent(target, "replace", "preserve")
    } catch (error) {
      this.failedAttempt(target, error)
      return
    }
    void refresh.then(
      (result) => {
        if (this.disposed || !this.obligations.has(target)) return
        // `undefined` is a refusal, not an attempt: this document is not the
        // active one. Costing an attempt for it would burn the budget while the
        // user is simply reading another screen.
        if (result === undefined) return
        if (isNetworkDocumentCommit(result, target)) {
          this.release(target)
          this.stop()
          return
        }
        this.failedAttempt(target, undefined)
      },
      (error: unknown) => this.failedAttempt(target, error),
    )
  }

  private failedAttempt(target: string, error: unknown): void {
    if (this.disposed) return
    const obligation = this.obligations.get(target)
    if (!obligation) return
    if (error !== undefined) {
      obligation.lastError =
        error instanceof Error ? error : new RequestError("Cable recovery failed")
    }
    obligation.attempts += 1
    if (obligation.attempts >= this.maxAttempts) {
      // One report per obligation, not one per attempt: a reconnect that needs
      // retrying is ordinary, and only the permanent failure is actionable.
      const cause = obligation.lastError
      this.release(target)
      this.report(
        new RequestError(
          `Cable reconnect recovery could not refresh the document after ${obligation.attempts} attempts`,
          { method: "GET" },
          cause ? { cause } : undefined,
        ),
      )
      this.stop()
      return
    }
    this.schedule(this.backoffDelay(), true)
  }

  private watch(): void {
    if (this.disposed) return
    this.unsubscribe ??= this.visits.subscribe(() => {
      if (this.disposed || this.obligations.size === 0) return
      if (this.visits.state.status === "started") return
      // Resume suspended obligations once the document is settled again.
      this.schedule(this.backoffDelay(), false)
    })
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
