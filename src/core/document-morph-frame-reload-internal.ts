import type { DocumentSession } from "./session"
import type { ProtocolDocument, ProtocolElement } from "./tree"

type DocumentMorphFrameReloader = (frames: readonly ProtocolElement[]) => void

interface PendingDocumentMorphFrameReload {
  readonly document: ProtocolDocument
  readonly frames: readonly ProtocolElement[]
  readonly generation: number
}

const pendingReloads = new WeakMap<DocumentSession, PendingDocumentMorphFrameReload>()
const reloaders = new WeakMap<DocumentSession, DocumentMorphFrameReloader>()

export function registerDocumentMorphFrameReloader(
  session: DocumentSession,
  reload: DocumentMorphFrameReloader,
): () => void {
  reloaders.set(session, reload)
  return () => {
    if (reloaders.get(session) === reload) reloaders.delete(session)
  }
}

export function stageDocumentMorphFrameReloads(
  session: DocumentSession,
  document: ProtocolDocument,
  generation: number,
  frames: readonly ProtocolElement[],
): void {
  if (frames.length === 0) {
    pendingReloads.delete(session)
    return
  }
  pendingReloads.set(session, {
    document,
    frames: Object.freeze([...frames]),
    generation,
  })
}

export function notifyDocumentMorphFrameReloads(
  session: DocumentSession,
  document: ProtocolDocument,
  generation: number,
): void {
  const pending = pendingReloads.get(session)
  pendingReloads.delete(session)
  if (
    !pending ||
    pending.document !== document ||
    pending.generation !== generation ||
    session.tree.document !== document ||
    session.treeGeneration !== generation
  ) {
    return
  }
  try {
    reloaders.get(session)?.(pending.frames)
  } catch {
    // A host-owned mounted-Frame continuation cannot roll back the committed document morph.
  }
}
