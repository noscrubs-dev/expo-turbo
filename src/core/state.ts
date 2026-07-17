import { StateError } from "./errors"

export type StateListener = () => void

export interface StateStore {
  delete(key: string): void
  get(key: string): unknown
  set(key: string, value: unknown): void
}

export interface StateSnapshot<Value = unknown> {
  readonly disposed: boolean
  readonly key: string
  readonly revision: number
  readonly value: Value | undefined
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
    this.assertActive()
    this.validateKey(key)
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
