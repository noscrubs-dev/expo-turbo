import type { VisitAction } from "../adapters"
import { PropsError, StateError } from "./errors"
import { CancellableEvent, NotificationEvent } from "./events"
import { consumeThenableResult } from "./thenable-result"

export class LinkClickEvent extends CancellableEvent<
  "click",
  Readonly<{ nodeKey: string; url: string }>
> {
  constructor(nodeKey: string, url: string) {
    super("click", Object.freeze({ nodeKey, url }))
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
    Object.freeze(this)
  }
}

export class BeforeVisitEvent extends CancellableEvent<"before-visit", Readonly<{ url: string }>> {
  constructor(url: string) {
    super("before-visit", Object.freeze({ url }))
  }
}

export class BeforeCacheEvent extends NotificationEvent<"before-cache", undefined> {
  constructor() {
    super("before-cache", undefined)
    Object.freeze(this)
  }
}

export class VisitEvent extends NotificationEvent<
  "visit",
  Readonly<{ action: VisitAction; url: string }>
> {
  constructor(url: string, action: VisitAction) {
    super("visit", Object.freeze({ action, url }))
  }
}

export type DocumentRenderMethod = "replace"

export interface DocumentRenderEventDetail {
  readonly generation: number
  readonly preview: boolean
  readonly renderMethod: DocumentRenderMethod
  readonly url: string
}

export class DocumentRenderEvent extends NotificationEvent<"render", DocumentRenderEventDetail> {
  constructor(detail: DocumentRenderEventDetail) {
    super("render", Object.freeze({ ...detail }))
    Object.freeze(this)
  }
}

export interface DocumentLoadEventDetail {
  readonly generation: number
  readonly url: string
}

export class DocumentLoadEvent extends NotificationEvent<"load", DocumentLoadEventDetail> {
  constructor(detail: DocumentLoadEventDetail) {
    super("load", Object.freeze({ ...detail }))
    Object.freeze(this)
  }
}

export type DocumentReloadCause = "content-type" | "transport"
export type DocumentReloadReason = "request-failed"

export interface DocumentReloadEventDetail {
  readonly cause: DocumentReloadCause
  readonly reason: DocumentReloadReason
}

export class DocumentReloadEvent extends NotificationEvent<"reload", DocumentReloadEventDetail> {
  constructor(detail: DocumentReloadEventDetail) {
    super("reload", Object.freeze({ ...detail }))
    Object.freeze(this)
  }
}

export type DocumentVisitLifecycleEvent =
  | BeforeCacheEvent
  | BeforeVisitEvent
  | DocumentLoadEvent
  | DocumentReloadEvent
  | DocumentRenderEvent
  | LinkClickEvent
  | VisitEvent

export interface DocumentVisitLifecycleEventMap {
  readonly "before-cache": BeforeCacheEvent
  readonly "before-visit": BeforeVisitEvent
  readonly click: LinkClickEvent
  readonly load: DocumentLoadEvent
  readonly reload: DocumentReloadEvent
  readonly render: DocumentRenderEvent
  readonly visit: VisitEvent
}

export interface DocumentVisitLifecycleOptions {
  readonly onObserverError?: (error: AggregateError) => undefined
}

type DocumentVisitLifecycleEventType = keyof DocumentVisitLifecycleEventMap
type DocumentVisitLifecycleListener<Type extends DocumentVisitLifecycleEventType> = (
  event: DocumentVisitLifecycleEventMap[Type],
) => undefined
type DocumentVisitObserver = (error: AggregateError) => undefined

export const DOCUMENT_VISIT_LIFECYCLE_BEFORE_DISPATCH = Symbol(
  "expo-turbo.document-visit-lifecycle.before-dispatch",
)
export const DOCUMENT_VISIT_LIFECYCLE_BEFORE_CACHE_DISPATCH = Symbol(
  "expo-turbo.document-visit-lifecycle.before-cache-dispatch",
)
export const DOCUMENT_VISIT_LIFECYCLE_CLICK_DISPATCH = Symbol(
  "expo-turbo.document-visit-lifecycle.click-dispatch",
)
export const DOCUMENT_VISIT_LIFECYCLE_VISIT_DISPATCH = Symbol(
  "expo-turbo.document-visit-lifecycle.visit-dispatch",
)
export const DOCUMENT_VISIT_LIFECYCLE_RENDER_DISPATCH = Symbol(
  "expo-turbo.document-visit-lifecycle.render-dispatch",
)
export const DOCUMENT_VISIT_LIFECYCLE_LOAD_DISPATCH = Symbol(
  "expo-turbo.document-visit-lifecycle.load-dispatch",
)
export const DOCUMENT_VISIT_LIFECYCLE_RELOAD_DISPATCH = Symbol(
  "expo-turbo.document-visit-lifecycle.reload-dispatch",
)

/**
 * Synchronous logical lifecycle for semantic links and native document visits.
 * Click and before-visit listeners may cancel admission; visit, before-cache,
 * render, load, and reload listeners are notification observers.
 */
export class DocumentVisitLifecycle {
  private readonly listeners = new Map<
    DocumentVisitLifecycleEventType,
    Set<(event: DocumentVisitLifecycleEvent) => unknown>
  >()
  private readonly onObserverError: DocumentVisitObserver | undefined

  constructor(options: DocumentVisitLifecycleOptions = {}) {
    this.onObserverError = observerOption(options)
  }

  subscribe<Type extends DocumentVisitLifecycleEventType>(
    type: Type,
    listener: DocumentVisitLifecycleListener<Type>,
  ): () => void {
    if (
      type !== "before-cache" &&
      type !== "before-visit" &&
      type !== "click" &&
      type !== "load" &&
      type !== "reload" &&
      type !== "render" &&
      type !== "visit"
    ) {
      throw new StateError("Document visit lifecycle event type is invalid")
    }
    if (typeof listener !== "function") {
      throw new StateError("Document visit lifecycle listener must be a function")
    }

    let listeners = this.listeners.get(type)
    if (!listeners) {
      listeners = new Set()
      this.listeners.set(type, listeners)
    }
    const admitted = listener as (event: DocumentVisitLifecycleEvent) => unknown
    listeners.add(admitted)
    return () => {
      listeners?.delete(admitted)
      if (listeners?.size === 0) this.listeners.delete(type)
    }
  }

  [DOCUMENT_VISIT_LIFECYCLE_CLICK_DISPATCH](event: LinkClickEvent): LinkClickEvent {
    for (const listener of [...(this.listeners.get("click") ?? [])]) {
      let result: unknown
      try {
        result = listener(event)
      } catch {
        throw new StateError("Click listener failed")
      }
      if (result === undefined) continue
      try {
        consumeThenableResult(result)
      } catch {
        throw new StateError("Click listener failed")
      }
      throw new StateError("Click listener must return undefined")
    }
    return event
  }

  [DOCUMENT_VISIT_LIFECYCLE_BEFORE_DISPATCH](event: BeforeVisitEvent): BeforeVisitEvent {
    for (const listener of [...(this.listeners.get("before-visit") ?? [])]) {
      let result: unknown
      try {
        result = listener(event)
      } catch {
        throw new StateError("Before-visit listener failed")
      }
      rejectListenerResult(result, "Before-visit listener must return undefined")
    }
    return event
  }

  [DOCUMENT_VISIT_LIFECYCLE_BEFORE_CACHE_DISPATCH](event: BeforeCacheEvent): void {
    this.dispatchNotification("before-cache", event, "Before-cache listener failed")
  }

  [DOCUMENT_VISIT_LIFECYCLE_VISIT_DISPATCH](event: VisitEvent): void {
    this.dispatchNotification("visit", event, "Visit listener failed")
  }

  [DOCUMENT_VISIT_LIFECYCLE_RENDER_DISPATCH](event: DocumentRenderEvent): void {
    this.dispatchNotification("render", event, "Render listener failed")
  }

  [DOCUMENT_VISIT_LIFECYCLE_LOAD_DISPATCH](event: DocumentLoadEvent): void {
    this.dispatchNotification("load", event, "Load listener failed")
  }

  [DOCUMENT_VISIT_LIFECYCLE_RELOAD_DISPATCH](event: DocumentReloadEvent): void {
    this.dispatchNotification("reload", event, "Reload listener failed")
  }

  private dispatchNotification(
    type: "before-cache" | "load" | "reload" | "render" | "visit",
    event:
      | BeforeCacheEvent
      | DocumentLoadEvent
      | DocumentReloadEvent
      | DocumentRenderEvent
      | VisitEvent,
    listenerFailure: string,
  ): void {
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
        rejectListenerResult(result, `${notificationName(type)} listener must return undefined`)
      } catch {
        errors.push(new StateError(listenerFailure))
      }
    }
    if (errors.length === 0) return
    if (!this.onObserverError) {
      surfaceObserverError(
        new AggregateError(errors, "Document visit notification observers failed"),
      )
      return
    }

    let result: unknown
    try {
      result = this.onObserverError(
        new AggregateError(errors, "Document visit notification observers failed"),
      )
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

function notificationName(type: "before-cache" | "load" | "reload" | "render" | "visit"): string {
  if (type === "before-cache") return "Before-cache"
  return `${type[0]?.toUpperCase() ?? ""}${type.slice(1)}`
}

export function admitDocumentVisitLifecycle(
  candidate: unknown,
  invalidMessage: string,
): DocumentVisitLifecycle | undefined {
  if (candidate === undefined) return undefined
  let valid = false
  try {
    valid = candidate instanceof DocumentVisitLifecycle
  } catch {
    // Hostile proxies are rejected through the same redacted option boundary.
  }
  if (!valid) throw new PropsError(invalidMessage)
  return candidate as DocumentVisitLifecycle
}

export function documentVisitLifecycleOption(
  options: unknown,
  owner: string,
): DocumentVisitLifecycle | undefined {
  let candidate: unknown
  try {
    if (!options || typeof options !== "object" || Array.isArray(options)) {
      throw new TypeError("invalid options")
    }
    candidate = (options as { readonly visitLifecycle?: unknown }).visitLifecycle
  } catch {
    throw new PropsError(`${owner} options could not be read`)
  }
  return admitDocumentVisitLifecycle(candidate, `${owner} visit lifecycle is invalid`)
}

function observerOption(options: unknown): DocumentVisitObserver | undefined {
  let observer: unknown
  try {
    if (!options || typeof options !== "object" || Array.isArray(options)) {
      throw new TypeError("invalid options")
    }
    observer = (options as { readonly onObserverError?: unknown }).onObserverError
  } catch {
    throw new PropsError("Document visit lifecycle options could not be read")
  }
  if (observer !== undefined && typeof observer !== "function") {
    throw new PropsError("Document visit lifecycle error observer must be a function")
  }
  return observer as DocumentVisitObserver | undefined
}

function rejectListenerResult(result: unknown, message: string): void {
  if (result === undefined) return
  consumeUnexpectedResult(result)
  throw new StateError(message)
}

function consumeUnexpectedResult(result: unknown): void {
  if ((typeof result !== "object" || result === null) && typeof result !== "function") {
    return
  }
  void Promise.resolve(result).catch(() => undefined)
}

function observerReporterError(errors: readonly StateError[]): AggregateError {
  return new AggregateError(
    [...errors, new StateError("Document visit notification observer reporter failed")],
    "Document visit notification observer reporting failed",
  )
}

function surfaceObserverError(error: AggregateError): void {
  queueMicrotask(() => {
    throw error
  })
}
