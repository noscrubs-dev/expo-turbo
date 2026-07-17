import type { ClockAdapter, NavigationAdapter, VisitAction } from "../adapters"
import {
  type DocumentCommitCandidate,
  DocumentCommitError,
  type DocumentLoadReport,
  type DocumentRequestLoader,
} from "./document-loader"
import { RequestError, TargetError } from "./errors"
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
  readonly onObserverError?: (error: AggregateError) => void
  readonly progressDelayMs?: number
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

export class DocumentVisitController {
  private readonly errorListeners = new Set<DocumentVisitErrorListener>()
  private readonly listeners = new Set<DocumentVisitListener>()
  private readonly onObserverError: ((error: AggregateError) => void) | undefined
  private readonly progressDelayMs: number
  private readonly requestOwner = Object.freeze({})
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
    this.onObserverError = options.onObserverError
    this.progressDelayMs = options.progressDelayMs ?? DOCUMENT_VISIT_PROGRESS_DELAY_MS
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
    if (action !== "advance") {
      return Promise.reject(
        new TargetError("Document replace and restore visits require history support"),
      )
    }
    let admission: TopLevelLocationDisposition
    try {
      admission = this.loader.classifyTopLevelSource(source)
    } catch (error) {
      return Promise.reject(error)
    }
    if (admission.classification !== "visitable") {
      return this.delegateInitial(admission, action, options.navigation)
    }

    const epoch = ++this.visitEpoch
    this.loader.cancel(this.requestOwner)
    this.clearProgress()
    this.progressVisible = false
    this.status = "started"
    let redirect: TopLevelLocationDisposition | undefined
    const loaded = this.loader.load(admission.url, this.requestOwner, {
      beforeCommit: (candidate) => {
        if (!candidate.redirected || candidate.classification !== "success") return "commit"
        const disposition = this.redirectDisposition(candidate)
        if (disposition.classification === "visitable") return "commit"
        redirect = disposition
        return "discard"
      },
    })
    if (epoch === this.visitEpoch && this.status === "started") {
      this.progressHandle = this.clock.setTimeout(() => {
        if (epoch !== this.visitEpoch || this.status !== "started") return
        this.progressHandle = undefined
        this.progressVisible = true
        this.publish()
      }, this.progressDelayMs)
      this.publish()
    }

    return loaded.then(
      async (report): Promise<DocumentVisitResult> => {
        if (epoch !== this.visitEpoch) return report
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
            const result = await this.delegateNavigation(redirect, "replace", options.navigation)
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
        if (epoch === this.visitEpoch) {
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

  cancel(): void {
    if (this.status !== "started") return
    this.visitEpoch += 1
    this.loader.cancel(this.requestOwner)
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
    if (this.progressHandle !== undefined) this.clock.clearTimeout(this.progressHandle)
    this.progressHandle = undefined
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
    this.clearProgress()
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
