import { PropsError, RegistryError, RequestError, StateError, TargetError } from "./errors"
import {
  buildFormRequest,
  type FormRequestPlan,
  type FormRequestProtocolOptions,
} from "./form-request"
import {
  type ExactFormSubmissionActivity,
  type FormSubmissionActivityListener,
  type FormSubmissionActivitySnapshot,
  type FormSubmissionTerminalSnapshot,
  type FormSubmitterActivitySnapshot,
  formSubmissionActivity,
} from "./form-submission-activity"
import type {
  FormSubmissionController,
  FormSubmissionControllerSubmitOptions,
  FormSubmissionReport,
} from "./form-submission-controller"
import {
  admitFormSubmissionProposal,
  type FormSubmissionProposal,
} from "./form-submission-proposal"
import { resolveFormSubmissionDestination } from "./frames"
import type { DocumentSession } from "./session"
import { attributeValue, isElement, type ProtocolElement, type ProtocolNode } from "./tree"

interface FormControlBase {
  readonly disabled?: boolean
  readonly name?: string
}

export interface FormControlDirectionality {
  readonly name: string
  readonly value: "ltr" | "rtl"
}

export type FormControlDescriptor =
  | (Omit<FormControlBase, "name"> & {
      readonly kind: "charset"
      readonly name: string
    })
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
      readonly directionality?: FormControlDirectionality
      readonly kind: "value"
      readonly value: string
    })

export interface SuccessfulFormEntry {
  readonly name: string
  readonly value: string
}

export interface SuccessfulFormEntriesOptions {
  readonly submitter?: FormControlSelection
}

export interface ActiveFormRequestPlanOptions extends SuccessfulFormEntriesOptions {
  readonly protocol: ActiveFormRequestProtocolOptions
  readonly signal?: AbortSignal
}

export type ActiveFormRequestProtocolOptions = Omit<FormRequestProtocolOptions, "frameId"> & {
  readonly frameId?: never
}

export type ActiveFormSubmissionProposalOptions = ActiveFormRequestPlanOptions

export type ActiveFormSubmitOptions = Omit<ActiveFormSubmissionProposalOptions, "signal"> & {
  readonly signal?: never
}

export interface ActiveFormRetryOptions {
  readonly protocol: ActiveFormRequestProtocolOptions
}

export interface FormControlRegistryOptions {
  readonly submissionController?: FormSubmissionController
}

export type DocumentFormControlsOptions = FormControlRegistryOptions

export interface FormControlRegistration {
  readonly nodeKey: string
  readonly selection: FormControlSelection
  unregister(): void
  update(descriptor: FormControlDescriptor): void
}

declare const FORM_CONTROL_SELECTION: unique symbol

export interface FormControlSelection {
  readonly [FORM_CONTROL_SELECTION]: true
  readonly nodeKey: string
}

function submitterSelectionOption(value: unknown): FormControlSelection | undefined {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new TargetError("Form successful-entry options must be an object")
    }
    if ("submitterNodeKey" in value) {
      throw new TargetError(
        "Form submitterNodeKey is unsupported; pass the registration-bound submitter selection",
      )
    }
    return (value as SuccessfulFormEntriesOptions).submitter
  } catch (error) {
    if (error instanceof TargetError) throw error
    throw new TargetError("Form submitter selection could not be read")
  }
}

interface FormControlRecord {
  descriptor: FormControlDescriptor
  readonly node: ProtocolElement
  readonly selection: FormControlSelection
  unregisterDisposal: () => void
}

interface DocumentFormControlRecord {
  readonly node: ProtocolElement
  readonly registry: FormControlRegistry
  unregisterDisposal: () => void
}

const INACTIVE_SUBMITTER_STATE: FormSubmitterActivitySnapshot = Object.freeze({
  pending: false,
  revision: 0,
})

function hasAttribute(node: ProtocolElement, name: string): boolean {
  return node.attributes.some((attribute) => attribute.name === name)
}

function activeProtocolOptions(
  value: ActiveFormRequestProtocolOptions,
): ActiveFormRequestProtocolOptions {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RequestError("Active form request protocol metadata must be an object")
  }
  if ("frameId" in value) {
    throw new RequestError("Active form requests derive Turbo-Frame metadata from data-turbo-frame")
  }
  const requestId = value.requestId
  const capabilityHash = value.capabilityHash
  return Object.freeze({
    ...(capabilityHash !== undefined ? { capabilityHash } : {}),
    requestId,
  })
}

function assertNativeTargetAttributes(
  form: ProtocolElement,
  submitter: FormControlRecord | undefined,
): void {
  if (hasAttribute(form, "target")) {
    throw new TargetError(
      "Native forms do not support browsing-context target; use data-turbo-frame",
      { target: form.key },
    )
  }
  if (submitter && hasAttribute(submitter.node, "formtarget")) {
    throw new TargetError(
      "Native submitters do not support browsing-context formtarget; use data-turbo-frame",
      { target: submitter.node.key },
    )
  }
}

function formRequestAttributes(form: ProtocolElement) {
  const action = attributeValue(form, "action")
  const enctype = attributeValue(form, "enctype")
  const method = attributeValue(form, "method")
  return Object.freeze({
    ...(action !== undefined ? { action } : {}),
    ...(enctype !== undefined ? { enctype } : {}),
    ...(method !== undefined ? { method } : {}),
    ...(hasAttribute(form, "data-turbo-stream") ? { streamAttributePresent: true as const } : {}),
  })
}

function submitterRequestAttributes(record: FormControlRecord) {
  if (record.descriptor.kind !== "submitter") {
    throw new TargetError(`Form control ${JSON.stringify(record.node.key)} is not a submitter`, {
      target: record.node.key,
    })
  }
  const action = attributeValue(record.node, "formaction")
  const enctype = attributeValue(record.node, "formenctype")
  const method = attributeValue(record.node, "formmethod")
  return Object.freeze({
    ...(action !== undefined ? { action } : {}),
    ...(enctype !== undefined ? { enctype } : {}),
    ...(method !== undefined ? { method } : {}),
    ...(record.descriptor.name !== undefined ? { name: record.descriptor.name } : {}),
    ...(hasAttribute(record.node, "data-turbo-stream")
      ? { streamAttributePresent: true as const }
      : {}),
    ...(record.descriptor.value !== undefined ? { value: record.descriptor.value } : {}),
  })
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
    case "charset":
      if (descriptor.name === undefined || descriptor.name.toLowerCase() !== "_charset_") {
        throw new PropsError("Charset form control name must be _charset_ ignoring ASCII case", {
          target: nodeKey,
        })
      }
      return Object.freeze({ ...base, kind: descriptor.kind, name: descriptor.name })
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
    case "value": {
      if (typeof descriptor.value !== "string") {
        throw new PropsError("Value form control value must be a string", {
          target: nodeKey,
        })
      }
      const directionality = descriptor.directionality
      let admittedDirectionality: FormControlDirectionality | undefined
      if (directionality !== undefined) {
        if (
          !directionality ||
          typeof directionality !== "object" ||
          Array.isArray(directionality)
        ) {
          throw new PropsError("Value form control directionality must be an object", {
            target: nodeKey,
          })
        }
        const name = directionality.name
        const value = directionality.value
        if (typeof name !== "string" || name === "") {
          throw new PropsError(
            "Value form control directionality name must be a non-empty string",
            {
              target: nodeKey,
            },
          )
        }
        if (value !== "ltr" && value !== "rtl") {
          throw new PropsError("Value form control directionality value must be ltr or rtl", {
            target: nodeKey,
          })
        }
        admittedDirectionality = Object.freeze({ name, value })
      }
      return Object.freeze({
        ...base,
        ...(admittedDirectionality ? { directionality: admittedDirectionality } : {}),
        kind: descriptor.kind,
        value: descriptor.value,
      })
    }
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
  private readonly selections = new WeakMap<FormControlSelection, FormControlRecord>()
  private readonly submissionActivity: ExactFormSubmissionActivity
  private unregisterFormDisposal: () => void

  constructor(
    private readonly session: DocumentSession,
    formNodeKey: string,
    private readonly options: FormControlRegistryOptions = {},
  ) {
    const form = session.tree.getNodeByKey(formNodeKey)
    if (!form || !isElement(form)) {
      throw new TargetError(`No active form element has key ${JSON.stringify(formNodeKey)}`, {
        target: formNodeKey,
      })
    }
    this.form = form
    this.submissionActivity = formSubmissionActivity(session, form)
    this.unregisterFormDisposal = session.registerDisposal(formNodeKey, () => {
      this.disposeRegistry(false)
    })
  }

  get isDisposed(): boolean {
    return this.disposed
  }

  get submissionState(): FormSubmissionActivitySnapshot {
    return this.submissionActivity.state
  }

  get submissionTerminalState(): FormSubmissionTerminalSnapshot {
    return this.submissionActivity.terminalState
  }

  subscribeSubmission(listener: FormSubmissionActivityListener): () => void {
    return this.submissionActivity.subscribe(listener)
  }

  subscribeSubmissionTerminal(listener: FormSubmissionActivityListener): () => void {
    return this.submissionActivity.subscribeTerminal(listener)
  }

  cancelSubmission(): void {
    this.submissionActivity.cancelActive()
  }

  dismissSubmissionTerminal(): void {
    this.submissionActivity.dismissTerminal()
  }

  retainSubmissionScope(): () => void {
    this.assertActive()
    return this.submissionActivity.retainScope()
  }

  controlSubmissionState(nodeKey: string): FormSubmitterActivitySnapshot {
    const node = this.activeControlOrUndefined(nodeKey)
    return node ? this.submissionActivity.stateForSubmitter(node) : INACTIVE_SUBMITTER_STATE
  }

  subscribeControlSubmission(
    nodeKey: string,
    listener: FormSubmissionActivityListener,
  ): () => void {
    const node = this.activeControlOrUndefined(nodeKey)
    return node ? this.submissionActivity.subscribeSubmitter(node, listener) : () => undefined
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

    const selection = Object.freeze({ nodeKey: node.key }) as FormControlSelection
    const record: FormControlRecord = {
      descriptor: admitted,
      node,
      selection,
      unregisterDisposal: () => undefined,
    }
    record.unregisterDisposal = this.session.registerDisposal(node.key, () => {
      this.release(record, false)
    })
    this.records.set(node, record)
    this.selections.set(selection, record)

    return Object.freeze({
      nodeKey: node.key,
      selection,
      unregister: () => this.release(record, true),
      update: (next: FormControlDescriptor) => {
        this.assertRecordActive(record)
        record.descriptor = normalizeDescriptor(next, node.key)
      },
    })
  }

  successfulEntries(options: SuccessfulFormEntriesOptions = {}): readonly SuccessfulFormEntry[] {
    this.assertActive()
    const selection = submitterSelectionOption(options)
    this.assertActive()
    const submitter = selection === undefined ? undefined : this.activeSubmitter(selection)
    return this.collectSuccessfulEntries(submitter)
  }

  requestPlan(options: ActiveFormRequestPlanOptions): FormRequestPlan {
    this.assertActive()
    if (!options || typeof options !== "object" || Array.isArray(options)) {
      throw new RequestError("Active form request plan options must be an object")
    }
    const protocol = activeProtocolOptions(options.protocol)
    const selection = submitterSelectionOption(options)
    const signal = options.signal
    this.assertActive()
    const documentUrl = this.session.tree.document.url
    if (!documentUrl) throw new RequestError("Active form request planning requires a document URL")
    const submitter = selection === undefined ? undefined : this.activeSubmitter(selection)
    return buildFormRequest({
      documentUrl,
      entries: this.collectSuccessfulEntries(submitter),
      form: formRequestAttributes(this.form),
      protocol,
      ...(signal !== undefined ? { signal } : {}),
      ...(submitter ? { submitter: submitterRequestAttributes(submitter) } : {}),
    })
  }

  submissionProposal(options: ActiveFormSubmissionProposalOptions): FormSubmissionProposal {
    this.assertActive()
    if (!options || typeof options !== "object" || Array.isArray(options)) {
      throw new RequestError("Active form submission proposal options must be an object")
    }
    const protocol = activeProtocolOptions(options.protocol)
    const selection = submitterSelectionOption(options)
    const signal = options.signal
    this.assertActive()
    const documentUrl = this.session.tree.document.url
    if (!documentUrl) {
      throw new RequestError("Active form submission proposals require a document URL")
    }
    const submitter = selection === undefined ? undefined : this.activeSubmitter(selection)
    assertNativeTargetAttributes(this.form, submitter)

    const formTarget = attributeValue(this.form, "data-turbo-frame")
    const submitterTarget = submitter
      ? attributeValue(submitter.node, "data-turbo-frame")
      : undefined
    const submitterConfirmation = submitter
      ? attributeValue(submitter.node, "data-turbo-confirm")
      : undefined
    const formConfirmation = attributeValue(this.form, "data-turbo-confirm")
    const confirmationMessage = submitterConfirmation ?? formConfirmation
    const destination = resolveFormSubmissionDestination(this.session.tree, this.form, {
      ...(formTarget !== undefined ? { formTarget } : {}),
      ...(submitterTarget !== undefined ? { submitterTarget } : {}),
    })
    const plan = buildFormRequest({
      documentUrl,
      entries: this.collectSuccessfulEntries(submitter),
      form: formRequestAttributes(this.form),
      protocol: {
        ...protocol,
        ...(destination.kind === "frame" ? { frameId: destination.frameId } : {}),
      },
      ...(signal !== undefined ? { signal } : {}),
      ...(submitter ? { submitter: submitterRequestAttributes(submitter) } : {}),
    })
    const destinationFrame =
      destination.kind === "frame"
        ? this.session.tree.getElementById(destination.frameId)
        : undefined
    if (destination.kind === "frame" && destinationFrame?.kind !== "frame") {
      throw new StateError("Form submission destination Frame is no longer active", {
        frameId: destination.frameId,
      })
    }
    let originParent = this.form.parent
    while (originParent && originParent.kind !== "document" && originParent.kind !== "frame") {
      originParent = originParent.parent
    }
    const originFrame = originParent?.kind === "frame" ? originParent : undefined
    const originFrameId = originFrame ? attributeValue(originFrame, "id") : undefined
    if (originFrame && !originFrameId) {
      throw new StateError("Form submission origin Frame requires a nonblank id", {
        target: originFrame.key,
      })
    }
    const proposal = Object.freeze({ destination, plan }) as FormSubmissionProposal
    return admitFormSubmissionProposal(proposal, {
      ...(confirmationMessage !== undefined ? { confirmationMessage } : {}),
      destination,
      ...(destination.kind === "frame"
        ? {
            destinationFrame: destinationFrame as ProtocolElement,
            destinationFrameId: destination.frameId,
          }
        : {}),
      form: this.form,
      ...(originFrame ? { originFrame, originFrameId: originFrameId as string } : {}),
      submissionActivity: this.submissionActivity,
      session: this.session,
      ...(submitter ? { submitter: submitter.node } : {}),
      treeGeneration: this.session.treeGeneration,
    })
  }

  submit(
    options: ActiveFormSubmitOptions,
    controllerOptions: FormSubmissionControllerSubmitOptions = {},
  ): Promise<FormSubmissionReport> {
    this.assertActive()
    const submissionController = this.options.submissionController
    if (!submissionController) {
      throw new StateError("Active form submission requires a configured submission controller")
    }
    if (!options || typeof options !== "object" || Array.isArray(options)) {
      throw new RequestError("Active form submit options must be an object")
    }
    if ("signal" in options) {
      throw new RequestError("Active form submission owns its abort signal")
    }
    const protocol = options.protocol
    const submitter = submitterSelectionOption(options)
    return submissionController.submit(
      (signal) =>
        this.submissionProposal({
          protocol,
          signal,
          ...(submitter ? { submitter } : {}),
        }),
      controllerOptions,
    )
  }

  retryFailure(
    options: ActiveFormRetryOptions,
    controllerOptions: FormSubmissionControllerSubmitOptions = {},
  ): Promise<FormSubmissionReport> {
    this.assertActive()
    if (!options || typeof options !== "object" || Array.isArray(options)) {
      throw new RequestError("Active form retry options must be an object")
    }
    const protocol = activeProtocolOptions(options.protocol)
    const source = this.submissionActivity.retrySource()
    if (protocol.requestId === source.requestId) {
      throw new RequestError("Form submission retry requires a fresh request ID")
    }
    const record = source.submitter ? this.records.get(source.submitter) : undefined
    if (source.submitter && !record) {
      throw new StateError("Form submission retry no longer owns its submitter registration", {
        target: source.submitter.key,
      })
    }
    return this.submit(
      {
        protocol,
        ...(record ? { submitter: record.selection } : {}),
      },
      controllerOptions,
    )
  }

  private collectSuccessfulEntries(
    submitter: FormControlRecord | undefined,
  ): readonly SuccessfulFormEntry[] {
    const entries: SuccessfulFormEntry[] = []

    const append = (descriptor: FormControlDescriptor) => {
      if (descriptor.disabled || descriptor.name === undefined || descriptor.name === "") return
      switch (descriptor.kind) {
        case "charset":
          entries.push(Object.freeze({ name: descriptor.name, value: "UTF-8" }))
          return
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
          if (descriptor.directionality) {
            entries.push(
              Object.freeze({
                name: descriptor.directionality.name,
                value: descriptor.directionality.value,
              }),
            )
          }
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

  private activeControlOrUndefined(nodeKey: string): ProtocolElement | undefined {
    if (
      this.disposed ||
      this.session.tree.getNodeByKey(this.form.key) !== this.form ||
      !this.session.tree.contains(this.form)
    ) {
      return undefined
    }
    const node = this.session.tree.getNodeByKey(nodeKey)
    if (!node || !isElement(node)) return undefined
    let parent = node.parent
    while (parent && parent !== this.form) parent = parent.parent
    return parent === this.form ? node : undefined
  }

  private activeSubmitter(selection: FormControlSelection): FormControlRecord {
    if (!selection || typeof selection !== "object" || Array.isArray(selection)) {
      throw new TargetError("Form submitter requires a registration-bound selection")
    }
    const record = this.selections.get(selection)
    if (!record || this.records.get(record.node) !== record) {
      throw new TargetError("Form submitter selection is no longer active")
    }
    if (record?.descriptor.kind !== "submitter") {
      throw new TargetError(`Form control ${JSON.stringify(record.node.key)} is not a submitter`, {
        target: record.node.key,
      })
    }
    if (record.descriptor.disabled) {
      throw new TargetError(`Form submitter ${JSON.stringify(record.node.key)} is disabled`, {
        target: record.node.key,
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

  constructor(
    private readonly session: DocumentSession,
    private readonly options: DocumentFormControlsOptions = {},
  ) {}

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
      registry: new FormControlRegistry(this.session, form.key, this.options),
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
