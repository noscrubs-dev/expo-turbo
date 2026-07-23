import type { DocumentSession, SessionListener } from "./session"

const listenersBySession = new WeakMap<DocumentSession, Set<SessionListener>>()

export function subscribeBeforeSessionMutation(
  session: DocumentSession,
  listener: SessionListener,
): () => void {
  let listeners = listenersBySession.get(session)
  if (!listeners) {
    listeners = new Set()
    listenersBySession.set(session, listeners)
  }
  listeners.add(listener)
  return () => {
    listeners?.delete(listener)
    if (listeners?.size === 0) listenersBySession.delete(session)
  }
}

export function notifyBeforeSessionMutation(session: DocumentSession): void {
  for (const listener of [...(listenersBySession.get(session) ?? [])]) listener()
}
