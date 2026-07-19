import { PropsError, RequestError, StateError } from "./errors"
import { NotificationEvent } from "./events"
import type { FormSubmissionDestination } from "./frames"

export type FormSubmissionState = "stopped" | "stopping" | "waiting"

export interface FormSubmissionHandle {
  readonly destination: FormSubmissionDestination
  readonly formNodeKey: string
  readonly requestId: string
  readonly signal: AbortSignal
  readonly state: FormSubmissionState
  readonly submitterNodeKey: string | undefined
  stop(): true | undefined
}

export interface FormSubmissionFetchResponse {
  readonly redirected: boolean
  readonly status: number
}

export type FormSubmissionEndOutcome =
  | Readonly<{
      fetchResponse: FormSubmissionFetchResponse
      success: boolean
    }>
  | Readonly<{
      error: RequestError
      success: false
    }>

export type SubmitStartEventDetail = Readonly<{ formSubmission: FormSubmissionHandle }>

export type SubmitEndEventDetail =
  | Readonly<{ formSubmission: FormSubmissionHandle }>
  | Readonly<{
      fetchResponse: FormSubmissionFetchResponse
      formSubmission: FormSubmissionHandle
      success: boolean
    }>
  | Readonly<{
      error: RequestError
      formSubmission: FormSubmissionHandle
      success: false
    }>

export class SubmitStartEvent extends NotificationEvent<"submit-start", SubmitStartEventDetail> {
  constructor(formSubmission: FormSubmissionHandle) {
    super("submit-start", Object.freeze({ formSubmission }))
    Object.freeze(this)
  }
}

export class SubmitEndEvent extends NotificationEvent<"submit-end", SubmitEndEventDetail> {
  constructor(formSubmission: FormSubmissionHandle, outcome?: FormSubmissionEndOutcome) {
    super("submit-end", cloneEndDetail(formSubmission, outcome))
    Object.freeze(this)
  }
}

export type FormSubmissionLifecycleEvent = SubmitEndEvent | SubmitStartEvent

export interface FormSubmissionLifecycleEventMap {
  readonly "submit-end": SubmitEndEvent
  readonly "submit-start": SubmitStartEvent
}

export interface FormSubmissionLifecycleOptions {
  readonly onObserverError?: (error: AggregateError) => undefined
}

type FormSubmissionLifecycleEventType = keyof FormSubmissionLifecycleEventMap
type FormSubmissionLifecycleListener<Type extends FormSubmissionLifecycleEventType> = (
  event: FormSubmissionLifecycleEventMap[Type],
) => undefined
type FormSubmissionObserver = (error: AggregateError) => undefined

interface FormSubmissionHandleState {
  readonly stop: () => void
  state: FormSubmissionState
}

interface CreateFormSubmissionHandleOptions {
  readonly controller: AbortController
  readonly destination: FormSubmissionDestination
  readonly formNodeKey: string
  readonly requestId: string
  readonly stop: () => void
  readonly submitterNodeKey?: string
}

class ExactFormSubmissionHandle implements FormSubmissionHandle {
  readonly destination: FormSubmissionDestination
  readonly formNodeKey: string
  readonly requestId: string
  readonly signal: AbortSignal
  readonly submitterNodeKey: string | undefined

  constructor(options: CreateFormSubmissionHandleOptions) {
    this.destination = cloneDestination(options.destination)
    this.formNodeKey = options.formNodeKey
    this.requestId = options.requestId
    this.signal = options.controller.signal
    this.submitterNodeKey = options.submitterNodeKey
    handleStates.set(this, {
      state: "waiting",
      stop: options.stop,
    })
    options.controller.signal.addEventListener(
      "abort",
      () => {
        const internal = handleStates.get(this)
        if (internal?.state === "waiting") internal.state = "stopping"
      },
      { once: true },
    )
    Object.freeze(this)
  }

  get state(): FormSubmissionState {
    return handleState(this).state
  }

  stop(): true | undefined {
    const internal = handleState(this)
    if (internal.state !== "waiting") return undefined
    internal.state = "stopping"
    internal.stop()
    return true
  }
}

const handleStates = new WeakMap<ExactFormSubmissionHandle, FormSubmissionHandleState>()

export const FORM_SUBMISSION_LIFECYCLE_START_DISPATCH = Symbol(
  "expo-turbo.form-submission-lifecycle.start-dispatch",
)
export const FORM_SUBMISSION_LIFECYCLE_END_DISPATCH = Symbol(
  "expo-turbo.form-submission-lifecycle.end-dispatch",
)

/**
 * Synchronous logical lifecycle for native form transport. Both events are
 * notification-only; a submit-start observer stops the exact attempt through
 * its live FormSubmission handle.
 */
export class FormSubmissionLifecycle {
  private readonly listeners = new Map<
    FormSubmissionLifecycleEventType,
    Set<(event: FormSubmissionLifecycleEvent) => unknown>
  >()
  private readonly onObserverError: FormSubmissionObserver | undefined

  constructor(options: FormSubmissionLifecycleOptions = {}) {
    this.onObserverError = observerOption(options)
  }

  subscribe<Type extends FormSubmissionLifecycleEventType>(
    type: Type,
    listener: FormSubmissionLifecycleListener<Type>,
  ): () => void {
    if (type !== "submit-start" && type !== "submit-end") {
      throw new StateError("Form submission lifecycle event type is invalid")
    }
    if (typeof listener !== "function") {
      throw new StateError("Form submission lifecycle listener must be a function")
    }

    let listeners = this.listeners.get(type)
    if (!listeners) {
      listeners = new Set()
      this.listeners.set(type, listeners)
    }
    const admitted = listener as (event: FormSubmissionLifecycleEvent) => unknown
    listeners.add(admitted)
    return () => {
      listeners?.delete(admitted)
      if (listeners?.size === 0) this.listeners.delete(type)
    }
  }

  [FORM_SUBMISSION_LIFECYCLE_START_DISPATCH](event: SubmitStartEvent): void {
    this.dispatch("submit-start", event)
  }

  [FORM_SUBMISSION_LIFECYCLE_END_DISPATCH](event: SubmitEndEvent): void {
    this.dispatch("submit-end", event)
  }

  private dispatch(
    type: FormSubmissionLifecycleEventType,
    event: FormSubmissionLifecycleEvent,
  ): void {
    const errors: StateError[] = []
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      let result: unknown
      try {
        result = listener(event)
      } catch {
        errors.push(new StateError(`Form ${type} listener failed`))
        continue
      }
      if (result === undefined) continue
      consumeUnexpectedResult(result)
      errors.push(new StateError(`Form ${type} listener must return undefined`))
    }
    if (errors.length === 0) return

    const aggregate = new AggregateError(
      errors,
      `Form submission ${type} notification observers failed`,
    )
    if (!this.onObserverError) {
      surfaceObserverError(aggregate)
      return
    }

    let result: unknown
    try {
      result = this.onObserverError(aggregate)
    } catch {
      surfaceObserverError(observerReporterError(errors))
      return
    }
    if (result !== undefined) {
      consumeUnexpectedResult(result)
      surfaceObserverError(observerReporterError(errors))
    }
  }
}

export function createFormSubmissionHandle(
  options: CreateFormSubmissionHandleOptions,
): FormSubmissionHandle {
  return new ExactFormSubmissionHandle(options)
}

export function finishFormSubmissionHandle(handle: FormSubmissionHandle): void {
  const internal = handleState(handle)
  internal.state = "stopped"
}

export function formSubmissionLifecycleOption(
  options: unknown,
  owner: string,
): FormSubmissionLifecycle | undefined {
  let candidate: unknown
  try {
    if (!options || typeof options !== "object" || Array.isArray(options)) {
      throw new TypeError("invalid options")
    }
    candidate = (options as { readonly submissionLifecycle?: unknown }).submissionLifecycle
  } catch {
    throw new PropsError(`${owner} options could not be read`)
  }
  if (candidate === undefined) return undefined

  let valid = false
  try {
    valid = candidate instanceof FormSubmissionLifecycle
  } catch {
    // Hostile proxies are rejected through the same redacted option boundary.
  }
  if (!valid) throw new PropsError(`${owner} submission lifecycle is invalid`)
  return candidate as FormSubmissionLifecycle
}

function cloneDestination(destination: FormSubmissionDestination): FormSubmissionDestination {
  return Object.freeze({ ...destination })
}

function cloneEndDetail(
  formSubmission: FormSubmissionHandle,
  outcome: FormSubmissionEndOutcome | undefined,
): SubmitEndEventDetail {
  if (!outcome) return Object.freeze({ formSubmission })
  if ("error" in outcome) {
    return Object.freeze({
      error: cloneEndError(outcome.error),
      formSubmission,
      success: false,
    })
  }
  return Object.freeze({
    fetchResponse: Object.freeze({ ...outcome.fetchResponse }),
    formSubmission,
    success: outcome.success,
  })
}

function cloneEndError(error: RequestError): RequestError {
  const method = typeof error.context.method === "string" ? error.context.method : undefined
  const responseStatus =
    typeof error.context.responseStatus === "number" &&
    Number.isSafeInteger(error.context.responseStatus) &&
    error.context.responseStatus >= 100 &&
    error.context.responseStatus <= 599
      ? error.context.responseStatus
      : undefined
  return Object.freeze(
    new RequestError("Form submission request failed", {
      ...(method ? { method } : {}),
      ...(responseStatus !== undefined ? { responseStatus } : {}),
    }),
  )
}

function handleState(handle: FormSubmissionHandle): FormSubmissionHandleState {
  const state = handleStates.get(handle as ExactFormSubmissionHandle)
  if (!state) throw new StateError("Form submission handle is invalid")
  return state
}

function observerOption(options: unknown): FormSubmissionObserver | undefined {
  let observer: unknown
  try {
    if (!options || typeof options !== "object" || Array.isArray(options)) {
      throw new TypeError("invalid options")
    }
    observer = (options as { readonly onObserverError?: unknown }).onObserverError
  } catch {
    throw new PropsError("Form submission lifecycle options could not be read")
  }
  if (observer !== undefined && typeof observer !== "function") {
    throw new PropsError("Form submission lifecycle error observer must be a function")
  }
  return observer as FormSubmissionObserver | undefined
}

function consumeUnexpectedResult(result: unknown): void {
  if ((typeof result !== "object" || result === null) && typeof result !== "function") return
  void Promise.resolve(result).catch(() => undefined)
}

function observerReporterError(errors: readonly StateError[]): AggregateError {
  return new AggregateError(
    [...errors, new StateError("Form submission lifecycle observer reporter failed")],
    "Form submission lifecycle observer reporting failed",
  )
}

function surfaceObserverError(error: AggregateError): void {
  queueMicrotask(() => {
    throw error
  })
}
