import {
  DOCUMENT_VISIT_LIFECYCLE_LOAD_DISPATCH,
  DOCUMENT_VISIT_LIFECYCLE_RENDER_DISPATCH,
  DocumentLoadEvent,
  DocumentRenderEvent,
  type DocumentRenderEventDetail,
  type DocumentVisitLifecycle,
} from "./document-visit-lifecycle"
import { StateError } from "./errors"
import type { DocumentSession } from "./session"
import type { ProtocolDocument } from "./tree"

export type DocumentRenderOutcome = "failed" | "rendered" | "superseded" | "unavailable"

export interface PreparedDocumentRender {
  readonly commit: DocumentRenderEventDetail
  readonly outcome: DocumentRenderOutcome | undefined
  readonly rendered: Promise<DocumentRenderOutcome>
  cancel(): void
  seal(): void
}

interface PendingDocumentRender {
  acknowledged: boolean
  readonly commit: DocumentRenderEventDetail
  readonly handle: PreparedDocumentRender
  readonly lifecycle: DocumentVisitLifecycle
  outcome: DocumentRenderOutcome | undefined
  renderDispatched: boolean
  revision: number | undefined
  readonly resolve: (outcome: DocumentRenderOutcome) => void
}

interface DocumentRenderBinding {
  readonly listeners: Set<() => void>
  readonly pending: Map<number, PendingDocumentRender>
  renderers: number
  revision: number
  suppressedGeneration: number | undefined
}

export interface DocumentRenderAcknowledgement {
  readonly fail: () => void
  readonly finish: () => void
  readonly status: "render"
}

const bindings = new WeakMap<DocumentSession, DocumentRenderBinding>()

export const DOCUMENT_REQUEST_LOADER_PREPARE_RENDER = Symbol(
  "expo-turbo.document-request-loader.prepare-render",
)

function bindingFor(session: DocumentSession): DocumentRenderBinding {
  let binding = bindings.get(session)
  if (!binding) {
    binding = {
      listeners: new Set(),
      pending: new Map(),
      renderers: 0,
      revision: 0,
      suppressedGeneration: undefined,
    }
    bindings.set(session, binding)
  }
  return binding
}

export function documentRenderLifecycleRevision(session: DocumentSession): number {
  return bindingFor(session).revision
}

export function subscribeDocumentRenderLifecycle(
  session: DocumentSession,
  listener: () => void,
): () => void {
  const binding = bindingFor(session)
  binding.listeners.add(listener)
  return () => binding.listeners.delete(listener)
}

export function retainDocumentRenderer(session: DocumentSession): () => void {
  const binding = bindingFor(session)
  binding.renderers += 1
  let retained = true
  return () => {
    if (!retained) return
    retained = false
    binding.renderers = Math.max(0, binding.renderers - 1)
    if (binding.renderers !== 0) return
    queueMicrotask(() => {
      if (binding.renderers !== 0) return
      for (const pending of [...binding.pending.values()]) settle(binding, pending, "unavailable")
    })
  }
}

export function prepareDocumentRender(
  session: DocumentSession,
  lifecycle: DocumentVisitLifecycle,
  detail: Readonly<{ preview: boolean; url: string }>,
): PreparedDocumentRender {
  const binding = bindingFor(session)
  const commit = Object.freeze({
    generation: session.treeGeneration + 1,
    preview: detail.preview,
    renderMethod: "replace" as const,
    url: detail.url,
  })
  if (binding.renderers === 0) {
    return Object.freeze({
      cancel: () => undefined,
      commit,
      outcome: "unavailable" as const,
      rendered: Promise.resolve("unavailable" as const),
      seal: () => undefined,
    })
  }

  for (const pending of [...binding.pending.values()]) settle(binding, pending, "superseded")

  let resolve!: (outcome: DocumentRenderOutcome) => void
  const rendered = new Promise<DocumentRenderOutcome>((settlePromise) => {
    resolve = settlePromise
  })
  let pending!: PendingDocumentRender
  const handle: PreparedDocumentRender = Object.freeze({
    cancel: () => settle(binding, pending, "superseded"),
    commit,
    get outcome() {
      return pending.outcome
    },
    rendered,
    seal: () => sealDocumentRender(session, handle),
  })
  pending = {
    acknowledged: false,
    commit,
    handle,
    lifecycle,
    outcome: undefined,
    renderDispatched: false,
    revision: undefined,
    resolve,
  }
  binding.pending.set(commit.generation, pending)
  return handle
}

export function acknowledgeDocumentRender(
  session: DocumentSession,
  document: ProtocolDocument,
  generation: number,
  revision: number,
): DocumentRenderAcknowledgement | undefined {
  const binding = bindings.get(session)
  if (!binding) return undefined
  for (const pending of [...binding.pending.values()]) {
    if (pending.commit.generation < generation) settle(binding, pending, "superseded")
  }
  const pending = binding.pending.get(generation)
  if (
    !pending ||
    pending.acknowledged ||
    pending.outcome !== undefined ||
    pending.revision === undefined ||
    session.treeGeneration !== generation ||
    session.tree.document !== document ||
    revision < pending.revision ||
    revision !== session.revision
  ) {
    return undefined
  }

  pending.acknowledged = true
  if (!pending.renderDispatched) {
    pending.renderDispatched = true
    pending.lifecycle[DOCUMENT_VISIT_LIFECYCLE_RENDER_DISPATCH](
      new DocumentRenderEvent(pending.commit),
    )
  }
  if (
    pending.outcome !== undefined ||
    session.treeGeneration !== generation ||
    session.tree.document !== document ||
    session.revision !== revision
  ) {
    if (
      pending.outcome === undefined &&
      (session.treeGeneration !== generation || session.tree.document !== document)
    ) {
      settle(binding, pending, "superseded")
    } else if (pending.outcome === undefined) {
      pending.revision = session.revision
      pending.acknowledged = false
    }
    return undefined
  }

  return Object.freeze({
    fail: () => finishAcknowledgement(session, document, revision, binding, pending, "failed"),
    finish: () => finishAcknowledgement(session, document, revision, binding, pending, "rendered"),
    status: "render" as const,
  })
}

export function hasDocumentRenderTicket(
  session: DocumentSession,
  document: ProtocolDocument,
  generation: number,
): boolean {
  const binding = bindings.get(session)
  const pending = binding?.pending.get(generation)
  return (
    session.treeGeneration === generation &&
    session.tree.document === document &&
    ((pending !== undefined && pending.outcome === undefined) ||
      binding?.suppressedGeneration === generation)
  )
}

function sealDocumentRender(
  session: DocumentSession,
  prepared: PreparedDocumentRender | undefined,
): void {
  if (!prepared || prepared.outcome !== undefined) return
  const binding = bindings.get(session)
  const pending = binding?.pending.get(prepared.commit.generation)
  if (!binding || !pending || pending.handle !== prepared) return
  if (session.treeGeneration !== prepared.commit.generation) {
    settle(binding, pending, "superseded")
    return
  }
  if (pending.revision !== undefined) return
  pending.revision = session.revision
  binding.revision += 1
  notifySubscribers(binding)
}

export function dispatchDocumentLoad(
  lifecycle: DocumentVisitLifecycle,
  commit: DocumentRenderEventDetail,
): void {
  lifecycle[DOCUMENT_VISIT_LIFECYCLE_LOAD_DISPATCH](
    new DocumentLoadEvent({ generation: commit.generation, url: commit.url }),
  )
}

function settle(
  binding: DocumentRenderBinding,
  pending: PendingDocumentRender,
  outcome: DocumentRenderOutcome,
): void {
  if (pending.outcome !== undefined) return
  pending.outcome = outcome
  if (outcome === "failed" || outcome === "superseded") {
    binding.suppressedGeneration = pending.commit.generation
  } else if (binding.suppressedGeneration === pending.commit.generation) {
    binding.suppressedGeneration = undefined
  }
  if (binding.pending.get(pending.commit.generation) === pending) {
    binding.pending.delete(pending.commit.generation)
  }
  pending.resolve(outcome)
}

function finishAcknowledgement(
  session: DocumentSession,
  document: ProtocolDocument,
  revision: number,
  binding: DocumentRenderBinding,
  pending: PendingDocumentRender,
  outcome: Extract<DocumentRenderOutcome, "failed" | "rendered">,
): void {
  if (pending.outcome !== undefined) return
  if (session.treeGeneration !== pending.commit.generation || session.tree.document !== document) {
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

function notifySubscribers(binding: DocumentRenderBinding): void {
  const errors: StateError[] = []
  for (const listener of [...binding.listeners]) {
    try {
      listener()
    } catch {
      errors.push(new StateError("Document render lifecycle subscriber failed"))
    }
  }
  if (errors.length === 0) return
  queueMicrotask(() => {
    throw new AggregateError(errors, "Document render lifecycle subscribers failed")
  })
}
