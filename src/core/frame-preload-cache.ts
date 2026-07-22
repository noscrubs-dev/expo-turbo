import { PropsError, TargetError } from "./errors"

export const FRAME_PRELOAD_CACHE_SIZE = 10

export interface FramePreloadEntry {
  readonly body: string
  readonly frameId: string
  readonly redirected: boolean
  readonly requestId: string
  readonly responseStatus: number
  readonly responseUrl: string
  readonly url: string
}

function framePreloadKey(frameId: string, value: string): string {
  if (
    typeof frameId !== "string" ||
    frameId.trim() === "" ||
    [...frameId].some((character) => {
      const codePoint = character.codePointAt(0)
      return codePoint !== undefined && (codePoint <= 31 || codePoint === 127)
    })
  ) {
    throw new TargetError("Frame preload IDs must be nonblank strings")
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new TargetError("Frame preload URL is invalid", { frameId })
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== ""
  ) {
    throw new TargetError("Frame preload URL must be fragment-free credential-free HTTP(S)", {
      frameId,
    })
  }
  return `${frameId}\n${url.toString()}`
}

/** One-use LRU storage for strictly admitted Frame responses. */
export class FramePreloadCache {
  private readonly entries = new Map<string, FramePreloadEntry>()

  constructor(readonly capacity: number = FRAME_PRELOAD_CACHE_SIZE) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new PropsError("Frame preload cache capacity must be a positive integer")
    }
  }

  get size(): number {
    return this.entries.size
  }

  clear(): void {
    this.entries.clear()
  }

  has(frameId: string, url: string): boolean {
    return this.entries.has(framePreloadKey(frameId, url))
  }

  put(entry: FramePreloadEntry): void {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new PropsError("Frame preload cache entries must be objects")
    }
    const key = framePreloadKey(entry.frameId, entry.url)
    if (
      typeof entry.body !== "string" ||
      entry.body.trim() === "" ||
      typeof entry.requestId !== "string" ||
      entry.requestId.trim() === "" ||
      typeof entry.responseStatus !== "number" ||
      !Number.isInteger(entry.responseStatus) ||
      entry.responseStatus < 200 ||
      entry.responseStatus >= 300 ||
      typeof entry.redirected !== "boolean"
    ) {
      throw new PropsError("Frame preload cache entry is invalid")
    }
    framePreloadKey(entry.frameId, entry.responseUrl)
    const retained = Object.freeze({ ...entry })
    this.entries.delete(key)
    this.entries.set(key, retained)
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
  }

  take(frameId: string, url: string): FramePreloadEntry | undefined {
    const key = framePreloadKey(frameId, url)
    const entry = this.entries.get(key)
    if (entry) this.entries.delete(key)
    return entry
  }
}
