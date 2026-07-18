import type { RestorationIdentifierAdapter } from "../adapters"
import { PropsError, StateError } from "./errors"

export type DocumentHistoryTraversalDirection = "back" | "forward"

export interface DocumentHistoryEntry {
  readonly restorationIdentifier: string
  readonly restorationIndex: number
  readonly url: string
}

export type DocumentHistoryState =
  | Readonly<{ readonly entry: DocumentHistoryEntry; readonly kind: "managed" }>
  | Readonly<{ readonly kind: "unmanaged"; readonly url: string }>

export interface DocumentScrollPosition {
  readonly x: number
  readonly y: number
}

export interface DocumentRestorationData {
  readonly scrollPosition?: DocumentScrollPosition
}

export interface DocumentHistoryInitialization {
  readonly entry: DocumentHistoryEntry
  readonly hostReplacementRequired: boolean
}

const emptyRestorationData = Object.freeze({})

function normalizeUrl(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new StateError("Document history URLs must be nonblank strings")
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new StateError("Document history URL is invalid")
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new StateError("Document history URL must be credential-free HTTP(S)")
  }
  return url.toString()
}

function normalizeIdentifier(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new StateError("Document restoration identifiers must be nonblank strings")
  }
  return value
}

function normalizeEntry(value: unknown): DocumentHistoryEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new StateError("Document history entries must be objects")
  }
  const entry = value as Record<string, unknown>
  if (
    Object.keys(entry).some(
      (key) => !["restorationIdentifier", "restorationIndex", "url"].includes(key),
    )
  ) {
    throw new StateError("Document history entries contain unsupported fields")
  }
  if (
    typeof entry.restorationIndex !== "number" ||
    !Number.isSafeInteger(entry.restorationIndex) ||
    entry.restorationIndex < 0
  ) {
    throw new StateError("Document restoration indexes must be non-negative safe integers")
  }
  return Object.freeze({
    restorationIdentifier: normalizeIdentifier(entry.restorationIdentifier),
    restorationIndex: entry.restorationIndex,
    url: normalizeUrl(entry.url),
  })
}

function normalizeRestorationPatch(value: unknown): DocumentScrollPosition | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PropsError("Document restoration data must be an object")
  }
  const patch = value as Record<string, unknown>
  if (Object.keys(patch).some((key) => key !== "scrollPosition")) {
    throw new PropsError("Document restoration data contains unsupported fields")
  }
  if (!Object.hasOwn(patch, "scrollPosition")) return undefined
  const position = patch.scrollPosition
  if (typeof position !== "object" || position === null || Array.isArray(position)) {
    throw new PropsError("Document scroll positions must be objects")
  }
  const coordinates = position as Record<string, unknown>
  if (Object.keys(coordinates).some((key) => key !== "x" && key !== "y")) {
    throw new PropsError("Document scroll positions contain unsupported fields")
  }
  if (
    typeof coordinates.x !== "number" ||
    !Number.isFinite(coordinates.x) ||
    typeof coordinates.y !== "number" ||
    !Number.isFinite(coordinates.y)
  ) {
    throw new PropsError("Document scroll positions require finite x and y values")
  }
  return Object.freeze({ x: coordinates.x, y: coordinates.y })
}

/**
 * Host-neutral history identity and restoration-data ledger. It intentionally
 * performs no host-router writes and does not enable visit actions.
 */
export class DocumentHistory {
  private readonly boundIdentifiers = new Set<string>()
  private currentEntry: DocumentHistoryEntry | undefined
  private readonly restorationData = new Map<string, DocumentRestorationData>()

  constructor(private readonly identifiers: RestorationIdentifierAdapter) {}

  get current(): DocumentHistoryEntry | undefined {
    return this.currentEntry
  }

  initialize(state: DocumentHistoryState): DocumentHistoryInitialization {
    if (this.currentEntry) {
      throw new StateError("Document history is already initialized")
    }
    if (typeof state !== "object" || state === null || Array.isArray(state)) {
      throw new StateError("Document history state must be an object")
    }

    const record = state as unknown as Record<string, unknown>
    let entry: DocumentHistoryEntry
    let hostReplacementRequired: boolean
    if (record.kind === "managed") {
      if (Object.keys(record).some((key) => key !== "kind" && key !== "entry")) {
        throw new StateError("Managed document history state contains unsupported fields")
      }
      entry = normalizeEntry(record.entry)
      hostReplacementRequired = false
    } else if (record.kind === "unmanaged") {
      if (Object.keys(record).some((key) => key !== "kind" && key !== "url")) {
        throw new StateError("Unmanaged document history state contains unsupported fields")
      }
      const url = normalizeUrl(record.url)
      entry = normalizeEntry({
        restorationIdentifier: this.identifiers.next(),
        restorationIndex: 0,
        url,
      })
      hostReplacementRequired = true
    } else {
      throw new StateError("Document history state kind is invalid")
    }

    const canonical = this.bind(entry)
    this.currentEntry = canonical
    return Object.freeze({ entry: canonical, hostReplacementRequired })
  }

  adoptTraversal(entry: DocumentHistoryEntry): DocumentHistoryTraversalDirection {
    const current = this.currentEntry
    if (!current) throw new StateError("Document history is not initialized")
    const canonical = this.bind(normalizeEntry(entry))
    const direction = canonical.restorationIndex > current.restorationIndex ? "forward" : "back"
    this.currentEntry = canonical
    return direction
  }

  getRestorationData(restorationIdentifier: string): DocumentRestorationData {
    const identifier = this.boundIdentifier(restorationIdentifier)
    return this.restorationData.get(identifier) ?? emptyRestorationData
  }

  updateRestorationData(
    restorationIdentifier: string,
    patch: DocumentRestorationData,
  ): DocumentRestorationData {
    const identifier = this.boundIdentifier(restorationIdentifier)
    const scrollPosition = normalizeRestorationPatch(patch)
    const current = this.restorationData.get(identifier) ?? emptyRestorationData
    if (!scrollPosition) return current
    const next = Object.freeze({ ...current, scrollPosition })
    this.restorationData.set(identifier, next)
    return next
  }

  private bind(entry: DocumentHistoryEntry): DocumentHistoryEntry {
    this.boundIdentifiers.add(entry.restorationIdentifier)
    return entry
  }

  private boundIdentifier(value: unknown): string {
    const identifier = normalizeIdentifier(value)
    if (!this.boundIdentifiers.has(identifier)) {
      throw new StateError("Document restoration identifier is not bound")
    }
    return identifier
  }
}
