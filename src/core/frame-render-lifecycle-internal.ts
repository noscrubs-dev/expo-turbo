import { StateError } from "./errors"
import {
  FRAME_LIFECYCLE_LOAD_DISPATCH,
  FRAME_LIFECYCLE_RENDER_DISPATCH,
  type FrameLifecycle,
  FrameLoadEvent,
  FrameRenderEvent,
  type FrameRenderEventDetail,
  type FrameRenderMethod,
} from "./frame-lifecycle"
import type { DocumentSession } from "./session"
import type { ProtocolElement } from "./tree"

export type FrameRenderOutcome = "failed" | "rendered" | "superseded" | "unavailable"

export interface PreparedFrameRender {
  readonly commit: FrameRenderEventDetail
  readonly outcome: FrameRenderOutcome | undefined
  readonly rendered: Promise<FrameRenderOutcome>
  cancel(): void
  isCurrent(): boolean
  seal(): void
}

interface PendingFrameRender {
  acknowledged: boolean
  readonly commit: FrameRenderEventDetail
  readonly frame: ProtocolElement
  readonly handle: PreparedFrameRender
  readonly ownerIsCurrent: (() => boolean) | undefined
  outcome: FrameRenderOutcome | undefined
  revision: number | undefined
  readonly resolve: (outcome: FrameRenderOutcome) => void
  readonly treeGeneration: number
}

interface FrameRenderBinding {
  readonly listeners: Set<() => void>
  readonly pending: Map<ProtocolElement, PendingFrameRender>
  readonly renderers: Map<ProtocolElement, number>
  revision: number
  readonly suppressed: WeakMap<ProtocolElement, number>
}

export interface FrameRenderAcknowledgement {
  readonly fail: () => void
  readonly finish: () => void
  readonly status: "frame-render"
}

const bindings = new WeakMap<DocumentSession, FrameRenderBinding>()
const preparedRenders = new WeakMap<PreparedFrameRender, PendingFrameRender>()

function bindingFor(session: DocumentSession): FrameRenderBinding {
  let binding = bindings.get(session)
  if (!binding) {
    binding = {
      listeners: new Set(),
      pending: new Map(),
      renderers: new Map(),
      revision: 0,
      suppressed: new WeakMap(),
    }
    bindings.set(session, binding)
  }
  return binding
}

export function frameRenderLifecycleRevision(session: DocumentSession): number {
  return bindingFor(session).revision
}

export function subscribeFrameRenderLifecycle(
  session: DocumentSession,
  listener: () => void,
): () => void {
  const binding = bindingFor(session)
  binding.listeners.add(listener)
  return () => binding.listeners.delete(listener)
}

export function retainFrameRenderer(session: DocumentSession, frame: ProtocolElement): () => void {
  const binding = bindingFor(session)
  binding.renderers.set(frame, (binding.renderers.get(frame) ?? 0) + 1)
  let retained = true
  return () => {
    if (!retained) return
    retained = false
    const remaining = Math.max(0, (binding.renderers.get(frame) ?? 0) - 1)
    if (remaining > 0) {
      binding.renderers.set(frame, remaining)
      return
    }
    binding.renderers.delete(frame)
    queueMicrotask(() => {
      if (binding.renderers.has(frame)) return
      const pending = binding.pending.get(frame)
      if (!pending) return
      settle(
        binding,
        pending,
        frameIsCurrent(session, frame, pending.commit.frameId, pending.treeGeneration)
          ? "unavailable"
          : "superseded",
      )
    })
  }
}

export function prepareFrameRender(
  session: DocumentSession,
  detail: Readonly<{
    frame: ProtocolElement
    frameId: string
    ownerIsCurrent?: () => boolean
    renderMethod?: FrameRenderMethod
    url: string
  }>,
): PreparedFrameRender {
  const binding = bindingFor(session)
  settleStaleFrameRenders(session, binding)
  const commit: FrameRenderEventDetail = Object.freeze({
    frameId: detail.frameId,
    renderMethod: detail.renderMethod ?? "replace",
    url: detail.url,
  })
  const treeGeneration = session.treeGeneration
  if (!frameIsCurrent(session, detail.frame, detail.frameId, treeGeneration)) {
    return settledFrameRender(commit, "superseded")
  }

  const existing = binding.pending.get(detail.frame)
  if (existing) settle(binding, existing, "superseded")
  binding.suppressed.delete(detail.frame)
  if ((binding.renderers.get(detail.frame) ?? 0) === 0) {
    return settledFrameRender(commit, "unavailable")
  }

  let resolve!: (outcome: FrameRenderOutcome) => void
  const rendered = new Promise<FrameRenderOutcome>((settlePromise) => {
    resolve = settlePromise
  })
  let pending!: PendingFrameRender
  const handle: PreparedFrameRender = Object.freeze({
    cancel: () => settle(binding, pending, "superseded"),
    commit,
    get outcome() {
      return pending.outcome
    },
    isCurrent: () => frameRenderIsCurrent(session, handle),
    rendered,
    seal: () => sealFrameRender(session, handle),
  })
  pending = {
    acknowledged: false,
    commit,
    frame: detail.frame,
    handle,
    ownerIsCurrent: detail.ownerIsCurrent,
    outcome: undefined,
    revision: undefined,
    resolve,
    treeGeneration,
  }
  binding.pending.set(detail.frame, pending)
  preparedRenders.set(handle, pending)
  return handle
}

export function acknowledgeFrameRender(
  session: DocumentSession,
  frame: ProtocolElement,
  frameId: string,
  revision: number,
): FrameRenderAcknowledgement | undefined {
  const binding = bindings.get(session)
  if (!binding) return undefined
  settleStaleFrameRenders(session, binding)
  const pending = binding.pending.get(frame)
  if (
    !pending ||
    pending.commit.frameId !== frameId ||
    pending.acknowledged ||
    pending.outcome !== undefined ||
    pending.revision === undefined ||
    !frameIsCurrent(session, frame, frameId, pending.treeGeneration) ||
    revision < pending.revision ||
    revision !== session.revision
  ) {
    return undefined
  }

  pending.acknowledged = true
  if (
    pending.outcome !== undefined ||
    !frameIsCurrent(session, frame, frameId, pending.treeGeneration) ||
    session.revision !== revision
  ) {
    if (
      pending.outcome === undefined &&
      !frameIsCurrent(session, frame, frameId, pending.treeGeneration)
    ) {
      settle(binding, pending, "superseded")
    } else if (pending.outcome === undefined) {
      pending.revision = session.revision
      pending.acknowledged = false
    }
    return undefined
  }

  return Object.freeze({
    fail: () =>
      finishAcknowledgement(session, frame, frameId, revision, binding, pending, "failed"),
    finish: () =>
      finishAcknowledgement(session, frame, frameId, revision, binding, pending, "rendered"),
    status: "frame-render" as const,
  })
}

export function hasFrameRenderTicket(
  session: DocumentSession,
  frame: ProtocolElement,
  frameId: string,
): boolean {
  const binding = bindings.get(session)
  const pending = binding?.pending.get(frame)
  const treeGeneration = pending?.treeGeneration ?? binding?.suppressed.get(frame)
  return (
    treeGeneration !== undefined &&
    frameIsCurrent(session, frame, frameId, treeGeneration) &&
    ((pending !== undefined && pending.outcome === undefined) ||
      binding?.suppressed.get(frame) === treeGeneration)
  )
}

/** Clears a completed/canceled Frame's autofocus suppression before a newer load begins. */
export function clearFrameRenderSuppression(
  session: DocumentSession,
  frame: ProtocolElement,
): void {
  bindings.get(session)?.suppressed.delete(frame)
}

export function dispatchFrameLoad(
  lifecycle: FrameLifecycle,
  prepared: PreparedFrameRender,
): boolean {
  if (!prepared.isCurrent()) return false
  const commit = prepared.commit
  lifecycle[FRAME_LIFECYCLE_LOAD_DISPATCH](
    new FrameLoadEvent({ frameId: commit.frameId, url: commit.url }),
  )
  return true
}

export function dispatchFrameRender(
  lifecycle: FrameLifecycle,
  prepared: PreparedFrameRender,
): boolean {
  if (!prepared.isCurrent()) return false
  lifecycle[FRAME_LIFECYCLE_RENDER_DISPATCH](new FrameRenderEvent(prepared.commit))
  return true
}

function frameRenderIsCurrent(session: DocumentSession, prepared: PreparedFrameRender): boolean {
  const pending = preparedRenders.get(prepared)
  const binding = bindings.get(session)
  return Boolean(
    pending &&
      binding &&
      pending.outcome === "rendered" &&
      (binding.renderers.get(pending.frame) ?? 0) > 0 &&
      (pending.ownerIsCurrent?.() ?? true) &&
      frameIsCurrent(session, pending.frame, pending.commit.frameId, pending.treeGeneration),
  )
}

function settledFrameRender(
  commit: FrameRenderEventDetail,
  outcome: Exclude<FrameRenderOutcome, "failed" | "rendered">,
): PreparedFrameRender {
  return Object.freeze({
    cancel: () => undefined,
    commit,
    isCurrent: () => false,
    outcome,
    rendered: Promise.resolve(outcome),
    seal: () => undefined,
  })
}

function sealFrameRender(session: DocumentSession, prepared: PreparedFrameRender): void {
  if (prepared.outcome !== undefined) return
  const binding = bindings.get(session)
  const pending = preparedRenders.get(prepared)
  if (!binding || !pending || binding.pending.get(pending.frame) !== pending) return
  if (!frameIsCurrent(session, pending.frame, pending.commit.frameId, pending.treeGeneration)) {
    settle(binding, pending, "superseded")
    return
  }
  if (pending.revision !== undefined) return
  pending.revision = session.revision
  binding.revision += 1
  notifySubscribers(binding)
}

function settleStaleFrameRenders(session: DocumentSession, binding: FrameRenderBinding): void {
  for (const pending of [...binding.pending.values()]) {
    if (!frameIsCurrent(session, pending.frame, pending.commit.frameId, pending.treeGeneration)) {
      settle(binding, pending, "superseded")
    }
  }
}

function settle(
  binding: FrameRenderBinding,
  pending: PendingFrameRender,
  outcome: FrameRenderOutcome,
): void {
  if (pending.outcome !== undefined) return
  pending.outcome = outcome
  if (outcome === "failed" || outcome === "superseded") {
    binding.suppressed.set(pending.frame, pending.treeGeneration)
  } else if (binding.suppressed.get(pending.frame) === pending.treeGeneration) {
    binding.suppressed.delete(pending.frame)
  }
  if (binding.pending.get(pending.frame) === pending) binding.pending.delete(pending.frame)
  pending.resolve(outcome)
}

function finishAcknowledgement(
  session: DocumentSession,
  frame: ProtocolElement,
  frameId: string,
  revision: number,
  binding: FrameRenderBinding,
  pending: PendingFrameRender,
  outcome: Extract<FrameRenderOutcome, "failed" | "rendered">,
): void {
  if (pending.outcome !== undefined) return
  if (!frameIsCurrent(session, frame, frameId, pending.treeGeneration)) {
    settle(binding, pending, "superseded")
    return
  }
  if (session.revision !== revision) {
    pending.revision = session.revision
    pending.acknowledged = false
    return
  }
  settle(binding, pending, outcome)
}

function frameIsCurrent(
  session: DocumentSession,
  frame: ProtocolElement,
  frameId: string,
  treeGeneration: number,
): boolean {
  return session.treeGeneration === treeGeneration && session.tree.getElementById(frameId) === frame
}

function notifySubscribers(binding: FrameRenderBinding): void {
  const errors: StateError[] = []
  for (const listener of [...binding.listeners]) {
    try {
      listener()
    } catch {
      errors.push(new StateError("Frame render lifecycle subscriber failed"))
    }
  }
  if (errors.length === 0) return
  queueMicrotask(() => {
    throw new AggregateError(errors, "Frame render lifecycle subscribers failed")
  })
}
