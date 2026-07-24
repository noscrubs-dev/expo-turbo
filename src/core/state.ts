import { StateError } from "./errors.js"
import type { DocumentSession } from "./session.js"
import type { ProtocolNode } from "./tree.js"

export type StateListener = () => void

export interface StateStore {
  delete(key: string): void
  get(key: string): unknown
  set(key: string, value: unknown): void
}

export interface ExactStateReference {
  readonly $state: string
}

export type StateReferenceInput<Value> =
  | ExactStateReference
  | (Value extends string
      ? Value
      : Value extends readonly unknown[]
        ? { readonly [Key in keyof Value]: StateReferenceInput<Value[Key]> }
        : Value extends object
          ? { readonly [Key in keyof Value]: StateReferenceInput<Value[Key]> }
          : Value)

export interface StateReferenceOptions {
  readonly maxDepth?: number
}

export interface StateSnapshot<Value = unknown> {
  readonly disposed: boolean
  readonly key: string
  readonly revision: number
  readonly value: Value | undefined
}

export type StateScopeKind = "form" | "frame"

export interface NodeStateScope {
  readonly kind: StateScopeKind
  readonly nodeKey: string
  readonly state: DocumentStateStore
}

interface ScopeRecord {
  readonly node: ProtocolNode
  readonly scope: NodeStateScope
  unregisterDisposal(): void
}

const STATE_INTERPOLATION = /\{\{state:([^{}]*)\}\}/g

function ownDataEntries(value: object): readonly (readonly [string, unknown])[] {
  return Reflect.ownKeys(value).map((key) => {
    if (typeof key !== "string") {
      throw new StateError("State reference objects must contain only string keys")
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new StateError("State reference objects must contain only enumerable data properties")
    }
    return [key, descriptor.value] as const
  })
}

function stateValue(state: StateStore, key: string): unknown {
  if (!key.trim()) throw new StateError("State reference keys must not be blank")
  const value = state.get(key)
  if (value === undefined) {
    throw new StateError(`State reference ${JSON.stringify(key)} has no value`, { target: key })
  }
  return value
}

function interpolatedValue(state: StateStore, key: string): string {
  const value = stateValue(state, key)
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "bigint" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return String(value)
  }
  throw new StateError(`State reference ${JSON.stringify(key)} is not a scalar string value`, {
    target: key,
  })
}

export function resolveStateReferences(
  input: unknown,
  state: StateStore,
  options: StateReferenceOptions = {},
): unknown {
  const maxDepth = options.maxDepth ?? 32
  if (!Number.isInteger(maxDepth) || maxDepth < 1) {
    throw new StateError("State reference maxDepth must be a positive integer")
  }
  const active = new Set<object>()

  const resolve = (value: unknown, depth: number): unknown => {
    if (depth > maxDepth) throw new StateError("State reference input exceeds maxDepth")
    if (typeof value === "string") {
      const remainder = value.replace(STATE_INTERPOLATION, "")
      if (remainder.includes("{{state")) {
        throw new StateError("State interpolation is malformed")
      }
      return value.replace(STATE_INTERPOLATION, (_token, key: string) =>
        interpolatedValue(state, key),
      )
    }
    if (value === null || typeof value !== "object") return value
    if (active.has(value)) throw new StateError("State reference input contains a cycle")

    active.add(value)
    try {
      if (Array.isArray(value)) {
        if (Object.hasOwn(value, "$state")) {
          throw new StateError("Exact state references must be plain objects")
        }
        return value.map((item) => resolve(item, depth + 1))
      }
      const prototype = Object.getPrototypeOf(value)
      if (prototype !== Object.prototype && prototype !== null) {
        throw new StateError("State reference input must contain only arrays and plain objects")
      }
      const entries = ownDataEntries(value)
      const exactReference = entries.find(([key]) => key === "$state")
      if (exactReference) {
        if (entries.length !== 1 || typeof exactReference[1] !== "string") {
          throw new StateError('Exact state references must contain only a string "$state" key')
        }
        return stateValue(state, exactReference[1])
      }
      return Object.fromEntries(entries.map(([key, item]) => [key, resolve(item, depth + 1)]))
    } finally {
      active.delete(value)
    }
  }

  return resolve(input, 0)
}

export class DocumentStateStore implements StateStore {
  private disposed = false
  private readonly listeners = new Map<string, Set<StateListener>>()
  private revision = 0
  private readonly snapshots = new Map<string, StateSnapshot>()
  private readonly values = new Map<string, unknown>()

  constructor(initial: Readonly<Record<string, unknown>> = {}) {
    for (const [key, value] of Object.entries(initial)) {
      this.validateKey(key)
      this.values.set(key, value)
    }
  }

  get isDisposed(): boolean {
    return this.disposed
  }

  delete(key: string): void {
    this.assertActive()
    this.validateKey(key)
    if (!this.values.delete(key)) return
    this.commit(key)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.revision += 1
    this.values.clear()
    this.snapshots.clear()
    for (const [key, listeners] of this.listeners) {
      this.snapshots.set(key, this.createSnapshot(key))
      for (const listener of listeners) listener()
    }
    this.listeners.clear()
  }

  get(key: string): unknown {
    this.assertActive()
    this.validateKey(key)
    return this.values.get(key)
  }

  getSnapshot<Value = unknown>(key: string): StateSnapshot<Value> {
    this.validateKey(key)
    let snapshot = this.snapshots.get(key)
    if (!snapshot) {
      snapshot = this.createSnapshot(key)
      this.snapshots.set(key, snapshot)
    }
    return snapshot as StateSnapshot<Value>
  }

  set(key: string, value: unknown): void {
    this.assertActive()
    this.validateKey(key)
    if (this.values.has(key) && Object.is(this.values.get(key), value)) return
    this.values.set(key, value)
    this.commit(key)
  }

  subscribe(key: string, listener: StateListener): () => void {
    this.validateKey(key)
    if (this.disposed) return () => undefined
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

  private assertActive(): void {
    if (this.disposed) throw new StateError("Document state store has been disposed")
  }

  private commit(key: string): void {
    this.revision += 1
    this.snapshots.delete(key)
    for (const listener of this.listeners.get(key) ?? []) listener()
  }

  private createSnapshot(key: string): StateSnapshot {
    return Object.freeze({
      disposed: this.disposed,
      key,
      revision: this.revision,
      value: this.values.get(key),
    })
  }

  private validateKey(key: string): void {
    if (!key.trim()) throw new StateError("Document state keys must not be blank")
  }
}

export class DocumentStateScopes {
  private disposed = false
  private readonly records = new Map<ProtocolNode, ScopeRecord>()

  constructor(private readonly session: DocumentSession) {}

  get isDisposed(): boolean {
    return this.disposed
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const record of this.records.values()) {
      record.unregisterDisposal()
      record.scope.state.dispose()
    }
    this.records.clear()
  }

  disposeScope(nodeKey: string): void {
    this.assertActive()
    const node = this.activeNode(nodeKey)
    const record = this.records.get(node)
    if (!record) return
    record.unregisterDisposal()
    record.scope.state.dispose()
    this.records.delete(node)
  }

  scopeFor(
    nodeKey: string,
    kind: StateScopeKind,
    initial: Readonly<Record<string, unknown>> = {},
  ): NodeStateScope {
    this.assertActive()
    const node = this.activeNode(nodeKey)
    const existing = this.records.get(node)
    if (existing) {
      if (existing.scope.kind !== kind) {
        throw new StateError(
          `Node ${JSON.stringify(nodeKey)} already owns a ${existing.scope.kind} state scope`,
          { target: nodeKey },
        )
      }
      return existing.scope
    }

    const scope = Object.freeze({
      kind,
      nodeKey,
      state: new DocumentStateStore(initial),
    })
    const record: ScopeRecord = {
      node,
      scope,
      unregisterDisposal: () => undefined,
    }
    record.unregisterDisposal = this.session.registerDisposal(nodeKey, () => {
      if (this.records.get(node) !== record) return
      this.records.delete(node)
      scope.state.dispose()
    })
    this.records.set(node, record)
    return scope
  }

  private activeNode(nodeKey: string): ProtocolNode {
    const node = this.session.tree.getNodeByKey(nodeKey)
    if (!node) {
      throw new StateError(`No active node has key ${JSON.stringify(nodeKey)}`, {
        target: nodeKey,
      })
    }
    return node
  }

  private assertActive(): void {
    if (this.disposed) throw new StateError("Document state scopes have been disposed")
  }
}
