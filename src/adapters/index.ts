import type { DocumentScrollPosition } from "../core/document-history"
import type { FormSubmissionTerminalSnapshot } from "../core/form-submission-activity"
import type { ProtocolInspectorAdapter } from "../core/inspector"
import type { StyleAdapter } from "./styles"

export type { DocumentHistoryHostAdapter } from "../core/document-history"
export type {
  DocumentHistoryTraversalSource,
  DocumentHistoryTraversalUnsubscribe,
} from "../core/document-history-traversal"
export * from "./styles"

export type Unsubscribe = () => void

export interface TurboRequestBody {
  readonly contentType?: string
  readonly value: string | Uint8Array
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

export type VisitAction = "advance" | "replace" | "restore"

export interface NavigationAdapter {
  back(): void
  openExternal(url: string): void | Promise<void>
  visit(url: string, action: VisitAction): void | Promise<void>
}

export interface CableCallbacks {
  connected(reconnected: boolean): void
  disconnected(): void
  received(message: string): void
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
   * Optional logical-focus snapshot used by standalone Stream messages. A
   * returned id preserves existing host focus; `undefined` allows one stream
   * autofocus attempt after the exact React commit.
   */
  getFocusedId?(): string | undefined
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
  readonly cable: CableAdapter
  readonly clock: ClockAdapter
  readonly confirmation?: FormConfirmationAdapter
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
