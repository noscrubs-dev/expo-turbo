import { ActionError, PropsError, StateError } from "./errors"
import { CancellableEvent, NotificationEvent } from "./events"
import { consumeThenableResult } from "./thenable-result"
import type { ProtocolElement } from "./tree"

export type MorphAttributeMutationType = "remove" | "update"

export interface BeforeMorphElementEventDetail {
  readonly currentElement: ProtocolElement
  readonly newElement?: ProtocolElement
}

export interface BeforeMorphAttributeEventDetail {
  readonly attributeName: string
  readonly currentElement: ProtocolElement
  readonly mutationType: MorphAttributeMutationType
  readonly newElement: ProtocolElement
}

export interface MorphElementEventDetail {
  readonly currentElement: ProtocolElement
  readonly newElement: ProtocolElement
}

export type BeforeMorphElementEvent = CancellableEvent<
  "before-morph-element",
  BeforeMorphElementEventDetail
>
export type BeforeMorphAttributeEvent = CancellableEvent<
  "before-morph-attribute",
  BeforeMorphAttributeEventDetail
>
export type MorphElementEvent = NotificationEvent<"morph-element", MorphElementEventDetail>

export type MorphLifecycleEvent =
  | BeforeMorphAttributeEvent
  | BeforeMorphElementEvent
  | MorphElementEvent

export interface MorphLifecycleEventMap {
  readonly "before-morph-attribute": BeforeMorphAttributeEvent
  readonly "before-morph-element": BeforeMorphElementEvent
  readonly "morph-element": MorphElementEvent
}

export interface MorphLifecycleOptions {
  readonly onObserverError?: (error: AggregateError) => undefined
}

type MorphLifecycleEventType = keyof MorphLifecycleEventMap
type MorphLifecycleListener<Type extends MorphLifecycleEventType> = (
  event: MorphLifecycleEventMap[Type],
) => undefined

const morphLifecycles = new WeakSet<MorphLifecycle>()

class ExactCancellableEvent<
  Type extends "before-morph-attribute" | "before-morph-element",
  Detail,
> extends CancellableEvent<Type, Detail> {
  constructor(type: Type, detail: Detail) {
    super(type, detail)
    Object.defineProperties(this, {
      defaultPrevented: { enumerable: true, get: () => preventedEvents.has(this) },
      detail: { writable: false },
      preventDefault: { value: () => preventedEvents.add(this), writable: false },
      type: { writable: false },
    })
    Object.freeze(this)
  }

  override get defaultPrevented(): boolean {
    return preventedEvents.has(this)
  }

  override preventDefault(): void {
    preventedEvents.add(this)
  }
}

const preventedEvents = new WeakSet<object>()

export const MORPH_LIFECYCLE_BEFORE_ELEMENT_DISPATCH = Symbol(
  "expo-turbo.morph-lifecycle.before-element-dispatch",
)
export const MORPH_LIFECYCLE_BEFORE_ATTRIBUTE_DISPATCH = Symbol(
  "expo-turbo.morph-lifecycle.before-attribute-dispatch",
)
export const MORPH_LIFECYCLE_ELEMENT_DISPATCH = Symbol(
  "expo-turbo.morph-lifecycle.element-dispatch",
)

export class MorphLifecycle {
  private readonly listeners = new Map<
    MorphLifecycleEventType,
    Set<(event: MorphLifecycleEvent) => unknown>
  >()
  private readonly onObserverError: MorphLifecycleOptions["onObserverError"]

  constructor(options: MorphLifecycleOptions = {}) {
    this.onObserverError = observerOption(options)
    morphLifecycles.add(this)
  }

  subscribe<Type extends MorphLifecycleEventType>(
    type: Type,
    listener: MorphLifecycleListener<Type>,
  ): () => void {
    if (
      type !== "before-morph-element" &&
      type !== "before-morph-attribute" &&
      type !== "morph-element"
    ) {
      throw new StateError("Morph lifecycle event type is invalid")
    }
    if (typeof listener !== "function") {
      throw new StateError("Morph lifecycle listener must be a function")
    }
    let listeners = this.listeners.get(type)
    if (!listeners) {
      listeners = new Set()
      this.listeners.set(type, listeners)
    }
    const admitted = listener as (event: MorphLifecycleEvent) => unknown
    listeners.add(admitted)
    return () => {
      listeners?.delete(admitted)
      if (listeners?.size === 0) this.listeners.delete(type)
    }
  }

  [MORPH_LIFECYCLE_BEFORE_ELEMENT_DISPATCH](
    currentElement: ProtocolElement,
    newElement?: ProtocolElement,
  ): boolean {
    const event = new ExactCancellableEvent(
      "before-morph-element",
      Object.freeze({ currentElement, ...(newElement ? { newElement } : {}) }),
    )
    this.dispatchBefore("before-morph-element", event)
    return !event.defaultPrevented
  }

  [MORPH_LIFECYCLE_BEFORE_ATTRIBUTE_DISPATCH](
    currentElement: ProtocolElement,
    newElement: ProtocolElement,
    attributeName: string,
    mutationType: MorphAttributeMutationType,
  ): boolean {
    const event = new ExactCancellableEvent(
      "before-morph-attribute",
      Object.freeze({ attributeName, currentElement, mutationType, newElement }),
    )
    this.dispatchBefore("before-morph-attribute", event)
    return !event.defaultPrevented
  }

  [MORPH_LIFECYCLE_ELEMENT_DISPATCH](
    currentElement: ProtocolElement,
    newElement: ProtocolElement,
  ): void {
    const event = new NotificationEvent(
      "morph-element",
      Object.freeze({ currentElement, newElement }),
    ) as MorphElementEvent
    Object.freeze(event)
    const errors: StateError[] = []
    for (const listener of [...(this.listeners.get("morph-element") ?? [])]) {
      try {
        const result = listener(event)
        if (result !== undefined) {
          consumeThenableResult(result)
          errors.push(new StateError("Morph lifecycle listener must return undefined"))
        }
      } catch {
        errors.push(new StateError("Morph-element listener failed"))
      }
    }
    if (errors.length === 0) return
    const aggregate = new AggregateError(errors, "Morph lifecycle observer failed")
    if (!this.onObserverError) {
      surfaceObserverError(aggregate)
      return
    }
    try {
      const result = this.onObserverError(aggregate)
      if (result !== undefined) {
        consumeThenableResult(result)
        surfaceObserverError(
          new AggregateError(errors, "Morph lifecycle observer reporting failed"),
        )
      }
    } catch {
      surfaceObserverError(new AggregateError(errors, "Morph lifecycle observer reporting failed"))
    }
  }

  private dispatchBefore(
    type: "before-morph-attribute" | "before-morph-element",
    event: BeforeMorphAttributeEvent | BeforeMorphElementEvent,
  ): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      let result: unknown
      try {
        result = listener(event)
      } catch {
        throw new ActionError("Before-morph listener failed")
      }
      if (result === undefined) continue
      consumeThenableResult(result)
      throw new ActionError("Before-morph listener must return undefined")
    }
  }
}

export function morphLifecycleOption(options: unknown, owner: string): MorphLifecycle | undefined {
  let candidate: unknown
  try {
    if (!options || typeof options !== "object" || Array.isArray(options)) {
      throw new TypeError("invalid options")
    }
    candidate = (options as { readonly morphLifecycle?: unknown }).morphLifecycle
  } catch {
    throw new PropsError(`${owner} options could not be read`)
  }
  if (candidate === undefined) return undefined
  if (
    ((typeof candidate !== "object" || candidate === null) && typeof candidate !== "function") ||
    !morphLifecycles.has(candidate as MorphLifecycle)
  ) {
    throw new PropsError(`${owner} Morph lifecycle is invalid`)
  }
  return candidate as MorphLifecycle
}

function observerOption(options: unknown): MorphLifecycleOptions["onObserverError"] {
  let observer: unknown
  try {
    if (!options || typeof options !== "object" || Array.isArray(options)) {
      throw new TypeError("invalid options")
    }
    observer = (options as { readonly onObserverError?: unknown }).onObserverError
  } catch {
    throw new PropsError("Morph lifecycle options could not be read")
  }
  if (observer !== undefined && typeof observer !== "function") {
    throw new PropsError("Morph lifecycle error observer must be a function")
  }
  return observer as MorphLifecycleOptions["onObserverError"]
}

function surfaceObserverError(error: AggregateError): void {
  queueMicrotask(() => {
    throw error
  })
}
