import { PropsError, RegistryError, StateError, TargetError } from "./errors"
import type { DocumentSession } from "./session"
import { isElement, type ProtocolElement, type ProtocolNode } from "./tree"

interface FormControlBase {
  readonly disabled?: boolean
  readonly name?: string
}

export type FormControlDescriptor =
  | (FormControlBase & {
      readonly kind: "checkable"
      readonly checked: boolean
      readonly value?: string
    })
  | (FormControlBase & {
      readonly kind: "multiple"
      readonly values: readonly string[]
    })
  | (FormControlBase & {
      readonly kind: "submitter"
      readonly value?: string
    })
  | (FormControlBase & {
      readonly kind: "value"
      readonly value: string
    })

export interface SuccessfulFormEntry {
  readonly name: string
  readonly value: string
}

export interface SuccessfulFormEntriesOptions {
  readonly submitterNodeKey?: string
}

export interface FormControlRegistration {
  readonly nodeKey: string
  unregister(): void
  update(descriptor: FormControlDescriptor): void
}

interface FormControlRecord {
  descriptor: FormControlDescriptor
  readonly node: ProtocolElement
  unregisterDisposal: () => void
}

interface DocumentFormControlRecord {
  readonly node: ProtocolElement
  readonly registry: FormControlRegistry
  unregisterDisposal: () => void
}

function normalizeDescriptor(
  descriptor: FormControlDescriptor,
  nodeKey: string,
): FormControlDescriptor {
  if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) {
    throw new PropsError("Form control descriptors must be objects")
  }
  if (descriptor.name !== undefined && typeof descriptor.name !== "string") {
    throw new PropsError("Form control name must be a string", { target: nodeKey })
  }
  if (descriptor.disabled !== undefined && typeof descriptor.disabled !== "boolean") {
    throw new PropsError("Form control disabled must be a boolean", {
      target: nodeKey,
    })
  }

  const base = {
    ...(descriptor.name !== undefined ? { name: descriptor.name } : {}),
    ...(descriptor.disabled !== undefined ? { disabled: descriptor.disabled } : {}),
  }
  switch (descriptor.kind) {
    case "checkable":
      if (typeof descriptor.checked !== "boolean") {
        throw new PropsError("Checkable form control checked must be a boolean", {
          target: nodeKey,
        })
      }
      if (descriptor.value !== undefined && typeof descriptor.value !== "string") {
        throw new PropsError("Checkable form control value must be a string", {
          target: nodeKey,
        })
      }
      return Object.freeze({
        ...base,
        checked: descriptor.checked,
        kind: descriptor.kind,
        ...(descriptor.value !== undefined ? { value: descriptor.value } : {}),
      })
    case "multiple": {
      if (!Array.isArray(descriptor.values)) {
        throw new PropsError("Multiple form control values must be an array of strings", {
          target: nodeKey,
        })
      }
      const values = [...descriptor.values]
      if (!values.every((value) => typeof value === "string")) {
        throw new PropsError("Multiple form control values must be an array of strings", {
          target: nodeKey,
        })
      }
      return Object.freeze({
        ...base,
        kind: descriptor.kind,
        values: Object.freeze(values),
      })
    }
    case "submitter":
      if (descriptor.value !== undefined && typeof descriptor.value !== "string") {
        throw new PropsError("Submitter form control value must be a string", {
          target: nodeKey,
        })
      }
      return Object.freeze({
        ...base,
        kind: descriptor.kind,
        ...(descriptor.value !== undefined ? { value: descriptor.value } : {}),
      })
    case "value":
      if (typeof descriptor.value !== "string") {
        throw new PropsError("Value form control value must be a string", {
          target: nodeKey,
        })
      }
      return Object.freeze({ ...base, kind: descriptor.kind, value: descriptor.value })
    default:
      throw new PropsError("Form control kind is unsupported", { target: nodeKey })
  }
}

/**
 * Host-neutral registration for the string-valued portion of a native form.
 * The host owns native widgets and updates their current values; this registry
 * retains exact logical-node identity and produces the currently supported
 * successful-entry subset.
 */
export class FormControlRegistry {
  private disposed = false
  private readonly form: ProtocolElement
  private readonly records = new Map<ProtocolNode, FormControlRecord>()
  private unregisterFormDisposal: () => void

  constructor(
    private readonly session: DocumentSession,
    formNodeKey: string,
  ) {
    const form = session.tree.getNodeByKey(formNodeKey)
    if (!form || !isElement(form)) {
      throw new TargetError(`No active form element has key ${JSON.stringify(formNodeKey)}`, {
        target: formNodeKey,
      })
    }
    this.form = form
    this.unregisterFormDisposal = session.registerDisposal(formNodeKey, () => {
      this.disposeRegistry(false)
    })
  }

  get isDisposed(): boolean {
    return this.disposed
  }

  register(nodeKey: string, descriptor: FormControlDescriptor): FormControlRegistration {
    this.assertActive()
    const admitted = normalizeDescriptor(descriptor, nodeKey)
    const node = this.activeControl(nodeKey)
    if (this.records.has(node)) {
      throw new RegistryError(`Form control ${JSON.stringify(nodeKey)} is already registered`, {
        target: nodeKey,
      })
    }

    const record: FormControlRecord = {
      descriptor: admitted,
      node,
      unregisterDisposal: () => undefined,
    }
    record.unregisterDisposal = this.session.registerDisposal(node.key, () => {
      this.release(record, false)
    })
    this.records.set(node, record)

    return Object.freeze({
      nodeKey: node.key,
      unregister: () => this.release(record, true),
      update: (next: FormControlDescriptor) => {
        this.assertRecordActive(record)
        record.descriptor = normalizeDescriptor(next, node.key)
      },
    })
  }

  successfulEntries(options: SuccessfulFormEntriesOptions = {}): readonly SuccessfulFormEntry[] {
    this.assertActive()
    const submitter =
      options.submitterNodeKey === undefined
        ? undefined
        : this.activeSubmitter(options.submitterNodeKey)
    const entries: SuccessfulFormEntry[] = []

    const append = (descriptor: FormControlDescriptor) => {
      if (descriptor.disabled || descriptor.name === undefined || descriptor.name === "") return
      switch (descriptor.kind) {
        case "checkable":
          if (descriptor.checked) {
            entries.push(Object.freeze({ name: descriptor.name, value: descriptor.value ?? "on" }))
          }
          return
        case "multiple":
          for (const value of descriptor.values) {
            entries.push(Object.freeze({ name: descriptor.name, value }))
          }
          return
        case "submitter":
          entries.push(Object.freeze({ name: descriptor.name, value: descriptor.value ?? "" }))
          return
        case "value":
          entries.push(Object.freeze({ name: descriptor.name, value: descriptor.value }))
      }
    }

    const visit = (node: ProtocolNode) => {
      const record = this.records.get(node)
      if (record && record !== submitter && record.descriptor.kind !== "submitter") {
        append(record.descriptor)
      }
      if (node.kind === "document" || isElement(node)) {
        for (const child of node.children) visit(child)
      }
    }
    for (const child of this.form.children) visit(child)
    if (submitter) append(submitter.descriptor)
    return Object.freeze(entries)
  }

  dispose(): void {
    this.disposeRegistry(true)
  }

  private activeControl(nodeKey: string): ProtocolElement {
    const node = this.session.tree.getNodeByKey(nodeKey)
    if (!node || !isElement(node)) {
      throw new TargetError(`No active form control has key ${JSON.stringify(nodeKey)}`, {
        target: nodeKey,
      })
    }
    let parent = node.parent
    while (parent && parent !== this.form) parent = parent.parent
    if (parent !== this.form) {
      throw new TargetError(`Form control ${JSON.stringify(nodeKey)} belongs to another form`, {
        target: nodeKey,
      })
    }
    return node
  }

  private activeSubmitter(nodeKey: string): FormControlRecord {
    const node = this.activeControl(nodeKey)
    const record = this.records.get(node)
    if (record?.descriptor.kind !== "submitter") {
      throw new TargetError(`Form submitter ${JSON.stringify(nodeKey)} is not registered`, {
        target: nodeKey,
      })
    }
    if (record.descriptor.disabled) {
      throw new TargetError(`Form submitter ${JSON.stringify(nodeKey)} is disabled`, {
        target: nodeKey,
      })
    }
    return record
  }

  private assertActive(): void {
    if (this.disposed) throw new StateError("Form control registry has been disposed")
    if (this.session.tree.getNodeByKey(this.form.key) !== this.form) {
      throw new StateError("Form control registry no longer owns its form node", {
        target: this.form.key,
      })
    }
  }

  private assertRecordActive(record: FormControlRecord): void {
    this.assertActive()
    if (this.records.get(record.node) !== record) {
      throw new StateError("Form control registration is no longer active", {
        target: record.node.key,
      })
    }
  }

  private disposeRegistry(unregisterDisposal: boolean): void {
    if (this.disposed) return
    this.disposed = true
    if (unregisterDisposal) this.unregisterFormDisposal()
    for (const record of [...this.records.values()]) this.release(record, true)
  }

  private release(record: FormControlRecord, unregisterDisposal: boolean): void {
    if (this.records.get(record.node) !== record) return
    this.records.delete(record.node)
    if (unregisterDisposal) record.unregisterDisposal()
  }
}

/**
 * Document-lifetime owner for native form-control registries. A logical form
 * keeps one registry while its exact tree node remains active; same-key
 * replacement creates a fresh registry and disposes the old identity.
 */
export class DocumentFormControls {
  private disposed = false
  private readonly records = new Map<string, DocumentFormControlRecord>()

  constructor(private readonly session: DocumentSession) {}

  get isDisposed(): boolean {
    return this.disposed
  }

  controlsFor(formNodeKey: string): FormControlRegistry {
    this.assertActive()
    const form = this.session.tree.getNodeByKey(formNodeKey)
    if (!form || !isElement(form)) {
      throw new TargetError(`No active form element has key ${JSON.stringify(formNodeKey)}`, {
        target: formNodeKey,
      })
    }

    const existing = this.records.get(form.key)
    if (existing?.node === form && !existing.registry.isDisposed) return existing.registry
    if (existing) this.release(existing, true)

    const record: DocumentFormControlRecord = {
      node: form,
      registry: new FormControlRegistry(this.session, form.key),
      unregisterDisposal: () => undefined,
    }
    record.unregisterDisposal = this.session.registerDisposal(form.key, () => {
      this.release(record, false)
    })
    this.records.set(form.key, record)
    return record.registry
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const record of [...this.records.values()]) this.release(record, true)
  }

  private assertActive(): void {
    if (this.disposed) throw new StateError("Document form controls have been disposed")
  }

  private release(record: DocumentFormControlRecord, unregisterDisposal: boolean): void {
    if (this.records.get(record.node.key) !== record) return
    this.records.delete(record.node.key)
    if (unregisterDisposal) record.unregisterDisposal()
    record.registry.dispose()
  }
}
