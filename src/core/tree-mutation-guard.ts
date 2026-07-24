import type { DocumentTree } from "./tree.js"

type DocumentTreeMutationGuard = () => void

const mutationGuards = new WeakMap<DocumentTree, Set<DocumentTreeMutationGuard>>()

export function assertDocumentTreeMutationAllowed(tree: DocumentTree): void {
  const guards = mutationGuards.get(tree)
  if (!guards) return
  for (const guard of [...guards]) guard()
}

export function registerDocumentTreeMutationGuard(
  tree: DocumentTree,
  guard: DocumentTreeMutationGuard,
): () => void {
  let guards = mutationGuards.get(tree)
  if (!guards) {
    guards = new Set()
    mutationGuards.set(tree, guards)
  }
  guards.add(guard)
  let active = true
  return () => {
    if (!active) return
    active = false
    guards?.delete(guard)
    if (guards?.size === 0) mutationGuards.delete(tree)
  }
}
