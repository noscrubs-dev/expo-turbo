import type { ClockAdapter } from "../adapters/index.js"
import type { DocumentRefreshRequest } from "../core/document-refresh-controller.js"
import { DOCUMENT_REFRESH_DEBOUNCE_MS } from "../core/document-refresh-controller.js"
import type { DocumentVisitController } from "../core/document-visit-controller.js"
import { RequestError, StateError } from "../core/errors.js"

export interface CableDocumentRecoveryOptions {
  readonly attempts?: number
  readonly backoffFactor?: number
  readonly debounceMs?: number
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

function canonical(url: string): string {
  try {
    return new URL(url).toString()
  } catch {
    return url
  }
}

/**
 * True only for a report that a network response for `target` was applied.
 *
 * `requestId` is the discriminator, and it is the reason a cache cannot fake
 * this: request ids are minted per network request, and a snapshot restore or
 * preview produces a `DocumentSnapshotRestoreReport` — `{ status, url }` — with
 * no request id anywhere in it. `empty` counts alongside `committed` because a
 * `204` is still the server being asked and answering "nothing changed".
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
export class CableDocumentRecovery {
  private attempts = 0
  private disposed = false
  private handle: unknown
  private lastError: Error | undefined
  private target: string | undefined
  private unsubscribe: (() => void) | undefined
  private readonly backoffFactor: number
  private readonly debounceMs: number
  private readonly maxAttempts: number
  private readonly maxDelayMs: number
  private readonly onError: ((error: Error) => void) | undefined

  constructor(
    private readonly visits: RecoveryVisits,
    private readonly clock: ClockAdapter,
    options: CableDocumentRecoveryOptions = {},
  ) {
    this.backoffFactor = options.backoffFactor ?? CABLE_RECOVERY_BACKOFF_FACTOR
    this.debounceMs = options.debounceMs ?? DOCUMENT_REFRESH_DEBOUNCE_MS
    this.maxAttempts = options.attempts ?? CABLE_RECOVERY_MAX_ATTEMPTS
    this.maxDelayMs = options.maxDelayMs ?? CABLE_RECOVERY_MAX_DELAY_MS
    this.onError = options.onError
    if (!Number.isFinite(this.debounceMs) || this.debounceMs < 0) {
      throw new RequestError("Cable recovery debounce must be a non-negative number")
    }
    if (!Number.isInteger(this.maxAttempts) || this.maxAttempts < 1) {
      throw new RequestError("Cable recovery attempts must be a positive integer")
    }
  }

  /** Whether a document still owes a recovery fetch. */
  get armed(): boolean {
    return this.target !== undefined
  }

  request(request: DocumentRefreshRequest): void {
    if (this.disposed) throw new StateError("Cable document recovery is disposed")
    if (!request || typeof request.baseUrl !== "string" || request.baseUrl === "") {
      throw new StateError("Cable document recovery requires a base URL")
    }
    // A fresh reconnect is fresh evidence, so the attempt budget starts over
    // and rapid reconnects coalesce into one obligation.
    this.target = canonical(request.baseUrl)
    this.attempts = 0
    this.lastError = undefined
    this.watch()
    this.schedule(this.debounceMs, true)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.clear()
  }

  private clear(): void {
    this.target = undefined
    this.attempts = 0
    this.lastError = undefined
    if (this.handle !== undefined) this.clock.clearTimeout(this.handle)
    this.handle = undefined
    const unsubscribe = this.unsubscribe
    this.unsubscribe = undefined
    unsubscribe?.()
  }

  private schedule(delayMs: number, reset: boolean): void {
    if (this.disposed || this.target === undefined) return
    if (this.handle !== undefined) {
      if (!reset) return
      this.clock.clearTimeout(this.handle)
    }
    this.handle = this.clock.setTimeout(() => this.fire(), delayMs)
  }

  private backoffDelay(): number {
    const scaled = this.debounceMs * this.backoffFactor ** this.attempts
    return Math.min(scaled, this.maxDelayMs)
  }

  private fire(): void {
    this.handle = undefined
    if (this.disposed) return
    const target = this.target
    if (target === undefined) return
    // A visit in flight may be about to re-fetch this itself; the watcher calls
    // back when it settles.
    if (this.visits.state.status === "started") return

    let refresh: Promise<unknown>
    try {
      refresh = this.visits.refreshCurrent(target, "replace", "preserve")
    } catch (error) {
      this.failedAttempt(error)
      return
    }
    void refresh.then(
      (result) => {
        if (this.disposed || this.target !== target) return
        // `undefined` is a refusal, not an attempt: a visit slipped in, or this
        // document is not the active one. Costing an attempt for it would burn
        // the budget while the user is simply reading another screen.
        if (result === undefined) return
        if (isNetworkDocumentCommit(result, target)) {
          this.clear()
          return
        }
        this.failedAttempt(undefined)
      },
      (error: unknown) => this.failedAttempt(error),
    )
  }

  private failedAttempt(error: unknown): void {
    if (this.disposed || this.target === undefined) return
    if (error !== undefined) {
      this.lastError = error instanceof Error ? error : new RequestError("Cable recovery failed")
    }
    this.attempts += 1
    if (this.attempts >= this.maxAttempts) {
      // One report per obligation, not one per attempt: a reconnect that needs
      // retrying is ordinary, and only the permanent failure is actionable.
      this.report(
        new RequestError(
          `Cable reconnect recovery could not refresh the document after ${this.attempts} attempts`,
          { method: "GET" },
        ),
      )
      this.clear()
      return
    }
    this.schedule(this.backoffDelay(), true)
  }

  private watch(): void {
    if (this.disposed) return
    this.unsubscribe ??= this.visits.subscribe(() => {
      if (this.disposed || this.target === undefined) return
      if (this.visits.state.status === "started") return
      // Resume a suspended recovery once the document is settled again.
      this.schedule(this.backoffDelay(), false)
    })
  }

  private report(error: Error): void {
    const cause = this.lastError
    if (!this.onError) {
      queueMicrotask(() => {
        throw error
      })
      return
    }
    try {
      this.onError(cause ? new AggregateError([error, cause], error.message) : error)
    } catch (reporterError) {
      queueMicrotask(() => {
        throw new AggregateError([error, reporterError], "Cable recovery reporter failed")
      })
    }
  }
}
