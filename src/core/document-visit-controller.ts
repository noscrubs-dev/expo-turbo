import type { ClockAdapter, NavigationAdapter, VisitAction } from "../adapters"
import type {
  DocumentHistory,
  DocumentHistoryEntry,
  DocumentHistoryProposal,
} from "./document-history"
import {
  type DocumentCommitCandidate,
  DocumentCommitError,
  type DocumentLoadReport,
  type DocumentRequestLoader,
  type DocumentTreeCommitCandidate,
} from "./document-loader"
import type { DocumentSnapshotCache } from "./document-snapshot-cache"
import { RequestError, StateError, TargetError } from "./errors"
import { resolveProtocolUrl } from "./protocol-request"
import {
  classifyTopLevelLocationAgainstRoot,
  type TopLevelLocationDisposition,
} from "./visitability"

export const DOCUMENT_VISIT_PROGRESS_DELAY_MS = 500

export type DocumentVisitStatus = "canceled" | "completed" | "failed" | "initialized" | "started"

export interface DocumentVisitSnapshot {
  readonly busy: boolean
  readonly progressVisible: boolean
  readonly revision: number
  readonly status: DocumentVisitStatus
}

export interface DocumentVisitControllerOptions {
  readonly history?: DocumentHistory
  readonly onObserverError?: (error: AggregateError) => void
  readonly progressDelayMs?: number
  readonly snapshotCache?: DocumentSnapshotCache
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

export type DocumentVisitResult = DocumentLoadReport | DocumentVisitDelegation

export type DocumentVisitListener = () => void
export type DocumentVisitErrorListener = (error: Error) => void

interface DocumentVisitHistoryPlan {
  readonly history: DocumentHistory
  readonly proposal: DocumentHistoryProposal
}

interface DocumentVisitHistoryGuard {
  readonly entry: DocumentHistoryEntry
  readonly history: DocumentHistory
}

export class DocumentVisitController {
  private readonly errorListeners = new Set<DocumentVisitErrorListener>()
  private readonly history: DocumentHistory | undefined
  private readonly listeners = new Set<DocumentVisitListener>()
  private readonly onObserverError: ((error: AggregateError) => void) | undefined
  private readonly progressDelayMs: number
  private readonly requestOwner = Object.freeze({})
  private readonly snapshotCache: DocumentSnapshotCache | undefined
  private progressHandle: unknown
  private progressVisible = false
  private revision = 0
  private snapshot: DocumentVisitSnapshot
  private status: DocumentVisitStatus = "initialized"
  private visitEpoch = 0

  constructor(
    private readonly loader: DocumentRequestLoader,
    private readonly clock: ClockAdapter,
    options: DocumentVisitControllerOptions = {},
  ) {
    this.history = options.history
    this.onObserverError = options.onObserverError
    this.progressDelayMs = options.progressDelayMs ?? DOCUMENT_VISIT_PROGRESS_DELAY_MS
    this.snapshotCache = options.snapshotCache
    if (!Number.isFinite(this.progressDelayMs) || this.progressDelayMs < 0) {
      throw new RequestError("Document visit progress delay must be a non-negative number")
    }
    this.snapshot = this.createSnapshot()
  }

  get state(): DocumentVisitSnapshot {
    return this.snapshot
  }

  visit(source: string, options: DocumentVisitOptions = {}): Promise<DocumentVisitResult> {
    const action = options.action ?? "advance"
    if (action !== "advance" && action !== "replace") {
      return Promise.reject(new TargetError("Document visit action is unsupported"))
    }
    let admission: TopLevelLocationDisposition
    let historyPlan: DocumentVisitHistoryPlan | undefined
    try {
      admission = this.loader.classifyTopLevelSource(source)
      if (admission.classification === "visitable") {
        historyPlan = this.proposeHistory(action, admission.url)
      }
    } catch (error) {
      return Promise.reject(error)
    }
    if (admission.classification !== "visitable") {
      return this.delegateInitial(admission, action, options.navigation)
    }

    return this.startVisit(admission.url, options.navigation, this.snapshotCache, historyPlan)
  }

  /**
   * Refreshes only when the captured URL still owns the idle active document.
   * This bypasses initial root visitability because Turbo refreshes current truth.
   */
  refreshCurrent(baseUrl: string): Promise<DocumentVisitResult | undefined> {
    if (this.status === "started") {
      return Promise.resolve(undefined)
    }
    let currentUrl: string | undefined
    let historyGuard: DocumentVisitHistoryGuard | undefined
    try {
      currentUrl = this.canonicalDocumentUrl(this.loader.currentUrl)
      if (!currentUrl || this.canonicalDocumentUrl(baseUrl) !== currentUrl) {
        return Promise.resolve(undefined)
      }
      historyGuard = this.captureHistoryGuard(currentUrl)
    } catch (error) {
      return Promise.reject(error)
    }
    return this.startVisit(currentUrl, undefined, undefined, undefined, historyGuard)
  }

  cancel(): void {
    if (this.status !== "started") return
    const epoch = this.visitEpoch
    if (!this.loader.cancel(this.requestOwner)) return
    if (epoch !== this.visitEpoch || this.status !== "started") return
    this.visitEpoch += 1
    this.finish("canceled")
  }

  subscribe(listener: DocumentVisitListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  subscribeErrors(listener: DocumentVisitErrorListener): () => void {
    this.errorListeners.add(listener)
    return () => this.errorListeners.delete(listener)
  }

  private startVisit(
    source: string,
    navigation?: NavigationAdapter,
    snapshotCache?: DocumentSnapshotCache,
    initialHistoryPlan?: DocumentVisitHistoryPlan,
    historyGuard?: DocumentVisitHistoryGuard,
  ): Promise<DocumentVisitResult> {
    let epoch: number | undefined
    let historyPlan = initialHistoryPlan
    let redirect: TopLevelLocationDisposition | undefined
    const loaded = this.loader.load(source, this.requestOwner, {
      beforeCommit: (candidate) => {
        if (candidate.redirected && candidate.classification === "success") {
          const disposition = this.redirectDisposition(candidate)
          if (disposition.classification !== "visitable") {
            redirect = disposition
            return "discard"
          }
        }
        if (
          candidate.status === "committed" &&
          historyPlan &&
          candidate.url !== historyPlan.proposal.entry.url
        ) {
          historyPlan = {
            history: historyPlan.history,
            proposal: historyPlan.history.retargetProposal(historyPlan.proposal, candidate.url),
          }
        }
        return "commit"
      },
      ...((snapshotCache || historyPlan || historyGuard) && {
        beforeTreeCommit: (candidate: DocumentTreeCommitCandidate) => {
          if (
            historyGuard &&
            (historyGuard.history.current !== historyGuard.entry ||
              candidate.url !== historyGuard.entry.url)
          ) {
            throw new StateError("Document history changed during the current-document refresh")
          }
          if (historyPlan && historyPlan.proposal.entry.url !== candidate.url) {
            throw new StateError("Document history proposal no longer matches the commit candidate")
          }
          if (snapshotCache) this.loader.captureCurrentSnapshot(snapshotCache)
          if (historyPlan) historyPlan.history.commitProposal(historyPlan.proposal)
        },
      }),
      onRequestStart: () => {
        epoch = ++this.visitEpoch
        this.progressVisible = false
        this.status = "started"
      },
    })
    if (epoch !== undefined && epoch === this.visitEpoch && this.status === "started") {
      this.clearProgress()
    }
    if (epoch !== undefined && epoch === this.visitEpoch && this.status === "started") {
      const progressHandle = this.clock.setTimeout(() => {
        if (epoch !== this.visitEpoch || this.status !== "started") return
        this.progressHandle = undefined
        this.progressVisible = true
        this.publish()
      }, this.progressDelayMs)
      if (epoch !== this.visitEpoch || this.status !== "started") {
        this.clock.clearTimeout(progressHandle)
      } else {
        this.progressHandle = progressHandle
        this.publish()
      }
    }

    return loaded.then(
      async (report): Promise<DocumentVisitResult> => {
        if (epoch === undefined || epoch !== this.visitEpoch) return report
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
          try {
            const result = await this.delegateNavigation(redirect, "replace", navigation)
            if (epoch === this.visitEpoch) this.finish("completed")
            return result
          } catch (error) {
            const reported =
              error instanceof Error
                ? error
                : new RequestError("Document redirect delegation failed")
            if (epoch === this.visitEpoch) {
              this.finish("failed")
              this.notifyError(reported)
            }
            throw reported
          }
        }
        if (report.status === "canceled") this.finish("canceled")
        else this.finish(report.classification === "success" ? "completed" : "failed")
        return report
      },
      (error: unknown) => {
        const reported = error instanceof Error ? error : new RequestError("Document visit failed")
        if (epoch !== undefined && epoch === this.visitEpoch) {
          const status =
            error instanceof DocumentCommitError && error.outcome.classification === "success"
              ? "completed"
              : "failed"
          this.finish(status)
          this.notifyError(reported)
        }
        throw reported
      },
    )
  }

  private proposeHistory(
    action: Exclude<VisitAction, "restore">,
    url: string,
  ): DocumentVisitHistoryPlan | undefined {
    const guard = this.captureHistoryGuard(this.loader.currentUrl)
    if (!guard) {
      if (action === "replace") {
        throw new TargetError("Document replace visits require configured history")
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
    return { history: guard.history, proposal }
  }

  private captureHistoryGuard(url: string | undefined): DocumentVisitHistoryGuard | undefined {
    const history = this.history
    if (!history) return undefined
    const entry = history.current
    if (!entry || this.canonicalDocumentUrl(url) !== entry.url) {
      throw new StateError("Document history must match the active document before a visit")
    }
    return { entry, history }
  }

  private canonicalDocumentUrl(url: string | undefined): string | undefined {
    if (!url) return undefined
    try {
      return resolveProtocolUrl(url, url).url
    } catch {
      throw new StateError("Active document history requires a valid credential-free HTTP(S) URL")
    }
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
  ): Promise<DocumentVisitDelegation> {
    if (!navigation) {
      return Promise.reject(new TargetError("Unvisitable document visits require navigation"))
    }
    return Promise.resolve()
      .then(() => navigation.visit(disposition.url, action))
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
    if (handle !== undefined) this.clock.clearTimeout(handle)
  }

  private createSnapshot(): DocumentVisitSnapshot {
    return Object.freeze({
      busy: this.status === "started",
      progressVisible: this.status === "started" && this.progressVisible,
      revision: this.revision,
      status: this.status,
    })
  }

  private finish(status: Extract<DocumentVisitStatus, "canceled" | "completed" | "failed">): void {
    if (this.status !== "started") return
    const epoch = this.visitEpoch
    this.clearProgress()
    if (epoch !== this.visitEpoch || this.status !== "started") return
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
