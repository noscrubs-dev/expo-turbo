import { destinationCommitActive } from "./destination-request-ownership"
import {
  prepareDocumentAutofocus,
  stageDocumentAutofocus,
  suppressDocumentAutofocus,
} from "./document-autofocus-internal"
import type { DocumentSnapshotCache } from "./document-snapshot-cache"
import { DisposalError, StateError, TargetError } from "./errors"
import { RecentRequestIds } from "./recent-request-ids"
import { markSessionCommitError } from "./session-commit-error-internal"
import { type DocumentTree, isElement, type ProtocolNode } from "./tree"
import { registerDocumentTreeMutationGuard } from "./tree-mutation-guard"

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

export interface DocumentTreeState {
  readonly generation: number
  readonly preview: boolean
}

export type DocumentSnapshotRestoreResult = Readonly<{ status: "miss" } | { status: "restored" }>

const snapshotMiss = Object.freeze({ status: "miss" as const })
const snapshotRestored = Object.freeze({ status: "restored" as const })

/** A logical mutation committed, but synchronous disposal/listener finalization failed. */
export class SessionCommitError extends AggregateError {
  constructor(errors: readonly unknown[]) {
    super(errors, "Document session notification failed")
    this.name = "SessionCommitError"
  }
}

let nextSessionIdentity = 0

export class DocumentSession {
  readonly recentRequestIds = new RecentRequestIds()
  private readonly disposals = new Map<ProtocolNode, Set<DisposalHook>>()
  private readonly identities = new WeakMap<ProtocolNode, string>()
  private readonly listeners = new Map<string, Set<SessionListener>>()
  private readonly revisionListeners = new Set<SessionListener>()
  private readonly treeStateListeners = new Set<SessionListener>()
  private readonly sessionIdentity = nextSessionIdentity++
  private readonly snapshots = new Map<string, NodeSnapshot>()
  private currentRevision = 0
  private currentTree: DocumentTree
  private currentTreeGeneration = 0
  private currentTreeState: DocumentTreeState = Object.freeze({ generation: 0, preview: false })
  private nextIdentity = 0
  private unregisterTreeMutationGuard: (() => void) | undefined

  constructor(
    tree: DocumentTree,
    private readonly options: DocumentSessionOptions = {},
  ) {
    const autofocus = prepareDocumentAutofocus(tree, this.currentTreeGeneration)
    this.currentTree = tree
    this.guardTree(tree)
    stageDocumentAutofocus(this, autofocus)
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

  get treeState(): DocumentTreeState {
    return this.currentTreeState
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

  captureSnapshot(cache: DocumentSnapshotCache): void {
    const url = this.currentTree.document.url
    if (url === undefined) {
      throw new TargetError("Document snapshot capture requires an active document URL")
    }
    cache.put(url, this.currentTree)
  }

  restoreSnapshot(cache: DocumentSnapshotCache, url: string): DocumentSnapshotRestoreResult {
    const tree = cache.get(url)
    if (!tree) return snapshotMiss
    this.replaceTree(tree)
    return snapshotRestored
  }

  replaceTree(tree: DocumentTree): void {
    this.installTree(tree, false)
  }

  replaceTreePreview(tree: DocumentTree): void {
    this.installTree(tree, true)
  }

  subscribeTreeState(listener: SessionListener): () => void {
    this.treeStateListeners.add(listener)
    return () => this.treeStateListeners.delete(listener)
  }

  subscribeRevision(listener: SessionListener): () => void {
    this.revisionListeners.add(listener)
    return () => this.revisionListeners.delete(listener)
  }

  private installTree(tree: DocumentTree, preview: boolean): void {
    this.assertMutationAllowed()
    const generation = this.currentTreeGeneration + 1
    const autofocus = preview ? undefined : prepareDocumentAutofocus(tree, generation)
    this.currentTree = tree
    this.guardTree(tree)
    this.currentTreeGeneration = generation
    this.currentTreeState = Object.freeze({ generation, preview })
    if (autofocus) stageDocumentAutofocus(this, autofocus)
    else suppressDocumentAutofocus(this)
    const disposalErrors = this.flushDisposals()
    this.currentRevision += 1
    this.snapshots.clear()
    this.reportErrors(disposalErrors, [
      ...this.notify([...this.listeners.keys()]),
      ...this.notifyListeners(this.treeStateListeners),
      ...this.notifyListeners(this.revisionListeners),
    ])
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
    this.assertMutationAllowed()
    const node = this.currentTree.getNodeByKey(key)
    if (!node || !isElement(node)) {
      throw new TargetError(`No active element has key ${JSON.stringify(key)}`, { target: key })
    }
    this.currentTree.setAttribute(node, name, value)
    this.commit([key])
  }

  removeAttribute(key: string, name: string): void {
    this.assertMutationAllowed()
    const node = this.currentTree.getNodeByKey(key)
    if (!node || !isElement(node)) {
      throw new TargetError(`No active element has key ${JSON.stringify(key)}`, { target: key })
    }
    this.currentTree.removeAttribute(node, name)
    this.commit([key])
  }

  mutate(mutator: (tree: DocumentTree) => readonly string[]): void {
    this.assertMutationAllowed()
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
    this.reportErrors(disposalErrors, [
      ...this.notify(uniqueKeys),
      ...this.notifyListeners(this.revisionListeners),
    ])
  }

  private assertMutationAllowed(): void {
    if (destinationCommitActive(this)) {
      throw new StateError("Document session cannot mutate during a destination commit transaction")
    }
  }

  private guardTree(tree: DocumentTree): void {
    this.unregisterTreeMutationGuard?.()
    this.unregisterTreeMutationGuard = registerDocumentTreeMutationGuard(tree, () => {
      if (this.currentTree === tree) this.assertMutationAllowed()
    })
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
    return this.notifyListeners(callbacks)
  }

  private notifyListeners(listeners: Iterable<SessionListener>): unknown[] {
    const errors: unknown[] = []
    for (const callback of [...listeners]) {
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
      throw markSessionCommitError(new SessionCommitError(errors))
    }
  }
}
