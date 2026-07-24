import { StateError } from "./errors.js"
import type { DocumentSession } from "./session.js"
import type { DocumentTree } from "./tree.js"

type DocumentSessionMorpher = (tree: DocumentTree) => void

const documentSessionMorphers = new WeakMap<DocumentSession, DocumentSessionMorpher>()

/** @internal Registers the session-owned bounded current-document morph capability. */
export function registerDocumentSessionMorpher(
  session: DocumentSession,
  morph: DocumentSessionMorpher,
): void {
  documentSessionMorphers.set(session, morph)
}

/** @internal Commits a preflighted bounded current-document refresh morph. */
export function morphCurrentDocument(session: DocumentSession, tree: DocumentTree): void {
  const morph = documentSessionMorphers.get(session)
  if (!morph) throw new StateError("Current-document refresh morph requires an active session")
  morph(tree)
}
