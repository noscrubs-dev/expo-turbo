import type { ClockAdapter, NavigationAdapter, VisitAction } from "../adapters"
import type {
  DocumentHistory,
  DocumentHistoryEntry,
  DocumentHistoryProposal,
  DocumentHistoryTraversalDirection,
  DocumentRestorationData,
} from "./document-history"
import {
  type DocumentCommitCandidate,
  DocumentCommitError,
  type DocumentLoadOptions,
  type DocumentLoadReport,
  type DocumentRequestLoader,
  DocumentSnapshotPreviewCommitError,
  DocumentSnapshotRestoreCommitError,
  type DocumentTreeCommitCandidate,
} from "./document-loader"
import {
  DOCUMENT_LOAD_DISCARD_HANDLING,
  DOCUMENT_LOAD_REQUEST_DISPATCHED,
} from "./document-loader-lifecycle-internal"
import type { DocumentSnapshotCache } from "./document-snapshot-cache"
import {
  admitDocumentVisitLifecycle,
  BeforeVisitEvent,
  DOCUMENT_VISIT_LIFECYCLE_BEFORE_DISPATCH,
  DOCUMENT_VISIT_LIFECYCLE_VISIT_DISPATCH,
  type DocumentVisitLifecycle,
  VisitEvent,
} from "./document-visit-lifecycle"
import { PropsError, RequestError, StateError, TargetError } from "./errors"
import { resolveProtocolUrl } from "./protocol-request"
import {
  type RequestOperationResult,
  requestLifecycleDefaultHandlingPrevented,
  settleRequestOperation,
} from "./request-lifecycle"
import {
  classifyTopLevelLocationAgainstRoot,
  type TopLevelLocationDisposition,
} from "./visitability"

export const DOCUMENT_VISIT_PROGRESS_DELAY_MS = 500

type DocumentVisitLoadOptions = DocumentLoadOptions &
  Readonly<{
    [DOCUMENT_LOAD_DISCARD_HANDLING]?: (
      controller: AbortController,
    ) => undefined | PromiseLike<undefined>
    [DOCUMENT_LOAD_REQUEST_DISPATCHED]?: () => undefined
  }>

export type DocumentVisitStatus = "canceled" | "completed" | "failed" | "initialized" | "started"

export interface DocumentVisitSnapshot {
  readonly busy: boolean
  readonly previewVisible: boolean
  readonly progressVisible: boolean
  readonly revision: number
  readonly status: DocumentVisitStatus
}

export interface DocumentVisitControllerOptions {
  readonly history?: DocumentHistory
  readonly onObserverError?: (error: AggregateError) => void
  readonly progressDelayMs?: number
  readonly snapshotCache?: DocumentSnapshotCache
  readonly visitLifecycle?: DocumentVisitLifecycle
}

interface AdmittedDocumentVisitControllerOptions {
  readonly history: DocumentHistory | undefined
  readonly onObserverError: ((error: AggregateError) => void) | undefined
  readonly progressDelayMs: number | undefined
  readonly snapshotCache: DocumentSnapshotCache | undefined
  readonly visitLifecycle: unknown
}

export interface DocumentVisitOptions {
  readonly action?: VisitAction
  readonly navigation?: NavigationAdapter
}

export type DocumentVisitDelegation =
  | Readonly<{
      kind: "external"
      reason: "external"
      status: "delegated"
      url: string
    }>
  | Readonly<{
      action: VisitAction
      kind: "navigation"
      reason: "outside-root" | "unvisitable-extension"
      status: "delegated"
      url: string
    }>

export type DocumentCachedVisitResult = Readonly<{
  source: "snapshot"
  status: "canceled" | "restored"
  url: string
}>

export type DocumentPreviewVisitResult = Readonly<{
  source: "preview"
  status: "canceled"
  url: string
}>

export type DocumentBeforeVisitCanceledResult = Readonly<{
  source: "visit-lifecycle"
  status: "canceled"
  url: string
}>

export type DocumentVisitResult =
  | DocumentBeforeVisitCanceledResult
  | DocumentCachedVisitResult
  | DocumentPreviewVisitResult
  | DocumentLoadReport
  | DocumentVisitDelegation

export type DocumentTraversalRestoreResult =
  | Readonly<{
      direction: DocumentHistoryTraversalDirection
      entry: DocumentHistoryEntry
      restorationData: DocumentRestorationData
      source: "snapshot"
      status: "canceled" | "restored"
    }>
  | Readonly<{
      direction: DocumentHistoryTraversalDirection
      entry: DocumentHistoryEntry
      restorationData: DocumentRestorationData
      result: DocumentVisitResult
      source: "network"
    }>

export type DocumentVisitListener = () => void
export type DocumentVisitErrorListener = (error: Error) => void

interface DocumentVisitHistoryPlan {
  readonly base: DocumentHistoryEntry
  readonly history: DocumentHistory
  readonly proposal: DocumentHistoryProposal
}

interface DocumentVisitHistoryGuard {
  readonly entry: DocumentHistoryEntry
  readonly history: DocumentHistory
  readonly kind: "refresh" | "traversal"
  readonly traversalEpoch?: number
}

interface DocumentPreviewContinuation {
  readonly documentClaimSerial: number
  readonly epoch: number
  readonly generation: number
  readonly history?: DocumentHistory
  readonly historyEntry?: DocumentHistoryEntry
  readonly url: string
}

export class DocumentVisitController {
  private attemptEpoch = 0
  private readonly errorListeners = new Set<DocumentVisitErrorListener>()
  private readonly history: DocumentHistory | undefined
  private readonly listeners = new Set<DocumentVisitListener>()
  private readonly onObserverError: ((error: AggregateError) => void) | undefined
  private readonly progressDelayMs: number
  private readonly requestOwner = Object.freeze({})
  private readonly snapshotCache: DocumentSnapshotCache | undefined
  private notifiedPreviewVisible: boolean
  private progressHandle: unknown
  private progressVisible = false
  private previewContinuationEpoch: number | undefined
  private revision = 0
  private snapshot: DocumentVisitSnapshot
  private status: DocumentVisitStatus = "initialized"
  private traversalEntry: DocumentHistoryEntry | undefined
  private traversalEpoch = 0
  private treeStateUnsubscribe: (() => void) | undefined
  private readonly visitLifecycle: DocumentVisitLifecycle | undefined
  private visitEpoch = 0

  constructor(
    private readonly loader: DocumentRequestLoader,
    private readonly clock: ClockAdapter,
    options: DocumentVisitControllerOptions = {},
  ) {
    const admittedOptions = documentVisitControllerOptions(options)
    this.history = admittedOptions.history
    this.onObserverError = admittedOptions.onObserverError
    this.progressDelayMs = admittedOptions.progressDelayMs ?? DOCUMENT_VISIT_PROGRESS_DELAY_MS
    this.snapshotCache = admittedOptions.snapshotCache
    this.visitLifecycle = admitDocumentVisitLifecycle(
      admittedOptions.visitLifecycle,
      "Document visit controller visit lifecycle is invalid",
    )
    if (!Number.isFinite(this.progressDelayMs) || this.progressDelayMs < 0) {
      throw new RequestError("Document visit progress delay must be a non-negative number")
    }
    this.snapshot = this.createSnapshot()
    this.notifiedPreviewVisible = this.snapshot.previewVisible
  }

  get state(): DocumentVisitSnapshot {
    this.syncTreeState()
    return this.snapshot
  }

  visit(source: string, options: DocumentVisitOptions = {}): Promise<DocumentVisitResult> {
    const documentClaimSerial = this.loader.documentClaimSerial
    const treeGeneration = this.loader.treeState.generation
    const action = options.action ?? "advance"
    if (action !== "advance" && action !== "replace" && action !== "restore") {
      return Promise.reject(new TargetError("Document visit action is unsupported"))
    }
    let admission: TopLevelLocationDisposition
    let historyPlan: DocumentVisitHistoryPlan | undefined
    try {
      admission = this.loader.classifyTopLevelSource(source)
      if (action === "restore" && admission.url.includes("#")) {
        throw new TargetError("Document restore fragments require anchor restoration support")
      }
      if (admission.classification === "visitable") {
        this.validateHistoryAction(action)
      } else if (action === "restore") {
        throw new TargetError("Document restore visits require a root-visitable location")
      }
    } catch (error) {
      return Promise.reject(error)
    }

    const attemptEpoch = ++this.attemptEpoch
    try {
      const canceled = this.beforeVisit(admission.url)
      if (canceled || attemptEpoch !== this.attemptEpoch) {
        return Promise.resolve(canceled ?? this.beforeVisitCanceled(admission.url))
      }
      if (admission.classification === "visitable") {
        historyPlan = this.proposeHistory(action, admission.url)
      }
    } catch (error) {
      return Promise.reject(error)
    }
    if (admission.classification !== "visitable") {
      return this.delegateInitial(admission, action, options.navigation)
    }

    if (action === "restore") {
      if (!historyPlan) {
        return Promise.reject(new TargetError("Document restore visits require configured history"))
      }
      return this.startRestoreVisit(
        admission.url,
        options.navigation,
        historyPlan,
        documentClaimSerial,
        treeGeneration,
        attemptEpoch,
      )
    }
    const cache = this.snapshotCache
    if (cache && new URL(admission.url).hash === "") {
      return this.startPreviewableVisit(
        admission.url,
        options.navigation,
        cache,
        historyPlan,
        action,
        attemptEpoch,
        documentClaimSerial,
        treeGeneration,
      )
    }
    return this.startVisit(
      admission.url,
      options.navigation,
      cache,
      historyPlan,
      undefined,
      action,
      undefined,
      attemptEpoch,
      undefined,
      documentClaimSerial,
      treeGeneration,
    )
  }

  /**
   * Refreshes only when the captured URL still owns the idle active document.
   * This bypasses initial root visitability because Turbo refreshes current truth.
   */
  refreshCurrent(baseUrl: string): Promise<DocumentVisitResult | undefined> {
    if (this.status === "started") {
      return Promise.resolve(undefined)
    }
    const documentClaimSerial = this.loader.documentClaimSerial
    const treeGeneration = this.loader.treeState.generation
    let currentUrl: string | undefined
    let historyPlan: DocumentVisitHistoryPlan | undefined
    try {
      currentUrl = this.canonicalDocumentUrl(this.loader.currentUrl)
      if (!currentUrl || this.canonicalDocumentUrl(baseUrl) !== currentUrl) {
        return Promise.resolve(undefined)
      }
      if (this.history) this.captureHistoryGuard(currentUrl, "refresh")
    } catch (error) {
      return Promise.reject(error)
    }
    const attemptEpoch = ++this.attemptEpoch
    try {
      const canceled = this.beforeVisit(currentUrl)
      if (canceled || attemptEpoch !== this.attemptEpoch) {
        return Promise.resolve(canceled ?? this.beforeVisitCanceled(currentUrl))
      }
      historyPlan = this.history ? this.proposeHistory("replace", currentUrl) : undefined
    } catch (error) {
      return Promise.reject(error)
    }
    return this.startVisit(
      currentUrl,
      undefined,
      undefined,
      historyPlan,
      undefined,
      "replace",
      undefined,
      attemptEpoch,
      undefined,
      documentClaimSerial,
      treeGeneration,
    )
  }

  /**
   * Applies a host history traversal after the host has already moved to the
   * supplied entry. Cached restoration is final; a miss performs one guarded
   * history-neutral GET.
   */
  restoreTraversal(entry: DocumentHistoryEntry): Promise<DocumentTraversalRestoreResult> {
    const documentClaimSerial = this.loader.documentClaimSerial
    const treeGeneration = this.loader.treeState.generation
    const traversalEpoch = ++this.traversalEpoch
    let direction: DocumentHistoryTraversalDirection
    let history: DocumentHistory
    let restoredEntry: DocumentHistoryEntry
    let restorationData: DocumentRestorationData
    try {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        throw new StateError("Document history entries must be objects")
      }
      const receivedKeys = Object.keys(entry)
      if (traversalEpoch !== this.traversalEpoch) {
        throw new StateError("Document traversal was superseded before admission")
      }
      if (
        receivedKeys.some(
          (key) => !["restorationIdentifier", "restorationIndex", "url"].includes(key),
        )
      ) {
        throw new StateError("Document history entries contain unsupported fields")
      }
      const receivedEntry = Object.freeze({
        restorationIdentifier: entry.restorationIdentifier,
        restorationIndex: entry.restorationIndex,
        url: entry.url,
      })
      if (traversalEpoch !== this.traversalEpoch) {
        throw new StateError("Document traversal was superseded before admission")
      }
      const configuredHistory = this.history
      if (!configuredHistory) {
        throw new TargetError("Document traversal restoration requires configured history")
      }
      history = configuredHistory
      const current = history.current
      if (!current) throw new StateError("Document history is not initialized")
      const traversalUrl = this.loader.resolveSource(receivedEntry.url)
      if (new URL(traversalUrl).hash !== "") {
        throw new TargetError("Document traversal fragments require anchor restoration support")
      }
      if (this.traversalEntry) {
        if (current !== this.traversalEntry) this.traversalEntry = current
      } else if (this.canonicalDocumentUrl(this.loader.currentUrl) !== current.url) {
        throw new StateError("Document history must match the active document before traversal")
      }
      if (traversalEpoch !== this.traversalEpoch) {
        throw new StateError("Document traversal was superseded before history adoption")
      }
      direction = history.adoptTraversal(receivedEntry)
      const adopted = history.current
      if (!adopted) throw new StateError("Document traversal did not publish a history entry")
      restoredEntry = adopted
      this.traversalEntry = adopted
      restorationData = history.getRestorationData(adopted.restorationIdentifier)
    } catch (error) {
      if (traversalEpoch === this.traversalEpoch) this.cancel()
      return Promise.reject(error)
    }

    const cache = this.snapshotCache
    if (cache) {
      let epoch: number | undefined
      try {
        const report = this.loader.restoreSnapshot(cache, restoredEntry.url, this.requestOwner, {
          beforeClaim: () => {
            this.assertDocumentClaimSerial(documentClaimSerial)
            this.assertTreeGeneration(treeGeneration)
            if (traversalEpoch !== this.traversalEpoch) {
              throw new StateError("Document snapshot traversal was superseded before ownership")
            }
            return undefined
          },
          beforeTreeCommit: () => {
            if (traversalEpoch !== this.traversalEpoch) {
              throw new StateError("Document snapshot traversal was superseded")
            }
            if (history.current !== restoredEntry) {
              throw new StateError("Document history changed during snapshot restoration")
            }
            this.loader.captureCurrentSnapshot(cache)
            if (traversalEpoch !== this.traversalEpoch || history.current !== restoredEntry) {
              throw new StateError("Document history changed during snapshot restoration")
            }
          },
          onRestoreStart: () => {
            if (traversalEpoch !== this.traversalEpoch) {
              throw new StateError("Document snapshot traversal was superseded")
            }
            this.previewContinuationEpoch = undefined
            epoch = ++this.visitEpoch
            this.progressVisible = false
            this.status = "started"
            this.publish()
            this.notifyVisit(restoredEntry.url, "restore", epoch)
          },
        })
        if (report.status !== "miss") {
          this.reconcileTraversal(restoredEntry)
          if (epoch !== undefined && epoch === this.visitEpoch) {
            this.clearProgress()
            this.finish(report.status === "committed" ? "completed" : "canceled")
          }
          return Promise.resolve(
            Object.freeze({
              direction,
              entry: restoredEntry,
              restorationData,
              source: "snapshot" as const,
              status: report.status === "committed" ? ("restored" as const) : ("canceled" as const),
            }),
          )
        }
      } catch (error) {
        const reported = error instanceof Error ? error : new StateError("Document restore failed")
        this.reconcileTraversal(restoredEntry)
        if (epoch !== undefined && epoch === this.visitEpoch) {
          this.clearProgress()
          this.finish(error instanceof DocumentSnapshotRestoreCommitError ? "completed" : "failed")
          this.notifyError(reported)
        }
        return Promise.reject(reported)
      }
    }

    const historyGuard: DocumentVisitHistoryGuard = {
      entry: restoredEntry,
      history,
      kind: "traversal",
      traversalEpoch,
    }
    return this.startVisit(
      restoredEntry.url,
      undefined,
      cache,
      undefined,
      historyGuard,
      "advance",
      undefined,
      undefined,
      undefined,
      documentClaimSerial,
      treeGeneration,
      "restore",
    ).then(
      (result) => {
        this.reconcileTraversal(restoredEntry)
        return Object.freeze({
          direction,
          entry: restoredEntry,
          restorationData,
          result,
          source: "network" as const,
        })
      },
      (error: unknown) => {
        this.reconcileTraversal(restoredEntry)
        throw error
      },
    )
  }

  cancel(): void {
    if (this.status !== "started") return
    const epoch = this.visitEpoch
    const continuationPending = this.previewContinuationEpoch === epoch
    if (!this.loader.cancel(this.requestOwner) && !continuationPending) return
    if (epoch !== this.visitEpoch || this.status !== "started") return
    if (continuationPending) this.previewContinuationEpoch = undefined
    this.attemptEpoch += 1
    this.visitEpoch += 1
    this.finish("canceled")
  }

  subscribe(listener: DocumentVisitListener): () => void {
    const wasEmpty = this.listeners.size === 0
    if (wasEmpty) {
      this.syncTreeState()
      this.notifiedPreviewVisible = this.snapshot.previewVisible
    }
    this.listeners.add(listener)
    if (wasEmpty) {
      this.treeStateUnsubscribe = this.loader.subscribeTreeState(() => {
        const previewVisible = this.loader.treeState.preview
        if (this.notifiedPreviewVisible === previewVisible) return
        this.notifiedPreviewVisible = previewVisible
        this.publish()
      })
    }
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0) {
        this.treeStateUnsubscribe?.()
        this.treeStateUnsubscribe = undefined
      }
    }
  }

  subscribeErrors(listener: DocumentVisitErrorListener): () => void {
    this.errorListeners.add(listener)
    return () => this.errorListeners.delete(listener)
  }

  private startPreviewableVisit(
    source: string,
    navigation: NavigationAdapter | undefined,
    cache: DocumentSnapshotCache,
    historyPlan: DocumentVisitHistoryPlan | undefined,
    action: Extract<VisitAction, "advance" | "replace">,
    attemptEpoch: number,
    documentClaimSerial: number,
    treeGeneration: number,
  ): Promise<DocumentVisitResult> {
    let epoch: number | undefined
    let historyEntry: DocumentHistoryEntry | undefined
    let previewClaimSerial: number | undefined
    let previewFinalizationError: DocumentSnapshotPreviewCommitError | undefined
    let previewGeneration: number | undefined
    let report: ReturnType<DocumentRequestLoader["previewSnapshot"]> | undefined
    try {
      report = this.loader.previewSnapshot(cache, source, this.requestOwner, {
        beforeClaim: () => {
          this.assertAttemptEpoch(attemptEpoch)
          this.assertDocumentClaimSerial(documentClaimSerial)
          this.assertTreeGeneration(treeGeneration)
          if (historyPlan) this.assertHistoryPlan(historyPlan)
          return undefined
        },
        beforeTreeCommit: () => {
          this.assertAttemptEpoch(attemptEpoch)
          if (historyPlan) this.assertHistoryPlan(historyPlan)
          this.loader.captureCurrentSnapshot(cache)
          if (historyPlan) this.assertHistoryPlan(historyPlan)
          if (historyPlan) historyEntry = historyPlan.history.commitProposal(historyPlan.proposal)
          if (epoch === undefined) {
            throw new StateError("Document preview started without a visit lifecycle")
          }
          previewClaimSerial = this.loader.documentClaimSerial
          previewGeneration = this.loader.treeState.generation + 1
          this.previewContinuationEpoch = epoch
          return undefined
        },
        onPreviewStart: () => {
          this.assertAttemptEpoch(attemptEpoch)
          if (historyPlan) this.assertHistoryPlan(historyPlan)
          this.previewContinuationEpoch = undefined
          epoch = ++this.visitEpoch
          this.progressVisible = false
          this.status = "started"
          this.publish()
          this.notifyVisit(source, action, epoch)
          return undefined
        },
      })
    } catch (error) {
      const reported =
        error instanceof Error ? error : new StateError("Document snapshot preview failed")
      if (error instanceof DocumentSnapshotPreviewCommitError) {
        report = error.outcome
        previewFinalizationError = error
      } else {
        if (epoch !== undefined && epoch === this.visitEpoch && this.status === "started") {
          this.previewContinuationEpoch = undefined
          this.finish("failed")
          this.notifyError(reported)
        }
        return Promise.reject(reported)
      }
    }

    if (!report) {
      if (epoch !== undefined && epoch === this.visitEpoch && this.status === "started") {
        this.previewContinuationEpoch = undefined
        this.finish("failed")
      }
      return Promise.reject(new StateError("Document snapshot preview produced no result"))
    }

    if (report.status === "miss") {
      try {
        this.assertAttemptEpoch(attemptEpoch)
        this.assertDocumentClaimSerial(documentClaimSerial)
        this.assertTreeGeneration(treeGeneration)
      } catch (error) {
        return Promise.reject(error)
      }
      return this.startVisit(
        source,
        navigation,
        cache,
        historyPlan,
        undefined,
        action,
        undefined,
        attemptEpoch,
        undefined,
        documentClaimSerial,
        treeGeneration,
      )
    }

    const canceled = Object.freeze({
      source: "preview" as const,
      status: "canceled" as const,
      url: report.url,
    })
    if (report.status === "canceled" || epoch === undefined) {
      if (epoch !== undefined && epoch === this.visitEpoch && this.status === "started") {
        this.previewContinuationEpoch = undefined
        this.finish("canceled")
      }
      return Promise.resolve(canceled)
    }

    if (previewClaimSerial === undefined || previewGeneration === undefined) {
      if (epoch === this.visitEpoch && this.status === "started") {
        this.previewContinuationEpoch = undefined
        this.finish("failed")
      }
      return Promise.reject(new StateError("Document preview continuation checkpoint is missing"))
    }

    const continuation: DocumentPreviewContinuation = {
      documentClaimSerial: previewClaimSerial,
      epoch,
      generation: previewGeneration,
      ...(historyPlan ? { history: historyPlan.history } : {}),
      ...(historyEntry ? { historyEntry } : {}),
      url: report.url,
    }
    if (!this.previewContinuationCurrent(continuation)) {
      if (epoch === this.visitEpoch && this.status === "started") {
        this.previewContinuationEpoch = undefined
        this.finish("canceled")
        if (previewFinalizationError) this.notifyError(previewFinalizationError)
      }
      if (previewFinalizationError) return Promise.reject(previewFinalizationError)
      return Promise.resolve(canceled)
    }

    if (previewFinalizationError) {
      this.notifyError(previewFinalizationError)
      if (!this.previewContinuationCurrent(continuation)) {
        if (epoch === this.visitEpoch && this.status === "started") {
          this.previewContinuationEpoch = undefined
          this.finish("canceled")
        }
        return Promise.reject(previewFinalizationError)
      }
    }

    this.scheduleProgress(epoch, false)
    if (!this.previewContinuationCurrent(continuation)) {
      if (epoch === this.visitEpoch && this.status === "started") {
        this.previewContinuationEpoch = undefined
        this.finish("canceled")
      }
      return Promise.resolve(canceled)
    }

    const revalidation = this.startVisit(
      source,
      navigation,
      undefined,
      undefined,
      undefined,
      action,
      undefined,
      undefined,
      continuation,
    ).catch((error: unknown) => {
      if (epoch !== this.visitEpoch) return canceled
      throw error
    })
    if (!previewFinalizationError) return revalidation
    return revalidation.then(
      () => {
        throw previewFinalizationError
      },
      (error: unknown) => {
        throw error
      },
    )
  }

  private startRestoreVisit(
    source: string,
    navigation: NavigationAdapter | undefined,
    historyPlan: DocumentVisitHistoryPlan,
    documentClaimSerial: number,
    treeGeneration: number,
    attemptEpoch: number,
  ): Promise<DocumentVisitResult> {
    const restoreEpoch = this.visitEpoch
    const cache = this.snapshotCache
    if (!cache) {
      return this.startVisit(
        source,
        navigation,
        undefined,
        historyPlan,
        undefined,
        "restore",
        restoreEpoch,
        attemptEpoch,
        undefined,
        documentClaimSerial,
        treeGeneration,
      )
    }

    let epoch: number | undefined
    try {
      const report = this.loader.restoreSnapshot(cache, source, this.requestOwner, {
        beforeClaim: () => {
          this.assertAttemptEpoch(attemptEpoch)
          this.assertRestoreEpoch(restoreEpoch)
          this.assertDocumentClaimSerial(documentClaimSerial)
          this.assertTreeGeneration(treeGeneration)
          this.assertHistoryPlan(historyPlan)
          return undefined
        },
        beforeTreeCommit: () => {
          this.assertHistoryPlan(historyPlan)
          this.loader.captureCurrentSnapshot(cache)
          this.assertHistoryPlan(historyPlan)
          historyPlan.history.commitProposal(historyPlan.proposal)
        },
        onRestoreStart: () => {
          this.assertAttemptEpoch(attemptEpoch)
          this.assertRestoreEpoch(restoreEpoch)
          this.assertHistoryPlan(historyPlan)
          this.previewContinuationEpoch = undefined
          epoch = ++this.visitEpoch
          this.progressVisible = false
          this.status = "started"
          this.publish()
          this.notifyVisit(source, "restore", epoch)
          return undefined
        },
      })
      if (report.status === "miss") {
        this.assertRestoreEpoch(restoreEpoch)
        this.assertDocumentClaimSerial(documentClaimSerial)
        this.assertTreeGeneration(treeGeneration)
        return this.startVisit(
          source,
          navigation,
          cache,
          historyPlan,
          undefined,
          "restore",
          restoreEpoch,
          attemptEpoch,
          undefined,
          documentClaimSerial,
          treeGeneration,
        )
      }
      if (epoch !== undefined && epoch === this.visitEpoch && this.status === "started") {
        this.finish(report.status === "committed" ? "completed" : "canceled")
      }
      return Promise.resolve(
        Object.freeze({
          source: "snapshot" as const,
          status: report.status === "committed" ? ("restored" as const) : ("canceled" as const),
          url: report.url,
        }),
      )
    } catch (error) {
      const reported =
        error instanceof Error ? error : new StateError("Document restore visit failed")
      if (epoch !== undefined && epoch === this.visitEpoch && this.status === "started") {
        this.finish(error instanceof DocumentSnapshotRestoreCommitError ? "completed" : "failed")
        this.notifyError(reported)
      }
      return Promise.reject(reported)
    }
  }

  private startVisit(
    source: string,
    navigation?: NavigationAdapter,
    snapshotCache?: DocumentSnapshotCache,
    initialHistoryPlan?: DocumentVisitHistoryPlan,
    historyGuard?: DocumentVisitHistoryGuard,
    action: VisitAction = "advance",
    restoreEpoch?: number,
    attemptEpoch?: number,
    continuation?: DocumentPreviewContinuation,
    expectedDocumentClaimSerial?: number,
    expectedTreeGeneration?: number,
    eventAction?: VisitAction,
  ): Promise<DocumentVisitResult> {
    let epoch: number | undefined = continuation?.epoch
    let historyPlan = initialHistoryPlan
    let continuationHistoryPlan: DocumentVisitHistoryPlan | undefined
    let redirect: TopLevelLocationDisposition | undefined
    let redirectDelegation: RequestOperationResult<DocumentVisitDelegation> | undefined
    let redirectFollowupUrl: string | undefined
    const loaded = this.loader.load(source, this.requestOwner, {
      ...((historyGuard?.kind === "traversal" ||
        historyPlan ||
        attemptEpoch !== undefined ||
        continuation ||
        expectedDocumentClaimSerial !== undefined ||
        expectedTreeGeneration !== undefined) && {
        beforeClaim: () => {
          if (attemptEpoch !== undefined) this.assertAttemptEpoch(attemptEpoch)
          if (continuation) this.assertPreviewContinuation(continuation, "pending")
          if (expectedDocumentClaimSerial !== undefined) {
            this.assertDocumentClaimSerial(expectedDocumentClaimSerial)
          }
          if (expectedTreeGeneration !== undefined) {
            this.assertTreeGeneration(expectedTreeGeneration)
          }
          if (restoreEpoch !== undefined) this.assertRestoreEpoch(restoreEpoch)
          if (
            historyGuard?.kind === "traversal" &&
            historyGuard.traversalEpoch !== this.traversalEpoch
          ) {
            throw new StateError("Document traversal request was superseded before ownership")
          }
          if (historyPlan) this.assertHistoryPlan(historyPlan)
          return undefined
        },
      }),
      beforeCommit: (candidate) => {
        if (continuation) this.assertPreviewContinuation(continuation, "claimed")
        if (action === "restore" && candidate.url.includes("#")) {
          throw new TargetError("Document restore fragments require anchor restoration support")
        }
        if (
          historyGuard?.kind === "traversal" &&
          historyGuard.traversalEpoch !== this.traversalEpoch
        ) {
          throw new StateError("Document traversal response was superseded")
        }
        if (
          historyGuard?.kind === "traversal" &&
          (historyGuard.history.current !== historyGuard.entry ||
            candidate.redirected ||
            candidate.url !== historyGuard.entry.url)
        ) {
          throw new StateError("Document traversal response no longer matches host history")
        }
        if (candidate.redirected && candidate.classification === "success") {
          const disposition = this.redirectDisposition(candidate)
          if (disposition.classification !== "visitable") {
            if (action === "restore") {
              throw new TargetError("Document restore redirects require a root-visitable location")
            }
            redirect = disposition
            return "discard"
          }
          if (candidate.status === "committed") redirectFollowupUrl = candidate.url
        }
        if (
          candidate.status === "committed" &&
          historyPlan &&
          candidate.url !== historyPlan.proposal.entry.url
        ) {
          historyPlan = {
            base: historyPlan.base,
            history: historyPlan.history,
            proposal: historyPlan.history.retargetProposal(historyPlan.proposal, candidate.url),
          }
        }
        if (
          candidate.status === "committed" &&
          continuation?.history &&
          continuation.historyEntry &&
          candidate.url !== continuation.historyEntry.url
        ) {
          continuationHistoryPlan = {
            base: continuation.historyEntry,
            history: continuation.history,
            proposal: continuation.history.proposeReplace(candidate.url),
          }
          this.assertPreviewContinuation(continuation, "claimed")
        }
        return "commit"
      },
      ...((snapshotCache || historyPlan || historyGuard || continuation) && {
        beforeTreeCommit: (candidate: DocumentTreeCommitCandidate) => {
          if (continuation) this.assertPreviewContinuation(continuation, "claimed")
          if (
            historyGuard?.kind === "traversal" &&
            historyGuard.traversalEpoch !== this.traversalEpoch
          ) {
            throw new StateError("Document traversal response was superseded")
          }
          if (
            historyGuard &&
            (historyGuard.history.current !== historyGuard.entry ||
              candidate.url !== historyGuard.entry.url)
          ) {
            throw new StateError("Document history changed during the current-document refresh")
          }
          if (historyPlan) this.assertHistoryPlan(historyPlan)
          if (historyPlan && historyPlan.proposal.entry.url !== candidate.url) {
            throw new StateError("Document history proposal no longer matches the commit candidate")
          }
          if (continuationHistoryPlan) this.assertHistoryPlan(continuationHistoryPlan)
          if (
            continuationHistoryPlan &&
            continuationHistoryPlan.proposal.entry.url !== candidate.url
          ) {
            throw new StateError(
              "Document preview redirect proposal no longer matches the commit candidate",
            )
          }
          if (snapshotCache) this.loader.captureCurrentSnapshot(snapshotCache)
          if (
            historyGuard?.kind === "traversal" &&
            historyGuard.traversalEpoch !== this.traversalEpoch
          ) {
            throw new StateError("Document traversal response was superseded")
          }
          if (historyGuard && historyGuard.history.current !== historyGuard.entry) {
            throw new StateError(
              historyGuard.kind === "traversal"
                ? "Document history changed during traversal restoration"
                : "Document history changed during the current-document refresh",
            )
          }
          if (historyPlan) this.assertHistoryPlan(historyPlan)
          if (historyPlan) historyPlan.history.commitProposal(historyPlan.proposal)
          if (continuationHistoryPlan) {
            continuationHistoryPlan.history.commitProposal(continuationHistoryPlan.proposal)
          }
        },
      }),
      onRequestStart: () => {
        if (continuation) {
          this.assertPreviewContinuation(continuation, "claimed")
          this.previewContinuationEpoch = undefined
          return undefined
        }
        if (
          historyGuard?.kind === "traversal" &&
          historyGuard.traversalEpoch !== this.traversalEpoch
        ) {
          throw new StateError("Document traversal request was superseded before starting")
        }
        this.previewContinuationEpoch = undefined
        epoch = ++this.visitEpoch
        this.progressVisible = false
        this.status = "started"
        this.publish()
      },
      ...(this.visitLifecycle && !continuation
        ? {
            [DOCUMENT_LOAD_REQUEST_DISPATCHED]: () => {
              if (epoch === undefined) {
                throw new StateError("Document request dispatched without a visit lifecycle")
              }
              this.notifyVisit(source, eventAction ?? action, epoch)
              return undefined
            },
          }
        : {}),
      ...({
        [DOCUMENT_LOAD_DISCARD_HANDLING]: async (controller) => {
          const disposition = redirect
          if (
            !disposition ||
            disposition.classification === "external" ||
            disposition.classification === "visitable"
          ) {
            return undefined
          }
          const generation = this.loader.treeState.generation
          const unsubscribe = this.loader.subscribeTreeState(() => {
            if (this.loader.treeState.generation !== generation) controller.abort()
          })
          try {
            if (this.loader.treeState.generation !== generation) controller.abort()
            redirectDelegation = await settleRequestOperation(controller.signal, () =>
              this.delegateNavigation(disposition, "replace", navigation, controller.signal),
            )
          } finally {
            unsubscribe()
          }
          return undefined
        },
      } satisfies DocumentVisitLoadOptions),
    } satisfies DocumentVisitLoadOptions)
    if (!continuation && epoch !== undefined) this.scheduleProgress(epoch, false)

    return loaded.then(
      async (report): Promise<DocumentVisitResult> => {
        if (epoch === undefined || epoch !== this.visitEpoch) return report
        if (
          redirectFollowupUrl &&
          report.status === "committed" &&
          report.classification === "success" &&
          report.redirected
        ) {
          this.notifyVisit(redirectFollowupUrl, "replace", epoch)
          if (epoch !== this.visitEpoch || this.status !== "started") return report
        }
        if (report.status === "discarded") {
          if (
            !redirect ||
            redirect.classification === "external" ||
            redirect.classification === "visitable"
          ) {
            const error = new RequestError("Discarded document redirect has no delegation target", {
              method: "GET",
              responseStatus: report.responseStatus,
            })
            this.finish("failed")
            this.notifyError(error)
            throw error
          }
          const delegated = redirectDelegation
          if (!delegated) {
            const error = new RequestError("Discarded document redirect was not delegated", {
              method: "GET",
              responseStatus: report.responseStatus,
            })
            this.finish("failed")
            this.notifyError(error)
            throw error
          }
          if (
            delegated.status === "canceled" ||
            epoch !== this.visitEpoch ||
            this.status !== "started"
          ) {
            return report
          }
          if (delegated.status === "rejected") {
            const reported =
              delegated.error instanceof Error
                ? delegated.error
                : new RequestError("Document redirect delegation failed")
            this.finish("failed")
            this.notifyError(reported)
            throw reported
          }
          this.finish("completed")
          return delegated.value
        }
        if (report.status === "canceled" || report.status === "prevented") this.finish("canceled")
        else this.finish(report.classification === "success" ? "completed" : "failed")
        return report
      },
      (error: unknown) => {
        const reported = error instanceof Error ? error : new RequestError("Document visit failed")
        if (
          redirectFollowupUrl &&
          epoch !== undefined &&
          epoch === this.visitEpoch &&
          error instanceof DocumentCommitError &&
          error.outcome.classification === "success" &&
          error.outcome.redirected
        ) {
          this.notifyVisit(redirectFollowupUrl, "replace", epoch)
        }
        if (
          continuation &&
          epoch !== undefined &&
          epoch === this.visitEpoch &&
          this.status === "started" &&
          this.previewContinuationEpoch === epoch &&
          !this.previewContinuationCurrent(continuation)
        ) {
          this.finish("canceled")
          return Object.freeze({
            source: "preview" as const,
            status: "canceled" as const,
            url: continuation.url,
          })
        }
        if (epoch !== undefined && epoch === this.visitEpoch) {
          const status =
            error instanceof DocumentCommitError && error.outcome.classification === "success"
              ? "completed"
              : "failed"
          this.finish(status)
          if (!requestLifecycleDefaultHandlingPrevented(error)) this.notifyError(reported)
        }
        throw reported
      },
    )
  }

  private proposeHistory(action: VisitAction, url: string): DocumentVisitHistoryPlan | undefined {
    const guard = this.captureHistoryGuard(this.loader.currentUrl, "refresh")
    if (!guard) {
      if (action === "replace") {
        throw new TargetError("Document replace visits require configured history")
      }
      if (action === "restore") {
        throw new TargetError("Document restore visits require configured history")
      }
      return undefined
    }
    const proposal =
      action === "replace" ? guard.history.proposeReplace(url) : guard.history.proposeAdvance(url)
    if (
      guard.history.current !== guard.entry ||
      this.canonicalDocumentUrl(this.loader.currentUrl) !== guard.entry.url
    ) {
      throw new StateError("Document history or the active document changed during visit planning")
    }
    return { base: guard.entry, history: guard.history, proposal }
  }

  private validateHistoryAction(action: VisitAction): void {
    const guard = this.captureHistoryGuard(this.loader.currentUrl, "refresh")
    if (guard) return
    if (action === "replace") {
      throw new TargetError("Document replace visits require configured history")
    }
    if (action === "restore") {
      throw new TargetError("Document restore visits require configured history")
    }
  }

  private beforeVisit(url: string): DocumentBeforeVisitCanceledResult | undefined {
    const lifecycle = this.visitLifecycle
    if (!lifecycle) return undefined
    const event = lifecycle[DOCUMENT_VISIT_LIFECYCLE_BEFORE_DISPATCH](new BeforeVisitEvent(url))
    return event.defaultPrevented ? this.beforeVisitCanceled(url) : undefined
  }

  private beforeVisitCanceled(url: string): DocumentBeforeVisitCanceledResult {
    return Object.freeze({
      source: "visit-lifecycle",
      status: "canceled",
      url,
    })
  }

  private notifyVisit(url: string, action: VisitAction, epoch: number): void {
    if (!this.visitLifecycle || epoch !== this.visitEpoch || this.status !== "started") {
      return
    }
    this.visitLifecycle[DOCUMENT_VISIT_LIFECYCLE_VISIT_DISPATCH](new VisitEvent(url, action))
  }

  private assertHistoryPlan(plan: DocumentVisitHistoryPlan): void {
    if (
      plan.history.current !== plan.base ||
      this.canonicalDocumentUrl(this.loader.currentUrl) !== plan.base.url
    ) {
      throw new StateError("Document history or the active document changed during the visit")
    }
  }

  private assertAttemptEpoch(epoch: number): void {
    if (epoch !== this.attemptEpoch) {
      throw new StateError("Document visit attempt was superseded before ownership")
    }
  }

  private assertDocumentClaimSerial(serial: number): void {
    if (this.loader.documentClaimSerial !== serial) {
      throw new StateError("Document destination ownership changed before the visit could claim it")
    }
  }

  private assertTreeGeneration(generation: number): void {
    if (this.loader.treeState.generation !== generation) {
      throw new StateError("Document tree changed before the visit could claim it")
    }
  }

  private assertPreviewContinuation(
    continuation: DocumentPreviewContinuation,
    phase: "claimed" | "pending" = "pending",
  ): void {
    const treeState = this.loader.treeState
    const expectedClaimSerial = continuation.documentClaimSerial + (phase === "claimed" ? 1 : 0)
    if (
      continuation.epoch !== this.visitEpoch ||
      this.status !== "started" ||
      this.loader.documentClaimSerial !== expectedClaimSerial ||
      treeState.generation !== continuation.generation ||
      !treeState.preview ||
      this.canonicalDocumentUrl(this.loader.currentUrl) !== continuation.url
    ) {
      throw new StateError("Document preview revalidation was superseded")
    }
    if (
      continuation.history &&
      (!continuation.historyEntry ||
        continuation.history.current !== continuation.historyEntry ||
        continuation.historyEntry.url !== continuation.url)
    ) {
      throw new StateError("Document preview history changed before revalidation")
    }
  }

  private previewContinuationCurrent(continuation: DocumentPreviewContinuation): boolean {
    try {
      this.assertPreviewContinuation(continuation)
      return true
    } catch {
      return false
    }
  }

  private assertRestoreEpoch(epoch: number): void {
    if (epoch !== this.visitEpoch) {
      throw new StateError("Document restore visit was superseded before ownership")
    }
  }

  private captureHistoryGuard(
    url: string | undefined,
    kind: DocumentVisitHistoryGuard["kind"],
  ): DocumentVisitHistoryGuard | undefined {
    const history = this.history
    if (!history) return undefined
    const entry = history.current
    if (!entry || this.canonicalDocumentUrl(url) !== entry.url) {
      throw new StateError("Document history must match the active document before a visit")
    }
    return { entry, history, kind }
  }

  private canonicalDocumentUrl(url: string | undefined): string | undefined {
    if (!url) return undefined
    try {
      return resolveProtocolUrl(url, url).url
    } catch {
      throw new StateError("Active document history requires a valid credential-free HTTP(S) URL")
    }
  }

  private reconcileTraversal(entry: DocumentHistoryEntry): void {
    if (this.traversalEntry !== entry) return
    const current = this.history?.current
    if (!current) return
    this.traversalEntry =
      this.canonicalDocumentUrl(this.loader.currentUrl) === current.url ? undefined : current
  }

  private delegateInitial(
    disposition: Exclude<TopLevelLocationDisposition, { classification: "visitable" }>,
    action: VisitAction,
    navigation: NavigationAdapter | undefined,
  ): Promise<DocumentVisitDelegation> {
    if (disposition.classification === "external") {
      if (!navigation) {
        return Promise.reject(new TargetError("External document visits require navigation"))
      }
      return Promise.resolve()
        .then(() => navigation.openExternal(disposition.url))
        .then(() =>
          Object.freeze({
            kind: "external",
            reason: "external",
            status: "delegated",
            url: disposition.url,
          }),
        )
    }
    return this.delegateNavigation(disposition, action, navigation)
  }

  private delegateNavigation(
    disposition: Extract<
      TopLevelLocationDisposition,
      { classification: "outside-root" | "unvisitable-extension" }
    >,
    action: VisitAction,
    navigation: NavigationAdapter | undefined,
    signal?: AbortSignal,
  ): Promise<DocumentVisitDelegation> {
    if (!navigation) {
      return Promise.reject(new TargetError("Unvisitable document visits require navigation"))
    }
    return Promise.resolve()
      .then(() => (signal?.aborted ? undefined : navigation.visit(disposition.url, action)))
      .then(() =>
        Object.freeze({
          action,
          kind: "navigation",
          reason: disposition.classification,
          status: "delegated",
          url: disposition.url,
        }),
      )
  }

  private redirectDisposition(candidate: DocumentCommitCandidate): TopLevelLocationDisposition {
    return classifyTopLevelLocationAgainstRoot(candidate.url, candidate.url, candidate.rootLocation)
  }

  private clearProgress(): void {
    const handle = this.progressHandle
    this.progressHandle = undefined
    if (handle !== undefined) this.clearProgressHandle(handle)
  }

  private clearProgressHandle(handle: unknown): void {
    try {
      this.clock.clearTimeout(handle)
    } catch {
      this.notifyError(new StateError("Document visit progress timer cleanup failed"))
    }
  }

  private scheduleProgress(epoch: number, publish: boolean): void {
    if (epoch !== this.visitEpoch || this.status !== "started") return
    this.clearProgress()
    if (epoch !== this.visitEpoch || this.status !== "started") return
    let progressHandle: unknown
    try {
      progressHandle = this.clock.setTimeout(() => {
        if (epoch !== this.visitEpoch || this.status !== "started") return
        this.progressHandle = undefined
        this.progressVisible = true
        this.publish()
      }, this.progressDelayMs)
    } catch {
      this.notifyError(new StateError("Document visit progress timer setup failed"))
      if (publish && epoch === this.visitEpoch && this.status === "started") this.publish()
      return
    }
    if (epoch !== this.visitEpoch || this.status !== "started") {
      this.clearProgressHandle(progressHandle)
      return
    }
    this.progressHandle = progressHandle
    if (publish) this.publish()
  }

  private createSnapshot(): DocumentVisitSnapshot {
    return Object.freeze({
      busy: this.status === "started",
      previewVisible: this.loader.treeState.preview,
      progressVisible: this.status === "started" && this.progressVisible,
      revision: this.revision,
      status: this.status,
    })
  }

  private syncTreeState(): void {
    if (this.snapshot.previewVisible === this.loader.treeState.preview) return
    this.revision += 1
    this.snapshot = this.createSnapshot()
  }

  private finish(status: Extract<DocumentVisitStatus, "canceled" | "completed" | "failed">): void {
    if (this.status !== "started") return
    const epoch = this.visitEpoch
    this.clearProgress()
    if (epoch !== this.visitEpoch || this.status !== "started") return
    if (this.previewContinuationEpoch === epoch) this.previewContinuationEpoch = undefined
    this.progressVisible = false
    this.status = status
    this.publish()
  }

  private publish(): void {
    this.revision += 1
    this.snapshot = this.createSnapshot()
    const errors: unknown[] = []
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length > 0) {
      this.reportObserverErrors(errors, "Document visit listener failed")
    }
  }

  private notifyError(error: Error): void {
    const errors: unknown[] = []
    for (const listener of [...this.errorListeners]) {
      try {
        listener(error)
      } catch (observerError) {
        errors.push(observerError)
      }
    }
    if (errors.length > 0) {
      this.reportObserverErrors(errors, "Document visit error observer failed")
    }
  }

  private reportObserverErrors(errors: readonly unknown[], message: string): void {
    const reported = new AggregateError(errors, message)
    if (!this.onObserverError) {
      queueMicrotask(() => {
        throw reported
      })
      return
    }
    try {
      this.onObserverError(reported)
    } catch (reporterError) {
      const terminal = new AggregateError(
        [reported, reporterError],
        "Document visit observer reporter failed",
      )
      queueMicrotask(() => {
        throw terminal
      })
    }
  }
}

function documentVisitControllerOptions(options: unknown): AdmittedDocumentVisitControllerOptions {
  try {
    if (!options || typeof options !== "object" || Array.isArray(options)) {
      throw new TypeError("invalid options")
    }
    const candidate = options as DocumentVisitControllerOptions
    return {
      history: candidate.history,
      onObserverError: candidate.onObserverError,
      progressDelayMs: candidate.progressDelayMs,
      snapshotCache: candidate.snapshotCache,
      visitLifecycle: candidate.visitLifecycle,
    }
  } catch {
    throw new PropsError("Document visit controller options could not be read")
  }
}
