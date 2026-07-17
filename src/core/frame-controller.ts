import type { Unsubscribe, VisibilityAdapter } from "../adapters"
import { FrameMissingError } from "./errors"
import type { FrameLoadReport, FrameRequestLoader } from "./frame-loader"
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

export class FrameController {
  private readonly errorListeners = new Set<FrameControllerErrorListener>()
  private readonly listeners = new Set<FrameControllerListener>()
  private connected = false
  private hasBeenLoaded = false
  private loadEpoch = 0
  private needsLoad: boolean
  private revision = 0
  private snapshot!: FrameControllerSnapshot
  private status: FrameControllerStatus = "idle"
  private loadedPromise: Promise<FrameLoadReport | undefined> = Promise.resolve(undefined)
  private visibilityUnsubscribe: Unsubscribe | undefined

  constructor(
    private readonly session: DocumentSession,
    readonly frameId: string,
    private readonly loader: FrameRequestLoader,
    private readonly visibility?: VisibilityAdapter,
  ) {
    this.needsLoad = this.source !== undefined
    this.snapshot = this.createSnapshot()
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
    const wasLoading = this.status === "loading"
    this.connected = false
    this.stopVisibilityObserver()
    this.cancel()
    if (!wasLoading) this.publish()
  }

  cancel(): void {
    this.loadEpoch += 1
    this.loader.cancel(this.frameId)
    if (this.status === "loading") {
      this.needsLoad = true
      this.status = "canceled"
      this.publish()
    }
  }

  load(): Promise<FrameLoadReport | undefined> {
    return this.loadSourceIfNeeded(true)
  }

  reload(): Promise<FrameLoadReport | undefined> {
    this.needsLoad = this.source !== undefined
    return this.loadSourceIfNeeded(true)
  }

  setDisabled(disabled: boolean): Promise<FrameLoadReport | undefined> {
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
    this.session.setAttribute(this.frame.key, "loading", style)
    this.publish()
    if (style === "eager") {
      this.stopVisibilityObserver()
      return this.loadSourceIfNeeded(false)
    }
    return this.loadLazySourceIfVisible()
  }

  setSource(source?: string | null): Promise<FrameLoadReport | undefined> {
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

  private get frame(): ProtocolElement {
    const frame = this.session.tree.getElementById(this.frameId)
    if (frame?.kind !== "frame") {
      throw new FrameMissingError(`Active frame ${JSON.stringify(this.frameId)} is missing`, {
        frameId: this.frameId,
      })
    }
    return frame
  }

  private loadSourceIfNeeded(force: boolean): Promise<FrameLoadReport | undefined> {
    const frame = this.frame
    const source = attributeValue(frame, "src")
    const disabled = attributeValue(frame, "disabled") !== undefined
    if (!this.connected || disabled || !source || (!force && !this.needsLoad)) {
      return Promise.resolve(undefined)
    }

    const epoch = ++this.loadEpoch
    this.stopVisibilityObserver()
    this.needsLoad = false
    this.status = "loading"
    this.publish()
    const loaded = this.loader.load(this.frameId, source).then(
      (report) => {
        if (epoch !== this.loadEpoch) return report
        this.status = report.status
        if (report.status === "completed" || report.status === "empty") {
          this.hasBeenLoaded = true
          this.needsLoad = false
        } else {
          this.needsLoad = true
        }
        this.publish()
        return report
      },
      (error: unknown) => {
        const reported = error instanceof Error ? error : new Error("Frame source load failed")
        if (epoch === this.loadEpoch) {
          this.needsLoad = true
          this.status = "error"
          this.publish()
          for (const listener of this.errorListeners) listener(reported)
        }
        throw reported
      },
    )
    this.loadedPromise = loaded
    return loaded
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
        void this.loadSourceIfNeeded(false).catch(() => undefined)
      })
      this.visibilityUnsubscribe = unsubscribe
      if (!this.needsLoad) this.stopVisibilityObserver()
    }
    return this.visibility.isVisible(this.frameId)
      ? this.loadSourceIfNeeded(false)
      : Promise.resolve(undefined)
  }

  private stopVisibilityObserver(): void {
    this.visibilityUnsubscribe?.()
    this.visibilityUnsubscribe = undefined
  }

  private createSnapshot(): FrameControllerSnapshot {
    const frame = this.session.tree.getElementById(this.frameId)
    if (frame?.kind !== "frame") {
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
    this.snapshot = this.createSnapshot()
    for (const listener of this.listeners) listener()
  }
}
