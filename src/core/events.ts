export class NotificationEvent<Name extends string, Detail> {
  constructor(
    readonly type: Name,
    readonly detail: Detail,
  ) {
    if (!type.trim()) throw new Error("Logical event types must not be blank")
  }
}

export class CancellableEvent<Name extends string, Detail> extends NotificationEvent<Name, Detail> {
  private prevented = false

  get defaultPrevented(): boolean {
    return this.prevented
  }

  preventDefault(): void {
    this.prevented = true
  }
}

export class PausableEvent<Name extends string, Detail> extends CancellableEvent<Name, Detail> {
  private pauses = 0
  private release: (() => void) | undefined
  private resumed: Promise<void> = Promise.resolve()

  get paused(): boolean {
    return this.pauses > 0
  }

  pause(): void {
    if (this.pauses === 0) {
      this.resumed = new Promise<void>((resolve) => {
        this.release = resolve
      })
    }
    this.pauses += 1
  }

  resume(): void {
    if (this.pauses === 0) throw new Error("Logical event is not paused")
    this.pauses -= 1
    if (this.pauses !== 0) return
    const release = this.release
    this.release = undefined
    release?.()
  }

  waitUntilResumed(): Promise<void> {
    return this.resumed
  }
}

export type LogicalEvent<Name extends string, Detail> =
  | CancellableEvent<Name, Detail>
  | NotificationEvent<Name, Detail>
  | PausableEvent<Name, Detail>

type EventName<Details extends object> = Extract<keyof Details, string>
type EventFor<Details extends object, Name extends EventName<Details>> = LogicalEvent<
  Name,
  Details[Name]
>
type EventListener<Event> = (event: Event) => unknown

export class TypedEventBus<Details extends object> {
  private readonly listeners = new Map<string, Set<EventListener<unknown>>>()
  private tail: Promise<void> = Promise.resolve()

  dispatch<Name extends EventName<Details>, Event extends EventFor<Details, Name>>(
    event: Event,
  ): Promise<Event> {
    const execution = this.tail.then(() => this.dispatchNow(event))
    this.tail = execution.then(
      () => undefined,
      () => undefined,
    )
    return execution
  }

  subscribe<Name extends EventName<Details>>(
    type: Name,
    listener: EventListener<EventFor<Details, Name>>,
  ): () => void {
    let listeners = this.listeners.get(type)
    if (!listeners) {
      listeners = new Set()
      this.listeners.set(type, listeners)
    }
    const erased = listener as EventListener<unknown>
    listeners.add(erased)
    return () => {
      listeners?.delete(erased)
      if (listeners?.size === 0) this.listeners.delete(type)
    }
  }

  private async dispatchNow<Name extends EventName<Details>, Event extends EventFor<Details, Name>>(
    event: Event,
  ): Promise<Event> {
    const listeners = [...(this.listeners.get(event.type) ?? [])]
    for (const listener of listeners) {
      await listener(event)
      if (event instanceof PausableEvent) await event.waitUntilResumed()
    }
    return event
  }
}
