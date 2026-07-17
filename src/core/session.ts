import { DisposalError, TargetError } from "./errors"
import { type DocumentTree, isElement, type ProtocolNode } from "./tree"

export type SessionListener = () => void
export type DisposalHook = () => void

export interface DocumentSessionOptions {
  readonly onDisposalError?: (error: DisposalError) => void
}

export interface NodeSnapshot {
  readonly identity: string
  readonly node: ProtocolNode
  readonly revision: number
}

/** A logical mutation committed, but synchronous disposal/listener finalization failed. */
export class SessionCommitError extends AggregateError {
  constructor(errors: readonly unknown[]) {
    super(errors, "Document session notification failed")
    this.name = "SessionCommitError"
  }
}

let nextSessionIdentity = 0

export class DocumentSession {
  private readonly disposals = new Map<ProtocolNode, Set<DisposalHook>>()
  private readonly identities = new WeakMap<ProtocolNode, string>()
  private readonly listeners = new Map<string, Set<SessionListener>>()
  private readonly sessionIdentity = nextSessionIdentity++
  private readonly snapshots = new Map<string, NodeSnapshot>()
  private currentRevision = 0
  private currentTree: DocumentTree
  private currentTreeGeneration = 0
  private nextIdentity = 0

  constructor(
    tree: DocumentTree,
    private readonly options: DocumentSessionOptions = {},
  ) {
    this.currentTree = tree
  }

  get revision(): number {
    return this.currentRevision
  }

  get tree(): DocumentTree {
    return this.currentTree
  }

  get treeGeneration(): number {
    return this.currentTreeGeneration
  }

  getNodeSnapshot(key: string): NodeSnapshot | undefined {
    const cached = this.snapshots.get(key)
    if (cached) return cached
    const node = this.currentTree.getNodeByKey(key)
    if (!node) return undefined
    let identity = this.identities.get(node)
    if (identity === undefined) {
      identity = `${this.sessionIdentity}:${this.nextIdentity++}`
      this.identities.set(node, identity)
    }
    const snapshot = Object.freeze({ identity, node, revision: this.currentRevision })
    this.snapshots.set(key, snapshot)
    return snapshot
  }

  replaceTree(tree: DocumentTree): void {
    this.currentTree = tree
    this.currentTreeGeneration += 1
    const disposalErrors = this.flushDisposals()
    this.currentRevision += 1
    this.snapshots.clear()
    this.reportErrors(disposalErrors, this.notify([...this.listeners.keys()]))
  }

  registerDisposal(key: string, hook: DisposalHook): () => void {
    const node = this.currentTree.getNodeByKey(key)
    if (!node) {
      throw new TargetError(`No active node has key ${JSON.stringify(key)}`, { target: key })
    }
    let hooks = this.disposals.get(node)
    if (!hooks) {
      hooks = new Set()
      this.disposals.set(node, hooks)
    }
    hooks.add(hook)
    return () => {
      hooks?.delete(hook)
      if (hooks?.size === 0) this.disposals.delete(node)
    }
  }

  setAttribute(key: string, name: string, value: string): void {
    const node = this.currentTree.getNodeByKey(key)
    if (!node || !isElement(node)) {
      throw new TargetError(`No active element has key ${JSON.stringify(key)}`, { target: key })
    }
    this.currentTree.setAttribute(node, name, value)
    this.commit([key])
  }

  removeAttribute(key: string, name: string): void {
    const node = this.currentTree.getNodeByKey(key)
    if (!node || !isElement(node)) {
      throw new TargetError(`No active element has key ${JSON.stringify(key)}`, { target: key })
    }
    this.currentTree.removeAttribute(node, name)
    this.commit([key])
  }

  mutate(mutator: (tree: DocumentTree) => readonly string[]): void {
    this.commit(mutator(this.currentTree))
  }

  subscribe(key: string, listener: SessionListener): () => void {
    let listeners = this.listeners.get(key)
    if (!listeners) {
      listeners = new Set()
      this.listeners.set(key, listeners)
    }
    listeners.add(listener)
    return () => {
      listeners?.delete(listener)
      if (listeners?.size === 0) this.listeners.delete(key)
    }
  }

  private commit(keys: readonly string[]): void {
    const disposalErrors = this.flushDisposals()
    this.currentRevision += 1
    const uniqueKeys = new Set(keys)
    for (const key of uniqueKeys) this.snapshots.delete(key)
    this.reportErrors(disposalErrors, this.notify(uniqueKeys))
  }

  private flushDisposals(): DisposalError[] {
    const removed = [...this.disposals.entries()]
      .filter(([node]) => !this.currentTree.contains(node))
      .sort(([left], [right]) => {
        const depth = (node: ProtocolNode) => {
          let value = 0
          let parent = node.parent
          while (parent) {
            value += 1
            parent = parent.parent
          }
          return value
        }
        return depth(right) - depth(left) || left.key.localeCompare(right.key)
      })
    const errors: DisposalError[] = []
    for (const [node, hooks] of removed) {
      this.disposals.delete(node)
      for (const hook of hooks) {
        try {
          hook()
        } catch (error) {
          errors.push(
            new DisposalError(
              `Disposal hook failed for node ${JSON.stringify(node.key)}`,
              {
                target: node.key,
              },
              { cause: error },
            ),
          )
        }
      }
    }
    return errors
  }

  private notify(keys: Iterable<string>): unknown[] {
    const callbacks: SessionListener[] = []
    for (const key of keys) {
      const listeners = this.listeners.get(key)
      if (listeners) callbacks.push(...listeners)
    }
    const errors: unknown[] = []
    for (const callback of callbacks) {
      try {
        callback()
      } catch (error) {
        errors.push(error)
      }
    }
    return errors
  }

  private reportErrors(
    disposalErrors: readonly DisposalError[],
    listenerErrors: readonly unknown[],
  ): void {
    const errors = [...listenerErrors]
    if (this.options.onDisposalError) {
      for (const disposalError of disposalErrors) {
        try {
          this.options.onDisposalError(disposalError)
        } catch (reporterError) {
          errors.push(disposalError, reporterError)
        }
      }
    } else {
      errors.unshift(...disposalErrors)
    }
    if (errors.length > 0) {
      throw new SessionCommitError(errors)
    }
  }
}
