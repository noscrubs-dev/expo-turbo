import type { DocumentSession } from "./session"
import type { DocumentTree, ProtocolDocument } from "./tree"

interface DocumentRefreshScrollBinding {
  readonly document: ProtocolDocument
  readonly generation: number
  readonly tree: DocumentTree
}

const preparedSessions = new WeakSet<DocumentSession>()
const pendingBindings = new WeakMap<DocumentSession, DocumentRefreshScrollBinding>()

/** @internal Marks the next authoritative document tree generation for a top reset. */
export function prepareDocumentRefreshScroll(session: DocumentSession): void {
  preparedSessions.add(session)
}

/** @internal Binds a prepared reset to the exact committed document generation. */
export function stageDocumentRefreshScroll(
  session: DocumentSession,
  tree: DocumentTree,
  generation: number,
): void {
  const prepared = preparedSessions.delete(session)
  pendingBindings.delete(session)
  if (!prepared) return
  pendingBindings.set(session, { document: tree.document, generation, tree })
}

/** @internal Clears a pre-commit reset marker after a failed tree commit. */
export function suppressPreparedDocumentRefreshScroll(session: DocumentSession): void {
  preparedSessions.delete(session)
}

/** @internal Drops a reset that never reached its exact renderer acknowledgement. */
export function discardDocumentRefreshScroll(session: DocumentSession, generation: number): void {
  const binding = pendingBindings.get(session)
  if (binding?.generation === generation) pendingBindings.delete(session)
}

/** @internal Consumes one reset only for the exact active rendered document generation. */
export function consumeDocumentRefreshScroll(
  session: DocumentSession,
  document: ProtocolDocument,
  generation: number,
): boolean {
  const binding = pendingBindings.get(session)
  if (!binding || binding.generation !== generation) return false
  pendingBindings.delete(session)
  return (
    session.tree === binding.tree &&
    session.tree.document === document &&
    session.treeGeneration === generation &&
    binding.document === document
  )
}
