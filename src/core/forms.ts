import type { FocusAdapter, TurboMultipartFile, VisitAction } from "../adapters"
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
  constrainFormSubmissionProposalToSafeTransport,
  type FormSubmissionProposal,
} from "./form-submission-proposal"
import { resolveFormSubmissionDestination } from "./frames"
import { protocolRequestHeaders } from "./protocol-request"
import type { DocumentSession } from "./session"
import { attributeValue, isElement, type ProtocolElement, type ProtocolNode } from "./tree"

interface FormControlBase {
  readonly disabled?: boolean
  readonly name?: string
}

export type FormControlValidity =
  | Readonly<{ readonly valid: true }>
  | Readonly<{ readonly message: string; readonly valid: false }>

interface ValidatableFormControlBase extends FormControlBase {
  readonly validity?: FormControlValidity
}

interface ValidatableFormEntryListBase {
  readonly disabled?: boolean
  readonly name?: never
  readonly validity?: FormControlValidity
}

export interface FormControlDirectionality {
  readonly name: string
  readonly value: "ltr" | "rtl"
}

export type FormFile = TurboMultipartFile

export interface SuccessfulFormEntry {
  readonly name: string
  readonly value: string | FormFile
}

export const MAX_FORM_CONTROL_ENTRIES_PER_CONTROL = 256

interface FormSelectOptionBase {
  readonly disabled?: boolean
  readonly kind: "option"
  readonly selected: boolean
}

export type FormSelectOption =
  | (FormSelectOptionBase & {
      readonly textContent?: string
      readonly value: string
    })
  | (FormSelectOptionBase & {
      readonly textContent: string
      readonly value?: undefined
    })

export interface FormSelectOptionGroup {
  readonly disabled?: boolean
  readonly kind: "group"
  readonly options: readonly FormSelectOption[]
}

export type FormSelectItem = FormSelectOption | FormSelectOptionGroup

export type FormControlDescriptor =
  | (ValidatableFormControlBase & {
      readonly kind: "checkable"
      readonly checked: boolean
      readonly value?: string
    })
  | (ValidatableFormEntryListBase & {
      readonly entries: readonly SuccessfulFormEntry[]
      readonly kind: "entries"
    })
  | (FormControlBase & {
      readonly directionality?: FormControlDirectionality
      readonly kind: "hidden"
      readonly value?: string
    })
  | (ValidatableFormControlBase & {
      readonly kind: "multiple"
      readonly values: readonly string[]
    })
  | (ValidatableFormControlBase & {
      readonly defaultSelection?: "first-enabled"
      readonly kind: "select"
      readonly options: readonly FormSelectItem[]
    })
  | (FormControlBase & {
      readonly kind: "submitter"
      readonly value?: string
    })
  | (ValidatableFormControlBase & {
      readonly directionality?: FormControlDirectionality
      readonly kind: "value"
      readonly value: string
    })

interface NormalizedFormSelectOption extends FormSelectOptionBase {
  readonly value: string
}

interface NormalizedFormSelectOptionGroup {
  readonly disabled?: boolean
  readonly kind: "group"
  readonly options: readonly NormalizedFormSelectOption[]
}

type NormalizedFormSelectItem = NormalizedFormSelectOption | NormalizedFormSelectOptionGroup

type NormalizedFormControlDescriptor =
  | Exclude<FormControlDescriptor, { readonly kind: "select" }>
  | (ValidatableFormControlBase & {
      readonly defaultSelection?: "first-enabled"
      readonly kind: "select"
      readonly options: readonly NormalizedFormSelectItem[]
    })

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

export interface InvalidFormControl {
  readonly message: string
  readonly nodeKey: string
}

export type FormConstraintValidationReport =
  | Readonly<{
      readonly invalidControls: readonly []
      readonly valid: true
    }>
  | Readonly<{
      readonly firstInvalid: InvalidFormControl
      readonly invalidControls: readonly InvalidFormControl[]
      readonly valid: false
    }>

export interface FormConstraintValidationSubmissionReport {
  readonly firstInvalid: InvalidFormControl
  readonly invalidControls: readonly InvalidFormControl[]
  readonly requestId: string
  readonly status: "invalid"
  readonly submitterNodeKey?: string
}

export type ActiveFormSubmissionReport =
  | FormConstraintValidationSubmissionReport
  | FormSubmissionReport

export interface ActiveFormRetryOptions {
  readonly protocol: ActiveFormRequestProtocolOptions
}

export type FormMode = "off" | "on" | "optin"

export type FormContainerRole = "datalist" | "fieldset" | "legend"

export interface FormControlSemantics {
  formContainerRole(element: ProtocolElement): FormContainerRole | undefined
}

export interface FormControlRegistryOptions {
  readonly focus?: FocusAdapter
  readonly formSemantics?: FormControlSemantics
  readonly formMode?: FormMode
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
  if (!value || typeof value !== "object") {
    throw new TargetError("Form successful-entry options must be an object")
  }
  let array: boolean
  try {
    array = Array.isArray(value)
  } catch {
    throw new TargetError("Form submitter selection could not be read")
  }
  if (array) throw new TargetError("Form successful-entry options must be an object")
  let hasLegacySelection: boolean
  try {
    hasLegacySelection = "submitterNodeKey" in value
  } catch {
    throw new TargetError("Form submitter selection could not be read")
  }
  if (hasLegacySelection) {
    throw new TargetError(
      "Form submitterNodeKey is unsupported; pass the registration-bound submitter selection",
    )
  }
  try {
    return (value as SuccessfulFormEntriesOptions).submitter
  } catch {
    throw new TargetError("Form submitter selection could not be read")
  }
}

interface FormControlRecord {
  descriptor: NormalizedFormControlDescriptor
  readonly node: ProtocolElement
  readonly selection: FormControlSelection
  unregisterDisposal: () => void
}

interface DocumentFormControlRecord {
  readonly node: ProtocolElement
  readonly registry: FormControlRegistry
  unregisterDisposal: () => void
}

const CHARSET_CONTROL_NAME = "_charset_"

function selectOptionTextValue(textContent: string): string {
  return textContent
    .replace(/[\t\n\f\r ]+/g, " ")
    .replace(/^ /, "")
    .replace(/ $/, "")
}

function isCharsetControlName(name: string): boolean {
  if (name.length !== CHARSET_CONTROL_NAME.length) return false
  for (let index = 0; index < name.length; index += 1) {
    const code = name.charCodeAt(index)
    const normalized = code >= 65 && code <= 90 ? code + 32 : code
    if (normalized !== CHARSET_CONTROL_NAME.charCodeAt(index)) return false
  }
  return true
}

const INACTIVE_SUBMITTER_STATE: FormSubmitterActivitySnapshot = Object.freeze({
  pending: false,
  revision: 0,
})
const VALID_FORM_CONTROL: FormControlValidity = Object.freeze({ valid: true })

function hasAttribute(node: ProtocolElement, name: string): boolean {
  return node.attributes.some((attribute) => attribute.name === name)
}

function exactVisitAction(value: string | undefined): VisitAction | undefined {
  return value === "advance" || value === "replace" || value === "restore" ? value : undefined
}

function normalizeFormMode(value: unknown): FormMode {
  if (value !== "off" && value !== "on" && value !== "optin") {
    throw new PropsError("Form mode must be off, on, or optin")
  }
  return value
}

function closestTurboSetting(node: ProtocolElement): string | undefined {
  let current: ProtocolNode | null = node
  while (current && current.kind !== "document") {
    if (isElement(current)) {
      const setting = attributeValue(current, "data-turbo")
      if (setting !== undefined) return setting
    }
    current = current.parent
  }
  return undefined
}

function formHasTurboOptIn(form: ProtocolElement): boolean {
  let current: ProtocolNode | null = form
  while (current && current.kind !== "document") {
    if (isElement(current) && attributeValue(current, "data-turbo") === "true") return true
    current = current.parent
  }
  return false
}

type ActiveFormOptionsScope = "request plan" | "retry" | "submission proposal" | "submit"

function activeFormOptions<T extends object>(value: T, scope: ActiveFormOptionsScope): T {
  if (!value || typeof value !== "object") {
    throw new RequestError(`Active form ${scope} options must be an object`)
  }
  let array: boolean
  try {
    array = Array.isArray(value)
  } catch {
    throw new RequestError(`Active form ${scope} options could not be read`)
  }
  if (array) {
    throw new RequestError(`Active form ${scope} options must be an object`)
  }
  return value
}

function activeFormOption<T extends object, K extends keyof T>(
  options: T,
  key: K,
  scope: ActiveFormOptionsScope,
): T[K] {
  try {
    return options[key]
  } catch {
    throw new RequestError(`Active form ${scope} options could not be read`)
  }
}

function hasActiveFormOption(
  options: object,
  key: PropertyKey,
  scope: ActiveFormOptionsScope,
): boolean {
  try {
    return key in options
  } catch {
    throw new RequestError(`Active form ${scope} options could not be read`)
  }
}

function activeProtocolOptions(value: unknown): ActiveFormRequestProtocolOptions {
  if (!value || typeof value !== "object") {
    throw new RequestError("Active form request protocol metadata must be an object")
  }
  let array: boolean
  try {
    array = Array.isArray(value)
  } catch {
    throw new RequestError("Active form request protocol metadata could not be read")
  }
  if (array) {
    throw new RequestError("Active form request protocol metadata must be an object")
  }
  let hasFrameId: boolean
  try {
    hasFrameId = "frameId" in value
  } catch {
    throw new RequestError("Active form request protocol metadata could not be read")
  }
  if (hasFrameId) {
    throw new RequestError("Active form requests derive Turbo-Frame metadata from data-turbo-frame")
  }
  let capabilityHash: unknown
  let requestId: unknown
  try {
    requestId = (value as ActiveFormRequestProtocolOptions).requestId
    capabilityHash = (value as ActiveFormRequestProtocolOptions).capabilityHash
  } catch {
    throw new RequestError("Active form request protocol metadata could not be read")
  }
  if (typeof requestId !== "string") {
    throw new RequestError("Active form request ID must be a string")
  }
  if (capabilityHash !== undefined && typeof capabilityHash !== "string") {
    throw new RequestError("Active form capability hash must be a string")
  }
  const admitted = Object.freeze({
    ...(capabilityHash !== undefined ? { capabilityHash } : {}),
    requestId,
  })
  protocolRequestHeaders(admitted)
  return admitted
}

function normalizeValidity(validity: unknown, nodeKey: string): FormControlValidity | undefined {
  if (validity === undefined) return undefined
  if (!validity || typeof validity !== "object" || Array.isArray(validity)) {
    throw new PropsError("Form control validity must be an object", { target: nodeKey })
  }
  const keys = Object.keys(validity)
  if (keys.some((key) => key !== "message" && key !== "valid")) {
    throw new PropsError("Form control validity contains unsupported fields", {
      target: nodeKey,
    })
  }
  const candidate = validity as Partial<FormControlValidity>
  const valid = candidate.valid
  const hasMessage = "message" in candidate
  const message = hasMessage ? candidate.message : undefined
  if (valid === true) {
    if (hasMessage) {
      throw new PropsError("Valid form controls must not provide a validation message", {
        target: nodeKey,
      })
    }
    return Object.freeze({ valid: true })
  }
  if (valid !== false) {
    throw new PropsError("Form control validity must provide a boolean valid value", {
      target: nodeKey,
    })
  }
  if (typeof message !== "string" || message.trim() === "") {
    throw new PropsError("Invalid form controls require a non-empty validation message", {
      target: nodeKey,
    })
  }
  return Object.freeze({ message, valid: false })
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

function normalizeDirectionality(
  directionality: unknown,
  nodeKey: string,
): FormControlDirectionality | undefined {
  if (directionality === undefined) return undefined
  if (!directionality || typeof directionality !== "object" || Array.isArray(directionality)) {
    throw new PropsError("Form control directionality must be an object", {
      target: nodeKey,
    })
  }
  const value = directionality as Partial<FormControlDirectionality>
  if (typeof value.name !== "string" || value.name === "") {
    throw new PropsError("Form control directionality name must be a non-empty string", {
      target: nodeKey,
    })
  }
  if (value.value !== "ltr" && value.value !== "rtl") {
    throw new PropsError("Form control directionality value must be ltr or rtl", {
      target: nodeKey,
    })
  }
  return Object.freeze({ name: value.name, value: value.value })
}

function normalizeFormFile(value: unknown, nodeKey: string): FormFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PropsError("Form file entries must provide a Blob and filename", { target: nodeKey })
  }
  if (Object.keys(value).some((key) => key !== "blob" && key !== "filename")) {
    throw new PropsError("Form file entries contain unsupported fields", { target: nodeKey })
  }
  let blob: unknown
  let filename: unknown
  try {
    blob = (value as FormFile).blob
    filename = (value as FormFile).filename
  } catch {
    throw new PropsError("Form file entries could not be read", { target: nodeKey })
  }
  if (!blob || typeof blob !== "object") {
    throw new PropsError("Form file entries must provide a Blob", { target: nodeKey })
  }
  let size: unknown
  let type: unknown
  try {
    size = (blob as Blob).size
    type = (blob as Blob).type
  } catch {
    throw new PropsError("Form file Blob metadata could not be read", { target: nodeKey })
  }
  if (
    typeof size !== "number" ||
    !Number.isSafeInteger(size) ||
    size < 0 ||
    typeof type !== "string"
  ) {
    throw new PropsError("Form file entries must provide a Blob", { target: nodeKey })
  }
  if (typeof filename !== "string" || filename === "" || /\p{Cc}/u.test(filename)) {
    throw new PropsError("Form file entry filenames must be non-empty printable strings", {
      target: nodeKey,
    })
  }
  return Object.freeze({ blob: blob as Blob, filename })
}

function normalizeDescriptor(
  descriptor: FormControlDescriptor,
  nodeKey: string,
): NormalizedFormControlDescriptor {
  if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) {
    throw new PropsError("Form control descriptors must be objects")
  }
  const name = descriptor.name
  const disabled = descriptor.disabled
  if (name !== undefined && typeof name !== "string") {
    throw new PropsError("Form control name must be a string", { target: nodeKey })
  }
  if (disabled !== undefined && typeof disabled !== "boolean") {
    throw new PropsError("Form control disabled must be a boolean", {
      target: nodeKey,
    })
  }

  const base = {
    ...(name !== undefined ? { name } : {}),
    ...(disabled !== undefined ? { disabled } : {}),
  }
  switch (descriptor.kind) {
    case "checkable": {
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
      const checkableValidity = normalizeValidity(descriptor.validity, nodeKey)
      return Object.freeze({
        ...base,
        checked: descriptor.checked,
        kind: "checkable",
        ...(checkableValidity ? { validity: checkableValidity } : {}),
        ...(descriptor.value !== undefined ? { value: descriptor.value } : {}),
      })
    }
    case "entries": {
      if ("name" in descriptor) {
        throw new PropsError("Entry-list form controls must not provide a control name", {
          target: nodeKey,
        })
      }
      if (
        Object.keys(descriptor).some(
          (key) => key !== "disabled" && key !== "entries" && key !== "kind" && key !== "validity",
        )
      ) {
        throw new PropsError("Entry-list form controls contain unsupported fields", {
          target: nodeKey,
        })
      }
      const sourceEntries = descriptor.entries
      if (!Array.isArray(sourceEntries)) {
        throw new PropsError("Entry-list form control entries must be an array", {
          target: nodeKey,
        })
      }
      const entryCount = sourceEntries.length
      if (entryCount > MAX_FORM_CONTROL_ENTRIES_PER_CONTROL) {
        throw new PropsError(
          `Entry-list form controls support at most ${MAX_FORM_CONTROL_ENTRIES_PER_CONTROL} entries`,
          { target: nodeKey },
        )
      }
      const entries: SuccessfulFormEntry[] = []
      for (let index = 0; index < entryCount; index += 1) {
        const entry = sourceEntries[index]
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
          throw new PropsError("Entry-list form control entries must be objects", {
            target: nodeKey,
          })
        }
        if (Object.keys(entry).some((key) => key !== "name" && key !== "value")) {
          throw new PropsError("Entry-list form control entries contain unsupported fields", {
            target: nodeKey,
          })
        }
        const name = entry.name
        const value = entry.value
        if (typeof name !== "string") {
          throw new PropsError("Entry-list form control entry names must be strings", {
            target: nodeKey,
          })
        }
        entries.push(
          Object.freeze({
            name,
            value: typeof value === "string" ? value : normalizeFormFile(value, nodeKey),
          }),
        )
      }
      const entriesValidity = normalizeValidity(descriptor.validity, nodeKey)
      return Object.freeze({
        ...(disabled !== undefined ? { disabled } : {}),
        entries: Object.freeze(entries),
        kind: "entries",
        ...(entriesValidity ? { validity: entriesValidity } : {}),
      })
    }
    case "hidden": {
      if ("validity" in descriptor) {
        throw new PropsError("Hidden form controls cannot provide constraint validity", {
          target: nodeKey,
        })
      }
      if (descriptor.value !== undefined && typeof descriptor.value !== "string") {
        throw new PropsError("Hidden form control value must be a string", {
          target: nodeKey,
        })
      }
      const hiddenDirectionality = normalizeDirectionality(descriptor.directionality, nodeKey)
      return Object.freeze({
        ...base,
        ...(hiddenDirectionality ? { directionality: hiddenDirectionality } : {}),
        kind: "hidden",
        ...(descriptor.value !== undefined ? { value: descriptor.value } : {}),
      })
    }
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
      const multipleValidity = normalizeValidity(descriptor.validity, nodeKey)
      return Object.freeze({
        ...base,
        kind: "multiple",
        ...(multipleValidity ? { validity: multipleValidity } : {}),
        values: Object.freeze(values),
      })
    }
    case "select": {
      const defaultSelection = descriptor.defaultSelection
      if (defaultSelection !== undefined && defaultSelection !== "first-enabled") {
        throw new PropsError("Select form control default selection is unsupported", {
          target: nodeKey,
        })
      }
      if (!Array.isArray(descriptor.options)) {
        throw new PropsError("Select form control options must be an array", {
          target: nodeKey,
        })
      }
      const normalizeOption = (value: unknown): NormalizedFormSelectOption => {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          throw new PropsError("Select form control options must be objects", {
            target: nodeKey,
          })
        }
        const option = value as Partial<FormSelectOption>
        if (option.kind !== "option") {
          throw new PropsError("Select option groups cannot contain nested groups", {
            target: nodeKey,
          })
        }
        if (option.textContent !== undefined && typeof option.textContent !== "string") {
          throw new PropsError("Select form control option text must be a string", {
            target: nodeKey,
          })
        }
        let admittedValue: string
        if (option.value !== undefined) {
          if (typeof option.value !== "string") {
            throw new PropsError("Select form control option values must be strings", {
              target: nodeKey,
            })
          }
          admittedValue = option.value
        } else if (typeof option.textContent === "string") {
          admittedValue = selectOptionTextValue(option.textContent)
        } else {
          throw new PropsError("Select form control options require a value or text snapshot", {
            target: nodeKey,
          })
        }
        if (typeof option.selected !== "boolean") {
          throw new PropsError("Select form control selectedness must be a boolean", {
            target: nodeKey,
          })
        }
        if (option.disabled !== undefined && typeof option.disabled !== "boolean") {
          throw new PropsError("Select form control option disabledness must be a boolean", {
            target: nodeKey,
          })
        }
        return Object.freeze({
          ...(option.disabled !== undefined ? { disabled: option.disabled } : {}),
          kind: option.kind,
          selected: option.selected,
          value: admittedValue,
        })
      }
      const options = Array.from(descriptor.options, (value): NormalizedFormSelectItem => {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          throw new PropsError("Select form control items must be objects", {
            target: nodeKey,
          })
        }
        if (value.kind === "option") return normalizeOption(value)
        if (value.kind !== "group") {
          throw new PropsError("Select form control item kind is unsupported", {
            target: nodeKey,
          })
        }
        if (value.disabled !== undefined && typeof value.disabled !== "boolean") {
          throw new PropsError("Select option-group disabledness must be a boolean", {
            target: nodeKey,
          })
        }
        if (!Array.isArray(value.options)) {
          throw new PropsError("Select option-group options must be an array", {
            target: nodeKey,
          })
        }
        return Object.freeze({
          ...(value.disabled !== undefined ? { disabled: value.disabled } : {}),
          kind: value.kind,
          options: Object.freeze(Array.from(value.options, normalizeOption)),
        })
      })
      const selectValidity = normalizeValidity(descriptor.validity, nodeKey)
      return Object.freeze({
        ...base,
        ...(defaultSelection !== undefined ? { defaultSelection } : {}),
        kind: "select",
        options: Object.freeze(options),
        ...(selectValidity ? { validity: selectValidity } : {}),
      })
    }
    case "submitter":
      if ("validity" in descriptor) {
        throw new PropsError("Submitter form controls cannot provide constraint validity", {
          target: nodeKey,
        })
      }
      if (descriptor.value !== undefined && typeof descriptor.value !== "string") {
        throw new PropsError("Submitter form control value must be a string", {
          target: nodeKey,
        })
      }
      return Object.freeze({
        ...base,
        kind: "submitter",
        ...(descriptor.value !== undefined ? { value: descriptor.value } : {}),
      })
    case "value": {
      if (typeof descriptor.value !== "string") {
        throw new PropsError("Value form control value must be a string", {
          target: nodeKey,
        })
      }
      const admittedDirectionality = normalizeDirectionality(descriptor.directionality, nodeKey)
      const valueValidity = normalizeValidity(descriptor.validity, nodeKey)
      return Object.freeze({
        ...base,
        ...(admittedDirectionality ? { directionality: admittedDirectionality } : {}),
        kind: "value",
        ...(valueValidity ? { validity: valueValidity } : {}),
        value: descriptor.value,
      })
    }
    default:
      throw new PropsError("Form control kind is unsupported", { target: nodeKey })
  }
}

/**
 * Host-neutral registration for native form controls. String controls use the
 * ordinary descriptors; host-owned Blob/file entries use the `entries` descriptor.
 * The host owns native widgets and updates their current values; this registry
 * retains exact logical-node identity and produces the currently supported
 * successful-entry subset.
 */
export class FormControlRegistry {
  private disposed = false
  private readonly form: ProtocolElement
  private readonly formSemantics: FormControlSemantics | undefined
  private readonly formMode: FormMode
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
    if (
      options.focus !== undefined &&
      (!options.focus ||
        typeof options.focus.blur !== "function" ||
        typeof options.focus.focus !== "function" ||
        typeof options.focus.getFocusedId !== "function")
    ) {
      throw new PropsError("Form focus adapter must provide blur, focus, and getFocusedId")
    }
    this.formSemantics = options.formSemantics
    if (
      this.formSemantics !== undefined &&
      (!this.formSemantics || typeof this.formSemantics.formContainerRole !== "function")
    ) {
      throw new PropsError("Form semantics must provide formContainerRole")
    }
    this.formMode = normalizeFormMode(options.formMode ?? "on")
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

  controlInheritedDisabled(nodeKey: string): boolean {
    const node = this.activeControlOrUndefined(nodeKey)
    return node ? this.disabledByFieldset(node) : false
  }

  controlValidity(nodeKey: string): FormControlValidity {
    const node = this.activeControlOrUndefined(nodeKey)
    const record = node ? this.records.get(node) : undefined
    return record ? this.effectiveValidity(record) : VALID_FORM_CONTROL
  }

  subscribeControlInheritedDisabled(nodeKey: string, listener: () => void): () => void {
    const node = this.activeControlOrUndefined(nodeKey)
    if (!node || !this.formSemantics) return () => undefined
    const subscriptions: (() => void)[] = []
    let parent = node.parent
    while (parent && parent.kind !== "document") {
      if (isElement(parent) && this.formContainerRole(parent) === "fieldset") {
        subscriptions.push(this.session.subscribe(parent.key, listener))
      }
      parent = parent.parent
    }
    return () => {
      for (const unsubscribe of subscriptions) unsubscribe()
    }
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

  shouldInterceptSubmission(options: SuccessfulFormEntriesOptions = {}): boolean {
    this.assertActive()
    if (this.formMode === "off") return false
    const selection = submitterSelectionOption(options)
    const submitter = selection === undefined ? undefined : this.activeSubmitter(selection)
    if (submitter && closestTurboSetting(submitter.node) === "false") return false
    return this.formMode === "optin"
      ? formHasTurboOptIn(this.form)
      : closestTurboSetting(this.form) !== "false"
  }

  checkValidity(): FormConstraintValidationReport {
    this.assertActive()
    const invalidControls: InvalidFormControl[] = []
    const visit = (node: ProtocolNode) => {
      const record = this.records.get(node)
      if (record) {
        this.assertRecordActive(record)
        const validity = this.effectiveValidity(record)
        if (!validity.valid) {
          invalidControls.push(
            Object.freeze({ message: validity.message, nodeKey: record.node.key }),
          )
        }
      }
      if (node.kind === "document" || isElement(node)) {
        for (const child of node.children) visit(child)
      }
    }
    visit(this.session.tree.document)
    if (invalidControls.length === 0) {
      return Object.freeze({ invalidControls: Object.freeze([]) as readonly [], valid: true })
    }
    const admitted = Object.freeze(invalidControls)
    return Object.freeze({
      firstInvalid: admitted[0] as InvalidFormControl,
      invalidControls: admitted,
      valid: false,
    })
  }

  reportValidity(): FormConstraintValidationReport {
    const report = this.checkValidity()
    if (report.valid) return report
    const focus = this.options.focus
    if (!focus || typeof focus.focus !== "function") {
      throw new StateError("Invalid form submission requires a configured focus adapter", {
        target: report.firstInvalid.nodeKey,
      })
    }
    let result: unknown
    try {
      result = focus.focus(report.firstInvalid.nodeKey)
    } catch {
      throw new StateError("Form validation could not focus the first invalid control", {
        target: report.firstInvalid.nodeKey,
      })
    }
    if (result !== undefined) {
      if ((typeof result === "object" && result !== null) || typeof result === "function") {
        try {
          void Promise.resolve(result).catch(() => undefined)
        } catch {
          // The protocol error below is the only exposed host failure.
        }
      }
      throw new StateError("Form validation could not focus the first invalid control", {
        target: report.firstInvalid.nodeKey,
      })
    }
    return report
  }

  requestPlan(options: ActiveFormRequestPlanOptions): FormRequestPlan {
    this.assertActive()
    const admittedOptions = activeFormOptions(options, "request plan")
    const protocol = activeProtocolOptions(
      activeFormOption(admittedOptions, "protocol", "request plan"),
    )
    const selection = submitterSelectionOption(admittedOptions)
    const signal = activeFormOption(admittedOptions, "signal", "request plan")
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
    const admittedOptions = activeFormOptions(options, "submission proposal")
    const protocol = activeProtocolOptions(
      activeFormOption(admittedOptions, "protocol", "submission proposal"),
    )
    const selection = submitterSelectionOption(admittedOptions)
    const signal = activeFormOption(admittedOptions, "signal", "submission proposal")
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
    const submitterAction = submitter
      ? attributeValue(submitter.node, "data-turbo-action")
      : undefined
    const formAction = attributeValue(this.form, "data-turbo-action")
    const authoredAction = submitterAction ?? formAction
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
    const visitAction = exactVisitAction(
      authoredAction ??
        (destinationFrame?.kind === "frame"
          ? attributeValue(destinationFrame, "data-turbo-action")
          : undefined),
    )
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
      ...(visitAction ? { visitAction } : {}),
    })
  }

  submit(
    options: ActiveFormSubmitOptions,
    controllerOptions: FormSubmissionControllerSubmitOptions = {},
  ): Promise<ActiveFormSubmissionReport> {
    return this.submitWithTransportConstraint(options, controllerOptions, false)
  }

  private submitWithTransportConstraint(
    options: ActiveFormSubmitOptions,
    controllerOptions: FormSubmissionControllerSubmitOptions,
    requiresSafeTransport: boolean,
  ): Promise<ActiveFormSubmissionReport> {
    this.assertActive()
    const admittedOptions = activeFormOptions(options, "submit")
    if (hasActiveFormOption(admittedOptions, "signal", "submit")) {
      throw new RequestError("Active form submission owns its abort signal")
    }
    const protocol = activeProtocolOptions(activeFormOption(admittedOptions, "protocol", "submit"))
    const selection = submitterSelectionOption(admittedOptions)
    const submitter = selection === undefined ? undefined : this.activeSubmitter(selection)
    if (
      !hasAttribute(this.form, "novalidate") &&
      !(submitter && hasAttribute(submitter.node, "formnovalidate"))
    ) {
      const validation = this.reportValidity()
      if (!validation.valid) {
        return Promise.resolve(
          Object.freeze({
            firstInvalid: validation.firstInvalid,
            invalidControls: validation.invalidControls,
            requestId: protocol.requestId,
            status: "invalid",
            ...(submitter ? { submitterNodeKey: submitter.node.key } : {}),
          }),
        )
      }
    }
    const submissionController = this.options.submissionController
    if (!submissionController) {
      throw new StateError("Active form submission requires a configured submission controller")
    }
    return submissionController.submit((signal) => {
      const proposal = this.submissionProposal({
        protocol,
        signal,
        ...(selection ? { submitter: selection } : {}),
      })
      return requiresSafeTransport
        ? constrainFormSubmissionProposalToSafeTransport(proposal)
        : proposal
    }, controllerOptions)
  }

  retryFailure(
    options: ActiveFormRetryOptions,
    controllerOptions: FormSubmissionControllerSubmitOptions = {},
  ): Promise<ActiveFormSubmissionReport> {
    this.assertActive()
    const admittedOptions = activeFormOptions(options, "retry")
    const protocol = activeProtocolOptions(activeFormOption(admittedOptions, "protocol", "retry"))
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
    return this.submitWithTransportConstraint(
      {
        protocol,
        ...(record ? { submitter: record.selection } : {}),
      },
      controllerOptions,
      source.requiresSafeTransport,
    )
  }

  private collectSuccessfulEntries(
    submitter: FormControlRecord | undefined,
  ): readonly SuccessfulFormEntry[] {
    const entries: SuccessfulFormEntry[] = []

    const append = (record: FormControlRecord) => {
      const descriptor = record.descriptor
      if (
        this.recordDisabled(record) ||
        (record !== submitter && this.barredByDatalist(record.node))
      ) {
        return
      }
      if (descriptor.kind === "entries") {
        for (const entry of descriptor.entries) entries.push(entry)
        return
      }
      if (descriptor.name === undefined || descriptor.name === "") return
      switch (descriptor.kind) {
        case "checkable":
          if (descriptor.checked) {
            entries.push(Object.freeze({ name: descriptor.name, value: descriptor.value ?? "on" }))
          }
          return
        case "hidden":
          entries.push(
            Object.freeze({
              name: descriptor.name,
              value: isCharsetControlName(descriptor.name) ? "UTF-8" : (descriptor.value ?? ""),
            }),
          )
          if (descriptor.directionality) {
            entries.push(
              Object.freeze({
                name: descriptor.directionality.name,
                value: descriptor.directionality.value,
              }),
            )
          }
          return
        case "multiple":
          for (const value of descriptor.values) {
            entries.push(Object.freeze({ name: descriptor.name, value }))
          }
          return
        case "select": {
          let hasSelectedOption = false
          let firstEnabledOption: NormalizedFormSelectOption | undefined
          for (const item of descriptor.options) {
            const options = item.kind === "group" ? item.options : [item]
            for (const option of options) {
              if (option.selected) hasSelectedOption = true
              if (
                firstEnabledOption === undefined &&
                !option.disabled &&
                !(item.kind === "group" && item.disabled)
              ) {
                firstEnabledOption = option
              }
              if (item.kind === "group" && item.disabled) continue
              if (option.selected && !option.disabled) {
                entries.push(Object.freeze({ name: descriptor.name, value: option.value }))
              }
            }
          }
          if (
            descriptor.defaultSelection === "first-enabled" &&
            !hasSelectedOption &&
            firstEnabledOption
          ) {
            entries.push(Object.freeze({ name: descriptor.name, value: firstEnabledOption.value }))
          }
          return
        }
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
        this.assertRecordActive(record)
        append(record)
      }
      if (node.kind === "document" || isElement(node)) {
        for (const child of node.children) visit(child)
      }
    }
    visit(this.session.tree.document)
    if (submitter) {
      this.assertRecordActive(submitter)
      append(submitter)
    }
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
    const formId = attributeValue(node, "form")
    if (formId !== undefined) {
      if (formId === "") {
        throw new TargetError(`Form control ${JSON.stringify(nodeKey)} has a blank form owner`, {
          target: nodeKey,
        })
      }
      const owner = this.session.tree.getElementById(formId)
      if (!owner) {
        throw new TargetError(
          `Form control ${JSON.stringify(nodeKey)} references a missing form owner`,
          { target: nodeKey },
        )
      }
      if (owner !== this.form) {
        throw new TargetError(`Form control ${JSON.stringify(nodeKey)} belongs to another form`, {
          target: nodeKey,
        })
      }
      return node
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
    const formId = attributeValue(node, "form")
    if (formId !== undefined) {
      return formId !== "" && this.session.tree.getElementById(formId) === this.form
        ? node
        : undefined
    }
    let parent = node.parent
    while (parent && parent !== this.form) parent = parent.parent
    return parent === this.form ? node : undefined
  }

  private activeSubmitter(selection: FormControlSelection): FormControlRecord {
    if (!selection || typeof selection !== "object") {
      throw new TargetError("Form submitter requires a registration-bound selection")
    }
    let array: boolean
    try {
      array = Array.isArray(selection)
    } catch {
      throw new TargetError("Form submitter selection could not be read")
    }
    if (array) throw new TargetError("Form submitter requires a registration-bound selection")
    const record = this.selections.get(selection)
    if (!record || this.records.get(record.node) !== record) {
      throw new TargetError("Form submitter selection is no longer active")
    }
    this.assertRecordActive(record)
    if (record?.descriptor.kind !== "submitter") {
      throw new TargetError(`Form control ${JSON.stringify(record.node.key)} is not a submitter`, {
        target: record.node.key,
      })
    }
    if (this.recordDisabled(record)) {
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
    if (this.session.tree.getNodeByKey(record.node.key) !== record.node) {
      throw new StateError("Form control registration no longer owns its node", {
        target: record.node.key,
      })
    }
    const formId = attributeValue(record.node, "form")
    if (formId !== undefined) {
      if (formId === "" || this.session.tree.getElementById(formId) !== this.form) {
        throw new StateError("Form control registration no longer owns its form", {
          target: record.node.key,
        })
      }
      return
    }
    let parent = record.node.parent
    while (parent && parent !== this.form) parent = parent.parent
    if (parent !== this.form) {
      throw new StateError("Form control registration no longer owns its form", {
        target: record.node.key,
      })
    }
  }

  private disabledByFieldset(node: ProtocolElement): boolean {
    if (!this.formSemantics) return false
    let fieldset = node.parent
    while (fieldset && fieldset.kind !== "document") {
      if (
        isElement(fieldset) &&
        this.formContainerRole(fieldset) === "fieldset" &&
        hasAttribute(fieldset, "disabled")
      ) {
        const firstLegend = fieldset.children.find(
          (child): child is ProtocolElement =>
            isElement(child) && this.formContainerRole(child) === "legend",
        )
        let insideFirstLegend = false
        let parent: ProtocolNode | null = node
        while (parent && parent !== fieldset) {
          if (parent === firstLegend) {
            insideFirstLegend = true
            break
          }
          parent = parent.parent
        }
        if (!insideFirstLegend) return true
      }
      fieldset = fieldset.parent
    }
    return false
  }

  private recordDisabled(record: FormControlRecord): boolean {
    return record.descriptor.disabled === true || this.disabledByFieldset(record.node)
  }

  private effectiveValidity(record: FormControlRecord): FormControlValidity {
    if (
      this.recordDisabled(record) ||
      this.barredByDatalist(record.node) ||
      record.descriptor.kind === "hidden" ||
      record.descriptor.kind === "submitter"
    ) {
      return VALID_FORM_CONTROL
    }
    return record.descriptor.validity ?? VALID_FORM_CONTROL
  }

  private barredByDatalist(node: ProtocolElement): boolean {
    if (!this.formSemantics) return false
    let parent = node.parent
    while (parent && parent.kind !== "document") {
      if (isElement(parent) && this.formContainerRole(parent) === "datalist") return true
      parent = parent.parent
    }
    return false
  }

  private formContainerRole(element: ProtocolElement): FormContainerRole | undefined {
    const role = this.formSemantics?.formContainerRole(element)
    if (role !== undefined && role !== "datalist" && role !== "fieldset" && role !== "legend") {
      throw new PropsError("Form container role must be datalist, fieldset, or legend", {
        target: element.key,
      })
    }
    return role
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
