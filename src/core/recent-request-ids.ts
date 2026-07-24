import { RequestError } from "./errors.js"

export const RECENT_REQUEST_ID_LIMIT = 20

/** Turbo-compatible bounded insertion-order set used for refresh-loop suppression. */
export class RecentRequestIds {
  private readonly values = new Set<string>()

  constructor(private readonly limit = RECENT_REQUEST_ID_LIMIT) {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new RequestError("Recent request-id limit must be a positive integer")
    }
  }

  add(requestId: string): void {
    if (typeof requestId !== "string" || requestId.trim() === "") {
      throw new RequestError("Recent request id must be a nonblank string")
    }
    if (this.values.size >= this.limit) {
      const oldest = this.values.values().next().value
      if (oldest !== undefined) this.values.delete(oldest)
    }
    this.values.add(requestId)
  }

  has(requestId: string | undefined): boolean {
    return requestId !== undefined && this.values.has(requestId)
  }
}
