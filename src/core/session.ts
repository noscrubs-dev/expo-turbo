import { TargetError } from "./errors"
import { type DocumentTree, isElement, type ProtocolNode } from "./tree"

export type SessionListener = () => void

export interface NodeSnapshot {
  readonly node: ProtocolNode
  readonly revision: number
}

export class DocumentSession {
  private readonly listeners = new Map<string, Set<SessionListener>>()
  private readonly snapshots = new Map<string, NodeSnapshot>()
  private currentRevision = 0
  private currentTree: DocumentTree

  constructor(tree: DocumentTree) {
    this.currentTree = tree
  }

  get revision(): number {
    return this.currentRevision
  }

  get tree(): DocumentTree {
    return this.currentTree
  }

  getNodeSnapshot(key: string): NodeSnapshot | undefined {
    const cached = this.snapshots.get(key)
    if (cached) return cached
    const node = this.currentTree.getNodeByKey(key)
    if (!node) return undefined
    const snapshot = Object.freeze({ node, revision: this.currentRevision })
    this.snapshots.set(key, snapshot)
    return snapshot
  }

  replaceTree(tree: DocumentTree): void {
    this.currentTree = tree
    this.currentRevision += 1
    this.snapshots.clear()
    for (const listeners of this.listeners.values()) {
      for (const listener of listeners) listener()
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
    this.currentRevision += 1
    for (const key of new Set(keys)) {
      this.snapshots.delete(key)
      const listeners = this.listeners.get(key)
      if (!listeners) continue
      for (const listener of listeners) listener()
    }
  }
}
