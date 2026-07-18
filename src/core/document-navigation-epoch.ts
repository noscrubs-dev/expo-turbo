import type { DocumentSession } from "./session"

const documentNavigationEpochs = new WeakMap<DocumentSession, number>()

export function beginDocumentNavigation(session: DocumentSession): number {
  const epoch = currentDocumentNavigationEpoch(session) + 1
  documentNavigationEpochs.set(session, epoch)
  return epoch
}

export function currentDocumentNavigationEpoch(session: DocumentSession): number {
  return documentNavigationEpochs.get(session) ?? 0
}
