import { FrameMissingError, PropsError, RequestError, StateError } from "./errors"
import { CancellableEvent, NotificationEvent } from "./events"
import { consumeThenableResult } from "./thenable-result"

export type FrameMissingVisitAction = "advance" | "replace"

export interface FrameMissingResponse {
  readonly redirected: boolean
  readonly status: number
  readonly url: string
}

export interface FrameMissingVisitOptions {
  readonly action?: FrameMissingVisitAction
}

export interface FrameMissingEventDetail {
  readonly frameId: string
  readonly response: FrameMissingResponse
  visit(options?: FrameMissingVisitOptions): void
}

interface FrameResponseVisitRequestBase {
  readonly action: FrameMissingVisitAction
  readonly body: string
  readonly frameId: string
  readonly response: FrameMissingResponse
}

export type FrameResponseVisitReason = "frame-missing" | "visit-control-reload"

export type FrameResponseVisitRequest = Readonly<
  FrameResponseVisitRequestBase & { readonly reason: FrameResponseVisitReason }
>

export type FrameMissingVisitRequest = FrameResponseVisitRequest & {
  readonly reason: "frame-missing"
}

export type FrameVisitControlReloadRequest = FrameResponseVisitRequest & {
  readonly reason: "visit-control-reload"
}

export interface FrameLifecycleOptions {
  readonly onObserverError?: (error: AggregateError) => undefined
  readonly visitResponse?: (request: FrameResponseVisitRequest) => Promise<void> | void
}

export interface ExecuteFrameVisitControlReloadOptions {
  readonly body: string
  readonly frameId: string
  readonly response: FrameMissingResponse
}

interface FrameMissingEventState {
  body: string | undefined
  closed: boolean
  execution: Promise<void> | undefined
  readonly frameId: string
  intent: Readonly<{ action: FrameMissingVisitAction }> | undefined
  readonly response: FrameMissingResponse
}

interface FrameLifecycleState {
  readonly onObserverError: FrameLifecycleObserver | undefined
  readonly visitResponse: FrameLifecycleOptions["visitResponse"]
}

type FrameLifecycleObserver = (error: AggregateError) => undefined

export interface CreateFrameMissingEventOptions {
  readonly body: string
  readonly frameId: string
  readonly response: FrameMissingResponse
}

const eventStates = new WeakMap<FrameMissingEvent, FrameMissingEventState>()
const lifecycleStates = new WeakMap<FrameLifecycle, FrameLifecycleState>()
const frameLifecycles = new WeakSet<FrameLifecycle>()

/**
 * Cancellable native equivalent of Turbo's frame-missing event. The received
 * response body is deliberately retained outside this public event surface.
 */
export class FrameMissingEvent extends CancellableEvent<"frame-missing", FrameMissingEventDetail> {
  constructor(frameId: string, response: FrameMissingResponse) {
    const admittedResponse = cloneResponse(response)
    const state: FrameMissingEventState = {
      body: undefined,
      closed: false,
      execution: undefined,
      frameId,
      intent: undefined,
      response: admittedResponse,
    }
    const visit = (options?: FrameMissingVisitOptions) => {
      if (state.closed || state.intent) return
      state.intent = Object.freeze({
        action: visitActionOption(options, frameId),
      })
    }
    super(
      "frame-missing",
      Object.freeze({
        frameId,
        response: admittedResponse,
        visit,
      }),
    )

    let prevented = false
    Object.defineProperties(this, {
      defaultPrevented: {
        configurable: false,
        enumerable: true,
        get: () => prevented,
      },
      detail: { writable: false },
      preventDefault: {
        configurable: false,
        value: () => {
          prevented = true
        },
        writable: false,
      },
      type: { writable: false },
    })
    eventStates.set(this, state)
    Object.freeze(this)
  }
}

export type FrameRenderMethod = "replace"

export interface FrameRenderEventDetail {
  readonly frameId: string
  readonly renderMethod: FrameRenderMethod
  readonly url: string
}

export class FrameRenderEvent extends NotificationEvent<"frame-render", FrameRenderEventDetail> {
  constructor(detail: FrameRenderEventDetail) {
    super("frame-render", Object.freeze({ ...detail }))
    Object.freeze(this)
  }
}

export interface FrameLoadEventDetail {
  readonly frameId: string
  readonly url: string
}

export class FrameLoadEvent extends NotificationEvent<"frame-load", FrameLoadEventDetail> {
  constructor(detail: FrameLoadEventDetail) {
    super("frame-load", Object.freeze({ ...detail }))
    Object.freeze(this)
  }
}

export type FrameLifecycleEvent = FrameLoadEvent | FrameMissingEvent | FrameRenderEvent

export interface FrameLifecycleEventMap {
  readonly "frame-load": FrameLoadEvent
  readonly "frame-missing": FrameMissingEvent
  readonly "frame-render": FrameRenderEvent
}

type FrameLifecycleEventType = keyof FrameLifecycleEventMap
type FrameLifecycleListener<Type extends FrameLifecycleEventType> = (
  event: FrameLifecycleEventMap[Type],
) => undefined

export const FRAME_LIFECYCLE_MISSING_DISPATCH = Symbol(
  "expo-turbo.frame-lifecycle.missing-dispatch",
)
export const FRAME_LIFECYCLE_RENDER_DISPATCH = Symbol("expo-turbo.frame-lifecycle.render-dispatch")
export const FRAME_LIFECYCLE_LOAD_DISPATCH = Symbol("expo-turbo.frame-lifecycle.load-dispatch")

/**
 * Synchronous lifecycle for Frame response handling. Frame-missing listeners
 * may cancel an admission; render and load listeners are notification-only
 * observers.
 */
export class FrameLifecycle {
  private readonly listeners = new Map<
    FrameLifecycleEventType,
    Set<(event: FrameLifecycleEvent) => unknown>
  >()

  constructor(options: FrameLifecycleOptions = {}) {
    lifecycleStates.set(this, lifecycleOptions(options))
    frameLifecycles.add(this)
  }

  subscribe<Type extends FrameLifecycleEventType>(
    type: Type,
    listener: FrameLifecycleListener<Type>,
  ): () => void {
    if (type !== "frame-load" && type !== "frame-missing" && type !== "frame-render") {
      throw new StateError("Frame lifecycle event type is invalid")
    }
    if (typeof listener !== "function") {
      throw new StateError("Frame lifecycle listener must be a function")
    }

    let listeners = this.listeners.get(type)
    if (!listeners) {
      listeners = new Set()
      this.listeners.set(type, listeners)
    }
    const admitted = listener as (event: FrameLifecycleEvent) => unknown
    listeners.add(admitted)
    return () => {
      listeners?.delete(admitted)
      if (listeners?.size === 0) this.listeners.delete(type)
    }
  }

  [FRAME_LIFECYCLE_MISSING_DISPATCH](event: FrameMissingEvent): FrameMissingEvent {
    for (const listener of [...(this.listeners.get("frame-missing") ?? [])]) {
      let result: unknown
      try {
        result = listener(event)
      } catch {
        throw listenerError(event, "Frame-missing listener failed")
      }
      if (result === undefined) continue
      try {
        consumeUnexpectedResult(result)
      } catch {
        throw listenerError(event, "Frame-missing listener failed")
      }
      throw listenerError(event, "Frame-missing listener must return undefined")
    }
    return event
  }

  [FRAME_LIFECYCLE_RENDER_DISPATCH](event: FrameRenderEvent): void {
    this.dispatchNotification("frame-render", event, "Frame-render listener failed")
  }

  [FRAME_LIFECYCLE_LOAD_DISPATCH](event: FrameLoadEvent): void {
    this.dispatchNotification("frame-load", event, "Frame-load listener failed")
  }

  private dispatchNotification(
    type: "frame-load" | "frame-render",
    event: FrameLoadEvent | FrameRenderEvent,
    listenerFailure: string,
  ): void {
    const observer = admittedLifecycleState(this).onObserverError
    const errors: StateError[] = []
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      let result: unknown
      try {
        result = listener(event)
      } catch {
        errors.push(new StateError(listenerFailure))
        continue
      }
      try {
        rejectNotificationListenerResult(
          result,
          `${notificationName(type)} listener must return undefined`,
        )
      } catch {
        errors.push(new StateError(listenerFailure))
      }
    }
    if (errors.length === 0) return

    const observerError = new AggregateError(
      errors,
      "Frame lifecycle notification observers failed",
    )
    if (!observer) {
      surfaceObserverError(observerError)
      return
    }

    let result: unknown
    try {
      result = observer(observerError)
    } catch {
      surfaceObserverError(observerReporterError(errors))
      return
    }
    if (result !== undefined) {
      consumeNotificationResult(result)
      surfaceObserverError(observerReporterError(errors))
    }
  }
}

export function createFrameMissingEvent(
  options: CreateFrameMissingEventOptions,
): FrameMissingEvent {
  const event = new FrameMissingEvent(options.frameId, options.response)
  frameMissingEventState(event).body = options.body
  return event
}

export function hasFrameMissingVisitIntent(event: FrameMissingEvent): boolean {
  return frameMissingEventState(event).intent !== undefined
}

export function discardFrameMissingResponseBody(event: FrameMissingEvent): void {
  const state = frameMissingEventState(event)
  if (!state.execution) state.execution = Promise.resolve()
  state.body = undefined
  state.closed = true
}

export function executeFrameMissingVisit(
  lifecycle: FrameLifecycle,
  event: FrameMissingEvent,
): Promise<void> {
  const state = frameMissingEventState(event)
  if (state.execution) return state.execution
  if (!event.defaultPrevented || !state.intent) {
    const execution = Promise.resolve()
    state.body = undefined
    state.closed = true
    state.execution = execution
    return execution
  }

  const lifecycleState = admittedLifecycleState(lifecycle)
  const body = state.body
  state.body = undefined
  state.closed = true
  if (body === undefined) {
    const execution = failedVisit(state.frameId, state.response, "frame-missing")
    state.execution = execution
    return execution
  }
  const execution = executeVisit(
    lifecycleState.visitResponse,
    Object.freeze({
      action: state.intent.action,
      body,
      frameId: state.frameId,
      reason: "frame-missing",
      response: state.response,
    }),
  )
  state.execution = execution
  return execution
}

export function executeFrameVisitControlReload(
  lifecycle: FrameLifecycle | undefined,
  options: ExecuteFrameVisitControlReloadOptions,
): Promise<void> {
  if (!lifecycle) {
    return failedVisit(options.frameId, options.response, "visit-control-reload")
  }
  const lifecycleState = admittedLifecycleState(lifecycle)
  return executeVisit(
    lifecycleState.visitResponse,
    Object.freeze({
      action: "advance",
      body: options.body,
      frameId: options.frameId,
      reason: "visit-control-reload",
      response: cloneResponse(options.response),
    }),
  )
}

export function frameLifecycleOption(options: unknown, owner: string): FrameLifecycle | undefined {
  let candidate: unknown
  try {
    if (!options || typeof options !== "object" || Array.isArray(options)) {
      throw new TypeError("invalid options")
    }
    candidate = (options as { readonly frameLifecycle?: unknown }).frameLifecycle
  } catch {
    throw new PropsError(`${owner} options could not be read`)
  }
  if (candidate === undefined) return undefined
  if (
    ((typeof candidate !== "object" || candidate === null) && typeof candidate !== "function") ||
    !frameLifecycles.has(candidate as FrameLifecycle)
  ) {
    throw new PropsError(`${owner} Frame lifecycle is invalid`)
  }
  return candidate as FrameLifecycle
}

async function executeVisit(
  visitResponse: FrameLifecycleOptions["visitResponse"],
  request: FrameResponseVisitRequest,
): Promise<void> {
  try {
    if (!visitResponse) {
      throw new Error("Frame response visitor is unavailable")
    }
    await visitResponse(request)
  } catch {
    throw new RequestError(
      request.reason === "frame-missing"
        ? "Frame-missing response visit failed"
        : "Frame visit-control response visit failed",
      {
        frameId: request.frameId,
        responseStatus: request.response.status,
      },
    )
  }
}

function failedVisit(
  frameId: string,
  response: FrameMissingResponse,
  reason: FrameResponseVisitReason,
): Promise<never> {
  return Promise.reject(
    new RequestError(
      reason === "frame-missing"
        ? "Frame-missing response visit failed"
        : "Frame visit-control response visit failed",
      {
        frameId,
        responseStatus: response.status,
      },
    ),
  )
}

function admittedLifecycleState(lifecycle: FrameLifecycle): FrameLifecycleState {
  const state = lifecycleStates.get(lifecycle)
  if (!state || !frameLifecycles.has(lifecycle)) {
    throw new StateError("Frame lifecycle is invalid")
  }
  return state
}

function frameMissingEventState(event: FrameMissingEvent): FrameMissingEventState {
  const state = eventStates.get(event)
  if (!state) throw new StateError("Frame-missing event is invalid")
  return state
}

function listenerError(event: FrameMissingEvent, message: string): FrameMissingError {
  return new FrameMissingError(message, {
    frameId: event.detail.frameId,
    responseStatus: event.detail.response.status,
  })
}

function cloneResponse(response: FrameMissingResponse): FrameMissingResponse {
  return Object.freeze({
    redirected: response.redirected,
    status: response.status,
    url: response.url,
  })
}

function visitActionOption(
  options: FrameMissingVisitOptions | undefined,
  frameId: string,
): FrameMissingVisitAction {
  if (options === undefined) return "advance"
  let action: unknown
  try {
    if (!options || typeof options !== "object" || Array.isArray(options)) {
      throw new TypeError("invalid options")
    }
    action = options.action
  } catch {
    throw new FrameMissingError("Frame-missing visit options could not be read", { frameId })
  }
  if (action === undefined) return "advance"
  if (action !== "advance" && action !== "replace") {
    throw new FrameMissingError("Frame-missing visit action is invalid", { frameId })
  }
  return action
}

function lifecycleOptions(options: unknown): FrameLifecycleState {
  let observer: unknown
  let visitor: unknown
  try {
    if (!options || typeof options !== "object" || Array.isArray(options)) {
      throw new TypeError("invalid options")
    }
    observer = (options as { readonly onObserverError?: unknown }).onObserverError
    visitor = (options as { readonly visitResponse?: unknown }).visitResponse
  } catch {
    throw new PropsError("Frame lifecycle options could not be read")
  }
  if (observer !== undefined && typeof observer !== "function") {
    throw new PropsError("Frame lifecycle error observer must be a function")
  }
  if (visitor !== undefined && typeof visitor !== "function") {
    throw new PropsError("Frame lifecycle response visitor must be a function")
  }
  return {
    onObserverError: observer as FrameLifecycleObserver | undefined,
    visitResponse: visitor as FrameLifecycleOptions["visitResponse"],
  }
}

function consumeUnexpectedResult(result: unknown): void {
  consumeThenableResult(result)
}

function notificationName(type: "frame-load" | "frame-render"): string {
  return `${type[0]?.toUpperCase() ?? ""}${type.slice(1)}`
}

function rejectNotificationListenerResult(result: unknown, message: string): void {
  if (result === undefined) return
  consumeNotificationResult(result)
  throw new StateError(message)
}

function consumeNotificationResult(result: unknown): void {
  if ((typeof result !== "object" || result === null) && typeof result !== "function") return
  void Promise.resolve(result).catch(() => undefined)
}

function observerReporterError(errors: readonly StateError[]): AggregateError {
  return new AggregateError(
    [...errors, new StateError("Frame lifecycle notification observer reporter failed")],
    "Frame lifecycle notification observer reporting failed",
  )
}

function surfaceObserverError(error: AggregateError): void {
  queueMicrotask(() => {
    throw error
  })
}
