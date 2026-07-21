import type {
  CableReconnectRequest,
  CableStreamSourceConnectionSnapshot,
  ObservableCableStreamSourceCollection,
} from "./cable-stream-sources"
import type { DocumentRefreshRequester } from "./document-refresh-controller"
import type { DocumentVisitController } from "./document-visit-controller"
import { RequestError, StateError } from "./errors"
import type { FrameControllerSnapshot } from "./frame-controller"
import { requestLifecycleDefaultHandlingPrevented } from "./request-lifecycle"
import type { DocumentSession } from "./session"
import type { ProtocolElement } from "./tree"

export interface FrameReconnectController {
  readonly state: Pick<FrameControllerSnapshot, "busy" | "connected" | "disabled" | "source">
  reload(): Promise<unknown>
  subscribe(listener: () => void): () => void
}

/** Finds an already-mounted controller without creating or connecting one. */
export interface FrameReconnectControllerLookup {
  findMounted(frame: ProtocolElement): FrameReconnectController | undefined
}

export interface FrameReconnectReconcilerOptions {
  /** Receives a redacted error when an asynchronous Frame reload fails. */
  readonly onError?: (error: Error) => void
}

interface CapturedSource {
  readonly identity: string
  readonly key: string
  readonly node: ProtocolElement
}

interface ActiveSource {
  readonly captured: CapturedSource
  readonly frame: ProtocolElement | undefined
}

interface FrameCandidate {
  readonly controller: FrameReconnectController
  readonly frame: ProtocolElement
  readonly sources: readonly CapturedSource[]
}

interface PendingReconciliation {
  readonly baseUrl: string
  readonly sources: readonly CapturedSource[]
}

type ReconciliationPlan =
  | Readonly<{ kind: "connection" }>
  | Readonly<{ kind: "document" }>
  | Readonly<{ kind: "drop" }>
  | Readonly<{ controllers: readonly FrameReconnectController[]; kind: "frames-busy" }>
  | Readonly<{ candidates: readonly FrameCandidate[]; kind: "frames" }>

type CandidateState = "drop" | "ready" | "retry"

/**
 * Reconciles only the scopes that owned active Cable stream sources after a
 * confirmed Action Cable reconnect. A document-level source wins; otherwise
 * each active outermost Frame reloads through its existing controller.
 */
export class FrameReconnectReconciler {
  private disposed = false
  private frameUnsubscribes: readonly (() => void)[] = []
  private pending: PendingReconciliation | undefined
  private processing = false
  private subscribingConnection = false
  private subscribingFrames = false
  private subscribingVisit = false
  private connectionUnsubscribe: (() => void) | undefined
  private visitUnsubscribe: (() => void) | undefined
  private readonly onError: ((error: Error) => void) | undefined

  constructor(
    private readonly session: DocumentSession,
    private readonly sources: Pick<
      ObservableCableStreamSourceCollection,
      "connectionSnapshot" | "subscribeConnection"
    >,
    private readonly frames: FrameReconnectControllerLookup,
    private readonly documentRefresh: DocumentRefreshRequester,
    private readonly visits: Pick<DocumentVisitController, "state" | "subscribe">,
    options: FrameReconnectReconcilerOptions = {},
  ) {
    if (options.onError !== undefined && typeof options.onError !== "function") {
      throw new StateError("Frame reconnect reconciler error observer must be a function")
    }
    this.onError = options.onError
  }

  request(request: CableReconnectRequest): void {
    if (this.disposed) throw new StateError("Frame reconnect reconciler is disposed")
    this.pending = admitReconnectRequest(this.session, request)
    this.clearDeferredSubscriptions()
    this.advance(false)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.pending = undefined
    this.clearDeferredSubscriptions()
  }

  private advance(deferred: boolean): void {
    try {
      this.advanceUnsafe(deferred)
    } catch (error) {
      if (!deferred) throw error
      this.report(error)
    }
  }

  private advanceUnsafe(deferred: boolean): void {
    if (this.disposed || this.processing) return
    const pending = this.pending
    if (!pending) {
      this.clearDeferredSubscriptions()
      return
    }
    if (this.visits.state.status === "started") {
      this.clearConnectionSubscription()
      this.clearFrameSubscriptions()
      this.observeVisit()
      return
    }

    this.clearVisitSubscription()
    const plan = this.plan(pending)
    if (plan.kind === "connection") {
      this.clearFrameSubscriptions()
      this.observeConnection()
      return
    }

    this.clearConnectionSubscription()
    if (plan.kind === "drop") {
      this.pending = undefined
      this.clearFrameSubscriptions()
      return
    }
    if (plan.kind === "document") {
      this.pending = undefined
      this.clearFrameSubscriptions()
      const request = Object.freeze({ baseUrl: pending.baseUrl, scroll: "preserve" as const })
      try {
        this.documentRefresh.request(request)
      } catch (error) {
        if (!deferred) throw error
        this.report(error)
      }
      return
    }
    if (plan.kind === "frames-busy") {
      this.observeFrames(plan.controllers)
      return
    }

    this.clearFrameSubscriptions()
    this.startFrameReloads(pending, plan.candidates)
  }

  private plan(pending: PendingReconciliation): ReconciliationPlan {
    const sourceState = sourceStates(this.sources.connectionSnapshot)
    const active: ActiveSource[] = []
    let reconnecting = false
    for (const captured of pending.sources) {
      const current = this.currentSource(captured)
      if (!current) continue
      const state = sourceState.get(captured.key)
      if (state === "reconnecting") {
        reconnecting = true
        continue
      }
      if (state !== "connected") continue
      active.push(Object.freeze({ captured, frame: nearestFrame(current) }))
    }
    if (reconnecting) return Object.freeze({ kind: "connection" })
    if (active.length === 0) return Object.freeze({ kind: "drop" })
    if (active.some((source) => source.frame === undefined)) {
      return Object.freeze({ kind: "document" })
    }

    const grouped = new Map<ProtocolElement, CapturedSource[]>()
    for (const source of active) {
      const frame = source.frame
      if (!frame) continue
      const sources = grouped.get(frame)
      if (sources) sources.push(source.captured)
      else grouped.set(frame, [source.captured])
    }
    const viable = new Map<ProtocolElement, FrameCandidate>()
    for (const [frame, sources] of grouped) {
      const controller = this.frames.findMounted(frame)
      if (!controller || !canReconcile(controller)) continue
      viable.set(
        frame,
        Object.freeze({
          controller,
          frame,
          sources: Object.freeze([...sources]),
        }),
      )
    }
    const candidates = this.session.tree
      .getFrames()
      .filter((frame) => viable.has(frame) && !hasFrameAncestor(frame, viable))
      .flatMap((frame) => {
        const candidate = viable.get(frame)
        return candidate ? [candidate] : []
      })
    if (candidates.length === 0) return Object.freeze({ kind: "drop" })
    const busy = candidates.filter((candidate) => candidate.controller.state.busy)
    if (busy.length > 0) {
      return Object.freeze({
        controllers: Object.freeze(busy.map((candidate) => candidate.controller)),
        kind: "frames-busy",
      })
    }
    return Object.freeze({ candidates: Object.freeze(candidates), kind: "frames" })
  }

  private currentSource(captured: CapturedSource): ProtocolElement | undefined {
    const snapshot = this.session.getNodeSnapshot(captured.key)
    return snapshot?.identity === captured.identity && snapshot.node === captured.node
      ? captured.node
      : undefined
  }

  private startFrameReloads(
    pending: PendingReconciliation,
    candidates: readonly FrameCandidate[],
  ): void {
    this.processing = true
    void this.reloadFrames(pending, candidates).then(
      (retry) => {
        this.processing = false
        if (this.disposed) return
        if (this.pending === pending && !retry) this.pending = undefined
        this.advance(true)
      },
      (error: unknown) => {
        this.processing = false
        if (this.pending === pending) this.pending = undefined
        if (!this.disposed && !requestLifecycleDefaultHandlingPrevented(error)) this.report(error)
        this.advance(true)
      },
    )
  }

  private async reloadFrames(
    pending: PendingReconciliation,
    candidates: readonly FrameCandidate[],
  ): Promise<boolean> {
    for (const candidate of candidates) {
      if (this.disposed || this.pending !== pending) return false
      if (this.visits.state.status === "started") return true
      const state = this.candidateState(candidate)
      if (state === "retry") return true
      if (state === "drop") continue
      try {
        await candidate.controller.reload()
      } catch (error) {
        if (!this.disposed && !requestLifecycleDefaultHandlingPrevented(error)) this.report(error)
      }
    }
    return false
  }

  private candidateState(candidate: FrameCandidate): CandidateState {
    let connected = false
    for (const captured of candidate.sources) {
      const source = this.currentSource(captured)
      if (!source || nearestFrame(source) !== candidate.frame) continue
      const state = sourceStates(this.sources.connectionSnapshot).get(captured.key)
      if (state === "reconnecting") return "retry"
      if (state === "connected") connected = true
    }
    if (!connected) return "drop"
    if (this.frames.findMounted(candidate.frame) !== candidate.controller) return "drop"
    if (!canReconcile(candidate.controller)) return "drop"
    return candidate.controller.state.busy ? "retry" : "ready"
  }

  private observeVisit(): void {
    if (this.disposed || this.visitUnsubscribe || this.subscribingVisit) return
    this.subscribingVisit = true
    let unsubscribe: (() => void) | undefined
    try {
      unsubscribe = this.visits.subscribe(() => this.advance(true))
    } finally {
      this.subscribingVisit = false
    }
    if (!unsubscribe) return
    if (this.disposed || !this.pending || this.visits.state.status !== "started") {
      unsubscribe()
      this.advance(true)
      return
    }
    this.visitUnsubscribe = unsubscribe
  }

  private observeConnection(): void {
    if (this.disposed || this.connectionUnsubscribe || this.subscribingConnection) return
    this.subscribingConnection = true
    let unsubscribe: (() => void) | undefined
    try {
      unsubscribe = this.sources.subscribeConnection(() => this.advance(true))
    } finally {
      this.subscribingConnection = false
    }
    if (!unsubscribe) return
    if (this.disposed || !this.pending || this.plan(this.pending).kind !== "connection") {
      unsubscribe()
      this.advance(true)
      return
    }
    this.connectionUnsubscribe = unsubscribe
  }

  private observeFrames(controllers: readonly FrameReconnectController[]): void {
    if (this.disposed || this.frameUnsubscribes.length > 0 || this.subscribingFrames) return
    this.subscribingFrames = true
    const unsubscribes: (() => void)[] = []
    try {
      for (const controller of controllers) {
        unsubscribes.push(controller.subscribe(() => this.advance(true)))
      }
    } finally {
      this.subscribingFrames = false
    }
    if (!this.pending || this.disposed) {
      for (const unsubscribe of unsubscribes) unsubscribe()
      this.advance(true)
      return
    }
    this.frameUnsubscribes = Object.freeze(unsubscribes)
    this.advance(true)
  }

  private clearDeferredSubscriptions(): void {
    this.clearVisitSubscription()
    this.clearConnectionSubscription()
    this.clearFrameSubscriptions()
  }

  private clearVisitSubscription(): void {
    const unsubscribe = this.visitUnsubscribe
    this.visitUnsubscribe = undefined
    unsubscribe?.()
  }

  private clearConnectionSubscription(): void {
    const unsubscribe = this.connectionUnsubscribe
    this.connectionUnsubscribe = undefined
    unsubscribe?.()
  }

  private clearFrameSubscriptions(): void {
    const unsubscribes = this.frameUnsubscribes
    this.frameUnsubscribes = []
    for (const unsubscribe of unsubscribes) unsubscribe()
  }

  private report(_error: unknown): void {
    const reported = new RequestError("Frame reconnect reconciliation failed")
    if (this.onError) {
      try {
        this.onError(reported)
        return
      } catch (reporterError) {
        queueMicrotask(() => {
          throw new AggregateError([reported, reporterError], "Frame reconnect reporter failed")
        })
        return
      }
    }
    queueMicrotask(() => {
      throw reported
    })
  }
}

function admitReconnectRequest(
  session: DocumentSession,
  request: CableReconnectRequest,
): PendingReconciliation {
  if (request === null || typeof request !== "object" || Array.isArray(request)) {
    throw new RequestError("Frame reconnect reconciliation request must be an object")
  }
  const baseUrl = request.baseUrl
  if (typeof baseUrl !== "string" || baseUrl.trim() === "") {
    throw new RequestError("Frame reconnect reconciliation requires an active document URL")
  }
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    throw new RequestError("Frame reconnect reconciliation requires a valid absolute URL")
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw new RequestError("Frame reconnect reconciliation requires a credential-free HTTP(S) URL")
  }
  if (request.scroll !== "preserve") {
    throw new RequestError("Frame reconnect reconciliation requires scroll preservation")
  }
  if (!Array.isArray(request.sourceKeys) || request.sourceKeys.length === 0) {
    throw new RequestError("Frame reconnect reconciliation requires active Cable stream sources")
  }
  const keys = new Set<string>()
  const sources: CapturedSource[] = []
  for (const key of request.sourceKeys) {
    if (typeof key !== "string" || key.trim() === "" || keys.has(key)) {
      throw new RequestError(
        "Frame reconnect reconciliation source keys must be unique nonblank strings",
      )
    }
    keys.add(key)
    const snapshot = session.getNodeSnapshot(key)
    if (snapshot?.node.kind !== "stream-source") {
      throw new RequestError("Frame reconnect reconciliation requires active Cable stream sources")
    }
    sources.push(Object.freeze({ identity: snapshot.identity, key, node: snapshot.node }))
  }
  sources.sort((left, right) => left.key.localeCompare(right.key))
  return Object.freeze({ baseUrl, sources: Object.freeze(sources) })
}

function sourceStates(snapshot: CableStreamSourceConnectionSnapshot): ReadonlyMap<string, string> {
  return new Map(snapshot.sources.map((source) => [source.nodeKey, source.state]))
}

function nearestFrame(source: ProtocolElement): ProtocolElement | undefined {
  let parent = source.parent
  while (parent) {
    if (parent.kind === "frame") return parent
    parent = parent.parent
  }
  return undefined
}

function hasFrameAncestor(
  frame: ProtocolElement,
  candidates: ReadonlyMap<ProtocolElement, unknown>,
): boolean {
  let parent = frame.parent
  while (parent) {
    if (parent.kind === "frame" && candidates.has(parent)) return true
    parent = parent.parent
  }
  return false
}

function canReconcile(controller: FrameReconnectController): boolean {
  const state = controller.state
  return (
    state.connected &&
    !state.disabled &&
    typeof state.source === "string" &&
    state.source.trim() !== ""
  )
}
