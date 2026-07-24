import type { MorphLifecycle } from "./morph-lifecycle.js"
import type { DocumentTree } from "./tree.js"

const lifecycles = new WeakMap<DocumentTree, MorphLifecycle>()
const dispatching = new WeakSet<DocumentTree>()

export function installMorphLifecycle(
  tree: DocumentTree,
  lifecycle: MorphLifecycle | undefined,
): void {
  if (lifecycle) lifecycles.set(tree, lifecycle)
  else lifecycles.delete(tree)
}

export function documentTreeMorphLifecycle(tree: DocumentTree): MorphLifecycle | undefined {
  return lifecycles.get(tree)
}

export function morphLifecycleDispatchActive(tree: DocumentTree): boolean {
  return dispatching.has(tree)
}

export function dispatchMorphLifecycle<Result>(tree: DocumentTree, dispatch: () => Result): Result {
  dispatching.add(tree)
  try {
    return dispatch()
  } finally {
    dispatching.delete(tree)
  }
}
