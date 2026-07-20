import type { Unsubscribe, VisibilityAdapter } from "../adapters"
import { FrameMissingError, StateError, TargetError } from "./errors"
import {
  registerFrameAutofocusController,
  stageFrameAutofocusReport,
} from "./frame-autofocus-internal"
import {
  assertFrameHistoryCommitPlan,
  FRAME_HISTORY_PLAN_OPTION,
  type FrameHistoryAction,
  type FrameHistoryCommitPlan,
  type FrameHistoryCoordinator,
  finalizeFrameHistoryVisit,
  frameHistoryCommittedCandidate,
  prepareFrameHistoryCommit,
} from "./frame-history"
import { isFrameCommitProtected, registerFrameHistoryVisit } from "./frame-history-internal"
import {
  FRAME_RENDER_PREPARE_OPTION,
  FRAME_REQUEST_LOADER_DISPATCH_FRAME_LOAD,
  FRAME_REQUEST_LOADER_DISPATCH_FRAME_RENDER,
  FRAME_REQUEST_LOADER_PREPARE_RENDER,
  FrameCommitError,
  type FrameLoadReport,
  type FrameRequestLoader,
} from "./frame-loader"
import {
  clearFrameRenderSuppression,
  type PreparedFrameRender,
} from "./frame-render-lifecycle-internal"
import type { FrameResponseReport } from "./frames"
import { requestLifecycleDefaultHandlingPrevented } from "./request-lifecycle"
import type { DocumentSession } from "./session"
import { attributeValue, type ProtocolElement } from "./tree"

export type FrameLoadingStyle = "eager" | "lazy"
export type FrameControllerStatus =
  | "canceled"
  | "completed"
  | "empty"
  | "error"
  | "idle"
  | "loading"
  | "prevented"
  | "promoted"

interface PendingFrameAutofocus {
  readonly report: FrameResponseReport
  stateRevision: number
}

export interface FrameControllerSnapshot {
  readonly busy: boolean
  readonly complete: boolean
  readonly connected: boolean
  readonly disabled: boolean
  readonly frameId: string
  readonly hasBeenLoaded: boolean
  readonly loading: FrameLoadingStyle
  readonly revision: number
  readonly source?: string
  readonly status: FrameControllerStatus
  readonly target?: string
}

export type FrameControllerListener = () => void
export type FrameControllerErrorListener = (error: Error) => void

function loadingStyle(frame: ProtocolElement): FrameLoadingStyle {
  return attributeValue(frame, "loading")?.toLowerCase() === "lazy" ? "lazy" : "eager"
}

function appearanceVisitAction(frame: ProtocolElement): FrameHistoryAction | "restore" | undefined {
  const value = attributeValue(frame, "data-turbo-action")
  return value === "advance" || value === "replace" || value === "restore" ? value : undefined
}

export class FrameController {
  private readonly errorListeners = new Set<FrameControllerErrorListener>()
  private readonly frameNode: ProtocolElement
  private readonly listeners = new Set<FrameControllerListener>()
  private readonly requestOwner = Object.freeze({})
  private connected = false
  private hasBeenLoaded = false
  private loadEpoch = 0
  private needsLoad: boolean
  private revision = 0
  private snapshot!: FrameControllerSnapshot
  private status: FrameControllerStatus = "idle"
  private pendingAutofocus: PendingFrameAutofocus | undefined
  private pendingFrameRender: Readonly<{ epoch: number; prepared: PreparedFrameRender }> | undefined
  private visitFinalization: AbortController | undefined
  private loadedPromise: Promise<FrameLoadReport | undefined> = Promise.resolve(undefined)
  private visibilityUnsubscribe: Unsubscribe | undefined

  constructor(
    private readonly session: DocumentSession,
    readonly frameId: string,
    private readonly loader: FrameRequestLoader,
    private readonly visibility?: VisibilityAdapter,
    frameNode?: ProtocolElement,
    private readonly frameHistory?: FrameHistoryCoordinator,
  ) {
    const activeFrame = frameNode ?? this.session.tree.getElementById(this.frameId)
    if (
      activeFrame?.kind !== "frame" ||
      attributeValue(activeFrame, "id") !== this.frameId ||
      !this.session.tree.contains(activeFrame)
    ) {
      throw new FrameMissingError(`Active frame ${JSON.stringify(this.frameId)} is missing`, {
        frameId: this.frameId,
      })
    }
    this.frameNode = activeFrame
    this.needsLoad = this.source !== undefined
    this.snapshot = this.createSnapshot()
    registerFrameHistoryVisit(this, (source, historyPlan) => {
      assertFrameHistoryCommitPlan(historyPlan)
      this.assertLoadAdmission()
      if (!this.connected) {
        this.connected = true
        this.publish()
      }
      return this.startLoad(source, historyPlan)
    })
    registerFrameAutofocusController(this, {
      consume: (revision) => this.consumeAutofocus(revision),
      stage: (report, candidates, publish) => {
        if (this.stageAutofocus(report, candidates) && publish) this.publish()
      },
    })
  }

  get loaded(): Promise<FrameLoadReport | undefined> {
    return this.loadedPromise
  }

  get state(): FrameControllerSnapshot {
    return this.snapshot
  }

  get source(): string | undefined {
    return attributeValue(this.frame, "src")
  }

  get target(): string | undefined {
    return attributeValue(this.frame, "target")
  }

  connect(): Promise<FrameLoadReport | undefined> {
    this.assertLoadAdmission()
    if (!this.connected) {
      this.connected = true
      this.publish()
    }
    return loadingStyle(this.frame) === "eager"
      ? this.loadSourceIfNeeded(false)
      : this.loadLazySourceIfVisible()
  }

  disconnect(): void {
    if (!this.connected) return
    const revision = this.revision
    this.connected = false
    this.pendingAutofocus = undefined
    this.stopVisibilityObserver()
    this.cancel()
    if (this.revision === revision) this.publish()
  }

  cancel(): void {
    this.cancelVisitFinalization()
    const epoch = this.loadEpoch
    const pendingFrameRender =
      this.pendingFrameRender?.epoch === epoch ? this.pendingFrameRender : undefined
    const requestCanceled = this.loader.cancel(this.frameId, this.requestOwner)
    if (!requestCanceled && !pendingFrameRender) return
    if (epoch !== this.loadEpoch) return
    pendingFrameRender?.prepared.cancel()
    if (this.pendingFrameRender === pendingFrameRender) this.pendingFrameRender = undefined
    if (!requestCanceled) return
    this.loadEpoch += 1
    if (this.status === "loading") {
      this.needsLoad = true
      this.status = "canceled"
      this.publish()
    }
  }

  load(): Promise<FrameLoadReport | undefined> {
    this.assertLoadAdmission()
    return this.loadSourceIfNeeded(true)
  }

  visit(source: string): Promise<FrameLoadReport | undefined> {
    this.assertLoadAdmission()
    if (!this.connected) {
      this.connected = true
      this.publish()
    }
    return source === this.source ? this.reload() : this.setSource(source)
  }

  reload(): Promise<FrameLoadReport | undefined> {
    this.assertLoadAdmission()
    this.needsLoad = this.source !== undefined
    return this.loadSourceIfNeeded(true)
  }

  setDisabled(disabled: boolean): Promise<FrameLoadReport | undefined> {
    this.assertLoadAdmission()
    if (disabled) {
      this.session.setAttribute(this.frame.key, "disabled", "")
      this.stopVisibilityObserver()
      this.cancel()
      this.publish()
      return Promise.resolve(undefined)
    }

    this.session.removeAttribute(this.frame.key, "disabled")
    this.publish()
    return loadingStyle(this.frame) === "eager"
      ? this.loadSourceIfNeeded(false)
      : this.loadLazySourceIfVisible()
  }

  setLoading(style: FrameLoadingStyle): Promise<FrameLoadReport | undefined> {
    this.assertLoadAdmission()
    this.session.setAttribute(this.frame.key, "loading", style)
    this.publish()
    if (style === "eager") {
      this.stopVisibilityObserver()
      return this.loadSourceIfNeeded(false)
    }
    return this.loadLazySourceIfVisible()
  }

  setSource(source?: string | null): Promise<FrameLoadReport | undefined> {
    this.assertLoadAdmission()
    const nextSource = source || undefined
    if (nextSource === this.source) return this.loadedPromise

    this.cancel()
    if (nextSource) this.session.setAttribute(this.frame.key, "src", nextSource)
    else {
      this.session.removeAttribute(this.frame.key, "src")
      this.stopVisibilityObserver()
    }
    this.needsLoad = nextSource !== undefined
    this.status = "idle"
    this.publish()

    if (loadingStyle(this.frame) === "eager" || this.hasBeenLoaded) {
      return this.loadSourceIfNeeded(false)
    }
    return this.loadLazySourceIfVisible()
  }

  subscribe(listener: FrameControllerListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  subscribeErrors(listener: FrameControllerErrorListener): () => void {
    this.errorListeners.add(listener)
    return () => this.errorListeners.delete(listener)
  }

  private consumeAutofocus(revision: number): FrameResponseReport | undefined {
    const pending = this.pendingAutofocus
    if (!this.connected || !pending || pending.stateRevision !== revision) return undefined
    this.pendingAutofocus = undefined
    this.publish()
    return pending.report
  }

  private get frame(): ProtocolElement {
    if (
      !this.session.tree.contains(this.frameNode) ||
      this.session.tree.getElementById(this.frameId) !== this.frameNode
    ) {
      throw new FrameMissingError(`Active frame ${JSON.stringify(this.frameId)} is missing`, {
        frameId: this.frameId,
      })
    }
    return this.frameNode
  }

  private loadSourceIfNeeded(force: boolean): Promise<FrameLoadReport | undefined> {
    const frame = this.frame
    const source = attributeValue(frame, "src")
    const disabled = attributeValue(frame, "disabled") !== undefined
    if (!this.connected || disabled || !source || (!force && !this.needsLoad)) {
      return Promise.resolve(undefined)
    }

    return this.startLoad(source)
  }

  private startLoad(
    source: string,
    historyPlan?: FrameHistoryCommitPlan,
  ): Promise<FrameLoadReport | undefined> {
    this.assertLoadAdmission()
    this.cancelVisitFinalization()
    const priorFrameRender = this.pendingFrameRender
    priorFrameRender?.prepared.cancel()
    if (this.pendingFrameRender === priorFrameRender) this.pendingFrameRender = undefined
    clearFrameRenderSuppression(this.session, this.frameNode)
    const visitFinalization = historyPlan ? new AbortController() : undefined
    this.visitFinalization = visitFinalization
    const epoch = ++this.loadEpoch
    this.stopVisibilityObserver()
    this.pendingAutofocus = undefined
    this.needsLoad = false
    this.status = "loading"
    this.publish()
    const request = this.loader.load(this.frameId, source, {
      ...(historyPlan ? { [FRAME_HISTORY_PLAN_OPTION]: historyPlan } : {}),
      owner: this.requestOwner,
      [FRAME_RENDER_PREPARE_OPTION]: (frame, candidate) => {
        this.trackFrameRender(
          this.loader[FRAME_REQUEST_LOADER_PREPARE_RENDER](frame, candidate),
          epoch,
        )
        return undefined
      },
    })
    if (historyPlan && epoch === this.loadEpoch) this.publish()
    const loaded = request.then(
      async (report) => {
        if (epoch !== this.loadEpoch) return report
        const prepared =
          this.pendingFrameRender?.epoch === epoch ? this.pendingFrameRender.prepared : undefined
        if (!prepared) {
          return this.finishLoadWithoutRender(report, epoch, historyPlan, visitFinalization)
        }
        if (report.status !== "promoted" && report.frame && this.connected) {
          stageFrameAutofocusReport(this, report.frame, this.session, this.frameNode)
        }
        let committedHistoryFailure: FrameCommitError | undefined
        if (historyPlan && report.status === "completed") {
          try {
            this.publish()
            await finalizeFrameHistoryVisit(
              historyPlan,
              () => epoch === this.loadEpoch && this.connected,
              visitFinalization?.signal,
            )
          } catch {
            committedHistoryFailure = new FrameCommitError(
              frameHistoryCommittedCandidate(historyPlan),
            )
          } finally {
            if (this.visitFinalization === visitFinalization) this.visitFinalization = undefined
          }
        }
        if (this.visitFinalization === visitFinalization) this.visitFinalization = undefined
        const rendering = this.frameRenderResult(prepared, epoch)
        const rendered = typeof rendering === "boolean" ? rendering : await rendering
        this.finishAfterFrameRender(
          prepared,
          rendered,
          epoch,
          committedHistoryFailure?.outcome ?? report,
        )
        if (committedHistoryFailure) {
          if (epoch === this.loadEpoch) {
            for (const listener of this.errorListeners) listener(committedHistoryFailure)
          }
          throw committedHistoryFailure
        }
        return report
      },
      async (error: unknown) => {
        const reported = error instanceof Error ? error : new Error("Frame source load failed")
        const committed = error instanceof FrameCommitError
        const prepared =
          this.pendingFrameRender?.epoch === epoch ? this.pendingFrameRender.prepared : undefined
        let publicationFailure: unknown
        try {
          let rendered = false
          if (committed) {
            const rendering = this.frameRenderResult(prepared, epoch)
            rendered = typeof rendering === "boolean" ? rendering : await rendering
          } else {
            prepared?.cancel()
          }
          if (epoch === this.loadEpoch) {
            if (committed) {
              this.finishAfterFrameRender(prepared, rendered, epoch, error.outcome)
            } else {
              this.needsLoad = true
              this.status = "error"
              this.publish()
            }
          }
        } catch (failure) {
          publicationFailure = failure
        } finally {
          if (this.visitFinalization === visitFinalization) this.visitFinalization = undefined
        }
        if (publicationFailure !== undefined && !committed) throw publicationFailure
        if (epoch === this.loadEpoch && !requestLifecycleDefaultHandlingPrevented(error)) {
          for (const listener of this.errorListeners) listener(reported)
        }
        throw reported
      },
    )
    this.loadedPromise = loaded
    return loaded
  }

  private async finishLoadWithoutRender(
    report: FrameLoadReport,
    epoch: number,
    historyPlan: FrameHistoryCommitPlan | undefined,
    visitFinalization: AbortController | undefined,
  ): Promise<FrameLoadReport> {
    if (report.status !== "promoted" && report.frame && this.connected) {
      stageFrameAutofocusReport(this, report.frame, this.session, this.frameNode)
    }
    this.applyLoadReport(report)
    if (historyPlan && report.status === "completed") {
      try {
        this.publish()
        await finalizeFrameHistoryVisit(
          historyPlan,
          () => epoch === this.loadEpoch && this.connected,
          visitFinalization?.signal,
        )
      } catch {
        const committed = new FrameCommitError(frameHistoryCommittedCandidate(historyPlan))
        if (epoch === this.loadEpoch) {
          for (const listener of this.errorListeners) listener(committed)
        }
        throw committed
      } finally {
        if (this.visitFinalization === visitFinalization) this.visitFinalization = undefined
      }
    } else {
      this.publish()
    }
    if (this.visitFinalization === visitFinalization) this.visitFinalization = undefined
    return report
  }

  private frameRenderResult(
    prepared: PreparedFrameRender | undefined,
    epoch: number,
  ): boolean | Promise<boolean> {
    if (!prepared) return false
    prepared.seal()
    if (prepared.outcome !== undefined) return prepared.outcome === "rendered"
    if (this.pendingFrameRender?.prepared !== prepared) this.trackFrameRender(prepared, epoch)
    const pending = this.pendingFrameRender
    if (!pending || pending.prepared !== prepared) {
      throw new StateError("Frame render tracking was lost before acknowledgement", {
        frameId: this.frameId,
      })
    }
    return prepared.rendered.then((outcome) => {
      if (this.pendingFrameRender === pending) this.pendingFrameRender = undefined
      return outcome === "rendered"
    })
  }

  private trackFrameRender(
    prepared: PreparedFrameRender | undefined,
    epoch: number,
  ): PreparedFrameRender | undefined {
    if (!prepared) return undefined
    if (epoch !== this.loadEpoch || this.status !== "loading") {
      prepared.cancel()
      throw new StateError("Frame render prepared without an active load", {
        frameId: this.frameId,
      })
    }
    if (prepared.outcome === undefined) this.pendingFrameRender = Object.freeze({ epoch, prepared })
    return prepared
  }

  private finishAfterFrameRender(
    prepared: PreparedFrameRender | undefined,
    rendered: boolean,
    epoch: number,
    report: Extract<FrameLoadReport, Readonly<{ status: "completed" }>> | FrameLoadReport,
  ): void {
    if (epoch !== this.loadEpoch || this.status !== "loading") return
    this.applyLoadReport(report)
    this.publish()
    if (!rendered || !prepared || report.status !== "completed" || epoch !== this.loadEpoch) {
      return
    }
    if (!this.frameRenderContinuationCurrent(prepared, epoch)) return
    if (!this.loader[FRAME_REQUEST_LOADER_DISPATCH_FRAME_RENDER](prepared)) return
    if (!this.frameRenderContinuationCurrent(prepared, epoch)) return
    this.loader[FRAME_REQUEST_LOADER_DISPATCH_FRAME_LOAD](prepared)
  }

  private frameRenderContinuationCurrent(prepared: PreparedFrameRender, epoch: number): boolean {
    return (
      epoch === this.loadEpoch &&
      this.connected &&
      this.snapshot.status === "completed" &&
      attributeValue(this.frameNode, "disabled") === undefined &&
      this.session.tree.getElementById(this.frameId) === this.frameNode &&
      prepared.isCurrent()
    )
  }

  private applyLoadReport(report: FrameLoadReport): void {
    this.status = report.status
    if (
      report.status === "completed" ||
      report.status === "empty" ||
      report.status === "promoted"
    ) {
      this.hasBeenLoaded = true
      this.needsLoad = false
    } else {
      this.needsLoad = true
    }
  }

  private cancelVisitFinalization(): void {
    const controller = this.visitFinalization
    this.visitFinalization = undefined
    controller?.abort()
  }

  private assertLoadAdmission(): void {
    if (isFrameCommitProtected(this.loader, this.frameId, this.requestOwner)) {
      throw new StateError("Frame controller cannot mutate during its commit transaction", {
        frameId: this.frameId,
      })
    }
  }

  private loadLazySourceIfVisible(): Promise<FrameLoadReport | undefined> {
    const frame = this.frame
    if (
      !this.connected ||
      !this.visibility ||
      attributeValue(frame, "disabled") !== undefined ||
      !attributeValue(frame, "src") ||
      !this.needsLoad
    ) {
      return Promise.resolve(undefined)
    }

    if (!this.visibilityUnsubscribe) {
      const unsubscribe = this.visibility.subscribe(this.frameId, (visible) => {
        if (!visible) return
        void this.loadLazySourceAfterAppearance().catch(() => undefined)
      })
      this.visibilityUnsubscribe = unsubscribe
      if (!this.needsLoad) {
        this.stopVisibilityObserver()
        return this.loadedPromise
      }
    }
    return this.visibility.isVisible(this.frameId)
      ? this.loadLazySourceAfterAppearance()
      : Promise.resolve(undefined)
  }

  private loadLazySourceAfterAppearance(): Promise<FrameLoadReport | undefined> {
    const frame = this.frame
    const source = attributeValue(frame, "src")
    if (
      !this.connected ||
      attributeValue(frame, "disabled") !== undefined ||
      !source ||
      !this.needsLoad
    ) {
      return Promise.resolve(undefined)
    }

    const action = appearanceVisitAction(frame)
    if (!action) return this.startLoad(source)

    try {
      if (action === "restore") {
        throw new TargetError("Lazy Frame restore requires whole-document traversal", {
          frameId: this.frameId,
        })
      }
      if (!this.frameHistory) {
        throw new TargetError("Lazy Frame action requires history coordination", {
          frameId: this.frameId,
        })
      }
      const plan = prepareFrameHistoryCommit(this.frameHistory, this, frame, source, action)
      return this.startLoad(source, plan)
    } catch (error) {
      return this.rejectAppearanceLoad(error)
    }
  }

  private rejectAppearanceLoad(error: unknown): Promise<FrameLoadReport | undefined> {
    const reported = error instanceof Error ? error : new Error("Lazy Frame source load failed")
    this.loadEpoch += 1
    this.stopVisibilityObserver()
    this.needsLoad = false
    this.status = "error"
    const loaded = Promise.reject<FrameLoadReport | undefined>(reported)
    this.loadedPromise = loaded
    this.publish()
    for (const listener of this.errorListeners) listener(reported)
    return loaded
  }

  private stopVisibilityObserver(): void {
    this.visibilityUnsubscribe?.()
    this.visibilityUnsubscribe = undefined
  }

  private stageAutofocus(report: FrameResponseReport, candidates: readonly string[]): boolean {
    if (candidates.length === 0) {
      const changed = this.pendingAutofocus !== undefined
      this.pendingAutofocus = undefined
      return changed
    }
    this.pendingAutofocus = {
      report,
      stateRevision: this.revision,
    }
    return true
  }

  private createSnapshot(): FrameControllerSnapshot {
    const frame = this.session.tree.contains(this.frameNode) ? this.frameNode : undefined
    if (!frame || frame !== this.session.tree.getElementById(this.frameId)) {
      if (!this.snapshot) {
        throw new FrameMissingError(`Active frame ${JSON.stringify(this.frameId)} is missing`, {
          frameId: this.frameId,
        })
      }
      return Object.freeze({
        ...this.snapshot,
        busy: this.status === "loading",
        complete: this.status !== "loading",
        connected: this.connected,
        hasBeenLoaded: this.hasBeenLoaded,
        revision: this.revision,
        status: this.status,
      })
    }
    const source = attributeValue(frame, "src")
    const target = attributeValue(frame, "target")
    return Object.freeze({
      busy: this.status === "loading",
      complete: this.status !== "loading",
      connected: this.connected,
      disabled: attributeValue(frame, "disabled") !== undefined,
      frameId: this.frameId,
      hasBeenLoaded: this.hasBeenLoaded,
      loading: loadingStyle(frame),
      revision: this.revision,
      ...(source !== undefined ? { source } : {}),
      status: this.status,
      ...(target !== undefined ? { target } : {}),
    })
  }

  private publish(): void {
    this.revision += 1
    if (this.pendingAutofocus) this.pendingAutofocus.stateRevision = this.revision
    this.snapshot = this.createSnapshot()
    for (const listener of this.listeners) listener()
  }
}
