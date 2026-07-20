import type { DocumentSession } from "./session"
import type { ProtocolNode } from "./tree"

interface StreamAutofocusBinding {
  readonly candidates: readonly string[]
  readonly nodes: readonly ProtocolNode[]
  readonly revision: number
}

interface StreamAutofocusState {
  readonly listeners: Set<() => void>
  pending: StreamAutofocusBinding | undefined
  revision: number
}

const states = new WeakMap<DocumentSession, StreamAutofocusState>()

function stateFor(session: DocumentSession): StreamAutofocusState {
  let state = states.get(session)
  if (!state) {
    state = { listeners: new Set(), pending: undefined, revision: 0 }
    states.set(session, state)
  }
  return state
}

function notify(state: StreamAutofocusState): void {
  const errors: unknown[] = []
  for (const listener of [...state.listeners]) {
    try {
      listener()
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length === 0) return
  queueMicrotask(() => {
    throw new AggregateError(errors, "Stream autofocus lifecycle subscribers failed")
  })
}

function liveCandidates(
  session: DocumentSession,
  binding: StreamAutofocusBinding,
): readonly string[] {
  return binding.candidates.filter(
    (candidate, index) => session.tree.getNodeByKey(candidate) === binding.nodes[index],
  )
}

export function streamAutofocusLifecycleRevision(session: DocumentSession): number {
  return stateFor(session).revision
}

export function subscribeStreamAutofocusLifecycle(
  session: DocumentSession,
  listener: () => void,
): () => void {
  const state = stateFor(session)
  state.listeners.add(listener)
  return () => state.listeners.delete(listener)
}

export function stageStandaloneStreamAutofocus(
  session: DocumentSession,
  candidates: readonly ProtocolNode[],
): void {
  const state = stateFor(session)
  if (state.pending && liveCandidates(session, state.pending).length > 0) return

  const seen = new Set<ProtocolNode>()
  const nodes: ProtocolNode[] = []
  for (const candidate of candidates) {
    if (seen.has(candidate) || session.tree.getNodeByKey(candidate.key) !== candidate) continue
    seen.add(candidate)
    nodes.push(candidate)
  }
  const pending =
    nodes.length === 0
      ? undefined
      : Object.freeze({
          candidates: Object.freeze(nodes.map((candidate) => candidate.key)),
          nodes: Object.freeze([...nodes]),
          revision: session.revision,
        })
  if (!state.pending && !pending) return
  state.pending = pending
  state.revision += 1
  notify(state)
}

export function pruneStandaloneStreamAutofocus(session: DocumentSession): void {
  const state = states.get(session)
  if (!state?.pending || liveCandidates(session, state.pending).length > 0) return
  state.pending = undefined
  state.revision += 1
  notify(state)
}

export function consumeStandaloneStreamAutofocus(
  session: DocumentSession,
  revision: number,
): readonly string[] | undefined {
  const state = states.get(session)
  const pending = state?.pending
  if (!state || !pending) return undefined
  if (revision !== session.revision || pending.revision > revision) return undefined
  state.pending = undefined
  const candidates = liveCandidates(session, pending)
  return candidates.length > 0 ? Object.freeze(candidates) : undefined
}
