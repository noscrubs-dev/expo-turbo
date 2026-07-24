import { applicationAutofocusCandidates } from "./autofocus-candidates-internal.js"
import { StateError } from "./errors.js"
import type { DocumentSession } from "./session.js"
import type { DocumentTree, ProtocolDocument, ProtocolNode } from "./tree.js"

export interface PreparedDocumentAutofocus {
  readonly generation: number
}

interface DocumentAutofocusBinding {
  readonly candidateNodes: readonly ProtocolNode[]
  readonly candidates: readonly string[]
  readonly document: ProtocolDocument
  readonly generation: number
  readonly tree: DocumentTree
}

const pendingBindings = new WeakMap<DocumentSession, DocumentAutofocusBinding>()
const preparedBindings = new WeakMap<PreparedDocumentAutofocus, DocumentAutofocusBinding>()

export function prepareDocumentAutofocus(
  tree: DocumentTree,
  generation: number,
): PreparedDocumentAutofocus {
  const candidates = applicationAutofocusCandidates(tree.document)
  const candidateNodes = candidates.map((candidate) => tree.getNodeByKey(candidate))
  if (candidateNodes.some((candidate) => candidate === undefined)) {
    throw new StateError("Document autofocus candidate binding failed")
  }
  const prepared = Object.freeze({ generation })
  preparedBindings.set(prepared, {
    candidateNodes: Object.freeze(candidateNodes as ProtocolNode[]),
    candidates,
    document: tree.document,
    generation,
    tree,
  })
  return prepared
}

export function stageDocumentAutofocus(
  session: DocumentSession,
  prepared: PreparedDocumentAutofocus,
): void {
  const binding = preparedBindings.get(prepared)
  if (!binding || session.tree !== binding.tree || session.treeGeneration !== binding.generation) {
    throw new StateError("Document autofocus generation is invalid")
  }
  pendingBindings.set(session, binding)
}

export function suppressDocumentAutofocus(session: DocumentSession): void {
  pendingBindings.delete(session)
}

export function consumeDocumentAutofocus(
  session: DocumentSession,
  document: ProtocolDocument,
  generation: number,
): readonly string[] | undefined {
  const binding = pendingBindings.get(session)
  if (!binding || binding.generation !== generation) return undefined
  pendingBindings.delete(session)
  if (
    session.tree !== binding.tree ||
    session.tree.document !== document ||
    session.treeGeneration !== binding.generation ||
    binding.document !== document
  ) {
    return undefined
  }

  const candidates = applicationAutofocusCandidates(binding.document)
  if (
    candidates.length !== binding.candidates.length ||
    !candidates.every(
      (candidate, index) =>
        candidate === binding.candidates[index] &&
        binding.tree.getNodeByKey(candidate) === binding.candidateNodes[index],
    )
  ) {
    return undefined
  }
  return binding.candidates
}
