import type { DocumentScrollPosition } from "../core/document-history"
import type { DocumentVisitStatus } from "../core/document-visit-controller"
import type { FormSubmissionTerminalSnapshot } from "../core/form-submission-activity"
import type { ProtocolInspectorAdapter } from "../core/inspector"
import type { StyleAdapter } from "./styles"

export type { DocumentHistoryHostAdapter } from "../core/document-history"
export type {
  DocumentHistoryTraversalSource,
  DocumentHistoryTraversalUnsubscribe,
} from "../core/document-history-traversal"
export * from "./action-cable-endpoint"
export * from "./action-cable-lifecycle"
export * from "./action-cable-websocket"
export * from "./action-cable-wire"
export * from "./styles"

export type Unsubscribe = () => void

/**
 * One host-owned file selected for a native multipart form. The public core
 * retains the immutable Blob reference and filename; the FetchAdapter turns
 * it into the platform's FormData representation immediately before fetch.
 */
export interface TurboMultipartFile {
  readonly blob: Blob
  readonly filename: string
}

export interface TurboMultipartEntry {
  readonly name: string
  readonly value: string | TurboMultipartFile
}

/**
 * Immutable semantic multipart payload. `byteLength` is the bounded logical
 * payload size (field UTF-8 bytes plus Blob bytes), not exact wire framing.
 * Adapters must not send a Content-Type header for this body: FormData owns
 * the boundary.
 */
export interface TurboMultipartBody {
  readonly byteLength: number
  readonly entries: readonly TurboMultipartEntry[]
  readonly kind: "multipart"
}

export type TurboRequestBodyValue = string | Uint8Array | TurboMultipartBody

export interface TurboRequestBody {
  readonly contentType?: string
  readonly value: TurboRequestBodyValue
}

export function isTurboMultipartBody(value: unknown): value is TurboMultipartBody {
  try {
    return (
      !!value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      (value as { readonly kind?: unknown }).kind === "multipart"
    )
  } catch {
    return false
  }
}

export interface TurboRequest {
  readonly body?: TurboRequestBody
  readonly headers: Readonly<Record<string, string>>
  readonly method: string
  readonly signal?: AbortSignal
  readonly url: string
}

export interface TurboResponse {
  readonly headers: Readonly<Record<string, string>>
  readonly redirected: boolean
  readonly status: number
  readonly url: string
  text(): Promise<string>
}

export interface FetchAdapter {
  fetch(request: TurboRequest): Promise<TurboResponse>
}

export interface FormConfirmationAdapter {
  confirm(message: string, signal: AbortSignal): boolean | Promise<boolean>
}

export type FormSubmissionAnnouncementTerminalSnapshot = Exclude<
  FormSubmissionTerminalSnapshot,
  Readonly<{ readonly revision: number; readonly status: "none" }>
>

export interface FormSubmissionAnnouncementEvent {
  readonly formNodeKey: string
  readonly terminalState: FormSubmissionAnnouncementTerminalSnapshot
}

/** Host-owned localized and platform-specific delivery for settled native forms. */
export interface FormSubmissionAnnouncementAdapter {
  announce(event: FormSubmissionAnnouncementEvent): void | Promise<void>
}

export type DocumentVisitAnnouncementStatus = Exclude<DocumentVisitStatus, "initialized">

export interface DocumentVisitAnnouncementEvent {
  readonly status: DocumentVisitAnnouncementStatus
}

/** Host-owned localized and platform-specific delivery for document visit state. */
export interface DocumentVisitAnnouncementAdapter {
  announce(event: DocumentVisitAnnouncementEvent): void | Promise<void>
}

export type VisitAction = "advance" | "replace" | "restore"

export interface NavigationAdapter {
  back(): void
  openExternal(url: string): void | Promise<void>
  visit(url: string, action: VisitAction): void | Promise<void>
}

export interface DocumentLinkBrowsingContextRequest {
  readonly target: string
  readonly url: string
}

export interface DocumentLinkDownloadRequest {
  readonly filename?: string
  readonly url: string
}

/**
 * Optional host-owned equivalents for browser link behavior that Turbo leaves
 * to the browser. React Native has no implicit browsing contexts or downloads,
 * so an authored `target` or `download` link is admitted only through this
 * explicit adapter.
 */
export interface DocumentLinkAdapter {
  download(request: DocumentLinkDownloadRequest): void | Promise<void>
  openBrowsingContext(request: DocumentLinkBrowsingContextRequest): void | Promise<void>
}

export interface CableCallbacks {
  connected(reconnected: boolean): void
  disconnected(willAttemptReconnect?: boolean): void
  received(message: string): PromiseLike<void> | void
  rejected(): void
}

export interface CableSubscription {
  unsubscribe(): void
}

export interface CableAdapter {
  subscribe(identifier: string, callbacks: CableCallbacks): CableSubscription
}

export type LifecycleState = "active" | "background" | "inactive"

export interface LifecycleAdapter {
  getState(): LifecycleState
  subscribe(listener: (state: LifecycleState) => void): Unsubscribe
}

export interface VisibilityAdapter {
  isVisible(id: string): boolean
  subscribe(id: string, listener: (visible: boolean) => void): Unsubscribe
}

export interface FocusAdapter {
  blur(id: string): void
  focus(id: string): void
  getFocusedId(): string | undefined
}

export interface AutofocusAdapter {
  canFocus(id: string): boolean
  focus(id: string): void
  /**
   * Optional logical-focus snapshot used by standalone Stream autofocus. A
   * returned id preserves existing host focus; `undefined` allows one admitted
   * autofocus attempt after the exact React commit.
   */
  getFocusedId?(): string | undefined
  /**
   * Optional logical-focus snapshot used to retain focus when native morphing
   * keeps a logical node but React must remount it under a different parent.
   */
  getMorphFocusedId?(): string | undefined
}

/**
 * Host-owned synchronous request to bring one autofocus candidate into the
 * mounted viewport. The renderer calls this immediately after native focus;
 * it does not infer scroll containers or wait for physical scroll completion.
 */
export interface AutofocusScrollAdapter {
  canScroll(id: string): boolean
  scrollTo(id: string): void
}

export type ScrollAlignment = "start" | "center" | "end" | "nearest"

export interface ScrollAdapter {
  scrollTo(id: string, alignment: ScrollAlignment): Promise<void> | void
}

/** Host-owned synchronous request for a same-document anchor scroll. */
export interface DocumentAnchorScrollAdapter {
  scrollTo(id: string, alignment: "start"): undefined
}

/** Host-owned synchronous admission for render-time document-link preloading. */
export interface DocumentAutomaticPreloadPolicy {
  canPreload(url: string): boolean
}

/** Host-owned synchronous admission for touch-native document-link prefetch. */
export interface DocumentPrefetchPolicy {
  canPrefetch(url: string): boolean
}

export type FrameAutoscrollBehavior = "auto" | "smooth"

export interface FrameAutoscrollRequest {
  readonly behavior: FrameAutoscrollBehavior
  readonly block: ScrollAlignment
  readonly frameId: string
}

/**
 * Host-owned scrolling for a mounted Frame boundary. A smooth request starts
 * here but does not delay subsequent autofocus or Frame lifecycle work.
 */
export interface FrameAutoscrollAdapter {
  canScroll(frameId: string): boolean
  scrollTo(request: FrameAutoscrollRequest): void
}

/** Host-owned reset for the mounted owning-document scroll container. */
export interface DocumentRefreshScrollAdapter {
  canReset(): boolean
  reset(): void
}

/** Host-owned restoration for the mounted owning-document scroll container. */
export interface DocumentHistoryScrollAdapter {
  canRestore(): boolean
  restore(position: DocumentScrollPosition): void
}

export interface StorageAdapter {
  delete(key: string): Promise<void>
  get(key: string): Promise<string | undefined>
  set(key: string, value: string): Promise<void>
}

export interface ObservabilityEvent {
  readonly code: string
  readonly details: Readonly<Record<string, boolean | number | string | undefined>>
  readonly level: "debug" | "info" | "warning" | "error"
}

export interface ObservabilityAdapter {
  report(event: ObservabilityEvent): void
}

export interface ClockAdapter {
  clearTimeout(handle: unknown): void
  now(): number
  setTimeout(callback: () => void, delayMs: number): unknown
}

export interface RequestIdAdapter {
  next(): string
}

export interface RestorationIdentifierAdapter {
  next(): string
}

export interface ExpoTurboAdapters<TStyle = unknown> {
  readonly autofocus?: AutofocusAdapter
  readonly autofocusScroll?: AutofocusScrollAdapter
  readonly cable: CableAdapter
  readonly clock: ClockAdapter
  readonly confirmation?: FormConfirmationAdapter
  readonly documentAnnouncements?: DocumentVisitAnnouncementAdapter
  readonly documentHistoryScroll?: DocumentHistoryScrollAdapter
  readonly documentRefreshScroll?: DocumentRefreshScrollAdapter
  readonly fetch: FetchAdapter
  readonly focus: FocusAdapter
  readonly frameAutoscroll?: FrameAutoscrollAdapter
  readonly formAnnouncements?: FormSubmissionAnnouncementAdapter
  readonly inspector?: ProtocolInspectorAdapter
  readonly lifecycle: LifecycleAdapter
  readonly navigation: NavigationAdapter
  readonly observability: ObservabilityAdapter
  readonly requestIds: RequestIdAdapter
  readonly scroll: ScrollAdapter
  readonly storage: StorageAdapter
  readonly styles: StyleAdapter<TStyle>
  readonly visibility: VisibilityAdapter
}
