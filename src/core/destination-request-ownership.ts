import { StateError } from "./errors"
import type { DocumentSession } from "./session"
import { attributeValue, type ProtocolElement } from "./tree"

export interface DestinationRequestLease {
  readonly controller: AbortController
  readonly destination: "document" | "frame"
  readonly documentClaimSerial?: number
  readonly frame?: ProtocolElement
  readonly frameId?: string
  readonly sourceOwner?: object
  readonly treeGeneration: number
}

export interface FrameRequestCheckpoint {
  readonly frame: ProtocolElement
  readonly frameId: string
  readonly generation: number
  readonly treeGeneration: number
}

class DestinationRequestOwnership {
  private document: DestinationRequestLease | undefined
  private documentClaimSerial = 0
  private documentCommit: DestinationRequestLease | undefined
  private frameCommit: DestinationRequestLease | undefined
  private readonly frameGenerations = new WeakMap<ProtocolElement, number>()
  private readonly frames = new Map<string, DestinationRequestLease>()
  private readonly sourceOwners = new WeakMap<object, DestinationRequestLease>()

  constructor(private readonly session: DocumentSession) {}

  get currentDocumentClaimSerial(): number {
    return this.documentClaimSerial
  }

  claimDocument(
    controller: AbortController,
    treeGeneration: number,
    sourceOwner?: object,
  ): DestinationRequestLease {
    if (this.session.treeGeneration !== treeGeneration) {
      throw new StateError("Destination request no longer owns its document tree")
    }
    const lease: DestinationRequestLease = Object.freeze({
      controller,
      destination: "document",
      documentClaimSerial: this.documentClaimSerial + 1,
      ...(sourceOwner ? { sourceOwner } : {}),
      treeGeneration,
    })
    return this.claim(lease)
  }

  claimFrame(
    frame: ProtocolElement,
    controller: AbortController,
    sourceOwner?: object,
  ): DestinationRequestLease {
    const frameId = attributeValue(frame, "id")
    if (frame.kind !== "frame" || !frameId || this.session.tree.getElementById(frameId) !== frame) {
      throw new StateError("Destination request requires an exact active Frame", {
        ...(frameId ? { frameId } : {}),
      })
    }
    const lease: DestinationRequestLease = Object.freeze({
      controller,
      destination: "frame",
      frame,
      frameId,
      ...(sourceOwner ? { sourceOwner } : {}),
      treeGeneration: this.session.treeGeneration,
    })
    return this.claim(lease)
  }

  cancel(lease: DestinationRequestLease): boolean {
    if (this.documentCommit === lease || this.frameCommit === lease) return false
    this.detach(lease)
    lease.controller.abort()
    return true
  }

  owns(lease: DestinationRequestLease): boolean {
    if (
      lease.controller.signal.aborted ||
      this.session.treeGeneration !== lease.treeGeneration ||
      (lease.sourceOwner && this.sourceOwners.get(lease.sourceOwner) !== lease)
    ) {
      return false
    }
    if (lease.destination === "document") {
      return this.document === lease
    }
    return Boolean(
      lease.frame &&
        lease.frameId &&
        this.frames.get(lease.frameId) === lease &&
        this.session.tree.getElementById(lease.frameId) === lease.frame,
    )
  }

  isCommitting(lease: DestinationRequestLease): boolean {
    return this.documentCommit === lease || this.frameCommit === lease
  }

  get commitActive(): boolean {
    return this.documentCommit !== undefined || this.frameCommit !== undefined
  }

  /** Retains staged-application ownership after the owning response changes the tree generation. */
  retains(lease: DestinationRequestLease): boolean {
    if (lease.controller.signal.aborted) return false
    const destinationRetained =
      lease.destination === "document"
        ? this.document === lease
        : Boolean(lease.frameId && this.frames.get(lease.frameId) === lease)
    return Boolean(
      destinationRetained &&
        (!lease.sourceOwner || this.sourceOwners.get(lease.sourceOwner) === lease),
    )
  }

  commitDocument(lease: DestinationRequestLease, callback: () => void): boolean {
    if (lease.destination !== "document") {
      throw new StateError("Document commit ownership requires a document lease")
    }
    if (!this.owns(lease)) return false
    if (this.documentCommit || this.frameCommit) {
      throw new StateError("A document commit transaction is already active")
    }
    this.documentCommit = lease
    try {
      callback()
      return true
    } finally {
      if (this.documentCommit === lease) this.documentCommit = undefined
    }
  }

  commitFrame(lease: DestinationRequestLease, callback: () => void): boolean {
    if (lease.destination !== "frame") {
      throw new StateError("Frame commit ownership requires a Frame lease")
    }
    if (!this.owns(lease)) return false
    if (this.documentCommit || this.frameCommit) {
      throw new StateError("A Frame commit transaction is already active")
    }
    this.frameCommit = lease
    try {
      callback()
      return true
    } finally {
      if (this.frameCommit === lease) this.frameCommit = undefined
    }
  }

  checkpointFrame(frame: ProtocolElement): FrameRequestCheckpoint {
    const frameId = attributeValue(frame, "id")
    if (frame.kind !== "frame" || !frameId || this.session.tree.getElementById(frameId) !== frame) {
      throw new StateError("Destination request checkpoint requires an exact active Frame", {
        ...(frameId ? { frameId } : {}),
      })
    }
    return Object.freeze({
      frame,
      frameId,
      generation: this.frameGenerations.get(frame) ?? 0,
      treeGeneration: this.session.treeGeneration,
    })
  }

  transferFrame(
    lease: DestinationRequestLease,
    checkpoint: FrameRequestCheckpoint,
  ): DestinationRequestLease | undefined {
    const { frame, frameId } = checkpoint
    if (
      !this.owns(lease) ||
      this.session.treeGeneration !== checkpoint.treeGeneration ||
      this.session.tree.getElementById(frameId) !== frame ||
      (this.frameGenerations.get(frame) ?? 0) !== checkpoint.generation
    ) {
      return undefined
    }
    this.detach(lease)
    return this.claim(
      Object.freeze({
        controller: lease.controller,
        destination: "frame",
        frame,
        frameId,
        ...(lease.sourceOwner ? { sourceOwner: lease.sourceOwner } : {}),
        treeGeneration: this.session.treeGeneration,
      }),
    )
  }

  release(lease: DestinationRequestLease): void {
    this.detach(lease)
  }

  private claim(lease: DestinationRequestLease): DestinationRequestLease {
    if (this.documentCommit) {
      throw new StateError("Destination requests cannot start during a document commit transaction")
    }
    if (this.frameCommit) {
      throw new StateError("Destination requests cannot start during a Frame commit transaction")
    }
    if (
      lease.destination === "document" &&
      lease.documentClaimSerial !== this.documentClaimSerial + 1
    ) {
      throw new StateError("Document destination claim serial is invalid")
    }
    const displaced = new Set<DestinationRequestLease>()
    const destinationLease =
      lease.destination === "document"
        ? this.document
        : lease.frameId
          ? this.frames.get(lease.frameId)
          : undefined
    const ownerLease = lease.sourceOwner ? this.sourceOwners.get(lease.sourceOwner) : undefined
    if (destinationLease) displaced.add(destinationLease)
    if (ownerLease) displaced.add(ownerLease)

    for (const current of displaced) this.detach(current)
    if (lease.destination === "document") this.document = lease
    else if (lease.frameId) {
      this.frames.set(lease.frameId, lease)
      if (lease.frame) {
        this.frameGenerations.set(lease.frame, (this.frameGenerations.get(lease.frame) ?? 0) + 1)
      }
    }
    if (lease.sourceOwner) this.sourceOwners.set(lease.sourceOwner, lease)
    if (lease.destination === "document") {
      this.documentClaimSerial = lease.documentClaimSerial as number
    }

    // Install the new lease before aborting displaced work. Abort listeners may
    // synchronously start newer work, which must be able to supersede this one.
    for (const current of displaced) current.controller.abort()
    return lease
  }

  private detach(lease: DestinationRequestLease): void {
    if (lease.destination === "document") {
      if (this.document === lease) this.document = undefined
    } else if (lease.frameId && this.frames.get(lease.frameId) === lease) {
      this.frames.delete(lease.frameId)
    }
    if (lease.sourceOwner && this.sourceOwners.get(lease.sourceOwner) === lease) {
      this.sourceOwners.delete(lease.sourceOwner)
    }
  }
}

const ownershipBySession = new WeakMap<DocumentSession, DestinationRequestOwnership>()

export function destinationRequestOwnership(session: DocumentSession): DestinationRequestOwnership {
  let ownership = ownershipBySession.get(session)
  if (!ownership) {
    ownership = new DestinationRequestOwnership(session)
    ownershipBySession.set(session, ownership)
  }
  return ownership
}

export function destinationCommitActive(session: DocumentSession): boolean {
  return ownershipBySession.get(session)?.commitActive ?? false
}
