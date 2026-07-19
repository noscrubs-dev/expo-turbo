import { FrameMissingError, PropsError, RequestError, StateError } from "./errors"
import { CancellableEvent } from "./events"
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

export interface FrameMissingVisitRequest {
  readonly action: FrameMissingVisitAction
  readonly body: string
  readonly frameId: string
  readonly response: FrameMissingResponse
}

export interface FrameLifecycleOptions {
  readonly visitResponse?: (request: FrameMissingVisitRequest) => Promise<void> | void
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
  readonly visitResponse: FrameLifecycleOptions["visitResponse"]
}

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

export type FrameLifecycleEvent = FrameMissingEvent

export interface FrameLifecycleEventMap {
  readonly "frame-missing": FrameMissingEvent
}

type FrameLifecycleEventType = keyof FrameLifecycleEventMap
type FrameLifecycleListener<Type extends FrameLifecycleEventType> = (
  event: FrameLifecycleEventMap[Type],
) => undefined

export const FRAME_LIFECYCLE_MISSING_DISPATCH = Symbol(
  "expo-turbo.frame-lifecycle.missing-dispatch",
)

/** Synchronous lifecycle for a response that omits its requested Frame. */
export class FrameLifecycle {
  private readonly listeners = new Map<
    FrameLifecycleEventType,
    Set<(event: FrameLifecycleEvent) => unknown>
  >()

  constructor(options: FrameLifecycleOptions = {}) {
    lifecycleStates.set(this, { visitResponse: visitResponseOption(options) })
    frameLifecycles.add(this)
  }

  subscribe<Type extends FrameLifecycleEventType>(
    type: Type,
    listener: FrameLifecycleListener<Type>,
  ): () => void {
    if (type !== "frame-missing") {
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
  const execution = executeVisit(lifecycleState.visitResponse, state, body)
  state.execution = execution
  return execution
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
  state: FrameMissingEventState,
  body: string | undefined,
): Promise<void> {
  try {
    if (!visitResponse || body === undefined) {
      throw new Error("Frame response visitor is unavailable")
    }
    await visitResponse(
      Object.freeze({
        action: state.intent?.action ?? "advance",
        body,
        frameId: state.frameId,
        response: state.response,
      }),
    )
  } catch {
    throw new RequestError("Frame-missing response visit failed", {
      frameId: state.frameId,
      responseStatus: state.response.status,
    })
  }
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

function visitResponseOption(options: unknown): FrameLifecycleOptions["visitResponse"] {
  let visitor: unknown
  try {
    if (!options || typeof options !== "object" || Array.isArray(options)) {
      throw new TypeError("invalid options")
    }
    visitor = (options as { readonly visitResponse?: unknown }).visitResponse
  } catch {
    throw new PropsError("Frame lifecycle options could not be read")
  }
  if (visitor !== undefined && typeof visitor !== "function") {
    throw new PropsError("Frame lifecycle response visitor must be a function")
  }
  return visitor as FrameLifecycleOptions["visitResponse"]
}

function consumeUnexpectedResult(result: unknown): void {
  consumeThenableResult(result)
}
