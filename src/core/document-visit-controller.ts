import type { ClockAdapter } from "../adapters"
import {
  DocumentCommitError,
  type DocumentLoadReport,
  type DocumentRequestLoader,
} from "./document-loader"
import { RequestError } from "./errors"

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

  visit(source: string): Promise<DocumentLoadReport> {
    let admittedSource: string
    try {
      admittedSource = this.loader.resolveSource(source)
    } catch (error) {
      return Promise.reject(error)
    }

    const epoch = ++this.visitEpoch
    this.loader.cancel(this.requestOwner)
    this.clearProgress()
    this.progressVisible = false
    this.status = "started"
    const loaded = this.loader.load(admittedSource, this.requestOwner)
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
      (report) => {
        if (epoch !== this.visitEpoch) return report
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
