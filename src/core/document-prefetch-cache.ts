import { PropsError, TargetError } from "./errors"

export const DOCUMENT_PREFETCH_CACHE_TTL_MS = 10_000

interface DocumentPrefetchEntry {
  readonly cancel: () => void
  readonly expiresAt: number
  readonly promise: Promise<DocumentPrefetchedResponse | undefined>
  readonly url: string
}

export interface DocumentPrefetchedResponse {
  readonly body: string
  readonly contentType?: string
  readonly redirected: boolean
  readonly requestId: string
  readonly responseStatus: number
  readonly url: string
}

export interface DocumentPrefetchLease {
  cancel(): void
  readonly promise: Promise<DocumentPrefetchedResponse | undefined>
}

function prefetchKey(value: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TargetError("Document prefetch URLs must be nonblank strings")
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new TargetError("Document prefetch URL is invalid")
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new TargetError("Document prefetch URL must be credential-free HTTP(S)")
  }
  url.hash = ""
  return url.toString()
}

/** One-shot native press-in response cache matching Turbo's one-entry, 10-second prefetch cache. */
export class DocumentPrefetchCache {
  private entry: DocumentPrefetchEntry | undefined

  constructor(
    readonly ttlMs: number = DOCUMENT_PREFETCH_CACHE_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isFinite(ttlMs) || ttlMs < 0) {
      throw new PropsError("Document prefetch cache TTL must be a non-negative number")
    }
  }

  clear(): void {
    this.entry = undefined
  }

  take(url: string): DocumentPrefetchLease | undefined {
    const key = prefetchKey(url)
    const entry = this.entry
    if (!entry || entry.url !== key) return undefined
    this.entry = undefined
    if (entry.expiresAt <= this.now()) return undefined
    return Object.freeze({
      cancel: entry.cancel,
      promise: entry.promise,
    })
  }

  put(url: string, response: DocumentPrefetchedResponse): void {
    this.putPending(url, Promise.resolve(response))
  }

  putPending(
    url: string,
    promise: Promise<DocumentPrefetchedResponse | undefined>,
    cancel: () => void = () => undefined,
  ): void {
    const key = prefetchKey(url)
    if (!promise || typeof promise.then !== "function") {
      throw new PropsError("Document prefetch cache entries must be promises")
    }
    if (typeof cancel !== "function") {
      throw new PropsError("Document prefetch cache cancellation must be a function")
    }
    const admitted = promise.then((response) => {
      if (!response) return undefined
      if (!response || typeof response !== "object" || Array.isArray(response)) {
        throw new PropsError("Document prefetch responses must be objects")
      }
      const responseUrl = prefetchKey(response.url)
      const requestUrl = new URL(key)
      const finalUrl = new URL(responseUrl)
      if (requestUrl.origin !== finalUrl.origin) {
        throw new TargetError("Document prefetch responses must remain same-origin")
      }
      if (
        typeof response.redirected !== "boolean" ||
        typeof response.responseStatus !== "number" ||
        !Number.isInteger(response.responseStatus) ||
        !(
          (response.responseStatus >= 200 && response.responseStatus < 300) ||
          (response.responseStatus >= 400 && response.responseStatus < 600)
        ) ||
        typeof response.body !== "string" ||
        (response.contentType !== undefined && typeof response.contentType !== "string") ||
        typeof response.requestId !== "string" ||
        response.requestId.trim() === ""
      ) {
        throw new PropsError("Document prefetch response metadata is invalid")
      }
      return Object.freeze({
        body: response.body,
        ...(response.contentType !== undefined ? { contentType: response.contentType } : {}),
        redirected: response.redirected || responseUrl !== key,
        requestId: response.requestId,
        responseStatus: response.responseStatus,
        url: responseUrl,
      })
    })
    this.entry = Object.freeze({
      cancel,
      expiresAt: this.now() + this.ttlMs,
      promise: admitted,
      url: key,
    })
  }
}
