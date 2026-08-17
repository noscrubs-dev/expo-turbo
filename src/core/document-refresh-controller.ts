import type { ClockAdapter } from "../adapters/index.js"
import type { DocumentVisitController } from "./document-visit-controller.js"
import { DocumentReconnectReconciliationError, RequestError, StateError } from "./errors.js"
import { resolveProtocolUrl } from "./protocol-request.js"
import { requestLifecycleDefaultHandlingPrevented } from "./request-lifecycle.js"
import type { DocumentSession } from "./session.js"

export const DOCUMENT_REFRESH_DEBOUNCE_MS = 150

export interface DocumentRefreshRequest {
  /** Active document URL captured when the refresh Stream action was dispatched. */
  readonly baseUrl: string
  readonly method?: string
  readonly requestId?: string
  readonly scroll?: string
}

export interface DocumentRefreshRequester {
  request(request: DocumentRefreshRequest): void
}

export interface DocumentRefreshControllerOptions {
  readonly debounceMs?: number
  readonly onError?: (error: Error) => void
}

export interface DocumentReconnectReconcilerOptions {
  /** Receives a structured error when a deferred handoff fails or is disposed. */
  readonly onError?: (error: Error) => void
}

/**
 * Schedules current-document refreshes without disturbing a newer document
 * visit. Exact `method="morph"` uses the bounded document-root morph path;
 * exact `scroll="preserve"` is the only non-reset native scroll policy.
 */
export class DocumentRefreshController implements DocumentRefreshRequester {
  private disposed = false
  private handle: unknown
  private pending: DocumentRefreshRequest | undefined
  private readonly debounceMs: number
  private readonly onError: ((error: Error) => void) | undefined

  constructor(
    private readonly session: DocumentSession,
    private readonly visits: Pick<DocumentVisitController, "refreshCurrent">,
    private readonly clock: ClockAdapter,
    options: DocumentRefreshControllerOptions = {},
  ) {
    this.debounceMs = options.debounceMs ?? DOCUMENT_REFRESH_DEBOUNCE_MS
    this.onError = options.onError
    if (!Number.isFinite(this.debounceMs) || this.debounceMs < 0) {
      throw new RequestError("Document refresh debounce must be a non-negative number")
    }
  }

  request(request: DocumentRefreshRequest): void {
    if (this.disposed) throw new StateError("Document refresh controller is disposed")
    this.pending = admitDocumentRefreshRequest(request)
    if (this.handle !== undefined) this.clock.clearTimeout(this.handle)
    this.handle = this.clock.setTimeout(() => this.flush(), this.debounceMs)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.handle !== undefined) this.clock.clearTimeout(this.handle)
    this.handle = undefined
    this.pending = undefined
  }

  private flush(): void {
    const request = this.pending
    this.handle = undefined
    this.pending = undefined
    if (!request || this.disposed) return
    if (this.session.recentRequestIds.has(request.requestId)) return

    let refresh: Promise<unknown>
    try {
      refresh = this.visits.refreshCurrent(
        request.baseUrl,
        request.method === "morph" ? "morph" : "replace",
        request.scroll === "preserve" ? "preserve" : "reset",
      )
    } catch (error) {
      this.report(error)
      return
    }
    void refresh.catch((error: unknown) => this.report(error))
  }

  private report(error: unknown): void {
    if (requestLifecycleDefaultHandlingPrevented(error)) return
    const reported = error instanceof Error ? error : new RequestError("Document refresh failed")
    if (this.onError) {
      try {
        this.onError(reported)
        return
      } catch (reporterError) {
        queueMicrotask(() => {
          throw new AggregateError([reported, reporterError], "Document refresh reporter failed")
        })
        return
      }
    }
    queueMicrotask(() => {
      throw reported
    })
  }
}

/**
 * Defers Cable-recovery reconciliations until the active document visit has
 * settled. Obligations use the protocol's canonical document URL as identity.
 * Different documents keep first-insertion order; a repeat updates that
 * document's request without moving it. A request made during a handoff starts
 * a later drain, so a reentrant requester cannot lose or duplicate it.
 *
 * A successful `request()` handoff completes an obligation. A handoff throw
 * also completes only that obligation and is thrown to the direct caller or
 * reported from deferred work. There is no retry here: the wrapped requester
 * owns transport and retry policy. Disposal reports each obligation that has
 * not started handoff, then makes later work inert except that `request()` keeps
 * its existing disposed-state error.
 *
 * Ordinary Stream `refresh` behavior remains unchanged. The wrapped requester
 * must still enforce active-document URL ownership; use
 * `DocumentRefreshController` for that bounded check and debounce.
 */
export class DocumentReconnectReconciler implements DocumentRefreshRequester {
  private disposed = false
  private draining = false
  private drainScheduled = false
  private readonly pending = new Map<string, DocumentRefreshRequest>()
  private subscribing = false
  private unsubscribe: (() => void) | undefined
  private readonly onError: ((error: Error) => void) | undefined

  constructor(
    private readonly refresh: DocumentRefreshRequester,
    private readonly visits: Pick<DocumentVisitController, "state" | "subscribe">,
    options: DocumentReconnectReconcilerOptions = {},
  ) {
    this.onError = options.onError
  }

  request(request: DocumentRefreshRequest): void {
    if (this.disposed) throw new StateError("Document reconnect reconciler is disposed")
    const admitted = admitDocumentRefreshRequest(request)
    this.pending.set(canonicalDocumentRefreshUrl(admitted.baseUrl), admitted)
    if (this.draining) {
      this.scheduleDrain()
      return
    }
    this.reconcile(false)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const unsubscribe = this.unsubscribe
    this.unsubscribe = undefined
    unsubscribe?.()
    const pending = [...this.pending.entries()]
    this.pending.clear()
    for (const [documentUrl, request] of pending) {
      this.report(request, "disposed", documentUrl)
    }
  }

  private reconcile(deferred: boolean): void {
    if (this.disposed || this.draining || this.pending.size === 0) return
    if (this.visitStarted()) {
      this.observeCurrentVisit()
      return
    }

    const unsubscribe = this.unsubscribe
    this.unsubscribe = undefined
    unsubscribe?.()

    this.draining = true
    let directError: unknown
    try {
      // This fixed key list is the atomic drain batch. A repeat for a key that
      // has not run yet uses its newest value in place. A request added by a
      // handoff callback stays queued for a later microtask.
      const keys = [...this.pending.keys()]
      for (const key of keys) {
        if (this.disposed || this.visitStarted()) break
        const request = this.pending.get(key)
        if (!request) continue
        this.pending.delete(key)
        try {
          this.refresh.request(request)
        } catch (error) {
          if (deferred) this.report(request, "handoff-failed", key)
          else if (directError === undefined) directError = error
          else this.report(request, "handoff-failed", key)
        }
      }
    } finally {
      this.draining = false
    }

    if (!this.disposed && this.pending.size > 0) {
      if (this.visitStarted()) this.observeCurrentVisit()
      else this.scheduleDrain()
    }
    if (directError !== undefined) throw directError
  }

  private observeCurrentVisit(): void {
    if (this.disposed || this.pending.size === 0 || this.unsubscribe || this.subscribing) return
    this.subscribing = true
    let unsubscribe: (() => void) | undefined
    try {
      unsubscribe = this.visits.subscribe(() => this.reconcile(true))
    } finally {
      this.subscribing = false
    }
    if (!unsubscribe) return
    if (this.disposed || this.pending.size === 0 || !this.visitStarted()) {
      unsubscribe()
      this.reconcile(true)
      return
    }
    this.unsubscribe = unsubscribe
  }

  private scheduleDrain(): void {
    if (this.disposed || this.drainScheduled || this.pending.size === 0) return
    this.drainScheduled = true
    queueMicrotask(() => {
      this.drainScheduled = false
      this.reconcile(true)
    })
  }

  private visitStarted(): boolean {
    return this.visits.state.status === "started"
  }

  private report(
    request: DocumentRefreshRequest,
    reason: "disposed" | "handoff-failed",
    documentUrl = canonicalDocumentRefreshUrl(request.baseUrl),
  ): void {
    const reported = new DocumentReconnectReconciliationError(
      documentUrl,
      reason,
      request.requestId,
    )
    if (this.onError) {
      try {
        this.onError(reported)
        return
      } catch (reporterError) {
        queueMicrotask(() => {
          throw new AggregateError([reported, reporterError], "Document reconnect reporter failed")
        })
        return
      }
    }
    queueMicrotask(() => {
      throw reported
    })
  }
}

function canonicalDocumentRefreshUrl(baseUrl: string): string {
  return resolveProtocolUrl(baseUrl, baseUrl).url
}

function admitDocumentRefreshRequest(request: DocumentRefreshRequest): DocumentRefreshRequest {
  if (request === null || typeof request !== "object") {
    throw new RequestError("Document refresh request must be an object")
  }
  const baseUrl = request.baseUrl
  if (typeof baseUrl !== "string" || baseUrl.trim() === "") {
    throw new RequestError("Document refresh requires an active document URL")
  }
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    throw new RequestError("Document refresh requires a valid absolute URL")
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw new RequestError("Document refresh requires a credential-free HTTP(S) URL")
  }
  if (request.scroll !== undefined && typeof request.scroll !== "string") {
    throw new RequestError("Document refresh scroll policy must be a string")
  }
  if (request.requestId !== undefined && typeof request.requestId !== "string") {
    throw new RequestError("Document refresh request id must be a string")
  }
  return Object.freeze({
    baseUrl,
    ...(request.method !== undefined ? { method: request.method } : {}),
    ...(request.requestId !== undefined ? { requestId: request.requestId } : {}),
    scroll: request.scroll === "preserve" ? "preserve" : "reset",
  })
}
