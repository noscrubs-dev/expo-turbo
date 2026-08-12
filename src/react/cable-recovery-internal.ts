import type { ClockAdapter } from "../adapters/index.js"
import type { DocumentRefreshRequest } from "../core/document-refresh-controller.js"
import { DOCUMENT_REFRESH_DEBOUNCE_MS } from "../core/document-refresh-controller.js"
import type { DocumentVisitController } from "../core/document-visit-controller.js"
import { RequestError, StateError } from "../core/errors.js"
import type { DocumentSession } from "../core/session.js"

export interface CableDocumentRecoveryOptions {
  readonly attempts?: number
  readonly debounceMs?: number
  readonly onError?: (error: Error) => void
}

type RecoveryVisits = Pick<DocumentVisitController, "refreshCurrent" | "state" | "subscribe">
type RecoverySession = Pick<DocumentSession, "subscribeTreeState" | "tree" | "treeGeneration">

/** Bounded so a server that is simply down cannot keep this armed forever. */
export const CABLE_RECOVERY_MAX_ATTEMPTS = 3

function canonical(url: string): string {
  try {
    return new URL(url).toString()
  } catch {
    return url
  }
}

/**
 * Document recovery after an Action Cable reconnect.
 *
 * Everything broadcast while the socket was down was missed, so the document
 * has to be re-fetched. The hard part is knowing when that obligation is
 * discharged, and deriving it from visit outcomes does not work: each
 * enumeration of "which endings count" has turned out to be missing a case —
 * a navigation starting inside the debounce and failing, then a recovery
 * request cancelled mid-flight by a navigation that then failed.
 *
 * So this conditions on the outcome itself rather than on the events that might
 * produce it:
 *
 *   **the recovery stays armed until the document it needs has actually been
 *   re-fetched.**
 *
 * Concretely it is discharged by exactly two observations, both read from the
 * session rather than inferred from a visit:
 *
 * - `recovered` — the tree generation advanced while the active document is
 *   still the one that reconnected. Some commit re-fetched it; which visit did,
 *   and how that visit ended, does not matter.
 * - `moot` — the active document is no longer the one that reconnected. That
 *   document was fetched fresh with its own subscriptions, so there is nothing
 *   left to recover.
 *
 * Anything else — a refusal, a cancellation, a failure, a supersession, an
 * interleaving nobody has thought of yet — simply is not one of those two, so
 * the recovery stays armed and tries again. Attempts are bounded, and
 * exhausting them reports rather than retrying forever.
 */
export class CableDocumentRecovery {
  private attempts = 0
  private baselineGeneration = 0
  private disposed = false
  private handle: unknown
  private target: string | undefined
  private unsubscribeSession: (() => void) | undefined
  private unsubscribeVisits: (() => void) | undefined
  private readonly debounceMs: number
  private readonly maxAttempts: number
  private readonly onError: ((error: Error) => void) | undefined

  constructor(
    private readonly session: RecoverySession,
    private readonly visits: RecoveryVisits,
    private readonly clock: ClockAdapter,
    options: CableDocumentRecoveryOptions = {},
  ) {
    this.debounceMs = options.debounceMs ?? DOCUMENT_REFRESH_DEBOUNCE_MS
    this.maxAttempts = options.attempts ?? CABLE_RECOVERY_MAX_ATTEMPTS
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
    const target = canonical(request.baseUrl)
    // Rapid reconnects for the same document coalesce into one obligation
    // rather than queueing several.
    if (this.target !== target) this.attempts = 0
    this.target = target
    this.baselineGeneration = this.session.treeGeneration
    this.watch()
    this.arm(true)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.clear()
  }

  private discharge(): "moot" | "recovered" | undefined {
    if (this.target === undefined) return undefined
    const active = this.session.tree.document.url
    // An untitled document cannot be the one that reconnected, so treat the
    // recovery as moot rather than refreshing something unidentifiable.
    if (active === undefined || canonical(active) !== this.target) return "moot"
    if (this.session.treeGeneration > this.baselineGeneration) return "recovered"
    return undefined
  }

  private clear(): void {
    this.target = undefined
    this.attempts = 0
    if (this.handle !== undefined) this.clock.clearTimeout(this.handle)
    this.handle = undefined
    const visits = this.unsubscribeVisits
    const session = this.unsubscribeSession
    this.unsubscribeVisits = undefined
    this.unsubscribeSession = undefined
    visits?.()
    session?.()
  }

  private arm(reset: boolean): void {
    if (this.disposed || this.target === undefined) return
    if (this.handle !== undefined) {
      if (!reset) return
      this.clock.clearTimeout(this.handle)
    }
    this.handle = this.clock.setTimeout(() => this.fire(), this.debounceMs)
  }

  private evaluate(): void {
    if (this.disposed || this.target === undefined) return
    if (this.discharge()) {
      this.clear()
      return
    }
    // A visit in flight may yet be the commit that discharges this, so let it
    // finish; the watchers call back.
    if (this.visits.state.status === "started") return
    this.arm(false)
  }

  private fire(): void {
    this.handle = undefined
    if (this.disposed) return
    const target = this.target
    if (target === undefined) return
    if (this.discharge()) {
      this.clear()
      return
    }
    if (this.visits.state.status === "started") return
    if (this.attempts >= this.maxAttempts) {
      // No URL in the context: that field is deliberately not part of the
      // redacted protocol metadata errors are allowed to carry.
      this.report(
        new RequestError("Cable reconnect recovery gave up refreshing the document", {
          method: "GET",
        }),
      )
      this.clear()
      return
    }

    this.attempts += 1
    let refresh: Promise<unknown>
    try {
      refresh = this.visits.refreshCurrent(target, "replace", "preserve")
    } catch (error) {
      this.report(error)
      this.evaluate()
      return
    }
    // The result is deliberately ignored. Whether it committed, was refused,
    // was cancelled, or was superseded, the only question that matters is
    // whether the document has since been re-fetched, and `discharge()` reads
    // that from the session.
    void refresh.then(
      () => this.evaluate(),
      (error: unknown) => {
        this.report(error)
        this.evaluate()
      },
    )
  }

  private watch(): void {
    if (this.disposed) return
    this.unsubscribeVisits ??= this.visits.subscribe(() => this.evaluate())
    this.unsubscribeSession ??= this.session.subscribeTreeState(() => this.evaluate())
  }

  private report(error: unknown): void {
    const reported =
      error instanceof Error ? error : new RequestError("Cable document recovery failed")
    if (!this.onError) {
      queueMicrotask(() => {
        throw reported
      })
      return
    }
    try {
      this.onError(reported)
    } catch (reporterError) {
      // A reporter that throws must not be swallowed either.
      queueMicrotask(() => {
        throw new AggregateError(
          [reported, reporterError],
          "Cable document recovery reporter failed",
        )
      })
    }
  }
}
