import { PropsError, TargetError } from "./errors"
import { DocumentTree } from "./tree"

export const DOCUMENT_PREFETCH_CACHE_TTL_MS = 10_000

interface DocumentPrefetchEntry {
  readonly expiresAt: number
  readonly promise: Promise<DocumentTree | undefined>
  readonly url: string
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

  take(url: string): Promise<DocumentTree | undefined> | undefined {
    const key = prefetchKey(url)
    const entry = this.entry
    if (!entry || entry.url !== key) return undefined
    this.entry = undefined
    if (entry.expiresAt <= this.now()) return undefined
    return entry.promise.then((tree) => tree?.clone())
  }

  put(url: string, tree: DocumentTree): void {
    if (!(tree instanceof DocumentTree)) {
      throw new PropsError("Document prefetch cache entries must be document trees")
    }
    const key = prefetchKey(url)
    const documentUrl = tree.document.url
    if (documentUrl === undefined || prefetchKey(documentUrl) !== key) {
      throw new TargetError("Document prefetch tree URL must match its cache key")
    }
    const snapshot = tree.clone({ omitTemporaryElements: true })
    this.putPending(key, Promise.resolve(snapshot))
  }

  putPending(url: string, promise: Promise<DocumentTree | undefined>): void {
    const key = prefetchKey(url)
    if (!promise || typeof promise.then !== "function") {
      throw new PropsError("Document prefetch cache entries must be promises")
    }
    this.entry = Object.freeze({
      expiresAt: this.now() + this.ttlMs,
      promise,
      url: key,
    })
  }
}
