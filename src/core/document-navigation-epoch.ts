import type { DocumentSession } from "./session"

const documentNavigationEpochs = new WeakMap<DocumentSession, number>()
const documentNavigationListeners = new WeakMap<DocumentSession, Set<() => void>>()

export function beginDocumentNavigation(session: DocumentSession): number {
  const epoch = currentDocumentNavigationEpoch(session) + 1
  documentNavigationEpochs.set(session, epoch)
  for (const listener of [...(documentNavigationListeners.get(session) ?? [])]) listener()
  return epoch
}

export function currentDocumentNavigationEpoch(session: DocumentSession): number {
  return documentNavigationEpochs.get(session) ?? 0
}

export function subscribeDocumentNavigation(
  session: DocumentSession,
  listener: () => void,
): () => void {
  let listeners = documentNavigationListeners.get(session)
  if (!listeners) {
    listeners = new Set()
    documentNavigationListeners.set(session, listeners)
  }
  listeners.add(listener)
  return () => {
    listeners?.delete(listener)
    if (listeners?.size === 0) documentNavigationListeners.delete(session)
  }
}
