import { ActionError, type ExpoTurboError, PropsError, StateError } from "./errors"
import { CancellableEvent, NotificationEvent } from "./events"
import type { DocumentSession } from "./session"
import { isSessionCommitError } from "./session-commit-error-internal"
import type { StreamActionReport } from "./streams"
import { consumeThenableResult } from "./thenable-result"
import type { ProtocolElement } from "./tree"

export interface StreamRenderResult {
  readonly appliedTargets: number
  readonly matchedTargets: number
  readonly status: "applied" | "noop"
}

export interface StreamRenderContext {
  readonly action: string
  readonly index: number
  readonly newStream: ProtocolElement
  readonly session: DocumentSession
  renderDefault(): StreamRenderResult
}

export type StreamRenderer = (context: StreamRenderContext) => StreamRenderResult

export interface BeforeStreamRenderEventDetail {
  readonly action: string
  readonly index: number
  readonly newStream: ProtocolElement
  render: StreamRenderer
}

export type BeforeStreamRenderEvent = CancellableEvent<
  "before-stream-render",
  BeforeStreamRenderEventDetail
>

export interface StreamActionEventDetail {
  readonly newStream: ProtocolElement
  readonly report: StreamActionReport
}

export type StreamActionEvent = NotificationEvent<"stream-action", StreamActionEventDetail>

export type StreamLifecycleEvent = BeforeStreamRenderEvent | StreamActionEvent

export interface StreamLifecycleEventMap {
  readonly "before-stream-render": BeforeStreamRenderEvent
  readonly "stream-action": StreamActionEvent
}

export interface StreamLifecycleOptions {
  readonly onObserverError?: (error: AggregateError) => undefined
}

type StreamLifecycleEventType = keyof StreamLifecycleEventMap
type StreamLifecycleListener<Type extends StreamLifecycleEventType> = (
  event: StreamLifecycleEventMap[Type],
) => undefined
type StreamLifecycleObserver = (error: AggregateError) => undefined

interface StreamRenderDetailState {
  readonly action: string
  renderer: StreamRenderer
}

const streamRenderDetailStates = new WeakMap<
  ExactBeforeStreamRenderEventDetail,
  StreamRenderDetailState
>()
const preventedStreamRenderEvents = new WeakSet<ExactBeforeStreamRenderEvent>()
const streamLifecycles = new WeakSet<StreamLifecycle>()

class ExactBeforeStreamRenderEventDetail implements BeforeStreamRenderEventDetail {
  readonly action: string
  readonly index: number
  readonly newStream: ProtocolElement

  constructor(action: string, index: number, newStream: ProtocolElement, renderer: StreamRenderer) {
    this.action = action
    this.index = index
    this.newStream = newStream
    streamRenderDetailStates.set(this, { action, renderer })
    Object.freeze(this)
  }

  get render(): StreamRenderer {
    return renderDetailState(this).renderer
  }

  set render(renderer: StreamRenderer) {
    if (typeof renderer !== "function") {
      throw new ActionError("Stream renderer must be a function", { action: this.action })
    }
    renderDetailState(this).renderer = renderer
  }
}

class ExactBeforeStreamRenderEvent extends CancellableEvent<
  "before-stream-render",
  BeforeStreamRenderEventDetail
> {
  constructor(action: string, index: number, newStream: ProtocolElement, renderer: StreamRenderer) {
    super(
      "before-stream-render",
      new ExactBeforeStreamRenderEventDetail(action, index, newStream, renderer),
    )
    Object.defineProperties(this, {
      defaultPrevented: {
        configurable: false,
        enumerable: true,
        get: () => preventedStreamRenderEvents.has(this),
      },
      detail: { writable: false },
      preventDefault: {
        configurable: false,
        value: () => preventedStreamRenderEvents.add(this),
        writable: false,
      },
      type: { writable: false },
    })
    Object.freeze(this)
  }

  override get defaultPrevented(): boolean {
    return preventedStreamRenderEvents.has(this)
  }

  override preventDefault(): void {
    preventedStreamRenderEvents.add(this)
  }
}

class ExactStreamActionEvent extends NotificationEvent<"stream-action", StreamActionEventDetail> {
  constructor(newStream: ProtocolElement, report: StreamActionReport) {
    super(
      "stream-action",
      Object.freeze({
        newStream,
        report: cloneActionReport(report),
      }),
    )
    Object.freeze(this)
  }
}

export const STREAM_LIFECYCLE_BEFORE_DISPATCH = Symbol(
  "expo-turbo.stream-lifecycle.before-dispatch",
)
export const STREAM_LIFECYCLE_ACTION_DISPATCH = Symbol(
  "expo-turbo.stream-lifecycle.action-dispatch",
)

/**
 * Synchronous logical lifecycle for one ordered Turbo Stream action. Before
 * listeners may cancel or replace the registered native renderer; action
 * listeners are isolated notification observers.
 */
export class StreamLifecycle {
  private readonly listeners = new Map<
    StreamLifecycleEventType,
    Set<(event: StreamLifecycleEvent) => unknown>
  >()
  private readonly onObserverError: StreamLifecycleObserver | undefined

  constructor(options: StreamLifecycleOptions = {}) {
    this.onObserverError = observerOption(options)
    streamLifecycles.add(this)
  }

  subscribe<Type extends StreamLifecycleEventType>(
    type: Type,
    listener: StreamLifecycleListener<Type>,
  ): () => void {
    if (type !== "before-stream-render" && type !== "stream-action") {
      throw new StateError("Stream lifecycle event type is invalid")
    }
    if (typeof listener !== "function") {
      throw new StateError("Stream lifecycle listener must be a function")
    }

    let listeners = this.listeners.get(type)
    if (!listeners) {
      listeners = new Set()
      this.listeners.set(type, listeners)
    }
    const admitted = listener as (event: StreamLifecycleEvent) => unknown
    listeners.add(admitted)
    return () => {
      listeners?.delete(admitted)
      if (listeners?.size === 0) this.listeners.delete(type)
    }
  }

  [STREAM_LIFECYCLE_BEFORE_DISPATCH](event: BeforeStreamRenderEvent): void {
    for (const listener of [...(this.listeners.get("before-stream-render") ?? [])]) {
      let result: unknown
      try {
        result = listener(event)
      } catch (error) {
        if (isSessionCommitError(error)) throw error
        throw new ActionError("Before-stream-render listener failed", {
          action: event.detail.action,
        })
      }
      if (result === undefined) continue
      consumeUnexpectedResult(result)
      throw new ActionError("Before-stream-render listener must return undefined", {
        action: event.detail.action,
      })
    }
  }

  [STREAM_LIFECYCLE_ACTION_DISPATCH](event: StreamActionEvent): void {
    const errors: StateError[] = []
    for (const listener of [...(this.listeners.get("stream-action") ?? [])]) {
      let result: unknown
      try {
        result = listener(event)
      } catch {
        errors.push(new StateError("Stream-action listener failed"))
        continue
      }
      if (result === undefined) continue
      try {
        consumeUnexpectedResult(result)
      } catch {
        errors.push(new StateError("Stream-action listener failed"))
        continue
      }
      errors.push(new StateError("Stream-action listener must return undefined"))
    }
    if (errors.length === 0) return

    const aggregate = new AggregateError(errors, "Stream action notification observers failed")
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
      try {
        consumeUnexpectedResult(result)
      } catch {
        surfaceObserverError(observerReporterError(errors))
        return
      }
      surfaceObserverError(observerReporterError(errors))
    }
  }
}

export function createBeforeStreamRenderEvent(
  action: string,
  index: number,
  newStream: ProtocolElement,
  renderer: StreamRenderer,
): BeforeStreamRenderEvent {
  return new ExactBeforeStreamRenderEvent(action, index, newStream, renderer)
}

export function createStreamActionEvent(
  newStream: ProtocolElement,
  report: StreamActionReport,
): StreamActionEvent {
  return new ExactStreamActionEvent(newStream, report)
}

export function streamLifecycleOption(
  options: unknown,
  owner: string,
): StreamLifecycle | undefined {
  let candidate: unknown
  try {
    if (!options || typeof options !== "object" || Array.isArray(options)) {
      throw new TypeError("invalid options")
    }
    candidate = (options as { readonly streamLifecycle?: unknown }).streamLifecycle
  } catch {
    throw new PropsError(`${owner} options could not be read`)
  }
  if (candidate === undefined) return undefined

  if (
    ((typeof candidate !== "object" || candidate === null) && typeof candidate !== "function") ||
    !streamLifecycles.has(candidate as StreamLifecycle)
  ) {
    throw new PropsError(`${owner} Stream lifecycle is invalid`)
  }
  return candidate as StreamLifecycle
}

function renderDetailState(detail: ExactBeforeStreamRenderEventDetail): StreamRenderDetailState {
  const state = streamRenderDetailStates.get(detail)
  if (!state) throw new StateError("Before-stream-render detail is invalid")
  return state
}

function cloneActionReport(report: StreamActionReport): StreamActionReport {
  return Object.freeze({
    action: report.action,
    appliedTargets: report.appliedTargets,
    ...(report.error ? { error: cloneActionError(report.error, report.action) } : {}),
    index: report.index,
    matchedTargets: report.matchedTargets,
    status: report.status,
  })
}

function cloneActionError(_error: ExpoTurboError, action: string): ExpoTurboError {
  return Object.freeze(new ActionError("Turbo Stream action failed", { action }))
}

function observerOption(options: unknown): StreamLifecycleObserver | undefined {
  let observer: unknown
  try {
    if (!options || typeof options !== "object" || Array.isArray(options)) {
      throw new TypeError("invalid options")
    }
    observer = (options as { readonly onObserverError?: unknown }).onObserverError
  } catch {
    throw new PropsError("Stream lifecycle options could not be read")
  }
  if (observer !== undefined && typeof observer !== "function") {
    throw new PropsError("Stream lifecycle error observer must be a function")
  }
  return observer as StreamLifecycleObserver | undefined
}

function consumeUnexpectedResult(result: unknown): void {
  consumeThenableResult(result)
}

function observerReporterError(errors: readonly StateError[]): AggregateError {
  return new AggregateError(
    [...errors, new StateError("Stream lifecycle observer reporter failed")],
    "Stream lifecycle observer reporting failed",
  )
}

function surfaceObserverError(error: AggregateError): void {
  queueMicrotask(() => {
    throw error
  })
}
