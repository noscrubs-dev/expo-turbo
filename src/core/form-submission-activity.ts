import type { DocumentSession } from "./session"
import { attributeValue, type ProtocolElement } from "./tree"

export type FormSubmissionActivityStatus = "idle" | "submitting"

export interface FormSubmissionActivitySnapshot {
  readonly busy: boolean
  readonly requestId?: string
  readonly revision: number
  readonly status: FormSubmissionActivityStatus
  readonly submitterNodeKey?: string
}

export interface FormSubmitterActivitySnapshot {
  readonly pending: boolean
  readonly revision: number
  readonly submitsWith?: string
}

export type FormSubmissionDuplicateBehavior = "prevent" | "supersede"
export type FormSubmissionActivityListener = () => void

export interface FormSubmissionActivityLease {
  readonly abortListener: () => void
  cleaned: boolean
  readonly controller: AbortController
  readonly requestId: string
  readonly submitter: ProtocolElement | undefined
  submitsWith: string | undefined
  readonly unregisterDisposals: Array<() => void>
}

const IDLE_SUBMITTER_STATE: FormSubmitterActivitySnapshot = Object.freeze({
  pending: false,
  revision: 0,
})

/** Internal exact-form activity shared by every registry and controller in one session. */
export class ExactFormSubmissionActivity {
  private current: FormSubmissionActivityLease | undefined
  private displayed: FormSubmissionActivityLease | undefined
  private readonly listeners = new Set<FormSubmissionActivityListener>()
  private revision = 0
  private scopeOwners = 0
  private snapshot: FormSubmissionActivitySnapshot = Object.freeze({
    busy: false,
    revision: 0,
    status: "idle",
  })
  private readonly submitterListeners = new Map<
    ProtocolElement,
    Set<FormSubmissionActivityListener>
  >()
  private readonly submitterSnapshots = new WeakMap<
    ProtocolElement,
    FormSubmitterActivitySnapshot
  >()

  constructor(
    private readonly session: DocumentSession,
    private readonly form: ProtocolElement,
  ) {}

  get state(): FormSubmissionActivitySnapshot {
    return this.snapshot
  }

  admit(
    controller: AbortController,
    requestId: string,
    submitter: ProtocolElement | undefined,
    duplicateBehavior: FormSubmissionDuplicateBehavior,
    deferPresentation = false,
  ): FormSubmissionActivityLease | undefined {
    const previous = this.current
    if (previous && duplicateBehavior === "prevent") {
      controller.abort()
      return undefined
    }

    const lease: FormSubmissionActivityLease = {
      abortListener: () => this.finish(lease),
      cleaned: false,
      controller,
      requestId,
      submitter,
      submitsWith: undefined,
      unregisterDisposals: [],
    }
    this.current = lease
    lease.unregisterDisposals.push(
      this.session.registerDisposal(this.form.key, () => this.cancel(lease)),
    )
    if (submitter) {
      lease.unregisterDisposals.push(
        this.session.registerDisposal(submitter.key, () => this.cancel(lease)),
      )
    }
    controller.signal.addEventListener("abort", lease.abortListener, { once: true })

    // Install the replacement before aborting its predecessor. Reentrant abort
    // work may supersede this lease and must remain authoritative.
    if (deferPresentation && this.displayed) {
      const displayed = this.displayed
      this.displayed = undefined
      this.publish(displayed.submitter)
    }
    previous?.controller.abort()
    return this.owns(lease) ? lease : undefined
  }

  start(lease: FormSubmissionActivityLease): boolean {
    if (!this.owns(lease)) return false
    const rawSubmitsWith = lease.submitter
      ? attributeValue(lease.submitter, "data-turbo-submits-with")
      : undefined
    lease.submitsWith =
      rawSubmitsWith === undefined || rawSubmitsWith === "" ? undefined : rawSubmitsWith

    const previous = this.displayed
    this.displayed = lease
    this.publish(previous?.submitter, lease.submitter)
    return this.owns(lease)
  }

  finish(lease: FormSubmissionActivityLease): void {
    this.cleanup(lease)
    if (this.current !== lease) return
    this.current = undefined
    const previous = this.displayed
    this.displayed = undefined
    if (previous) this.publish(previous.submitter)
  }

  cancelActive(): void {
    const active = this.current
    if (active) this.cancel(active)
  }

  owns(lease: FormSubmissionActivityLease): boolean {
    return this.current === lease && !lease.controller.signal.aborted
  }

  retainScope(): () => void {
    this.scopeOwners += 1
    let retained = true
    return () => {
      if (!retained) return
      retained = false
      this.scopeOwners -= 1
      if (this.scopeOwners === 0) this.cancelActive()
    }
  }

  subscribe(listener: FormSubmissionActivityListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  stateForSubmitter(submitter: ProtocolElement): FormSubmitterActivitySnapshot {
    return this.submitterSnapshots.get(submitter) ?? IDLE_SUBMITTER_STATE
  }

  subscribeSubmitter(
    submitter: ProtocolElement,
    listener: FormSubmissionActivityListener,
  ): () => void {
    let listeners = this.submitterListeners.get(submitter)
    if (!listeners) {
      listeners = new Set()
      this.submitterListeners.set(submitter, listeners)
    }
    listeners.add(listener)
    return () => {
      listeners?.delete(listener)
      if (listeners?.size === 0) this.submitterListeners.delete(submitter)
    }
  }

  private cancel(lease: FormSubmissionActivityLease): void {
    if (this.current !== lease) return
    lease.controller.abort()
    this.finish(lease)
  }

  private cleanup(lease: FormSubmissionActivityLease): void {
    if (lease.cleaned) return
    lease.cleaned = true
    lease.controller.signal.removeEventListener("abort", lease.abortListener)
    for (const unregister of lease.unregisterDisposals.splice(0)) unregister()
  }

  private publish(previousSubmitter?: ProtocolElement, nextSubmitter?: ProtocolElement): void {
    this.revision += 1
    const displayed = this.displayed
    this.snapshot = displayed
      ? Object.freeze({
          busy: true,
          requestId: displayed.requestId,
          revision: this.revision,
          status: "submitting",
          ...(displayed.submitter ? { submitterNodeKey: displayed.submitter.key } : {}),
        })
      : Object.freeze({ busy: false, revision: this.revision, status: "idle" })

    const changedSubmitters = new Set<ProtocolElement>()
    if (previousSubmitter) changedSubmitters.add(previousSubmitter)
    if (nextSubmitter) changedSubmitters.add(nextSubmitter)
    for (const submitter of changedSubmitters) {
      const pending = displayed?.submitter === submitter
      this.submitterSnapshots.set(
        submitter,
        pending
          ? Object.freeze({
              pending: true,
              revision: this.revision,
              ...(displayed.submitsWith !== undefined
                ? { submitsWith: displayed.submitsWith }
                : {}),
            })
          : Object.freeze({ pending: false, revision: this.revision }),
      )
    }

    const errors: unknown[] = []
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch (error) {
        errors.push(error)
      }
    }
    for (const submitter of changedSubmitters) {
      for (const listener of [...(this.submitterListeners.get(submitter) ?? [])]) {
        try {
          listener()
        } catch (error) {
          errors.push(error)
        }
      }
    }
    if (errors.length > 0) {
      queueMicrotask(() => {
        throw new AggregateError(errors, "Form submission activity listener failed")
      })
    }
  }
}

const activities = new WeakMap<
  DocumentSession,
  WeakMap<ProtocolElement, ExactFormSubmissionActivity>
>()

export function formSubmissionActivity(
  session: DocumentSession,
  form: ProtocolElement,
): ExactFormSubmissionActivity {
  let sessionActivities = activities.get(session)
  if (!sessionActivities) {
    sessionActivities = new WeakMap()
    activities.set(session, sessionActivities)
  }
  let activity = sessionActivities.get(form)
  if (!activity) {
    activity = new ExactFormSubmissionActivity(session, form)
    sessionActivities.set(form, activity)
  }
  return activity
}
