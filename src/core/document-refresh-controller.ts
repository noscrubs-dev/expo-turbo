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

/**
 * Schedules plain document replacement refreshes without disturbing a newer
 * document visit. Morph and explicit scroll policies remain separate adapters.
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
    const baseUrl = this.admitBaseUrl(request.baseUrl)
    if (request.method === "morph") {
      throw new RequestError("Native document refresh morph method requires morph support")
    }
    if (request.scroll !== undefined) {
      throw new RequestError("Native document refresh scroll policy requires a scroll adapter")
    }
    if (request.requestId !== undefined && typeof request.requestId !== "string") {
      throw new RequestError("Document refresh request id must be a string")
    }

    this.pending = Object.freeze({
      baseUrl,
      ...(request.method !== undefined ? { method: request.method } : {}),
      ...(request.requestId !== undefined ? { requestId: request.requestId } : {}),
    })
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

  private admitBaseUrl(value: string): string {
    if (typeof value !== "string" || value.trim() === "") {
      throw new RequestError("Document refresh requires an active document URL")
    }
    let url: URL
    try {
      url = new URL(value)
    } catch {
      throw new RequestError("Document refresh requires a valid absolute URL")
    }
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
      throw new RequestError("Document refresh requires a credential-free HTTP(S) URL")
    }
    return value
  }

  private flush(): void {
    const request = this.pending
    this.handle = undefined
    this.pending = undefined
    if (!request || this.disposed) return
    if (this.session.recentRequestIds.has(request.requestId)) return

    let refresh: Promise<unknown>
    try {
      refresh = this.visits.refreshCurrent(request.baseUrl)
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
