import type { RestorationIdentifierAdapter } from "../adapters"
import { PropsError, StateError } from "./errors"

export type DocumentHistoryTraversalDirection = "back" | "forward"

export interface DocumentHistoryEntry {
  readonly restorationIdentifier: string
  readonly restorationIndex: number
  readonly url: string
}

export type DocumentHistoryWriteMethod = "push" | "replace"

export interface DocumentHistoryHostAdapter {
  write(method: DocumentHistoryWriteMethod, entry: DocumentHistoryEntry): undefined
}

declare const DOCUMENT_HISTORY_PROPOSAL: unique symbol

export interface DocumentHistoryProposal {
  readonly [DOCUMENT_HISTORY_PROPOSAL]: true
  readonly entry: DocumentHistoryEntry
  readonly method: DocumentHistoryWriteMethod
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
  readonly hostState: "adopted" | "replaced"
}

interface DocumentHistoryProposalIdentity {
  readonly base: DocumentHistoryEntry
  readonly entry: DocumentHistoryEntry
  readonly frameScope?: object
  readonly method: DocumentHistoryWriteMethod
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
 * Host-neutral history identity/restoration ledger plus synchronous host-write
 * boundary. It does not subscribe to traversal or enable visit actions.
 */
export class DocumentHistory {
  private readonly boundIdentifiers = new Set<string>()
  private currentEntry: DocumentHistoryEntry | undefined
  private readonly frameIdentifiers = new WeakMap<object, string>()
  private readonly frameReservedIdentifiers = new Set<string>()
  private mutationActive = false
  private readonly proposals = new WeakMap<object, DocumentHistoryProposalIdentity>()
  private readonly restorationData = new Map<string, DocumentRestorationData>()

  constructor(
    private readonly identifiers: RestorationIdentifierAdapter,
    private readonly host: DocumentHistoryHostAdapter,
  ) {}

  get current(): DocumentHistoryEntry | undefined {
    return this.currentEntry
  }

  initialize(state: DocumentHistoryState): DocumentHistoryInitialization {
    return this.mutate(() => {
      if (this.currentEntry) {
        throw new StateError("Document history is already initialized")
      }
      if (typeof state !== "object" || state === null || Array.isArray(state)) {
        throw new StateError("Document history state must be an object")
      }

      const record = state as unknown as Record<string, unknown>
      let entry: DocumentHistoryEntry
      let hostState: DocumentHistoryInitialization["hostState"]
      if (record.kind === "managed") {
        if (Object.keys(record).some((key) => key !== "kind" && key !== "entry")) {
          throw new StateError("Managed document history state contains unsupported fields")
        }
        entry = normalizeEntry(record.entry)
        hostState = "adopted"
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
        hostState = "replaced"
      } else {
        throw new StateError("Document history state kind is invalid")
      }

      if (hostState === "replaced") {
        return this.commitHostWrite("replace", entry, () => {
          const canonical = this.bind(entry)
          this.currentEntry = canonical
          return Object.freeze({ entry: canonical, hostState })
        })
      }
      const canonical = this.bind(entry)
      this.currentEntry = canonical
      return Object.freeze({ entry: canonical, hostState })
    })
  }

  adoptTraversal(entry: DocumentHistoryEntry): DocumentHistoryTraversalDirection {
    return this.mutate(() => {
      const current = this.currentEntry
      if (!current) throw new StateError("Document history is not initialized")
      const canonical = this.bind(normalizeEntry(entry))
      const direction = canonical.restorationIndex > current.restorationIndex ? "forward" : "back"
      this.currentEntry = canonical
      return direction
    })
  }

  proposeAdvance(requestedUrl: string): DocumentHistoryProposal {
    return this.mutate(() => {
      const current = this.currentEntry
      if (!current) throw new StateError("Document history is not initialized")
      const url = normalizeUrl(requestedUrl)
      return this.propose(current, url, url === current.url ? "replace" : "push")
    })
  }

  proposeReplace(url: string): DocumentHistoryProposal {
    return this.mutate(() => {
      const current = this.currentEntry
      if (!current) throw new StateError("Document history is not initialized")
      return this.propose(current, normalizeUrl(url), "replace")
    })
  }

  proposeFrameAdvance(frameScope: object, requestedUrl: string): DocumentHistoryProposal {
    return this.mutate(() => {
      const current = this.currentEntry
      if (!current) throw new StateError("Document history is not initialized")
      return this.proposeFrame(current, normalizeUrl(requestedUrl), "push", frameScope)
    })
  }

  proposeFrameReplace(frameScope: object, url: string): DocumentHistoryProposal {
    return this.mutate(() => {
      const current = this.currentEntry
      if (!current) throw new StateError("Document history is not initialized")
      return this.proposeFrame(current, normalizeUrl(url), "replace", frameScope)
    })
  }

  retargetProposal(proposal: DocumentHistoryProposal, finalUrl: string): DocumentHistoryProposal {
    return this.mutate(() => {
      const identity = this.proposalIdentity(proposal)
      const entry = normalizeEntry({ ...identity.entry, url: finalUrl })
      this.proposals.delete(proposal)
      return this.admitProposal(identity.base, entry, identity.method, identity.frameScope)
    })
  }

  commitProposal(proposal: DocumentHistoryProposal): DocumentHistoryEntry {
    return this.mutate(() => {
      const identity = this.proposalIdentity(proposal)
      if (this.currentEntry !== identity.base) {
        throw new StateError("Document history proposal is stale")
      }
      if (
        identity.frameScope &&
        this.frameIdentifiers.get(identity.frameScope) !== identity.entry.restorationIdentifier
      ) {
        throw new StateError("Document Frame history proposal scope is invalid")
      }
      if (!identity.frameScope && this.boundIdentifiers.has(identity.entry.restorationIdentifier)) {
        throw new StateError("Document history proposal identifier is already bound")
      }
      return this.commitHostWrite(identity.method, identity.entry, () => {
        this.proposals.delete(proposal)
        this.boundIdentifiers.add(identity.entry.restorationIdentifier)
        this.currentEntry = identity.entry
        return identity.entry
      })
    })
  }

  getRestorationData(restorationIdentifier: string): DocumentRestorationData {
    const identifier = this.boundIdentifier(restorationIdentifier)
    return this.restorationData.get(identifier) ?? emptyRestorationData
  }

  updateRestorationData(
    restorationIdentifier: string,
    patch: DocumentRestorationData,
  ): DocumentRestorationData {
    return this.mutate(() => {
      const identifier = this.boundIdentifier(restorationIdentifier)
      const scrollPosition = normalizeRestorationPatch(patch)
      const current = this.restorationData.get(identifier) ?? emptyRestorationData
      if (!scrollPosition) return current
      const next = Object.freeze({ ...current, scrollPosition })
      this.restorationData.set(identifier, next)
      return next
    })
  }

  private mutate<T>(mutation: () => T): T {
    if (this.mutationActive) {
      throw new StateError("Document history cannot mutate during another mutation")
    }
    this.mutationActive = true
    try {
      return mutation()
    } finally {
      this.mutationActive = false
    }
  }

  private commitHostWrite<T>(
    method: DocumentHistoryWriteMethod,
    entry: DocumentHistoryEntry,
    commit: () => T,
  ): T {
    let result: unknown
    try {
      result = this.host.write(method, entry)
    } catch {
      throw new StateError("Document history host write failed")
    }
    if (result !== undefined) {
      if ((typeof result === "object" && result !== null) || typeof result === "function") {
        try {
          void Promise.resolve(result).catch(() => undefined)
        } catch {
          // The protocol error below is the only exposed host failure.
        }
      }
      throw new StateError("Document history host write failed")
    }
    return commit()
  }

  private bind(entry: DocumentHistoryEntry): DocumentHistoryEntry {
    this.boundIdentifiers.add(entry.restorationIdentifier)
    return entry
  }

  private propose(
    base: DocumentHistoryEntry,
    url: string,
    method: DocumentHistoryWriteMethod,
  ): DocumentHistoryProposal {
    if (method === "push" && base.restorationIndex === Number.MAX_SAFE_INTEGER) {
      throw new StateError("Document restoration index cannot advance past the safe integer limit")
    }
    const restorationIdentifier = normalizeIdentifier(this.identifiers.next())
    if (
      this.boundIdentifiers.has(restorationIdentifier) ||
      this.frameReservedIdentifiers.has(restorationIdentifier)
    ) {
      throw new StateError("Generated document restoration identifier is already bound")
    }
    const entry = normalizeEntry({
      restorationIdentifier,
      restorationIndex: method === "push" ? base.restorationIndex + 1 : base.restorationIndex,
      url,
    })
    return this.admitProposal(base, entry, method)
  }

  private proposeFrame(
    base: DocumentHistoryEntry,
    url: string,
    method: DocumentHistoryWriteMethod,
    frameScope: object,
  ): DocumentHistoryProposal {
    if (
      (typeof frameScope !== "object" && typeof frameScope !== "function") ||
      frameScope === null
    ) {
      throw new StateError("Document Frame history scopes must be objects")
    }
    if (method === "push" && base.restorationIndex === Number.MAX_SAFE_INTEGER) {
      throw new StateError("Document restoration index cannot advance past the safe integer limit")
    }

    let restorationIdentifier = this.frameIdentifiers.get(frameScope)
    if (!restorationIdentifier) {
      restorationIdentifier = normalizeIdentifier(this.identifiers.next())
      if (
        this.boundIdentifiers.has(restorationIdentifier) ||
        this.frameReservedIdentifiers.has(restorationIdentifier)
      ) {
        throw new StateError("Generated Frame restoration identifier is already bound")
      }
      this.frameIdentifiers.set(frameScope, restorationIdentifier)
      this.frameReservedIdentifiers.add(restorationIdentifier)
    }

    const entry = normalizeEntry({
      restorationIdentifier,
      restorationIndex: method === "push" ? base.restorationIndex + 1 : base.restorationIndex,
      url,
    })
    return this.admitProposal(base, entry, method, frameScope)
  }

  private admitProposal(
    base: DocumentHistoryEntry,
    entry: DocumentHistoryEntry,
    method: DocumentHistoryWriteMethod,
    frameScope?: object,
  ): DocumentHistoryProposal {
    const proposal = Object.freeze({ entry, method }) as DocumentHistoryProposal
    const identity =
      frameScope === undefined
        ? Object.freeze({ base, entry, method })
        : Object.freeze({ base, entry, frameScope, method })
    this.proposals.set(proposal, identity)
    return proposal
  }

  private proposalIdentity(proposal: DocumentHistoryProposal): DocumentHistoryProposalIdentity {
    const identity = this.proposals.get(proposal)
    if (!identity || proposal.entry !== identity.entry || proposal.method !== identity.method) {
      throw new StateError("Document history proposal was not issued by this ledger")
    }
    return identity
  }

  private boundIdentifier(value: unknown): string {
    const identifier = normalizeIdentifier(value)
    if (!this.boundIdentifiers.has(identifier)) {
      throw new StateError("Document restoration identifier is not bound")
    }
    return identifier
  }
}
