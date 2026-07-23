import type { VisitAction } from "../adapters"
import { PropsError, StateError } from "./errors"
import { CancellableEvent, NotificationEvent, PausableEvent } from "./events"
import { consumeThenableResult, resolveThenableResult } from "./thenable-result"
import type { ProtocolDocument } from "./tree"

export type DocumentVisitDirection = "back" | "forward" | "none"

export interface DocumentRenderContext {
  readonly currentDocument: ProtocolDocument
  readonly newDocument: ProtocolDocument
  renderDefault(): undefined
}

export type DocumentRenderer = (
  context: DocumentRenderContext,
) => PromiseLike<undefined> | undefined

export interface BeforeDocumentRenderEventDetail {
  readonly currentDocument: ProtocolDocument
  readonly newDocument: ProtocolDocument
  readonly renderMethod: DocumentRenderMethod
  readonly url: string
  render: DocumentRenderer
}

interface BeforeDocumentRenderDetailState {
  renderer: DocumentRenderer
}

const beforeDocumentRenderDetailStates = new WeakMap<
  ExactBeforeDocumentRenderEventDetail,
  BeforeDocumentRenderDetailState
>()

class ExactBeforeDocumentRenderEventDetail implements BeforeDocumentRenderEventDetail {
  readonly currentDocument: ProtocolDocument
  readonly newDocument: ProtocolDocument
  readonly renderMethod: DocumentRenderMethod
  readonly url: string

  constructor(
    currentDocument: ProtocolDocument,
    newDocument: ProtocolDocument,
    renderMethod: DocumentRenderMethod,
    url: string,
    renderer: DocumentRenderer,
  ) {
    this.currentDocument = currentDocument
    this.newDocument = newDocument
    this.renderMethod = renderMethod
    this.url = url
    beforeDocumentRenderDetailStates.set(this, { renderer })
    Object.freeze(this)
  }

  get render(): DocumentRenderer {
    return beforeDocumentRenderDetailState(this).renderer
  }

  set render(renderer: DocumentRenderer) {
    if (typeof renderer !== "function") {
      throw new StateError("Before-document-render renderer must be a function")
    }
    beforeDocumentRenderDetailState(this).renderer = renderer
  }
}

export class BeforeDocumentRenderEvent extends PausableEvent<
  "before-render",
  BeforeDocumentRenderEventDetail
> {
  constructor(detail: Omit<BeforeDocumentRenderEventDetail, "render">, renderer: DocumentRenderer) {
    super(
      "before-render",
      new ExactBeforeDocumentRenderEventDetail(
        detail.currentDocument,
        detail.newDocument,
        detail.renderMethod,
        detail.url,
        renderer,
      ),
    )
  }
}

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

export class BeforePrefetchEvent extends CancellableEvent<
  "before-prefetch",
  Readonly<{ nodeKey: string; url: string }>
> {
  constructor(nodeKey: string, url: string) {
    super("before-prefetch", Object.freeze({ nodeKey, url }))
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
  Readonly<{ action: VisitAction; direction: DocumentVisitDirection; url: string }>
> {
  constructor(
    url: string,
    action: VisitAction,
    direction: DocumentVisitDirection = action === "advance"
      ? "forward"
      : action === "replace"
        ? "none"
        : "back",
  ) {
    super("visit", Object.freeze({ action, direction, url }))
  }
}

export type DocumentRenderMethod = "morph" | "replace"

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

export interface DocumentMorphEventDetail {
  readonly currentDocument: ProtocolDocument
  readonly generation: number
  readonly newDocument: ProtocolDocument
  readonly url: string
}

export class DocumentMorphEvent extends NotificationEvent<"morph", DocumentMorphEventDetail> {
  constructor(detail: DocumentMorphEventDetail) {
    super("morph", Object.freeze({ ...detail }))
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
  | BeforeDocumentRenderEvent
  | BeforePrefetchEvent
  | BeforeVisitEvent
  | DocumentLoadEvent
  | DocumentMorphEvent
  | DocumentReloadEvent
  | DocumentRenderEvent
  | LinkClickEvent
  | VisitEvent

export interface DocumentVisitLifecycleEventMap {
  readonly "before-cache": BeforeCacheEvent
  readonly "before-render": BeforeDocumentRenderEvent
  readonly "before-prefetch": BeforePrefetchEvent
  readonly "before-visit": BeforeVisitEvent
  readonly click: LinkClickEvent
  readonly load: DocumentLoadEvent
  readonly morph: DocumentMorphEvent
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
export const DOCUMENT_VISIT_LIFECYCLE_BEFORE_RENDER_DISPATCH = Symbol(
  "expo-turbo.document-visit-lifecycle.before-render-dispatch",
)
export const DOCUMENT_VISIT_LIFECYCLE_HAS_BEFORE_RENDER = Symbol(
  "expo-turbo.document-visit-lifecycle.has-before-render",
)
export const DOCUMENT_VISIT_LIFECYCLE_BEFORE_PREFETCH_DISPATCH = Symbol(
  "expo-turbo.document-visit-lifecycle.before-prefetch-dispatch",
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
export const DOCUMENT_VISIT_LIFECYCLE_MORPH_DISPATCH = Symbol(
  "expo-turbo.document-visit-lifecycle.morph-dispatch",
)
export const DOCUMENT_VISIT_LIFECYCLE_RELOAD_DISPATCH = Symbol(
  "expo-turbo.document-visit-lifecycle.reload-dispatch",
)

/**
 * Synchronous logical lifecycle for semantic links and native document visits.
 * Click, before-prefetch, before-visit, and before-render listeners may cancel admission;
 * visit, before-cache, morph, render, load, and reload listeners are notification observers.
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
      type !== "before-prefetch" &&
      type !== "before-render" &&
      type !== "before-visit" &&
      type !== "click" &&
      type !== "load" &&
      type !== "morph" &&
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

  [DOCUMENT_VISIT_LIFECYCLE_BEFORE_PREFETCH_DISPATCH](
    event: BeforePrefetchEvent,
  ): BeforePrefetchEvent {
    for (const listener of [...(this.listeners.get("before-prefetch") ?? [])]) {
      let result: unknown
      try {
        result = listener(event)
      } catch {
        throw new StateError("Before-prefetch listener failed")
      }
      if (result === undefined) continue
      try {
        consumeThenableResult(result)
      } catch {
        throw new StateError("Before-prefetch listener failed")
      }
      throw new StateError("Before-prefetch listener must return undefined")
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

  [DOCUMENT_VISIT_LIFECYCLE_BEFORE_RENDER_DISPATCH](
    event: BeforeDocumentRenderEvent,
  ): DocumentRenderer {
    for (const listener of [...(this.listeners.get("before-render") ?? [])]) {
      let result: unknown
      try {
        result = listener(event)
      } catch {
        throw new StateError("Before-document-render listener failed")
      }
      if (result === undefined) continue
      try {
        consumeThenableResult(result)
      } catch {
        throw new StateError("Before-document-render listener failed")
      }
      throw new StateError("Before-document-render listener must return undefined")
    }
    return event.detail.render
  }

  [DOCUMENT_VISIT_LIFECYCLE_HAS_BEFORE_RENDER](): boolean {
    return (this.listeners.get("before-render")?.size ?? 0) > 0
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

  [DOCUMENT_VISIT_LIFECYCLE_MORPH_DISPATCH](event: DocumentMorphEvent): void {
    this.dispatchNotification("morph", event, "Morph listener failed")
  }

  [DOCUMENT_VISIT_LIFECYCLE_RELOAD_DISPATCH](event: DocumentReloadEvent): void {
    this.dispatchNotification("reload", event, "Reload listener failed")
  }

  private dispatchNotification(
    type: "before-cache" | "load" | "morph" | "reload" | "render" | "visit",
    event:
      | BeforeCacheEvent
      | DocumentLoadEvent
      | DocumentMorphEvent
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

export async function runBeforeDocumentRender(
  lifecycle: DocumentVisitLifecycle,
  detail: Omit<BeforeDocumentRenderEventDetail, "render">,
): Promise<boolean> {
  let defaultRendered = false
  let rendering = true
  const context = Object.freeze({
    currentDocument: detail.currentDocument,
    newDocument: detail.newDocument,
    renderDefault(): undefined {
      if (!rendering) throw new StateError("Document render context is no longer active")
      if (defaultRendered) {
        throw new StateError("Default document renderer may run only once")
      }
      defaultRendered = true
      return undefined
    },
  })
  const defaultRenderer: DocumentRenderer = (activeContext) => {
    if (activeContext !== context) {
      throw new StateError("Document renderer received an invalid context")
    }
    return activeContext.renderDefault()
  }
  const event = new BeforeDocumentRenderEvent(detail, defaultRenderer)
  const renderer = lifecycle[DOCUMENT_VISIT_LIFECYCLE_BEFORE_RENDER_DISPATCH](event)
  await event.waitUntilResumed()
  if (event.defaultPrevented) return false

  let result: unknown
  try {
    result = renderer(context)
    const settlement = resolveThenableResult(result)
    if (settlement) result = await settlement
  } catch {
    throw new StateError("Document renderer failed")
  } finally {
    rendering = false
  }
  if (result !== undefined) {
    throw new StateError("Document renderer must return undefined")
  }
  if (!defaultRendered) {
    throw new StateError("Document renderer must call renderDefault")
  }
  return true
}

function notificationName(
  type: "before-cache" | "load" | "morph" | "reload" | "render" | "visit",
): string {
  if (type === "before-cache") return "Before-cache"
  return `${type[0]?.toUpperCase() ?? ""}${type.slice(1)}`
}

function beforeDocumentRenderDetailState(
  detail: ExactBeforeDocumentRenderEventDetail,
): BeforeDocumentRenderDetailState {
  const state = beforeDocumentRenderDetailStates.get(detail)
  if (!state) throw new StateError("Before-document-render event detail is invalid")
  return state
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
