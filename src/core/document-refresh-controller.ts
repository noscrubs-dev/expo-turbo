import type { ClockAdapter } from "../adapters"
import type { DocumentVisitController } from "./document-visit-controller"
import { RequestError, StateError } from "./errors"
import { requestLifecycleDefaultHandlingPrevented } from "./request-lifecycle"
import type { DocumentSession } from "./session"

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
  /** Receives a redacted error when a deferred handoff cannot be scheduled. */
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
 * Defers one Cable-recovery reconciliation until the active document visit has
 * settled. It intentionally leaves ordinary Stream `refresh` behavior alone.
 * The wrapped requester must still enforce active-document URL ownership; use
 * `DocumentRefreshController` for that bounded check and debounce.
 */
export class DocumentReconnectReconciler implements DocumentRefreshRequester {
  private disposed = false
  private pending: DocumentRefreshRequest | undefined
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
    this.pending = admitDocumentRefreshRequest(request)
    this.forward(false)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.pending = undefined
    const unsubscribe = this.unsubscribe
    this.unsubscribe = undefined
    unsubscribe?.()
  }

  private forward(deferred: boolean): void {
    if (this.disposed || !this.pending) return
    if (this.visits.state.status === "started") {
      this.observeCurrentVisit()
      return
    }

    const request = this.pending
    this.pending = undefined
    const unsubscribe = this.unsubscribe
    this.unsubscribe = undefined
    unsubscribe?.()
    try {
      this.refresh.request(request)
    } catch (error) {
      if (!deferred) throw error
      this.report(error)
    }
  }

  private observeCurrentVisit(): void {
    if (this.disposed || this.unsubscribe || this.subscribing) return
    this.subscribing = true
    let unsubscribe: (() => void) | undefined
    try {
      unsubscribe = this.visits.subscribe(() => this.forward(true))
    } finally {
      this.subscribing = false
    }
    if (!unsubscribe) return
    if (this.disposed || !this.pending || this.visits.state.status !== "started") {
      unsubscribe()
      this.forward(false)
      return
    }
    this.unsubscribe = unsubscribe
  }

  private report(_error: unknown): void {
    const reported = new RequestError("Document reconnect reconciliation failed")
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
