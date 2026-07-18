import { documentCachePolicy } from "./document-metadata"
import { PropsError, TargetError } from "./errors"
import { DocumentTree } from "./tree"

export const DOCUMENT_SNAPSHOT_CACHE_SIZE = 10

function cacheKey(value: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TargetError("Document snapshot URLs must be nonblank strings")
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new TargetError("Document snapshot URL is invalid")
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new TargetError("Document snapshot URL must be credential-free HTTP(S)")
  }
  url.hash = ""
  return url.toString()
}

/**
 * Stores independent document-tree snapshots under Turbo's fragment-free URL
 * keys. Both writes and reads refresh LRU recency; reads return a fresh clone so
 * restoring and mutating a document cannot alter the retained snapshot.
 */
export class DocumentSnapshotCache {
  private readonly entries = new Map<string, DocumentTree>()

  constructor(readonly capacity: number = DOCUMENT_SNAPSHOT_CACHE_SIZE) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new PropsError("Document snapshot cache capacity must be a positive integer")
    }
  }

  get size(): number {
    return this.entries.size
  }

  clear(): void {
    this.entries.clear()
  }

  get(url: string): DocumentTree | undefined {
    const key = cacheKey(url)
    const snapshot = this.entries.get(key)
    if (!snapshot) return undefined
    this.entries.delete(key)
    this.entries.set(key, snapshot)
    return snapshot.clone()
  }

  has(url: string): boolean {
    return this.entries.has(cacheKey(url))
  }

  put(url: string, tree: DocumentTree): void {
    if (!(tree instanceof DocumentTree)) {
      throw new PropsError("Document snapshot cache entries must be document trees")
    }
    const key = cacheKey(url)
    const documentUrl = tree.document.url
    if (documentUrl === undefined || cacheKey(documentUrl) !== key) {
      throw new TargetError("Document snapshot tree URL must match its cache key")
    }
    if (!documentCachePolicy(tree).cacheable) return
    const snapshot = tree.clone({ omitTemporaryElements: true })
    this.entries.delete(key)
    this.entries.set(key, snapshot)
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
  }
}
