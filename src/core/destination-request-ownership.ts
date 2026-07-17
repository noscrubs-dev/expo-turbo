import { StateError } from "./errors"
import type { DocumentSession } from "./session"
import { attributeValue, type ProtocolElement } from "./tree"

export interface DestinationRequestLease {
  readonly controller: AbortController
  readonly destination: "document" | "frame"
  readonly frame?: ProtocolElement
  readonly frameId?: string
  readonly sourceOwner?: object
  readonly treeGeneration: number
}

class DestinationRequestOwnership {
  private document: DestinationRequestLease | undefined
  private readonly frames = new Map<string, DestinationRequestLease>()
  private readonly sourceOwners = new WeakMap<object, DestinationRequestLease>()

  constructor(private readonly session: DocumentSession) {}

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

  cancel(lease: DestinationRequestLease): void {
    this.detach(lease)
    lease.controller.abort()
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

  release(lease: DestinationRequestLease): void {
    this.detach(lease)
  }

  private claim(lease: DestinationRequestLease): DestinationRequestLease {
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
    else if (lease.frameId) this.frames.set(lease.frameId, lease)
    if (lease.sourceOwner) this.sourceOwners.set(lease.sourceOwner, lease)

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
