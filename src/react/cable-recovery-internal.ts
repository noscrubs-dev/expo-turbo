import type { ClockAdapter } from "../adapters/index.js"
import type { DocumentRefreshRequest } from "../core/document-refresh-controller.js"
import { DOCUMENT_REFRESH_DEBOUNCE_MS } from "../core/document-refresh-controller.js"
import type { DocumentVisitController } from "../core/document-visit-controller.js"
import { RequestError, StateError } from "../core/errors.js"

export interface CableDocumentRecoveryOptions {
  readonly debounceMs?: number
  readonly onError?: (error: Error) => void
}

type RecoveryVisits = Pick<DocumentVisitController, "refreshCurrent" | "state" | "subscribe">

/**
 * Debounced document recovery after an Action Cable reconnect.
 *
 * `DocumentRefreshController` cannot own this on its own: it drops the pending
 * request when its timer fires, and `refreshCurrent()` resolves `undefined`
 * without doing anything while a visit is in flight. A navigation that starts
 * inside the debounce window therefore swallows the recovery, and if that
 * navigation then fails or is cancelled the stale document stays on screen with
 * nothing left to refresh it.
 *
 * The rule here is the one that matters: a *successful* visit obsoletes the
 * recovery, because it committed fresh content. Anything else — a failure, a
 * cancellation, a refusal — leaves the document stale, so the recovery re-arms.
 *
 * The request is cleared the moment a refresh is actually dispatched, so a
 * failing recovery reports through `onError` once and cannot re-trigger itself.
 */
export class CableDocumentRecovery {
  private disposed = false
  private handle: unknown
  private pending: DocumentRefreshRequest | undefined
  private unsubscribe: (() => void) | undefined
  private readonly debounceMs: number
  private readonly onError: ((error: Error) => void) | undefined

  constructor(
    private readonly visits: RecoveryVisits,
    private readonly clock: ClockAdapter,
    options: CableDocumentRecoveryOptions = {},
  ) {
    this.debounceMs = options.debounceMs ?? DOCUMENT_REFRESH_DEBOUNCE_MS
    this.onError = options.onError
    if (!Number.isFinite(this.debounceMs) || this.debounceMs < 0) {
      throw new RequestError("Cable recovery debounce must be a non-negative number")
    }
  }

  request(request: DocumentRefreshRequest): void {
    if (this.disposed) throw new StateError("Cable document recovery is disposed")
    if (!request || typeof request.baseUrl !== "string" || request.baseUrl === "") {
      throw new StateError("Cable document recovery requires a base URL")
    }
    // Rapid reconnects collapse into one refresh rather than queueing several.
    this.pending = request
    this.arm()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.pending = undefined
    this.clearTimer()
    this.release()
  }

  private arm(): void {
    if (this.disposed || !this.pending) return
    this.clearTimer()
    this.handle = this.clock.setTimeout(() => this.fire(), this.debounceMs)
  }

  private clearTimer(): void {
    if (this.handle !== undefined) this.clock.clearTimeout(this.handle)
    this.handle = undefined
  }

  private release(): void {
    const unsubscribe = this.unsubscribe
    this.unsubscribe = undefined
    unsubscribe?.()
  }

  private fire(): void {
    this.handle = undefined
    const request = this.pending
    if (!request || this.disposed) return
    if (this.visits.state.status === "started") {
      this.waitForSettle()
      return
    }

    // Dispatched: from here the recovery either lands or is reported, and it
    // never re-arms itself.
    this.pending = undefined
    let refresh: Promise<unknown>
    try {
      refresh = this.visits.refreshCurrent(request.baseUrl, "replace", "preserve")
    } catch (error) {
      this.report(error)
      return
    }
    void refresh.then(
      (result) => {
        // `undefined` means the controller refused: a visit slipped in, or this
        // is no longer the document that reconnected. The former still needs
        // recovering, and waiting for the settle tells the two apart.
        if (result === undefined && !this.disposed) {
          this.pending = request
          this.waitForSettle()
        }
      },
      (error: unknown) => this.report(error),
    )
  }

  private waitForSettle(): void {
    if (this.disposed || this.unsubscribe) return
    this.unsubscribe = this.visits.subscribe(() => {
      if (this.disposed || this.visits.state.status === "started") return
      this.release()
      if (!this.pending) return
      if (this.visits.state.status === "completed") {
        // Fresh content committed, so there is nothing left to recover.
        this.pending = undefined
        return
      }
      this.arm()
    })
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
    } catch {
      // A reporter that throws must not take the recovery path down with it.
    }
  }
}
