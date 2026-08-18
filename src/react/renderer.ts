import bidiFactory from "bidi-js"
import {
  Component,
  type ComponentType,
  createContext,
  createElement,
  Fragment,
  type ReactNode,
  startTransition,
  useCallback,
  useContext,
  useEffect,
  useInsertionEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"

import type {
  AutofocusAdapter,
  AutofocusScrollAdapter,
  DocumentAnchorScrollAdapter,
  DocumentAutomaticPreloadPolicy,
  DocumentHistoryScrollAdapter,
  DocumentLinkAdapter,
  DocumentPrefetchPolicy,
  DocumentRefreshScrollAdapter,
  DocumentVisitAnnouncementAdapter,
  DocumentVisitAnnouncementEvent,
  FormSubmissionAnnouncementAdapter,
  FormSubmissionAnnouncementEvent,
  FormSubmissionAnnouncementTerminalSnapshot,
  FrameAutoscrollAdapter,
  NavigationAdapter,
  VisitAction,
} from "../adapters/index.js"
import {
  type ComponentStyleLayers,
  resolveComponentStyle,
  type StyleAdapter,
} from "../adapters/styles.js"
import { wasCableStreamSourceErrorReported } from "../core/cable-stream-source-errors-internal.js"
import type { CableStreamSourceCollection } from "../core/cable-stream-sources.js"
import { consumeDocumentAutofocus } from "../core/document-autofocus-internal.js"
import { notifyDocumentMorphFrameReloads } from "../core/document-morph-frame-reload-internal.js"
import type {
  DocumentPreloadLeaseRequester,
  DocumentPreloadRequester,
} from "../core/document-preloader.js"
import {
  consumeDocumentRefreshScroll,
  discardDocumentRefreshScroll,
} from "../core/document-refresh-scroll-internal.js"
import {
  acknowledgeDocumentRender,
  documentRenderLifecycleRevision,
  hasDocumentRenderTicket,
  retainDocumentRenderer,
  subscribeDocumentRenderLifecycle,
} from "../core/document-render-lifecycle-internal.js"
import type {
  DocumentReloadOptions,
  DocumentVisitController,
  DocumentVisitDelegation,
  DocumentVisitResult,
  DocumentVisitSnapshot,
} from "../core/document-visit-controller.js"
import {
  dispatchDocumentVisitBeforePrefetch,
  dispatchDocumentVisitLinkClick,
} from "../core/document-visit-controller-internal.js"
import {
  ExpoTurboError,
  RegistryError,
  RequestError,
  StateError,
  TargetError,
} from "../core/errors.js"
import type { FormLinkSubmissionController } from "../core/form-link-submission.js"
import type { FormRequestPlan } from "../core/form-request.js"
import type {
  FormSubmissionActivitySnapshot,
  FormSubmissionTerminalSnapshot,
  FormSubmitterActivitySnapshot,
} from "../core/form-submission-activity.js"
import type {
  FormSubmissionControllerSubmitOptions,
  FormSubmissionReport,
} from "../core/form-submission-controller.js"
import type { FormSubmissionProposal } from "../core/form-submission-proposal.js"
import type {
  ActiveFormRequestPlanOptions,
  ActiveFormRetryOptions,
  ActiveFormSubmissionProposalOptions,
  ActiveFormSubmissionReport,
  ActiveFormSubmitOptions,
  DocumentFormControls,
  FormConstraintValidationReport,
  FormControlDescriptor,
  FormControlRegistration,
  FormControlRegistry,
  FormControlSelection,
  FormSubmissionInterception,
  SuccessfulFormEntriesOptions,
  SuccessfulFormEntry,
} from "../core/forms.js"
import { consumeFrameRenderEffects } from "../core/frame-autofocus-internal.js"
import type { FrameController, FrameControllerSnapshot } from "../core/frame-controller.js"
import type {
  FrameControllerCollection,
  FrameVisitResult,
} from "../core/frame-controller-registry.js"
import type { FramePreloadRequester } from "../core/frame-preloader.js"
import {
  acknowledgeFrameRender,
  frameRenderLifecycleRevision,
  hasFrameRenderTicket,
  retainFrameRenderer,
  subscribeFrameRenderLifecycle,
} from "../core/frame-render-lifecycle-internal.js"
import type { FrameAutoscrollIntent } from "../core/frame-response-application.js"
import { resolveFormSubmissionDestination } from "../core/frames.js"
import { type ProtocolDirection, protocolDirection } from "../core/protocol-direction.js"
import {
  type ExternalDocumentLinkScheme,
  resolveDocumentLinkAnchor,
  resolveDocumentLinkFragment,
  resolveDocumentLinkUrl,
  resolveProtocolUrl,
} from "../core/protocol-request.js"
import { requestLifecycleDefaultHandlingPrevented } from "../core/request-lifecycle.js"
import type { DocumentSession, NodeSnapshot } from "../core/session.js"
import { subscribeBeforeSessionMutation } from "../core/session-mutation-internal.js"
import type {
  DocumentStateScopes,
  DocumentStateStore,
  StateScopeKind,
  StateSnapshot,
} from "../core/state.js"
import {
  consumeStandaloneStreamAutofocus,
  streamAutofocusLifecycleRevision,
  subscribeStreamAutofocusLifecycle,
} from "../core/stream-autofocus-internal.js"
import { registerStructuralOutputAdmission } from "../core/structural-output-admission-internal.js"
import { consumeThenableResult } from "../core/thenable-result.js"
import {
  attributeValue,
  isElement,
  type ProtocolDocument,
  type ProtocolElement,
  type ProtocolNode,
  type ProtocolParentNode,
  type ProtocolText,
  renderedTextValue,
} from "../core/tree.js"
import { EXPO_TURBO_RUNTIME_VERSION } from "../core/versions.js"
import { classifyTopLevelLocation } from "../core/visitability.js"
import type {
  ComponentActionExecutor,
  ComponentActionLifecycle,
  ComponentActionParams,
  ComponentActionResult,
  RegistryComponentAction,
} from "../registry/component-actions.js"
import type {
  ComponentRegistry,
  DecodedComponent,
  RegistryComponent,
  RegistryRenderDecodeResult,
  RegistryVocabularyIssue,
} from "../registry/registry.js"
import {
  analyzeRegistryStructuralOutput,
  type RegistryStructuralOutputAnalysis,
  type RegistryStructuralOutputDiagnostic,
} from "../registry/registry-structural-output-internal.js"

type RenderRegistry = Pick<ComponentRegistry<RegistryComponent>, "decode" | "decodeForRender"> &
  Partial<Pick<ComponentRegistry<RegistryComponent>, "resolve">>

export type ExpoTurboUnknownVocabularyKind = RegistryVocabularyIssue["kind"]

export interface ExpoTurboUnknownVocabularyEvent {
  readonly attribute?: string
  readonly documentUrl: string
  /**
   * Present when this vocabulary is reported because a form association on
   * another node failed. It holds that node's key, which is also the key the
   * matching `onError` carries, so the two can be correlated.
   *
   * It states only that unknown or undecodable vocabulary was unwrapped above
   * that node. It is not a claim that the element in `nodeKey` was its form
   * owner: an installed client cannot know what a tag it does not have means,
   * so an unwrapped layout wrapper and an unwrapped form owner are
   * indistinguishable here.
   */
  readonly failureNodeKey?: string
  readonly kind: ExpoTurboUnknownVocabularyKind
  /** Always the element the vocabulary issue was found on, with `tag`. */
  readonly nodeKey: string
  readonly tag: string
}

export type ExpoTurboUnknownVocabularyHandler = (
  event: ExpoTurboUnknownVocabularyEvent,
) => void | Promise<void>

/**
 * What the failure cost, stated by the party that knows: the renderer. It is a
 * description, not an instruction — but it is the one input a host boundary
 * needs to decide whether to replace the mounted document, and without it every
 * host has to guess. `ExpoTurbo` escalates `document` and only `document`.
 *
 * - `speculative` — work that existed only to be discarded. A press-in prefetch
 *   or an automatic preload failing costs nothing the user asked for; the
 *   navigation it was preparing has not started and still works without it.
 * - `background` — an accessory to a render that already succeeded: an
 *   accessibility announcement, autofocus, or a scroll adapter. The document is
 *   on screen and correct; only the accessory failed.
 * - `document` — the mounted document, or the navigation the user asked for,
 *   failed. This is the only severity where replacing what is on screen can be
 *   the right answer.
 */
export type ExpoTurboRenderErrorSeverity = "background" | "document" | "speculative"

/**
 * A blank document is a state with a duration, not a repeating event. Every
 * report while one lasts carries this, so a single surviving report states how
 * long the document has been blank and how many reports preceded it — which is
 * what separates "blank for 50 ms until the next Stream fixed it" from "blank
 * until the user force-quit the app".
 *
 * Reports are per waking revision and are deliberately not deduplicated; see
 * issue 433 for why no identity is constructible here. `attempt` is what a host
 * wanting edge-only telemetry filters on.
 */
export interface ExpoTurboDocumentBlankInterval {
  /** 1-based ordinal of this report inside the interval. */
  readonly attempt: number
  /** Document URL when the interval opened. */
  readonly documentUrl: string
  /** Root document node key, the same key the matching `onError` carries. */
  readonly nodeKey: string
  /** Installed Expo Turbo runtime version — the app-build half of the question. */
  readonly runtimeVersion: string
  /** `Date.now()` when the interval opened. */
  readonly since: number
}

/**
 * The falling edge of a blank document. `until - since` is how long the
 * document was blank.
 *
 * The interval is the guard's own state: it opens when the blank-root guard
 * raises and closes when the next commit produces output. A subtree that
 * suspends registers neither output nor a drop, so the guard stands down and
 * this fires; if it raises again afterwards that is a new interval. Reporting
 * the guard's state rather than a wider notion of emptiness is deliberate,
 * because the guard's state is exactly what decides whether a surface is up.
 */
export interface ExpoTurboDocumentBlankRecovery extends ExpoTurboDocumentBlankInterval {
  /** `Date.now()` when the document produced output again. */
  readonly until: number
}

export type ExpoTurboDocumentBlankRecoveryHandler = (event: ExpoTurboDocumentBlankRecovery) => void

export interface ExpoTurboRenderError {
  /** Present only on the blank-root guard's reports. */
  readonly blank?: ExpoTurboDocumentBlankInterval
  readonly error: Error
  readonly nodeKey: string
  readonly severity: ExpoTurboRenderErrorSeverity
}

export interface ExpoTurboFrameAccessibilityState {
  readonly busy: boolean
}

export interface ExpoTurboDocumentAccessibilityState {
  readonly busy: boolean
}

export interface ExpoTurboDocumentBinding {
  readonly accessibilityState: ExpoTurboDocumentAccessibilityState
  readonly controller: DocumentVisitController
  readonly state: DocumentVisitSnapshot
}

export interface ExpoTurboDocumentBoundaryProps extends ExpoTurboDocumentBinding {
  readonly children?: ReactNode
}

export interface ExpoTurboFrameBinding {
  readonly accessibilityState: ExpoTurboFrameAccessibilityState
  readonly controller: FrameController
  readonly state: FrameControllerSnapshot
}

export interface ExpoTurboFrameBoundaryProps extends ExpoTurboFrameBinding {
  readonly children?: ReactNode
}

export interface ExpoTurboFormAccessibilityState {
  readonly busy: boolean
}

export type ExpoTurboFormSubmitOptions = ActiveFormSubmitOptions & {
  /**
   * Defers submission until React has committed pending control descriptors.
   * Use this when one event updates control state and submits the form.
   */
  readonly afterCommit?: boolean
}

export interface ExpoTurboFormBinding {
  readonly accessibilityState: ExpoTurboFormAccessibilityState
  cancelSubmission(): void
  checkValidity(): FormConstraintValidationReport
  dismissTerminal(): void
  readonly formNodeKey: string
  readonly requestPlan: (options: ActiveFormRequestPlanOptions) => FormRequestPlan
  readonly shouldInterceptSubmission: (options?: SuccessfulFormEntriesOptions) => boolean
  readonly submissionInterception: (
    options?: SuccessfulFormEntriesOptions,
  ) => FormSubmissionInterception
  readonly submissionProposal: (
    options: ActiveFormSubmissionProposalOptions,
  ) => FormSubmissionProposal
  readonly successfulEntries: (
    options?: SuccessfulFormEntriesOptions,
  ) => readonly SuccessfulFormEntry[]
  readonly state: FormSubmissionActivitySnapshot
  readonly terminalState: FormSubmissionTerminalSnapshot
  retryFailure(
    options: ActiveFormRetryOptions,
    controllerOptions?: FormSubmissionControllerSubmitOptions,
  ): Promise<ActiveFormSubmissionReport>
  reportValidity(): FormConstraintValidationReport
  submit(
    options: ExpoTurboFormSubmitOptions,
    controllerOptions?: FormSubmissionControllerSubmitOptions,
  ): Promise<ActiveFormSubmissionReport>
}

export interface ExpoTurboFormBoundaryProps extends ExpoTurboFormBinding {
  readonly children?: ReactNode
}

export interface ExpoTurboFormControlAccessibilityState {
  readonly disabled: boolean
}

export interface ExpoTurboFormControlBinding {
  readonly accessibilityState: ExpoTurboFormControlAccessibilityState
  readonly disabled: boolean
  readonly nodeKey: string
  readonly pending: boolean
  selection(): FormControlSelection
  readonly submitsWith?: string
}

/**
 * The host's text primitive, wrapped around every text run the renderer places
 * itself. It receives one run as its only child and must render it inside
 * whatever component draws text on the host platform — `Text` on React Native.
 *
 * It is the host's because the renderer has no primitives of its own, and it is
 * needed because a text run has no host of its own: see `ProtocolTextRun` for
 * where the boundary between renderer-placed and component-owned text falls,
 * and for what happens to a run when this is absent.
 */
export interface ExpoTurboTextBoundaryProps {
  readonly children?: ReactNode
}

interface ExpoTurboFormContextValue {
  readonly binding: ExpoTurboFormBinding
  readonly registry: FormControlRegistry
}

interface RendererContextValue {
  readonly actions: ComponentActionExecutor | undefined
  readonly autofocus: AutofocusAdapter | undefined
  readonly autofocusScroll: AutofocusScrollAdapter | undefined
  readonly documentComponent: ComponentType<ExpoTurboDocumentBoundaryProps> | undefined
  readonly documentAnchorScroll: DocumentAnchorScrollAdapter | undefined
  readonly documentAutomaticPreloadPolicy: DocumentAutomaticPreloadPolicy | undefined
  readonly documentAnnouncements: DocumentVisitAnnouncementAdapter | undefined
  readonly documentController: DocumentVisitController | undefined
  readonly documentHistoryScroll: DocumentHistoryScrollAdapter | undefined
  readonly documentLinks: DocumentLinkAdapter | undefined
  readonly documentPrefetchPolicy: DocumentPrefetchPolicy | undefined
  readonly documentPreloader: DocumentPreloadRequester | undefined
  readonly documentRefreshScroll: DocumentRefreshScrollAdapter | undefined
  readonly frameAutoscroll: FrameAutoscrollAdapter | undefined
  readonly frameComponent: ComponentType<ExpoTurboFrameBoundaryProps> | undefined
  readonly framePreloader: FramePreloadRequester | undefined
  readonly formComponent: ComponentType<ExpoTurboFormBoundaryProps> | undefined
  readonly formAnnouncements: FormSubmissionAnnouncementAdapter | undefined
  readonly formLinks: FormLinkSubmissionController | undefined
  readonly frames: FrameControllerCollection | undefined
  readonly forms: DocumentFormControls | undefined
  readonly onDocumentBlankRecovery: ExpoTurboDocumentBlankRecoveryHandler | undefined
  readonly onError: ((event: ExpoTurboRenderError) => void) | undefined
  readonly onUnknownVocabulary: ExpoTurboUnknownVocabularyHandler | undefined
  readonly registry: RenderRegistry
  readonly renderError: ((event: ExpoTurboRenderError) => ReactNode) | undefined
  readonly session: DocumentSession
  readonly scopes: DocumentStateScopes | undefined
  readonly state: DocumentStateStore | undefined
  readonly streamSources: CableStreamSourceCollection | undefined
  readonly styles: StyleAdapter | undefined
  readonly textComponent: ComponentType<ExpoTurboTextBoundaryProps> | undefined
}

const RendererContext = createContext<RendererContextValue | undefined>(undefined)
const DocumentContext = createContext<ExpoTurboDocumentBinding | undefined>(undefined)
const FrameContext = createContext<ExpoTurboFrameBinding | undefined>(undefined)
const FormContext = createContext<ExpoTurboFormContextValue | undefined>(undefined)
const NavigationContext = createContext<NavigationAdapter | undefined>(undefined)
const ProtocolNodeContext = createContext<string | undefined>(undefined)
const ComponentDefinitionContext = createContext<RegistryComponent | undefined>(undefined)
const ComponentTagContext = createContext<string | undefined>(undefined)
const StateScopeContext = createContext<DocumentStateStore | undefined>(undefined)
const DirectionContext = createContext<ProtocolDirection | undefined>(undefined)
const DirectionFallbackContext = createContext<"ltr" | "rtl">("ltr")
const bidi = bidiFactory()

function inferredFormControlDirection(value: string, emptyFallback: "ltr" | "rtl"): "ltr" | "rtl" {
  for (const character of value) {
    const type = bidi.getBidiCharTypeName(character)
    if (type === "L") return "ltr"
    if (type === "R" || type === "AL") return "rtl"
  }
  return value === "" ? emptyFallback : "ltr"
}
const providerDisposableOwners = new WeakMap<object, number>()
const announcedFormTerminalRevisions = new WeakMap<
  DocumentSession,
  WeakMap<ProtocolElement, number>
>()
const announcedDocumentVisitStates = new WeakMap<
  DocumentVisitController,
  Readonly<{ revision: number; status: DocumentVisitAnnouncementEvent["status"] }>
>()
interface UnknownVocabularyClaim {
  readonly fingerprints: Set<string>
  generation: number
}
const unknownVocabularyClaims = new WeakMap<
  DocumentSession,
  WeakMap<ProtocolElement, UnknownVocabularyClaim>
>()
const droppedTextRunWarnings = new WeakMap<DocumentSession, WeakMap<ProtocolText, number>>()
const UNSUPPORTED_DOCUMENT_LINK_ATTRIBUTES = ["action", "confirm", "method", "stream"] as const
const UNSUPPORTED_DOCUMENT_PREFETCH_ATTRIBUTES = [
  ...UNSUPPORTED_DOCUMENT_LINK_ATTRIBUTES,
  "data-behavior",
  "data-confirm",
  "download",
  "data-method",
  "data-remote",
  "data-turbo-confirm",
  "data-turbo-method",
  "data-turbo-stream",
] as const
const MISSING_FORM_OWNER_KEY = "__expo-turbo-missing-form-owner__"

function exactVisitAction(value: string | undefined): VisitAction | undefined {
  return value === "advance" || value === "replace" || value === "restore" ? value : undefined
}

function linkFrameVisitAction(value: string | undefined): VisitAction | null | undefined {
  if (value === undefined) return undefined
  return exactVisitAction(value) ?? null
}

function hasProtocolAttribute(node: ProtocolElement, name: string): boolean {
  return node.attributes.some((attribute) => attribute.name === name)
}

function documentAnchorFrameScope(node: ProtocolElement): string | null | undefined {
  if (node.kind !== "element") return null
  let current: ProtocolNode | null = node.parent
  while (current && current.kind !== "document") {
    if (current.kind === "frame") return attributeValue(current, "id") || null
    if (!isElement(current) || current.kind !== "element") return null
    current = current.parent
  }
  return current?.kind === "document" ? undefined : null
}

function documentAnchorDestinationScope(
  session: DocumentSession,
  node: ProtocolElement,
  elementTarget: string | undefined,
): string | undefined {
  const destination = resolveFormSubmissionDestination(session.tree, node, {
    ...(elementTarget !== undefined ? { formTarget: elementTarget } : {}),
  })
  return destination.kind === "frame" ? destination.frameId : undefined
}

function documentLinkCaptureContext(node: ProtocolElement): Readonly<{
  elementTarget: string | undefined
  nearestFrameId: string | null | undefined
  optedOut: boolean
}> {
  let current: ProtocolNode | null = node
  let foundTurboSetting = false
  let nearestFrameId: string | null | undefined
  let optedOut = false
  while (current && current.kind !== "document") {
    if (current.kind === "frame" && nearestFrameId === undefined) {
      nearestFrameId = attributeValue(current, "id") || null
    }
    if (!foundTurboSetting && isElement(current)) {
      const setting = attributeValue(current, "data-turbo")
      if (setting !== undefined) {
        foundTurboSetting = true
        optedOut = setting === "false"
      }
    }
    current = current.parent
  }
  return { elementTarget: attributeValue(node, "data-turbo-frame"), nearestFrameId, optedOut }
}

function canonicalDocumentPreloadUrl(source: string, documentUrl: string): string {
  if (
    typeof source !== "string" ||
    source.trim() === "" ||
    [...source].some((character) => {
      const codePoint = character.codePointAt(0)
      return codePoint !== undefined && (codePoint <= 31 || codePoint === 127)
    })
  ) {
    throw new TargetError("Document link URL is invalid")
  }
  const resolved = resolveProtocolUrl(source, documentUrl, documentUrl)
  const url = new URL(resolved.url)
  url.hash = ""
  return url.toString()
}

function requestDocumentAnchorScroll(
  adapter: DocumentAnchorScrollAdapter | undefined,
  targetId: string,
): void {
  if (!adapter)
    throw new TargetError("Document link anchors require provider documentAnchorScroll support")
  let result: unknown
  try {
    result = adapter.scrollTo(targetId, "start")
  } catch {
    throw new StateError("Document link anchor scrolling failed")
  }
  if (result !== undefined) {
    consumeUnexpectedAdapterResult(result)
    throw new StateError("Document link anchor scrolling failed")
  }
}

function automaticDocumentPreloadUrl(
  session: DocumentSession,
  node: ProtocolElement,
  href: string,
  rawHref: string | undefined,
): string | undefined {
  if (
    attributeValue(node, "href") !== rawHref ||
    !hasProtocolAttribute(node, "data-turbo-preload") ||
    hasProtocolAttribute(node, "disabled") ||
    hasProtocolAttribute(node, "data-turbo-method") ||
    hasProtocolAttribute(node, "data-turbo-stream")
  ) {
    return undefined
  }
  const browserTarget = attributeValue(node, "target")
  if (browserTarget !== undefined && browserTarget !== "" && browserTarget !== "_self") {
    return undefined
  }
  if (hasProtocolAttribute(node, "download")) return undefined
  if (UNSUPPORTED_DOCUMENT_LINK_ATTRIBUTES.some((name) => hasProtocolAttribute(node, name))) {
    return undefined
  }

  let current: ProtocolNode | null = node
  while (current && current.kind !== "document") {
    if (isElement(current)) {
      const setting = attributeValue(current, "data-turbo")
      if (setting !== undefined) {
        if (setting === "false") return undefined
        break
      }
    }
    current = current.parent
  }

  try {
    const documentUrl = session.tree.document.url
    if (!documentUrl) return undefined
    let preloadUrl: string
    if (href.includes("#")) {
      preloadUrl = canonicalDocumentPreloadUrl(href, documentUrl)
    } else {
      const linkUrl = resolveDocumentLinkUrl(href, documentUrl)
      if (linkUrl.kind !== "protocol") return undefined
      preloadUrl = linkUrl.resolution.url
    }
    const frameTarget = attributeValue(node, "data-turbo-frame")
    const destination = resolveFormSubmissionDestination(session.tree, node, {
      ...(frameTarget !== undefined ? { formTarget: frameTarget } : {}),
    })
    if (destination.kind !== "document") return undefined
    const disposition = classifyTopLevelLocation(session.tree, preloadUrl)
    if (disposition.classification !== "visitable") return undefined
    return disposition.url
  } catch {
    return undefined
  }
}

interface AutomaticFramePreloadTarget {
  readonly frameId: string
  readonly url: string
}

function automaticFramePreloadTarget(
  session: DocumentSession,
  node: ProtocolElement,
  href: string,
  rawHref: string | undefined,
): AutomaticFramePreloadTarget | undefined {
  if (
    attributeValue(node, "href") !== rawHref ||
    !hasProtocolAttribute(node, "data-turbo-preload") ||
    hasProtocolAttribute(node, "disabled") ||
    hasProtocolAttribute(node, "data-turbo-method") ||
    hasProtocolAttribute(node, "data-turbo-stream")
  ) {
    return undefined
  }
  const browserTarget = attributeValue(node, "target")
  if (browserTarget !== undefined && browserTarget !== "" && browserTarget !== "_self") {
    return undefined
  }
  if (hasProtocolAttribute(node, "download")) return undefined
  if (UNSUPPORTED_DOCUMENT_LINK_ATTRIBUTES.some((name) => hasProtocolAttribute(node, name))) {
    return undefined
  }
  let current: ProtocolNode | null = node
  while (current && current.kind !== "document") {
    if (isElement(current)) {
      const setting = attributeValue(current, "data-turbo")
      if (setting !== undefined) {
        if (setting === "false") return undefined
        break
      }
    }
    current = current.parent
  }
  try {
    const documentUrl = session.tree.document.url
    if (!documentUrl) return undefined
    const frameTarget = attributeValue(node, "data-turbo-frame")
    const destination = resolveFormSubmissionDestination(session.tree, node, {
      ...(frameTarget !== undefined ? { formTarget: frameTarget } : {}),
    })
    if (destination.kind !== "frame") return undefined
    const resolved = resolveProtocolUrl(href, documentUrl, documentUrl)
    if (resolved.documentOrigin !== resolved.urlOrigin) return undefined
    const url = new URL(resolved.url)
    url.hash = ""
    return Object.freeze({ frameId: destination.frameId, url: url.toString() })
  } catch {
    return undefined
  }
}

function pressInDocumentPrefetchUrl(
  session: DocumentSession,
  node: ProtocolElement,
  href: string,
): string | undefined {
  const turboMethod = attributeValue(node, "data-turbo-method")
  if (
    hasProtocolAttribute(node, "disabled") ||
    hasProtocolAttribute(node, "target") ||
    UNSUPPORTED_DOCUMENT_PREFETCH_ATTRIBUTES.some(
      (name) => name !== "data-turbo-method" && hasProtocolAttribute(node, name),
    ) ||
    (turboMethod !== undefined && turboMethod !== "" && turboMethod.toLowerCase() !== "get")
  ) {
    return undefined
  }

  let current: ProtocolNode | null = node
  let foundPrefetchSetting = false
  let foundTurboSetting = false
  while (current && current.kind !== "document") {
    if (isElement(current)) {
      if (!foundPrefetchSetting) {
        const setting = attributeValue(current, "data-turbo-prefetch")
        if (setting !== undefined) {
          foundPrefetchSetting = true
          if (setting === "false") return undefined
        }
      }
      if (!foundTurboSetting) {
        const setting = attributeValue(current, "data-turbo")
        if (setting !== undefined) {
          foundTurboSetting = true
          if (setting === "false") return undefined
        }
      }
    }
    current = current.parent
  }

  try {
    const documentUrl = session.tree.document.url
    if (!documentUrl) return undefined
    const frameTarget = attributeValue(node, "data-turbo-frame")
    const destination = resolveFormSubmissionDestination(session.tree, node, {
      ...(frameTarget !== undefined ? { formTarget: frameTarget } : {}),
    })
    if (destination.kind !== "document") return undefined
    const linkUrl = resolveDocumentLinkUrl(href, documentUrl)
    if (linkUrl.kind !== "protocol") return undefined
    const disposition = classifyTopLevelLocation(session.tree, linkUrl.resolution.url)
    if (disposition.classification !== "visitable") return undefined
    const destinationUrl = new URL(disposition.url)
    const activeUrl = new URL(documentUrl)
    if (destinationUrl.pathname + destinationUrl.search === activeUrl.pathname + activeUrl.search) {
      return undefined
    }
    return disposition.url
  } catch {
    return undefined
  }
}

function useAutomaticDocumentPreloadRevision(
  session: DocumentSession,
  node: ProtocolElement | undefined,
  enabled: boolean,
): void {
  const subscribed =
    enabled && node !== undefined && hasProtocolAttribute(node, "data-turbo-preload")
  const subscribe = useCallback(
    (listener: () => void) => (subscribed ? session.subscribeRevision(listener) : () => undefined),
    [session, subscribed],
  )
  const snapshot = useCallback(() => (subscribed ? session.revision : 0), [session, subscribed])
  useSyncExternalStore(subscribe, snapshot, snapshot)
}

export interface ExpoTurboProviderProps {
  readonly actions?: ComponentActionExecutor
  readonly autofocus?: AutofocusAdapter
  readonly autofocusScroll?: AutofocusScrollAdapter
  readonly children?: ReactNode
  readonly documentComponent?: ComponentType<ExpoTurboDocumentBoundaryProps>
  readonly documentAnchorScroll?: DocumentAnchorScrollAdapter
  readonly documentAutomaticPreloadPolicy?: DocumentAutomaticPreloadPolicy
  readonly documentAnnouncements?: DocumentVisitAnnouncementAdapter
  readonly documentController?: DocumentVisitController
  readonly documentHistoryScroll?: DocumentHistoryScrollAdapter
  readonly documentLinks?: DocumentLinkAdapter
  readonly documentPrefetchPolicy?: DocumentPrefetchPolicy
  readonly documentPreloader?: DocumentPreloadRequester
  readonly documentRefreshScroll?: DocumentRefreshScrollAdapter
  readonly defaultDirection?: "ltr" | "rtl"
  readonly frameAutoscroll?: FrameAutoscrollAdapter
  readonly frameComponent?: ComponentType<ExpoTurboFrameBoundaryProps>
  readonly framePreloader?: FramePreloadRequester
  readonly formComponent?: ComponentType<ExpoTurboFormBoundaryProps>
  readonly formAnnouncements?: FormSubmissionAnnouncementAdapter
  readonly formLinks?: FormLinkSubmissionController
  readonly frames?: FrameControllerCollection
  readonly forms?: DocumentFormControls
  readonly navigation?: NavigationAdapter
  /**
   * The falling edge of a blank document. `onError` reports each waking
   * revision while one lasts; this fires once, when it ends.
   *
   * Without it "blank for 50 ms" and "blank until the user force-quit" are the
   * same signal. It fires only while this provider stays mounted: a host whose
   * boundary unmounts the provider on the first report has ended the document,
   * not recovered it, and gets no event.
   */
  readonly onDocumentBlankRecovery?: ExpoTurboDocumentBlankRecoveryHandler
  readonly onError?: (event: ExpoTurboRenderError) => void
  readonly onUnknownVocabulary?: ExpoTurboUnknownVocabularyHandler
  /**
   * Whether this provider disposes `scopes` and `state` when it unmounts.
   * Defaults to `true`, which is what a host composing them by hand expects.
   *
   * `ExpoTurbo` passes `false`: the runtime it built created those objects and
   * disposes them itself, and two owners calling `dispose()` on one object is
   * only harmless for as long as both stay idempotent.
   */
  readonly ownsStateDisposal?: boolean
  readonly registry: RenderRegistry
  readonly renderError?: (event: ExpoTurboRenderError) => ReactNode
  readonly scopes?: DocumentStateScopes
  readonly session: DocumentSession
  readonly state?: DocumentStateStore
  readonly streamSources?: CableStreamSourceCollection
  readonly styles?: StyleAdapter
  /**
   * The host's text primitive. Every text run the renderer places itself is
   * wrapped in it, because a bare string under a React Native `View` breaks the
   * text-in-view rule. Without it such a run is dropped instead of emitted.
   *
   * `ExpoTurboApp` from `expo-turbo/expo` supplies one for you.
   */
  readonly textComponent?: ComponentType<ExpoTurboTextBoundaryProps>
}

export interface ExpoTurboDisposable {
  dispose(): void
}

/**
 * Reference-counts a shared disposable across every mount that claims it, and
 * disposes it one microtask after the last claim is released so that a
 * remount in the same commit — StrictMode, a Fast Refresh cycle, a route
 * swap — hands the resource over instead of tearing it down.
 *
 * This is the bookkeeping every host was previously copying by hand. Hosts on
 * the `ExpoTurboApp`/`ExpoTurbo` path never need it: those components own the
 * runtime they create. It is public for hosts that compose a runtime manually
 * and share it between screens.
 */
export function useExpoTurboDisposable(resource: ExpoTurboDisposable | undefined): void {
  useEffect(() => {
    if (!resource) return
    providerDisposableOwners.set(resource, (providerDisposableOwners.get(resource) ?? 0) + 1)
    return () => {
      const owners = providerDisposableOwners.get(resource) ?? 0
      providerDisposableOwners.set(resource, Math.max(0, owners - 1))
      queueMicrotask(() => {
        if (providerDisposableOwners.get(resource) !== 0) return
        providerDisposableOwners.delete(resource)
        resource.dispose()
      })
    }
  }, [resource])
}

const useProviderDisposable = useExpoTurboDisposable

const EMPTY_DOCUMENT_OUTPUT_LEDGER: DocumentOutputLedger = createDocumentOutputLedger()

export function ExpoTurboProvider(props: ExpoTurboProviderProps): ReactNode {
  const outputLedger = useRef<DocumentOutputLedger | undefined>(undefined)
  outputLedger.current ??= createDocumentOutputLedger()
  const ownsStateDisposal = props.ownsStateDisposal !== false
  useProviderDisposable(ownsStateDisposal ? props.scopes : undefined)
  useProviderDisposable(ownsStateDisposal ? props.state : undefined)
  useInsertionEffect(
    () =>
      registerStructuralOutputAdmission(props.session, (request) => {
        const analysis = analyzeRegistryStructuralOutput(props.registry, request.nodes)
        const generation = props.session.treeGeneration
        return Object.freeze({
          hasOutput: analysis.hasOutput,
          hasVocabularyIssues: analysis.hasVocabularyIssues,
          report() {
            for (const diagnostic of analysis.diagnostics) {
              deliverUnknownVocabularyIssues(
                props.session,
                diagnostic.node,
                generation,
                diagnostic.issues,
                props.onUnknownVocabulary,
              )
            }
          },
        })
      }),
    [props.onUnknownVocabulary, props.registry, props.session],
  )
  const value = useMemo<RendererContextValue>(
    () => ({
      actions: props.actions,
      autofocus: props.autofocus,
      autofocusScroll: props.autofocusScroll,
      documentComponent: props.documentComponent,
      documentAnchorScroll: props.documentAnchorScroll,
      documentAutomaticPreloadPolicy: props.documentAutomaticPreloadPolicy,
      documentAnnouncements: props.documentAnnouncements,
      documentController: props.documentController,
      documentHistoryScroll: props.documentHistoryScroll,
      documentLinks: props.documentLinks,
      documentPrefetchPolicy: props.documentPrefetchPolicy,
      documentPreloader: props.documentPreloader,
      documentRefreshScroll: props.documentRefreshScroll,
      frameAutoscroll: props.frameAutoscroll,
      frameComponent: props.frameComponent,
      framePreloader: props.framePreloader,
      formComponent: props.formComponent,
      formAnnouncements: props.formAnnouncements,
      formLinks: props.formLinks,
      frames: props.frames,
      forms: props.forms,
      onDocumentBlankRecovery: props.onDocumentBlankRecovery,
      onError: props.onError,
      onUnknownVocabulary: props.onUnknownVocabulary,
      registry: props.registry,
      renderError: props.renderError,
      scopes: props.scopes,
      session: props.session,
      state: props.state,
      streamSources: props.streamSources,
      styles: props.styles,
      textComponent: props.textComponent,
    }),
    [
      props.actions,
      props.autofocus,
      props.autofocusScroll,
      props.documentComponent,
      props.documentAnchorScroll,
      props.documentAutomaticPreloadPolicy,
      props.documentAnnouncements,
      props.documentController,
      props.documentHistoryScroll,
      props.documentLinks,
      props.documentPrefetchPolicy,
      props.documentPreloader,
      props.documentRefreshScroll,
      props.frameAutoscroll,
      props.frameComponent,
      props.framePreloader,
      props.formComponent,
      props.formAnnouncements,
      props.formLinks,
      props.frames,
      props.forms,
      props.onDocumentBlankRecovery,
      props.onError,
      props.onUnknownVocabulary,
      props.registry,
      props.renderError,
      props.scopes,
      props.session,
      props.state,
      props.streamSources,
      props.styles,
      props.textComponent,
    ],
  )
  return createElement(
    DocumentOutputContext.Provider,
    { value: outputLedger.current },
    createElement(
      RendererContext.Provider,
      { value },
      createElement(
        DirectionFallbackContext.Provider,
        { value: props.defaultDirection ?? "ltr" },
        createElement(NavigationContext.Provider, { value: props.navigation }, props.children),
      ),
    ),
  )
}

function useRenderer(): RendererContextValue {
  const context = useContext(RendererContext)
  if (!context) throw new RegistryError("Expo Turbo renderer requires ExpoTurboProvider")
  return context
}

export function useProtocolNode(key: string): NodeSnapshot | undefined {
  const { session } = useRenderer()
  const subscribe = useCallback(
    (listener: () => void) => session.subscribe(key, listener),
    [key, session],
  )
  const snapshot = useCallback(() => session.getNodeSnapshot(key), [key, session])
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

export function createComponentStyleHook<TStyle, Token extends string>(
  adapter: StyleAdapter<TStyle, Token>,
): (layers: ComponentStyleLayers<TStyle>) => TStyle {
  return function useBoundComponentStyle(layers: ComponentStyleLayers<TStyle>): TStyle {
    const { session, styles } = useRenderer()
    const nodeKey = useContext(ProtocolNodeContext)
    const component = useContext(ComponentTagContext)
    if (!styles) throw new RegistryError("Expo Turbo component styles require a provider adapter")
    if (styles !== adapter) {
      throw new RegistryError("Expo Turbo component styles require the matching provider adapter")
    }
    if (!nodeKey || !component) {
      throw new RegistryError("Expo Turbo component styles require a component node")
    }
    const node = session.getNodeSnapshot(nodeKey)?.node
    if (!node || !isElement(node)) {
      throw new RegistryError("Expo Turbo component styles require an active component element")
    }
    return resolveComponentStyle(adapter, layers, { component })
  }
}

export function useComponentAction<Definition extends RegistryComponentAction>(
  definition: Definition,
  lifecycle?: ComponentActionLifecycle<ComponentActionResult<Definition>>,
): (params: ComponentActionParams<Definition>) => Promise<ComponentActionResult<Definition>> {
  const { actions } = useRenderer()
  const state = useContext(StateScopeContext)
  if (!actions) throw new RegistryError("Expo Turbo component actions require a provider runner")
  return useCallback(
    (params: ComponentActionParams<Definition>) =>
      actions.executeDefinition(definition, params, lifecycle, state),
    [actions, definition, lifecycle, state],
  )
}

export interface DocumentStateBinding<Value> extends StateSnapshot<Value> {
  remove(): void
  set(value: Value): void
}

function useStateBinding<Value>(
  state: DocumentStateStore,
  key: string,
): DocumentStateBinding<Value> {
  const subscribe = useCallback(
    (listener: () => void) => state.subscribe(key, listener),
    [key, state],
  )
  const getSnapshot = useCallback(() => state.getSnapshot<Value>(key), [key, state])
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  return useMemo(
    () =>
      Object.freeze({
        ...snapshot,
        remove: () => state.delete(key),
        set: (value: Value) => state.set(key, value),
      }),
    [key, snapshot, state],
  )
}

export function useDocumentState<Value = unknown>(key: string): DocumentStateBinding<Value> {
  const { state } = useRenderer()
  if (!state) throw new RegistryError("Expo Turbo document state requires a provider store")
  return useStateBinding<Value>(state, key)
}

export function useScopedState<Value = unknown>(key: string): DocumentStateBinding<Value> {
  const { state: documentState } = useRenderer()
  const scopedState = useContext(StateScopeContext)
  const state = scopedState ?? documentState
  if (!state) throw new RegistryError("Expo Turbo scoped state requires a provider store")
  return useStateBinding<Value>(state, key)
}

interface StateScopeBoundaryProps {
  readonly children?: ReactNode
  readonly kind: StateScopeKind
  readonly nodeKey: string
  readonly required?: boolean
}

function StateScopeBoundary(props: StateScopeBoundaryProps): ReactNode {
  const { scopes } = useRenderer()
  const scope = useMemo(
    () => scopes?.scopeFor(props.nodeKey, props.kind),
    [props.kind, props.nodeKey, scopes],
  )
  if (props.required && !scopes) {
    throw new RegistryError("Expo Turbo state scopes require a provider scope registry")
  }
  if (!scope) return props.children
  return createElement(StateScopeContext.Provider, { value: scope.state }, props.children)
}

export interface ExpoTurboStateScopeProps {
  readonly children?: ReactNode
  readonly kind: StateScopeKind
}

export function ExpoTurboStateScope(props: ExpoTurboStateScopeProps): ReactNode {
  const nodeKey = useContext(ProtocolNodeContext)
  if (!nodeKey) throw new RegistryError("Expo Turbo state scopes require a component node")
  return createElement(
    StateScopeBoundary,
    {
      kind: props.kind,
      nodeKey,
      required: true,
    },
    props.children,
  )
}

export interface ExpoTurboFormScopeProps {
  readonly children?: ReactNode
}

interface DeferredFormSubmission {
  readonly commitRevision: number
  readonly controllerOptions?: FormSubmissionControllerSubmitOptions
  readonly options: ActiveFormSubmitOptions
  readonly registry: FormControlRegistry
  reject(error: unknown): void
  resolve(report: ActiveFormSubmissionReport): void
}

function formSubmitAfterCommit(options: ExpoTurboFormSubmitOptions): boolean {
  if (!options || typeof options !== "object") return false
  let array: boolean
  try {
    array = Array.isArray(options)
  } catch {
    throw new RequestError("Active form submit options could not be read")
  }
  if (array) return false
  let afterCommit: unknown
  let hasAfterCommit: boolean
  try {
    hasAfterCommit = "afterCommit" in options
    afterCommit = hasAfterCommit
      ? (options as Readonly<{ afterCommit?: unknown }>).afterCommit
      : undefined
  } catch {
    throw new RequestError("Active form submit options could not be read")
  }
  if (!hasAfterCommit) return false
  if (afterCommit !== undefined && typeof afterCommit !== "boolean") {
    throw new RequestError("Form submission afterCommit must be boolean")
  }
  return afterCommit === true
}

/**
 * A form association whose owner tag is unknown must never reach the network:
 * `action`, `method`, and `enctype` on that element are vocabulary this client
 * cannot interpret. The binding keeps its read-only surface and refuses every
 * operation that would build or dispatch a request, the way a browser gives a
 * control no form owner when `form` points at a non-form element.
 */
/**
 * The node whose form association failed, when that is not the node the issues
 * were found on. The key is what the payload carries; the identity is what
 * deduplication compares, because a replacement node reuses its predecessor's
 * key and a second failure on the same key is still a second failure.
 */
interface VocabularyFailureSource {
  readonly identity: string
  readonly nodeKey: string
}

interface FormOwnerVocabularyMetadata {
  readonly failure?: VocabularyFailureSource
  readonly generation: number
  readonly handler: ExpoTurboUnknownVocabularyHandler | undefined
  readonly issues: readonly RegistryVocabularyIssue[]
  readonly node: ProtocolElement
  readonly registry: unknown
  readonly session: DocumentSession
}

function refuseInertFormOwner(operation: string, metadata: FormOwnerVocabularyMetadata): never {
  throw new InertFormOwnerError(operation, metadata)
}

function useFormBinding(
  registry: FormControlRegistry,
  formNodeKey: string,
  inert?: FormOwnerVocabularyMetadata,
): ExpoTurboFormBinding {
  const committedInert = useRef(inert)
  const committedRegistry = useRef(registry)
  const deferredSubmissions = useRef<DeferredFormSubmission[]>([])
  const mounted = useRef(false)
  const requestedCommitRevision = useRef(0)
  const pendingSubmissions = useRef(new Set<DeferredFormSubmission>())
  const [commitRevision, scheduleCommit] = useState(0)
  const subscribe = useCallback(
    (listener: () => void) => registry.subscribeSubmission(listener),
    [registry],
  )
  const snapshot = useCallback(() => registry.submissionState, [registry])
  const state = useSyncExternalStore(subscribe, snapshot, snapshot)
  const subscribeTerminal = useCallback(
    (listener: () => void) => registry.subscribeSubmissionTerminal(listener),
    [registry],
  )
  const terminalSnapshot = useCallback(() => registry.submissionTerminalState, [registry])
  const terminalState = useSyncExternalStore(subscribeTerminal, terminalSnapshot, terminalSnapshot)
  useLayoutEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      const error = new StateError("Deferred form submission lost its React binding")
      for (const submission of pendingSubmissions.current) submission.reject(error)
      pendingSubmissions.current.clear()
      deferredSubmissions.current = []
    }
  }, [])
  useLayoutEffect(() => {
    committedInert.current = inert
    committedRegistry.current = registry
  })
  useLayoutEffect(() => {
    const submissions: DeferredFormSubmission[] = []
    const waiting: DeferredFormSubmission[] = []
    for (const submission of deferredSubmissions.current) {
      if (submission.commitRevision <= commitRevision) submissions.push(submission)
      else waiting.push(submission)
    }
    if (submissions.length === 0) return
    deferredSubmissions.current = waiting
    queueMicrotask(() => {
      for (const submission of submissions) {
        if (!pendingSubmissions.current.delete(submission)) continue
        if (!mounted.current) {
          submission.reject(new StateError("Deferred form submission lost its React binding"))
          continue
        }
        if (submission.registry !== committedRegistry.current) {
          submission.reject(new StateError("Deferred form submission changed its React binding"))
          continue
        }
        // The owner tag can stop being known between queueing and execution
        // while the node and its form registry both stay active, so inertness
        // is rechecked here rather than trusted from the queueing render.
        if (committedInert.current) {
          submission.reject(new InertFormOwnerError("submission", committedInert.current))
          continue
        }
        try {
          void submission.registry
            .submit(submission.options, submission.controllerOptions)
            .then(submission.resolve, submission.reject)
        } catch (error) {
          submission.reject(error)
        }
      }
    })
  }, [commitRevision])
  const submit = useCallback(
    (
      options: ExpoTurboFormSubmitOptions,
      controllerOptions?: FormSubmissionControllerSubmitOptions,
    ): Promise<ActiveFormSubmissionReport> => {
      if (inert) refuseInertFormOwner("submission", inert)
      if (!formSubmitAfterCommit(options)) return registry.submit(options, controllerOptions)
      if (!mounted.current) {
        return Promise.reject(new StateError("Deferred form submission lost its React binding"))
      }

      return new Promise<ActiveFormSubmissionReport>((resolve, reject) => {
        const nextCommitRevision = requestedCommitRevision.current + 1
        requestedCommitRevision.current = nextCommitRevision
        const submission: DeferredFormSubmission = {
          commitRevision: nextCommitRevision,
          ...(controllerOptions !== undefined ? { controllerOptions } : {}),
          options,
          registry,
          reject,
          resolve,
        }
        pendingSubmissions.current.add(submission)
        deferredSubmissions.current.push(submission)
        startTransition(() => {
          scheduleCommit((revision) => Math.max(revision, nextCommitRevision))
        })
      })
    },
    [inert, registry],
  )
  const submissionInterception = useCallback(
    (options?: SuccessfulFormEntriesOptions) => registry.submissionInterception(options),
    [registry],
  )
  return useMemo<ExpoTurboFormBinding>(
    () =>
      Object.freeze({
        accessibilityState: Object.freeze({ busy: state.busy }),
        cancelSubmission: () => registry.cancelSubmission(),
        checkValidity: () => registry.checkValidity(),
        dismissTerminal: () => registry.dismissSubmissionTerminal(),
        formNodeKey,
        requestPlan: (options: ActiveFormRequestPlanOptions) =>
          inert ? refuseInertFormOwner("request planning", inert) : registry.requestPlan(options),
        retryFailure: (
          options: ActiveFormRetryOptions,
          controllerOptions?: FormSubmissionControllerSubmitOptions,
        ) =>
          inert
            ? refuseInertFormOwner("retry", inert)
            : registry.retryFailure(options, controllerOptions),
        reportValidity: () => registry.reportValidity(),
        state,
        shouldInterceptSubmission: (options?: SuccessfulFormEntriesOptions) =>
          submissionInterception(options).intercepted,
        submit,
        submissionInterception,
        submissionProposal: (options: ActiveFormSubmissionProposalOptions) =>
          inert
            ? refuseInertFormOwner("submission proposal", inert)
            : registry.submissionProposal(options),
        successfulEntries: (options?: SuccessfulFormEntriesOptions) =>
          registry.successfulEntries(options),
        terminalState,
      }),
    [formNodeKey, inert, registry, state, submissionInterception, submit, terminalState],
  )
}

type FormOwnerLookup = Readonly<{
  issues: readonly RegistryVocabularyIssue[]
  status: "declared" | "undeclared" | "unknown"
}>

/**
 * Classifies a form-association target the same way the render decode path
 * classifies any element: a tag this client does not know is deployment skew
 * reported as unknown vocabulary, not a failed association.
 *
 * The decode runs even when `resolve` knows the tag, because an owner that the
 * document never renders has no other reporter for its unknown attributes.
 */
function lookupFormOwner(registry: RenderRegistry, element: ProtocolElement): FormOwnerLookup {
  const result = registry.decodeForRender(element)
  const decoded = result.status === "decoded" ? result.decoded.definition : result.definition
  const definition = decoded ?? registry.resolve?.(element.tagName)
  return Object.freeze({
    issues: result.issues,
    status: !definition ? "unknown" : definition.formOwner ? "declared" : "undeclared",
  })
}

const MISSING_FORM_SCOPE_MESSAGE =
  "Expo Turbo form binding requires a form scope or explicit form association"

/**
 * Finds the nearest ancestor the render path unwrapped because of vocabulary:
 * a tag this client does not have, or one whose required attributes or child
 * shape it could not decode. Both are installed-client skew, and either can
 * remove an element that carried a form scope in the build that served the
 * document.
 *
 * This is evidence that vocabulary was unwrapped above a failed association,
 * and nothing more. It cannot show that the unwrapped element was the form
 * owner: the client does not have the tag, so a new layout wrapper and a new
 * form owner look identical from here. Unwrapping never breaks a real
 * ownership chain — a control under a declared owner still resolves through an
 * unwrapped ancestor, and a declared owner that unwraps keeps its form scope —
 * so this only runs once the association has already failed.
 */
function unwrappedAncestorVocabulary(
  registry: RenderRegistry,
  element: ProtocolElement,
): Readonly<{ issues: readonly RegistryVocabularyIssue[]; node: ProtocolElement }> | undefined {
  let ancestor: ProtocolParentNode | null = element.parent
  while (ancestor) {
    if (isElement(ancestor)) {
      let result: RegistryRenderDecodeResult<RegistryComponent>
      try {
        result = registry.decodeForRender(ancestor)
      } catch {
        // A malformed ancestor is a fatal document problem that the render path
        // raises on its own. It is not evidence of installed-client skew, so the
        // walk stops rather than attributing this failure to vocabulary.
        return undefined
      }
      if (result.status === "transparent" && result.issues.length > 0) {
        return Object.freeze({ issues: result.issues, node: ancestor })
      }
    }
    ancestor = ancestor.parent
  }
  return undefined
}

function useResolvedFormRegistry(): Readonly<{
  formNodeKey: string
  inert?: FormOwnerVocabularyMetadata
  registry: FormControlRegistry
}> {
  const { forms, onUnknownVocabulary, registry: componentRegistry, session } = useRenderer()
  const context = useContext(FormContext)
  const nodeKey = useContext(ProtocolNodeContext)
  const nodeSnapshot = useProtocolNode(nodeKey ?? MISSING_FORM_OWNER_KEY)
  const node = nodeSnapshot?.node
  const formId = node && isElement(node) ? attributeValue(node, "form") : undefined
  const formNodeKey =
    formId !== undefined && formId !== ""
      ? `id:${formId}`
      : (context?.binding.formNodeKey ?? MISSING_FORM_OWNER_KEY)
  const formSnapshot = useProtocolNode(formNodeKey)
  const form = formId ? session.tree.getElementById(formId) : undefined
  const owner =
    form && formSnapshot?.node === form ? lookupFormOwner(componentRegistry, form) : undefined
  useUnknownVocabularyReport(owner ? form : undefined, owner?.issues ?? NO_VOCABULARY_ISSUES)

  if (!forms) throw new RegistryError("Expo Turbo forms require provider form controls")
  if (!nodeKey || !node || !isElement(node)) {
    throw new RegistryError("Expo Turbo form association requires an active component element")
  }
  if (formId === "") {
    throw new RegistryError("Expo Turbo form association must not be blank")
  }
  if (formId === undefined) {
    if (!context) {
      // A control orphaned in a fully known document keeps the bare throw: the
      // signal below must stay rare enough that it means skew, not noise on
      // every ownerless control.
      const unwrapped = unwrappedAncestorVocabulary(componentRegistry, node)
      throw unwrapped
        ? new AttributedFormOwnerError(MISSING_FORM_SCOPE_MESSAGE, {
            // `nodeKey` and `tag` keep describing one element, the unwrapped
            // ancestor the issues belong to. The control this failed on travels
            // separately, so a host can correlate without the pair ever
            // describing two different elements.
            ...(nodeSnapshot ? { failure: { identity: nodeSnapshot.identity, nodeKey } } : {}),
            generation: session.treeGeneration,
            handler: onUnknownVocabulary,
            issues: unwrapped.issues,
            node: unwrapped.node,
            registry: componentRegistry,
            session,
          })
        : new RegistryError(MISSING_FORM_SCOPE_MESSAGE)
    }
    return Object.freeze({
      formNodeKey: context.binding.formNodeKey,
      registry: context.registry,
    })
  }

  if (!form || formSnapshot?.node !== form) {
    throw new RegistryError("Expo Turbo form association references a missing form owner")
  }
  const vocabulary = form
    ? Object.freeze({
        generation: session.treeGeneration,
        handler: onUnknownVocabulary,
        issues: owner?.issues ?? NO_VOCABULARY_ISSUES,
        node: form,
        registry: componentRegistry,
        session,
      })
    : undefined
  if (owner?.status === "undeclared" && vocabulary) {
    // The throw preempts the reporting effect, so the owner's issues ride along
    // and the boundary delivers them once this render commits.
    throw new AttributedFormOwnerError(
      "Expo Turbo form association target is not a declared form owner",
      vocabulary,
    )
  }
  // An unknown owner tag keeps the control bound to the owner's node key so its
  // disabled and pending state stay coherent and the association becomes live
  // as soon as a known form owner occupies that key. Until then the binding is
  // inert: nothing it exposes can build or dispatch a request.
  return Object.freeze({
    formNodeKey: form.key,
    ...(owner?.status === "unknown" && vocabulary ? { inert: vocabulary } : {}),
    registry: forms.controlsFor(form.key),
  })
}

function reportFormAnnouncementError(
  onError: ((event: ExpoTurboRenderError) => void) | undefined,
  nodeKey: string,
  cause: unknown,
): void {
  const error =
    cause instanceof Error
      ? cause
      : new RegistryError("Form submission announcement adapter failed")
  if (!onError) {
    queueMicrotask(() => {
      throw error
    })
    return
  }
  try {
    onError({ error, nodeKey, severity: "background" })
  } catch (reporterError) {
    queueMicrotask(() => {
      throw new AggregateError(
        [error, reporterError],
        "Form submission announcement error reporter failed",
      )
    })
  }
}

function reportDocumentVisitAnnouncementError(
  onError: ((event: ExpoTurboRenderError) => void) | undefined,
  nodeKey: string,
  cause: unknown,
): void {
  const error =
    cause instanceof Error ? cause : new RegistryError("Document visit announcement adapter failed")
  if (!onError) {
    queueMicrotask(() => {
      throw error
    })
    return
  }
  try {
    onError({ error, nodeKey, severity: "background" })
  } catch (reporterError) {
    queueMicrotask(() => {
      throw new AggregateError(
        [error, reporterError],
        "Document visit announcement error reporter failed",
      )
    })
  }
}

function claimFormTerminalAnnouncement(
  session: DocumentSession,
  form: ProtocolElement,
  revision: number,
): boolean {
  let formRevisions = announcedFormTerminalRevisions.get(session)
  if (!formRevisions) {
    formRevisions = new WeakMap()
    announcedFormTerminalRevisions.set(session, formRevisions)
  }
  const announcedRevision = formRevisions.get(form) ?? -1
  if (announcedRevision >= revision) return false
  formRevisions.set(form, revision)
  return true
}

function claimDocumentVisitAnnouncement(
  controller: DocumentVisitController,
  revision: number,
  status: DocumentVisitAnnouncementEvent["status"],
): boolean {
  const announced = announcedDocumentVisitStates.get(controller)
  if (announced?.revision === revision || announced?.status === status) return false
  announcedDocumentVisitStates.set(controller, Object.freeze({ revision, status }))
  return true
}

/**
 * Declares that the current registered component owns a logical native form.
 * The host-owned DocumentFormControls collection deliberately outlives React
 * effect replay; exact tree replacement remains its disposal boundary.
 */
export function ExpoTurboFormScope(props: ExpoTurboFormScopeProps): ReactNode {
  const { formAnnouncements, formComponent: FormComponent, forms, onError, session } = useRenderer()
  const definition = useContext(ComponentDefinitionContext)
  const nodeKey = useContext(ProtocolNodeContext)
  if (!forms) throw new RegistryError("Expo Turbo forms require provider form controls")
  if (!nodeKey) throw new RegistryError("Expo Turbo forms require a component node")
  const formNode = session.tree.getNodeByKey(nodeKey)
  if (!formNode || !isElement(formNode)) {
    throw new RegistryError("Expo Turbo forms require an active component element")
  }
  if (!definition?.formOwner) {
    throw new RegistryError("Expo Turbo form scope requires a declared form-owner component")
  }
  const registry = useMemo(() => forms.controlsFor(nodeKey), [forms, nodeKey])
  useEffect(() => {
    const release = registry.retainSubmissionScope()
    return () => queueMicrotask(release)
  }, [registry])
  const binding = useFormBinding(registry, nodeKey)
  const { terminalState } = binding
  const announcementBaseline = useRef({ node: formNode, revision: terminalState.revision })
  useEffect(() => {
    const baseline = announcementBaseline.current
    announcementBaseline.current = { node: formNode, revision: terminalState.revision }
    if (
      baseline.node !== formNode ||
      baseline.revision === terminalState.revision ||
      terminalState.status === "none" ||
      !formAnnouncements ||
      registry.submissionState.busy ||
      registry.submissionTerminalState !== terminalState ||
      session.tree.getNodeByKey(nodeKey) !== formNode
    ) {
      return
    }
    if (!claimFormTerminalAnnouncement(session, formNode, terminalState.revision)) return
    const event = Object.freeze({
      formNodeKey: nodeKey,
      terminalState: terminalState as FormSubmissionAnnouncementTerminalSnapshot,
    }) satisfies FormSubmissionAnnouncementEvent
    try {
      const delivery = formAnnouncements.announce(event)
      if (delivery) {
        void Promise.resolve(delivery).catch((error: unknown) => {
          reportFormAnnouncementError(onError, nodeKey, error)
        })
      }
    } catch (error) {
      reportFormAnnouncementError(onError, nodeKey, error)
    }
  }, [formAnnouncements, formNode, nodeKey, onError, registry, session, terminalState])
  const value = useMemo<ExpoTurboFormContextValue>(
    () => Object.freeze({ binding, registry }),
    [binding, registry],
  )
  // Host form chrome is visible output. A declared owner that unwraps still
  // mounts this scope, and the unwrapped node itself is never counted, so
  // without this the chrome would be output that nothing reports.
  const contents = FormComponent
    ? createElement(
        DocumentOutputMarker,
        { kind: "output" },
        createElement(FormComponent, { ...binding }, props.children),
      )
    : props.children
  return createElement(
    StateScopeBoundary,
    { kind: "form", nodeKey },
    createElement(FormContext.Provider, { value }, contents),
  )
}

export function useExpoTurboForm(): ExpoTurboFormBinding {
  const { formNodeKey, inert, registry } = useResolvedFormRegistry()
  return useFormBinding(registry, formNodeKey, inert)
}

export function useExpoTurboFormControl(
  descriptor: FormControlDescriptor,
): ExpoTurboFormControlBinding {
  const { session } = useRenderer()
  const { registry } = useResolvedFormRegistry()
  const nodeKey = useContext(ProtocolNodeContext)
  const direction = useContext(DirectionContext)
  const directionFallback = useContext(DirectionFallbackContext)
  const registration = useRef<FormControlRegistration | undefined>(undefined)
  if (!nodeKey) throw new RegistryError("Expo Turbo form controls require a component node")
  const node = session.tree.getNodeByKey(nodeKey)
  if (!node || !isElement(node)) {
    throw new RegistryError("Expo Turbo form controls require an active component element")
  }
  const dirname = attributeValue(node, "dirname")
  const effectiveDescriptor = useMemo<FormControlDescriptor>(() => {
    const resolvedDirection =
      direction === "ltr" || direction === "rtl"
        ? direction
        : descriptor.kind === "value"
          ? inferredFormControlDirection(descriptor.value, directionFallback)
          : undefined
    if (
      (descriptor.kind !== "value" && descriptor.kind !== "hidden") ||
      descriptor.directionality !== undefined ||
      !dirname?.trim() ||
      resolvedDirection === undefined
    ) {
      return descriptor
    }
    return Object.freeze({
      ...descriptor,
      directionality: Object.freeze({ name: dirname, value: resolvedDirection }),
    })
  }, [descriptor, direction, directionFallback, dirname])
  const descriptorRef = useRef(effectiveDescriptor)

  const subscribe = useCallback(
    (listener: () => void) => registry.subscribeControlSubmission(nodeKey, listener),
    [nodeKey, registry],
  )
  const snapshot = useCallback(
    (): FormSubmitterActivitySnapshot => registry.controlSubmissionState(nodeKey),
    [nodeKey, registry],
  )
  const submissionState = useSyncExternalStore(subscribe, snapshot, snapshot)
  const subscribeInheritedDisabled = useCallback(
    (listener: () => void) => registry.subscribeControlInheritedDisabled(nodeKey, listener),
    [nodeKey, registry],
  )
  const inheritedDisabledSnapshot = useCallback(
    () => registry.controlInheritedDisabled(nodeKey),
    [nodeKey, registry],
  )
  const inheritedDisabled = useSyncExternalStore(
    subscribeInheritedDisabled,
    inheritedDisabledSnapshot,
    inheritedDisabledSnapshot,
  )
  const disabled =
    effectiveDescriptor.disabled === true || inheritedDisabled || submissionState.pending

  useLayoutEffect(() => {
    descriptorRef.current = effectiveDescriptor
    registration.current?.update(effectiveDescriptor)
  }, [effectiveDescriptor])
  useLayoutEffect(() => {
    const current = registry.register(nodeKey, descriptorRef.current)
    registration.current = current
    return () => {
      if (registration.current === current) registration.current = undefined
      current.unregister()
    }
  }, [nodeKey, registry])

  return useMemo(
    () =>
      Object.freeze({
        accessibilityState: Object.freeze({ disabled }),
        disabled,
        nodeKey,
        pending: submissionState.pending,
        selection: () => {
          const current = registration.current
          if (!current) throw new StateError("Form control registration is not active")
          return current.selection
        },
        ...(submissionState.submitsWith !== undefined
          ? { submitsWith: submissionState.submitsWith }
          : {}),
      }),
    [disabled, nodeKey, submissionState],
  )
}

export function useNodeDisposal(dispose: () => void): void {
  const { session } = useRenderer()
  const nodeKey = useContext(ProtocolNodeContext)
  const disposeRef = useRef(dispose)
  disposeRef.current = dispose
  if (!nodeKey) throw new RegistryError("Expo Turbo node disposal requires a component node")
  useEffect(() => {
    let disposed = false
    const disposeOnce = () => {
      if (disposed) return
      disposed = true
      disposeRef.current()
    }
    const unregister = session.registerDisposal(nodeKey, disposeOnce)
    return () => {
      unregister()
      disposeOnce()
    }
  }, [nodeKey, session])
}

export function useFrameControllerState(controller: FrameController): FrameControllerSnapshot {
  const subscribe = useCallback(
    (listener: () => void) => controller.subscribe(listener),
    [controller],
  )
  const snapshot = useCallback(() => controller.state, [controller])
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

export function useDocumentVisitControllerState(
  controller: DocumentVisitController,
): DocumentVisitSnapshot {
  const subscribe = useCallback(
    (listener: () => void) => controller.subscribe(listener),
    [controller],
  )
  const snapshot = useCallback(() => controller.state, [controller])
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

export function useExpoTurboDocument(): ExpoTurboDocumentBinding | undefined {
  return useContext(DocumentContext)
}

export type ExpoTurboDocumentReload = (options?: DocumentReloadOptions) => Promise<void>

export function useDocumentReload(): ExpoTurboDocumentReload {
  const controller = useContext(DocumentContext)?.controller
  const reload = useCallback(
    async (options?: DocumentReloadOptions) => {
      if (!controller) throw new RegistryError("Expo Turbo document reload requires a document")
      await controller.reload(options)
    },
    [controller],
  )
  if (!controller) throw new RegistryError("Expo Turbo document reload requires a document")
  return reload
}

export type ExpoTurboDirection = ProtocolDirection

/** The nearest XML `dir` value, or `undefined` when the host should use its default direction. */
export function useExpoTurboDirection(): ExpoTurboDirection | undefined {
  return useContext(DirectionContext)
}

export type ExpoTurboDocumentLinkDelegation =
  | DocumentVisitDelegation
  | Readonly<{
      filename?: string
      kind: "download"
      status: "delegated"
      url: string
    }>
  | Readonly<{
      kind: "browsing-context"
      status: "delegated"
      target: string
      url: string
    }>
  | Readonly<{
      kind: "external"
      reason: "opt-out"
      status: "delegated"
      url: string
    }>
  | Readonly<{
      kind: "external"
      reason: "scheme"
      scheme: ExternalDocumentLinkScheme
      status: "delegated"
      url: string
    }>
  | Readonly<{
      action: "advance"
      kind: "navigation"
      reason: "form-mode-off" | "opt-out" | "unknown-vocabulary"
      status: "delegated"
      url: string
    }>

export type ExpoTurboDocumentLinkAnchor = Readonly<{
  kind: "anchor"
  status: "requested"
  targetId: string
  url: string
}>

export type ExpoTurboDocumentLinkResult =
  | DocumentVisitResult
  | ExpoTurboDocumentLinkAnchor
  | ExpoTurboDocumentLinkDelegation
  | FormSubmissionReport
  | Readonly<{
      kind: "link"
      status: "canceled"
      url: string
    }>
  | Readonly<{
      kind: "disabled"
      status: "ignored"
    }>
  | FrameVisitResult

export type ExpoTurboDocumentLinkActivation = () => Promise<ExpoTurboDocumentLinkResult>

export function useExpoTurboDocumentLink(href: string): ExpoTurboDocumentLinkActivation {
  const {
    documentAnchorScroll,
    documentAutomaticPreloadPolicy,
    documentController,
    documentLinks,
    documentPreloader,
    formLinks,
    framePreloader,
    frames,
    onError,
    session,
  } = useRenderer()
  const navigation = useContext(NavigationContext)
  const nodeKey = useContext(ProtocolNodeContext)
  const node = nodeKey ? session.tree.getNodeByKey(nodeKey) : undefined
  const link = node && isElement(node) ? node : undefined
  const rawHref = link ? attributeValue(link, "href") : undefined
  const rawTurboMethod = link ? attributeValue(link, "data-turbo-method") : undefined
  const rawTurboStream = link ? attributeValue(link, "data-turbo-stream") : undefined
  useAutomaticDocumentPreloadRevision(
    session,
    link,
    documentPreloader !== undefined || framePreloader !== undefined,
  )
  const mounted = useRef(true)
  const completedFramePreload = useRef<string | undefined>(undefined)
  const onErrorRef = useRef(onError)
  const automaticPreloadConfiguration = useRef({
    documentAutomaticPreloadPolicy,
    documentPreloader,
    framePreloader,
    href,
    link,
    nodeKey,
    rawHref,
    session,
  })
  useLayoutEffect(() => {
    onErrorRef.current = onError
  }, [onError])
  useLayoutEffect(() => {
    automaticPreloadConfiguration.current = {
      documentAutomaticPreloadPolicy,
      documentPreloader,
      framePreloader,
      href,
      link,
      nodeKey,
      rawHref,
      session,
    }
  }, [
    documentAutomaticPreloadPolicy,
    documentPreloader,
    framePreloader,
    href,
    link,
    nodeKey,
    rawHref,
    session,
  ])
  useLayoutEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const automaticPreloadUrl =
    documentPreloader && link
      ? automaticDocumentPreloadUrl(session, link, href, rawHref)
      : undefined
  useLayoutEffect(() => {
    const configuration = automaticPreloadConfiguration.current
    if (
      !mounted.current ||
      configuration.documentAutomaticPreloadPolicy !== documentAutomaticPreloadPolicy ||
      configuration.documentPreloader !== documentPreloader ||
      configuration.href !== href ||
      configuration.link !== link ||
      configuration.nodeKey !== nodeKey ||
      configuration.rawHref !== rawHref ||
      configuration.session !== session ||
      !documentPreloader ||
      !automaticPreloadUrl ||
      !nodeKey ||
      !link ||
      session.tree.getNodeByKey(nodeKey) !== link
    ) {
      return
    }
    const activeLink = link
    const linkNodeKey = nodeKey
    const isCurrentAutomaticPreload = () =>
      mounted.current &&
      automaticPreloadConfiguration.current === configuration &&
      session.tree.getNodeByKey(linkNodeKey) === activeLink &&
      automaticDocumentPreloadUrl(session, activeLink, href, rawHref) === automaticPreloadUrl
    let active = true
    const deactivate = () => {
      active = false
    }
    const policyAllowsPreload = () => {
      if (documentAutomaticPreloadPolicy === undefined) return true
      let allowed: unknown
      try {
        allowed = documentAutomaticPreloadPolicy.canPreload(automaticPreloadUrl)
      } catch {
        allowed = undefined
      }
      if (typeof allowed === "boolean") {
        if (!isCurrentAutomaticPreload()) return false
        return allowed
      }
      consumeUnexpectedAdapterResult(allowed)
      if (!isCurrentAutomaticPreload()) return false
      queueMicrotask(() => {
        if (!active || !isCurrentAutomaticPreload()) return
        const observer = onErrorRef.current
        if (!observer) return
        try {
          observer({
            error: new StateError("Automatic document preload policy check failed"),
            nodeKey: linkNodeKey,
            severity: "speculative",
          })
        } catch {
          queueMicrotask(() => {
            throw new StateError("Automatic document preload policy error reporting failed")
          })
        }
      })
      return false
    }
    if (!policyAllowsPreload()) return deactivate
    if (!isCurrentAutomaticPreload()) return deactivate

    const preload = () => {
      if (!active || !isCurrentAutomaticPreload()) return
      let request: Promise<unknown>
      try {
        request = documentPreloader.preload(automaticPreloadUrl)
      } catch (error) {
        request = Promise.reject(error)
      }
      void Promise.resolve(request).catch((error) => {
        if (!active || !isCurrentAutomaticPreload()) return
        if (requestLifecycleDefaultHandlingPrevented(error)) return
        const observer = onErrorRef.current
        if (!observer) return
        try {
          observer({
            error:
              error instanceof ExpoTurboError
                ? error
                : new RequestError("Automatic document preload failed"),
            nodeKey: linkNodeKey,
            severity: "speculative",
          })
        } catch {
          queueMicrotask(() => {
            throw new StateError("Automatic document preload error reporting failed")
          })
        }
      })
    }
    if (documentAutomaticPreloadPolicy === undefined) preload()
    else queueMicrotask(preload)
    return deactivate
  }, [
    automaticPreloadUrl,
    documentAutomaticPreloadPolicy,
    documentPreloader,
    href,
    link,
    nodeKey,
    rawHref,
    session,
  ])
  const automaticFramePreload =
    framePreloader && link ? automaticFramePreloadTarget(session, link, href, rawHref) : undefined
  useLayoutEffect(() => {
    const configuration = automaticPreloadConfiguration.current
    if (
      !mounted.current ||
      configuration.framePreloader !== framePreloader ||
      configuration.href !== href ||
      configuration.link !== link ||
      configuration.nodeKey !== nodeKey ||
      configuration.rawHref !== rawHref ||
      configuration.session !== session ||
      !framePreloader ||
      !automaticFramePreload ||
      !nodeKey ||
      !link ||
      session.tree.getNodeByKey(nodeKey) !== link
    ) {
      return
    }
    const activeLink = link
    const linkNodeKey = nodeKey
    const preload = automaticFramePreload
    const preloadKey = `${preload.frameId}\n${preload.url}`
    if (completedFramePreload.current === preloadKey) return
    const isCurrent = () => {
      if (
        !mounted.current ||
        automaticPreloadConfiguration.current !== configuration ||
        session.tree.getNodeByKey(linkNodeKey) !== activeLink
      ) {
        return false
      }
      const current = automaticFramePreloadTarget(session, activeLink, href, rawHref)
      return current?.frameId === preload.frameId && current.url === preload.url
    }
    let active = true
    let request: ReturnType<FramePreloadRequester["preload"]>
    try {
      request = framePreloader.preload(preload.frameId, preload.url)
    } catch (error) {
      request = Promise.reject(error)
    }
    void Promise.resolve(request).then(
      (report) => {
        if (
          active &&
          isCurrent() &&
          (report.status === "cached" || report.status === "hit" || report.status === "superseded")
        ) {
          completedFramePreload.current = preloadKey
        }
      },
      (error) => {
        if (!active || !isCurrent() || requestLifecycleDefaultHandlingPrevented(error)) return
        const observer = onErrorRef.current
        if (!observer) return
        try {
          observer({
            error:
              error instanceof ExpoTurboError
                ? error
                : new RequestError("Automatic Frame preload failed"),
            nodeKey: linkNodeKey,
            severity: "speculative",
          })
        } catch {
          queueMicrotask(() => {
            throw new StateError("Automatic Frame preload error reporting failed")
          })
        }
      },
    )
    return () => {
      active = false
    }
  }, [automaticFramePreload, framePreloader, href, link, nodeKey, rawHref, session])
  const activate = useCallback(async () => {
    if (!documentController || !nodeKey || !node || !isElement(node)) {
      throw new TargetError("Document link is outside the active document")
    }
    if (session.tree.getNodeByKey(nodeKey) !== node) {
      throw new TargetError("Document link is outside the active document")
    }
    if (attributeValue(node, "href") !== rawHref) {
      throw new TargetError("Document link href changed before activation")
    }
    if (attributeValue(node, "disabled") !== undefined) {
      return Object.freeze({ kind: "disabled", status: "ignored" })
    }
    for (const name of UNSUPPORTED_DOCUMENT_LINK_ATTRIBUTES) {
      if (attributeValue(node, name) !== undefined) {
        throw new TargetError("Document link metadata requires unsupported navigation behavior")
      }
    }
    const documentUrl = session.tree.document.url
    if (!documentUrl) throw new TargetError("Document links require an active document URL")
    const browserTarget = attributeValue(node, "target")
    const download = attributeValue(node, "download")
    if (
      download !== undefined ||
      (browserTarget !== undefined && browserTarget !== "" && browserTarget !== "_self")
    ) {
      if (!documentLinks) {
        throw new TargetError("Document link metadata requires provider documentLinks support")
      }
      const delegated = resolveDocumentLinkUrl(href, documentUrl)
      const url = delegated.kind === "external" ? delegated.url : delegated.resolution.url
      try {
        if (download !== undefined) {
          const filename = download === "" ? undefined : download
          const result = await documentLinks.download(
            Object.freeze({
              ...(filename !== undefined ? { filename } : {}),
              url,
            }),
          )
          if (result !== undefined) throw new StateError("Document link host delegation failed")
          return Object.freeze({
            ...(filename !== undefined ? { filename } : {}),
            kind: "download" as const,
            status: "delegated" as const,
            url,
          })
        }
        if (!browserTarget) {
          throw new TargetError("Document link browsing context target is invalid")
        }
        const result = await documentLinks.openBrowsingContext(
          Object.freeze({ target: browserTarget, url }),
        )
        if (result !== undefined) throw new StateError("Document link host delegation failed")
        return Object.freeze({
          kind: "browsing-context" as const,
          status: "delegated" as const,
          target: browserTarget,
          url,
        })
      } catch (error) {
        if (error instanceof TargetError) throw error
        throw new StateError("Document link host delegation failed")
      }
    }
    const actionValue = attributeValue(node, "data-turbo-action")
    const action = exactVisitAction(actionValue)
    const anchor = href.includes("#") ? resolveDocumentLinkAnchor(href, documentUrl) : undefined
    const captureContext = documentLinkCaptureContext(node)
    const { elementTarget, nearestFrameId, optedOut } = captureContext
    if (
      anchor &&
      !optedOut &&
      nearestFrameId !== null &&
      actionValue === undefined &&
      !UNSUPPORTED_DOCUMENT_PREFETCH_ATTRIBUTES.some((name) => hasProtocolAttribute(node, name))
    ) {
      const target = session.tree.getElementById(anchor.targetId)
      const sourceFrameScope = documentAnchorFrameScope(node)
      const destinationFrameScope = documentAnchorDestinationScope(session, node, elementTarget)
      const targetFrameScope = target ? documentAnchorFrameScope(target) : null
      if (
        sourceFrameScope === null ||
        sourceFrameScope !== nearestFrameId ||
        targetFrameScope !== destinationFrameScope
      ) {
        throw new TargetError("Document link anchor target is unavailable")
      }
      if (!dispatchDocumentVisitLinkClick(documentController, nodeKey, anchor.url)) {
        return Object.freeze({
          kind: "link" as const,
          status: "canceled" as const,
          url: anchor.url,
        })
      }
      if (
        session.tree.getNodeByKey(nodeKey) !== node ||
        attributeValue(node, "href") !== rawHref ||
        attributeValue(node, "disabled") !== undefined
      ) {
        throw new TargetError("Document link anchor changed before activation")
      }
      const confirmedDocumentUrl = session.tree.document.url
      if (!confirmedDocumentUrl) {
        throw new TargetError("Document links require an active document URL")
      }
      const confirmedAnchor = href.includes("#")
        ? resolveDocumentLinkAnchor(href, confirmedDocumentUrl)
        : undefined
      const confirmedCaptureContext = documentLinkCaptureContext(node)
      const confirmedTarget = confirmedAnchor
        ? session.tree.getElementById(confirmedAnchor.targetId)
        : undefined
      const confirmedBrowserTarget = attributeValue(node, "target")
      if (
        !confirmedAnchor ||
        confirmedAnchor.targetId !== anchor.targetId ||
        confirmedAnchor.url !== anchor.url ||
        (confirmedBrowserTarget !== undefined &&
          confirmedBrowserTarget !== "" &&
          confirmedBrowserTarget !== "_self") ||
        confirmedCaptureContext.optedOut ||
        confirmedCaptureContext.nearestFrameId !== sourceFrameScope ||
        confirmedCaptureContext.elementTarget !== elementTarget ||
        attributeValue(node, "data-turbo-action") !== undefined ||
        UNSUPPORTED_DOCUMENT_PREFETCH_ATTRIBUTES.some((name) => hasProtocolAttribute(node, name)) ||
        !confirmedTarget ||
        documentAnchorFrameScope(node) !== sourceFrameScope ||
        documentAnchorDestinationScope(session, node, confirmedCaptureContext.elementTarget) !==
          destinationFrameScope ||
        documentAnchorFrameScope(confirmedTarget) !== destinationFrameScope
      ) {
        throw new TargetError("Document link anchor changed before activation")
      }
      if (documentController.state.busy) {
        throw new TargetError("Document link anchors require an idle document")
      }
      requestDocumentAnchorScroll(documentAnchorScroll, anchor.targetId)
      return Object.freeze({
        kind: "anchor" as const,
        status: "requested" as const,
        targetId: anchor.targetId,
        url: anchor.url,
      })
    }
    const fragment = href.includes("#") ? resolveDocumentLinkFragment(href, documentUrl) : undefined
    const frameFragment =
      fragment && documentAnchorDestinationScope(session, node, elementTarget) !== undefined
        ? fragment
        : undefined
    const linkUrl = resolveDocumentLinkUrl(frameFragment?.requestUrl ?? href, documentUrl)
    if (linkUrl.kind === "external") {
      if (!navigation) throw new TargetError("Document link delegation requires host navigation")
      await navigation.openExternal(linkUrl.url)
      return Object.freeze({
        kind: "external",
        reason: "scheme",
        scheme: linkUrl.scheme,
        status: "delegated",
        url: linkUrl.url,
      })
    }
    const resolved = linkUrl.resolution
    const documentVisitOptions = navigation ? { navigation } : {}
    const disposition = classifyTopLevelLocation(session.tree, resolved.url)
    const delegateNativeNavigation = async (
      reason: "form-mode-off" | "opt-out" | "unknown-vocabulary",
    ) => {
      if (!navigation) throw new TargetError("Document link delegation requires host navigation")
      if (reason === "opt-out" && resolved.urlOrigin !== resolved.documentOrigin) {
        await navigation.openExternal(resolved.url)
        return Object.freeze({
          kind: "external" as const,
          reason,
          status: "delegated" as const,
          url: resolved.url,
        })
      }
      await navigation.visit(resolved.url, "advance")
      return Object.freeze({
        action: "advance" as const,
        kind: "navigation" as const,
        reason,
        status: "delegated" as const,
        url: resolved.url,
      })
    }
    if (!optedOut && disposition.classification !== "visitable") {
      if (!navigation) throw new TargetError("Document link delegation requires host navigation")
      if (disposition.classification === "external") {
        await navigation.openExternal(disposition.url)
        return Object.freeze({
          kind: "external",
          reason: "external",
          status: "delegated",
          url: disposition.url,
        })
      }
      await navigation.visit(disposition.url, "advance")
      return Object.freeze({
        action: "advance",
        kind: "navigation",
        reason: disposition.classification,
        status: "delegated",
        url: disposition.url,
      })
    }
    const turboMethod = attributeValue(node, "data-turbo-method")
    const turboStream = attributeValue(node, "data-turbo-stream")
    if (
      !optedOut &&
      (rawTurboMethod !== undefined ||
        rawTurboStream !== undefined ||
        turboMethod !== undefined ||
        turboStream !== undefined)
    ) {
      if (turboMethod !== rawTurboMethod || turboStream !== rawTurboStream) {
        throw new TargetError("Generated form link metadata changed before activation")
      }
      if (!formLinks) {
        throw new TargetError("Generated form links require provider form-link submissions")
      }
      const interception = formLinks.submissionInterception(node.key)
      if (!interception.intercept) {
        if (interception.reason === "missing-metadata") {
          throw new TargetError("Generated form link metadata changed before activation")
        }
        return delegateNativeNavigation(interception.reason)
      }
      return formLinks.submit(node.key, href)
    }
    if (
      !optedOut &&
      !dispatchDocumentVisitLinkClick(
        documentController,
        nodeKey,
        frameFragment?.url ?? disposition.url,
      )
    ) {
      return Object.freeze({
        kind: "link",
        status: "canceled",
        url: disposition.url,
      })
    }
    if (!optedOut && nearestFrameId !== undefined) {
      if (!nearestFrameId) {
        throw new TargetError("Frame-scoped document links require an identified Frame")
      }
      if (!frames) {
        throw new TargetError("Frame-scoped document links require provider Frame controllers", {
          frameId: nearestFrameId,
        })
      }
      const frameAction = linkFrameVisitAction(actionValue)
      const result = await frames.visit(frameFragment?.url ?? disposition.url, {
        ...(frameAction !== undefined ? { action: frameAction } : {}),
        ...(elementTarget !== undefined ? { elementTarget } : {}),
        frame: nearestFrameId,
      })
      if (frameFragment && result.kind === "frame" && result.load?.status === "completed") {
        const target = session.tree.getElementById(frameFragment.targetId)
        if (!target || documentAnchorFrameScope(target) !== result.frameId) {
          throw new TargetError("Frame link anchor target is unavailable")
        }
        requestDocumentAnchorScroll(documentAnchorScroll, frameFragment.targetId)
      }
      return result
    }
    if (!optedOut && elementTarget && elementTarget !== "_top") {
      const targetFrame = session.tree.getElementById(elementTarget)
      if (targetFrame?.kind === "frame" && attributeValue(targetFrame, "disabled") === undefined) {
        if (!frames) {
          throw new TargetError("Named Frame document links require provider Frame controllers", {
            frameId: elementTarget,
          })
        }
        const frameAction = linkFrameVisitAction(actionValue)
        const result = await frames.visit(frameFragment?.url ?? disposition.url, {
          ...(frameAction !== undefined ? { action: frameAction } : {}),
          elementTarget,
          frame: elementTarget,
        })
        if (frameFragment && result.kind === "frame" && result.load?.status === "completed") {
          const target = session.tree.getElementById(frameFragment.targetId)
          if (!target || documentAnchorFrameScope(target) !== result.frameId) {
            throw new TargetError("Frame link anchor target is unavailable")
          }
          requestDocumentAnchorScroll(documentAnchorScroll, frameFragment.targetId)
        }
        return result
      }
    }
    if (optedOut) {
      return delegateNativeNavigation("opt-out")
    }
    return documentController.visit(disposition.url, {
      ...(action !== undefined ? { action } : {}),
      ...documentVisitOptions,
    })
  }, [
    documentAnchorScroll,
    documentController,
    documentLinks,
    formLinks,
    frames,
    href,
    navigation,
    node,
    nodeKey,
    rawHref,
    rawTurboMethod,
    rawTurboStream,
    session,
  ])
  if (!documentController) {
    throw new RegistryError("Expo Turbo document links require a provider visit controller")
  }
  if (!nodeKey) throw new RegistryError("Expo Turbo document links require a component node")
  if (!node || !isElement(node)) {
    throw new RegistryError("Expo Turbo document links require an active component element")
  }
  return activate
}

export interface ExpoTurboDocumentLinkPrefetch {
  (): void
  cancel(): void
  commit(): void
}

interface DocumentLinkPrefetchConfiguration {
  readonly documentController: DocumentVisitController | undefined
  readonly documentPrefetchPolicy: DocumentPrefetchPolicy | undefined
  readonly documentPreloader: DocumentPreloadRequester | undefined
  readonly href: string
  readonly link: ProtocolElement | undefined
  readonly nodeKey: string | undefined
  readonly rawHref: string | undefined
  readonly session: DocumentSession
}

interface ActiveDocumentLinkPrefetch {
  readonly commit: () => void
  readonly configuration: DocumentLinkPrefetchConfiguration
  readonly prefetchUrl: string
  readonly release: () => void
  committed: boolean
}

function reportDocumentLinkPrefetchError(
  onError: ((event: ExpoTurboRenderError) => void) | undefined,
  nodeKey: string,
  error: unknown,
): void {
  if (requestLifecycleDefaultHandlingPrevented(error) || !onError) return
  try {
    onError({
      error:
        error instanceof ExpoTurboError
          ? error
          : new RequestError("Document link press-in prefetch failed"),
      nodeKey,
      severity: "speculative",
    })
  } catch {
    queueMicrotask(() => {
      throw new StateError("Document link press-in prefetch error reporting failed")
    })
  }
}

export function useExpoTurboDocumentLinkPrefetch(href: string): ExpoTurboDocumentLinkPrefetch {
  const { documentController, documentPrefetchPolicy, documentPreloader, onError, session } =
    useRenderer()
  const nodeKey = useContext(ProtocolNodeContext)
  const node = nodeKey ? session.tree.getNodeByKey(nodeKey) : undefined
  const link = node && isElement(node) ? node : undefined
  const rawHref = link ? attributeValue(link, "href") : undefined
  const mounted = useRef(true)
  const onErrorRef = useRef(onError)
  const prefetchConfiguration = useRef<DocumentLinkPrefetchConfiguration>({
    documentController,
    documentPrefetchPolicy,
    documentPreloader,
    href,
    link,
    nodeKey,
    rawHref,
    session,
  })
  const activePrefetch = useRef<ActiveDocumentLinkPrefetch | undefined>(undefined)
  const reportLeaseFailure = useCallback((active: ActiveDocumentLinkPrefetch, error: unknown) => {
    const { configuration, prefetchUrl } = active
    const { link: activeLink, nodeKey: activeNodeKey, rawHref: activeRawHref } = configuration
    if (
      !mounted.current ||
      prefetchConfiguration.current !== configuration ||
      !activeLink ||
      !activeNodeKey ||
      configuration.session.tree.getNodeByKey(activeNodeKey) !== activeLink ||
      attributeValue(activeLink, "href") !== activeRawHref ||
      pressInDocumentPrefetchUrl(configuration.session, activeLink, configuration.href) !==
        prefetchUrl
    ) {
      return
    }
    reportDocumentLinkPrefetchError(onErrorRef.current, activeNodeKey, error)
  }, [])
  const releaseActivePrefetch = useCallback(
    (active: ActiveDocumentLinkPrefetch) => {
      try {
        active.release()
      } catch (error) {
        reportLeaseFailure(active, error)
      }
    },
    [reportLeaseFailure],
  )
  useLayoutEffect(() => {
    onErrorRef.current = onError
  }, [onError])
  useLayoutEffect(() => {
    const configuration: DocumentLinkPrefetchConfiguration = {
      documentController,
      documentPrefetchPolicy,
      documentPreloader,
      href,
      link,
      nodeKey,
      rawHref,
      session,
    }
    prefetchConfiguration.current = configuration
    const active = activePrefetch.current
    if (active && active.configuration !== configuration && !active.committed) {
      activePrefetch.current = undefined
      releaseActivePrefetch(active)
    }
  }, [
    documentController,
    documentPrefetchPolicy,
    documentPreloader,
    href,
    link,
    nodeKey,
    rawHref,
    releaseActivePrefetch,
    session,
  ])
  useLayoutEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      const active = activePrefetch.current
      activePrefetch.current = undefined
      if (active && !active.committed) releaseActivePrefetch(active)
    }
  }, [releaseActivePrefetch])

  const prefetch = useCallback(() => {
    const prior = activePrefetch.current
    if (prior && !prior.committed) {
      activePrefetch.current = undefined
      releaseActivePrefetch(prior)
    }
    const configuration = prefetchConfiguration.current
    if (
      configuration.documentPreloader !== documentPreloader ||
      configuration.documentController !== documentController ||
      configuration.documentPrefetchPolicy !== documentPrefetchPolicy ||
      configuration.href !== href ||
      configuration.link !== link ||
      configuration.nodeKey !== nodeKey ||
      configuration.rawHref !== rawHref ||
      configuration.session !== session ||
      !mounted.current ||
      !documentPreloader ||
      !nodeKey ||
      !link ||
      attributeValue(link, "href") !== rawHref ||
      session.tree.getNodeByKey(nodeKey) !== link
    ) {
      return
    }
    const prefetchUrl = pressInDocumentPrefetchUrl(session, link, href)
    if (!prefetchUrl) return
    const policyAllowsPrefetch = () => {
      if (documentPrefetchPolicy === undefined) return true
      let allowed: unknown
      try {
        allowed = documentPrefetchPolicy.canPrefetch(prefetchUrl)
      } catch {
        allowed = undefined
      }
      if (typeof allowed === "boolean") return allowed
      consumeUnexpectedAdapterResult(allowed)
      const observer = onErrorRef.current
      if (!observer) return false
      try {
        observer({
          error: new StateError("Document link prefetch policy check failed"),
          nodeKey,
          severity: "speculative",
        })
      } catch {
        queueMicrotask(() => {
          throw new StateError("Document link prefetch policy error reporting failed")
        })
      }
      return false
    }
    if (!policyAllowsPrefetch()) return
    if (
      !mounted.current ||
      prefetchConfiguration.current !== configuration ||
      session.tree.getNodeByKey(nodeKey) !== link ||
      attributeValue(link, "href") !== rawHref ||
      pressInDocumentPrefetchUrl(session, link, href) !== prefetchUrl
    ) {
      return
    }
    if (!dispatchDocumentVisitBeforePrefetch(documentController, nodeKey, prefetchUrl)) return
    if (
      !mounted.current ||
      prefetchConfiguration.current !== configuration ||
      session.tree.getNodeByKey(nodeKey) !== link ||
      attributeValue(link, "href") !== rawHref ||
      pressInDocumentPrefetchUrl(session, link, href) !== prefetchUrl
    ) {
      return
    }
    if (!policyAllowsPrefetch()) return
    if (
      !mounted.current ||
      prefetchConfiguration.current !== configuration ||
      session.tree.getNodeByKey(nodeKey) !== link ||
      attributeValue(link, "href") !== rawHref ||
      pressInDocumentPrefetchUrl(session, link, href) !== prefetchUrl
    ) {
      return
    }

    let commit: () => void = () => undefined
    let preload: Promise<unknown>
    let release: () => void = () => undefined
    try {
      const leaseRequester = documentPreloader as Partial<DocumentPreloadLeaseRequester>
      if (typeof leaseRequester.retain === "function") {
        const lease = leaseRequester.retain(prefetchUrl)
        if (
          !lease ||
          typeof lease !== "object" ||
          typeof lease.commit !== "function" ||
          typeof lease.release !== "function"
        ) {
          throw new StateError("Document link prefetch lease is invalid")
        }
        const promise: unknown = lease.promise
        if (
          promise === null ||
          (typeof promise !== "object" && typeof promise !== "function") ||
          typeof (promise as PromiseLike<unknown>).then !== "function"
        ) {
          throw new StateError("Document link prefetch lease is invalid")
        }
        const activationPromise: unknown = lease.activationPromise ?? promise
        if (
          activationPromise === null ||
          (typeof activationPromise !== "object" && typeof activationPromise !== "function") ||
          typeof (activationPromise as PromiseLike<unknown>).then !== "function"
        ) {
          throw new StateError("Document link prefetch lease is invalid")
        }
        commit = () => lease.commit()
        preload = Promise.resolve(activationPromise)
        release = () => lease.release()
      } else {
        preload = documentPreloader.preload(prefetchUrl)
      }
    } catch (error) {
      preload = Promise.reject(error)
    }
    const active: ActiveDocumentLinkPrefetch = {
      commit,
      committed: false,
      configuration,
      prefetchUrl,
      release,
    }
    activePrefetch.current = active
    const activeLink = link
    const linkNodeKey = nodeKey
    void Promise.resolve(preload).catch((error) => {
      if (
        activePrefetch.current !== active ||
        !mounted.current ||
        prefetchConfiguration.current !== configuration ||
        session.tree.getNodeByKey(linkNodeKey) !== activeLink ||
        attributeValue(activeLink, "href") !== rawHref ||
        pressInDocumentPrefetchUrl(session, activeLink, href) !== prefetchUrl
      ) {
        return
      }
      reportDocumentLinkPrefetchError(onErrorRef.current, linkNodeKey, error)
    })
  }, [
    documentController,
    documentPrefetchPolicy,
    documentPreloader,
    href,
    link,
    nodeKey,
    rawHref,
    releaseActivePrefetch,
    session,
  ])

  const cancel = useCallback(() => {
    const active = activePrefetch.current
    if (!active || active.committed) return
    queueMicrotask(() => {
      if (activePrefetch.current !== active || active.committed) return
      activePrefetch.current = undefined
      releaseActivePrefetch(active)
    })
  }, [releaseActivePrefetch])

  const commit = useCallback(() => {
    const active = activePrefetch.current
    if (!active || active.committed) return
    active.committed = true
    try {
      active.commit()
    } catch (error) {
      if (activePrefetch.current === active) activePrefetch.current = undefined
      releaseActivePrefetch(active)
      reportLeaseFailure(active, error)
    }
  }, [releaseActivePrefetch, reportLeaseFailure])

  return useMemo(
    () =>
      Object.freeze(
        Object.assign(() => prefetch(), { cancel, commit }),
      ) as ExpoTurboDocumentLinkPrefetch,
    [cancel, commit, prefetch],
  )
}

export function useExpoTurboFrame(): ExpoTurboFrameBinding | undefined {
  return useContext(FrameContext)
}

interface VocabularyRenderMetadata extends FormOwnerVocabularyMetadata {
  readonly tolerated: boolean
}

const vocabularyRenderMetadata = new WeakMap<Error, VocabularyRenderMetadata>()

/**
 * Refusal from an inert form owner. Handlers see an ordinary `RegistryError`,
 * so a caller can never mistake a refusal for a usable request. A component
 * that calls a guarded method while rendering instead degrades to nothing and
 * reports through `onUnknownVocabulary`, because a vocabulary gap must never
 * raise the document error surface.
 *
 * Metadata is a construction invariant: every instance of this class carries
 * what the boundary needs, so two refusals can never be handled differently.
 */
class InertFormOwnerError extends RegistryError {
  constructor(operation: string, metadata: FormOwnerVocabularyMetadata) {
    super(`Expo Turbo form ${operation} requires a known form owner`, {
      target: metadata.node.key,
    })
    vocabularyRenderMetadata.set(this, Object.freeze({ ...metadata, tolerated: true }))
  }
}

/**
 * An association failure that carries vocabulary to report. The failure itself
 * is unchanged — form ownership stays declared, and missing, blank, and
 * undeclared targets still fail closed — but the issues travel with the error
 * so the boundary reports them once the render commits. That is what lets a
 * host tell installed-client skew from a document that was simply written
 * wrong; both used to arrive as a bare `onError`.
 */
class AttributedFormOwnerError extends RegistryError {
  constructor(message: string, metadata: FormOwnerVocabularyMetadata) {
    super(message, { target: metadata.node.key })
    vocabularyRenderMetadata.set(this, Object.freeze({ ...metadata, tolerated: false }))
  }
}

/**
 * What a node actually rendered, observed rather than predicted.
 *
 * The blank-root guard has to know whether a document produced output. Deriving
 * that from the protocol tree means predicting what components will do, and a
 * prediction has to be reconciled with the boundary lifecycles it models --
 * which is an open-ended set, not expressible in tree state. Counting what
 * mounted has nothing to keep in sync: registration follows mount and unmount,
 * so it cannot drift from what it describes.
 *
 * Output has exactly five kinds, all of them rendered by this file: a text node
 * with content, a Frame, a Cable stream source, a decoded component, and an
 * error surface. Drops are counted separately, because "nothing rendered here
 * because of vocabulary" and "nothing has rendered here yet" must not look
 * alike -- a suspended subtree registers neither.
 */
type DocumentOutputKind = "drop" | "output"

interface DocumentOutputLedger {
  drops: number
  readonly listeners: Set<() => void>
  output: number
  version: number
}

const DocumentOutputContext = createContext<DocumentOutputLedger | undefined>(undefined)

function createDocumentOutputLedger(): DocumentOutputLedger {
  return { drops: 0, listeners: new Set(), output: 0, version: 0 }
}

function documentOutputIsBlank(ledger: DocumentOutputLedger): boolean {
  return ledger.output === 0 && ledger.drops > 0
}

/**
 * Only a change in the blank verdict is worth a notification. Registering the
 * second component in a healthy document cannot change it, and waking the root
 * for that would re-render every node on every mount.
 */
function updateDocumentOutput(ledger: DocumentOutputLedger, apply: () => void): void {
  const before = documentOutputIsBlank(ledger)
  apply()
  if (documentOutputIsBlank(ledger) === before) return
  ledger.version += 1
  for (const listener of [...ledger.listeners]) listener()
}

function DocumentOutputMarker(
  props: Readonly<{ children?: ReactNode; kind: DocumentOutputKind }>,
): ReactNode {
  const ledger = useContext(DocumentOutputContext)
  const kind = props.kind
  useLayoutEffect(() => {
    if (!ledger) return
    updateDocumentOutput(ledger, () => {
      if (kind === "output") ledger.output += 1
      else ledger.drops += 1
    })
    return () => {
      updateDocumentOutput(ledger, () => {
        if (kind === "output") ledger.output -= 1
        else ledger.drops -= 1
      })
    }
  }, [kind, ledger])
  return props.children ?? null
}

function useDocumentOutputVersion(ledger: DocumentOutputLedger): number {
  const subscribe = useCallback(
    (listener: () => void) => {
      ledger.listeners.add(listener)
      return () => {
        ledger.listeners.delete(listener)
      }
    },
    [ledger],
  )
  const version = useCallback(() => ledger.version, [ledger])
  return useSyncExternalStore(subscribe, version, version)
}

interface UnknownVocabularyStructuralMetadata {
  readonly diagnostics: readonly RegistryStructuralOutputDiagnostic[]
  readonly generation: number
  readonly handler: ExpoTurboUnknownVocabularyHandler | undefined
  readonly root: ProtocolElement
  readonly session: DocumentSession
}

const unknownVocabularyStructuralMetadata = new WeakMap<
  UnknownVocabularyStructuralError,
  UnknownVocabularyStructuralMetadata
>()

class UnknownVocabularyStructuralError extends StateError {
  constructor(metadata: UnknownVocabularyStructuralMetadata) {
    // The message is fixed on purpose — trackers group on it. What was missing
    // is which screen and which app build, and both belong on the payload the
    // host already keeps: a bare error forwarded by a zero-configuration host
    // carries its own context even where the event around it is dropped.
    super("Expo Turbo document root has no renderable fallback", {
      documentUrl: metadata.session.tree.document.url ?? "about:blank",
      runtimeVersion: EXPO_TURBO_RUNTIME_VERSION,
      target: metadata.root.key,
    })
    unknownVocabularyStructuralMetadata.set(this, metadata)
  }
}

interface ErrorBoundaryProps {
  readonly children?: ReactNode
  readonly nodeKey: string
  readonly onError: ((event: ExpoTurboRenderError) => void) | undefined
  /**
   * Supplied by the one call site that has decided this commit is blank, and
   * only for that commit. The boundary never asks what the error is: when the
   * guard is in place it is the only thing that can throw below this boundary,
   * so the position decides, exactly as it does for output accounting.
   */
  readonly recordBlankInterval?: () => ExpoTurboDocumentBlankInterval
  readonly renderError: ((event: ExpoTurboRenderError) => ReactNode) | undefined
  readonly resetIdentity?: unknown
  readonly revision: number | string
}

interface ErrorBoundaryState {
  readonly error: Error | null
  readonly resetIdentity: unknown
  readonly revision: number | string
}

const alreadyReportedRenderErrors = new WeakSet<Error>()

class NodeErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = {
    error: null,
    resetIdentity: this.props.resetIdentity,
    revision: this.props.revision,
  }

  static getDerivedStateFromProps(
    props: ErrorBoundaryProps,
    state: ErrorBoundaryState,
  ): ErrorBoundaryState | null {
    return state.revision === props.revision && state.resetIdentity === props.resetIdentity
      ? null
      : {
          error: null,
          resetIdentity: props.resetIdentity,
          revision: props.revision,
        }
  }

  static getDerivedStateFromError(error: Error): Pick<ErrorBoundaryState, "error"> {
    return { error }
  }

  componentDidCatch(error: Error): void {
    if (alreadyReportedRenderErrors.has(error)) return
    const vocabulary = vocabularyRenderMetadata.get(error)
    if (vocabulary) {
      // Reporting happens here rather than during render so an abandoned
      // concurrent render cannot emit telemetry for state that never commits.
      if (
        vocabulary.session.treeGeneration === vocabulary.generation &&
        vocabulary.session.getNodeSnapshot(vocabulary.node.key)?.node === vocabulary.node
      ) {
        deliverUnknownVocabularyIssues(
          vocabulary.session,
          vocabulary.node,
          vocabulary.generation,
          vocabulary.issues,
          vocabulary.handler,
          vocabulary.failure,
        )
      }
      // A refusal raised while rendering is a tolerated vocabulary gap, not a
      // document error: the node degrades to nothing, and the blank-root guard
      // is told so its accounting matches what actually rendered.
      // The node this boundary now renders nothing for reports that through
      // the output ledger while it stays in this state, so the guard never has
      // to infer this boundary's lifetime from anywhere else.
      if (vocabulary.tolerated) return
    }
    const structuralMetadata =
      error instanceof UnknownVocabularyStructuralError
        ? unknownVocabularyStructuralMetadata.get(error)
        : undefined
    if (error instanceof UnknownVocabularyStructuralError) {
      unknownVocabularyStructuralMetadata.delete(error)
    }
    if (
      structuralMetadata &&
      structuralMetadata.session.treeGeneration === structuralMetadata.generation &&
      structuralMetadata.session.getNodeSnapshot(structuralMetadata.root.key)?.node ===
        structuralMetadata.root
    ) {
      for (const diagnostic of structuralMetadata.diagnostics) {
        if (
          structuralMetadata.session.getNodeSnapshot(diagnostic.node.key)?.node !== diagnostic.node
        ) {
          continue
        }
        deliverUnknownVocabularyIssues(
          structuralMetadata.session,
          diagnostic.node,
          structuralMetadata.generation,
          diagnostic.issues,
          structuralMetadata.handler,
        )
      }
    }
    const blank = this.props.recordBlankInterval?.()
    this.props.onError?.({
      ...(blank ? { blank } : {}),
      error,
      nodeKey: this.props.nodeKey,
      severity: "document",
    })
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children
    // A tolerated inert-owner refusal drops the node the way an unknown tag
    // with no children does, instead of raising the error surface.
    if (vocabularyRenderMetadata.get(this.state.error)?.tolerated) {
      return createElement(DocumentOutputMarker, { kind: "drop" })
    }
    // Always `document`: this branch is reached only for an error that raises a
    // surface. The blank interval is deliberately absent — it is a count, and
    // counting during render would count abandoned renders too.
    const rendered =
      this.props.renderError?.({
        error: this.state.error,
        nodeKey: this.props.nodeKey,
        severity: "document",
      }) ?? null
    // A node-level error surface is real output: a document showing one is not
    // blank, and replacing it with the blank-root surface would hide the error
    // the host is already reporting.
    if (rendered === null || !this.countsRenderedErrorAsOutput(this.state.error)) return rendered
    return createElement(DocumentOutputMarker, { kind: "output" }, rendered)
  }

  protected countsRenderedErrorAsOutput(_error: Error): boolean {
    return true
  }
}

/**
 * The boundary at the single position where the blank-root guard raises its own
 * surface. That surface must not count as output, or the guard would observe
 * itself and never clear.
 *
 * The exclusion is positional rather than a property of the error, because an
 * error is a value: the guard hands the very same instance to `onError` and
 * `renderError`, so a host can keep it and throw it again from anywhere, and a
 * check on its class or identity would follow it there. Which component renders
 * a surface is chosen by this file at one call site. Host code is never given
 * this class or an element of it -- the only elements it receives are the
 * document, Frame and form children rendered below this boundary -- so the
 * strongest forgery available is re-rendering the base boundary, which counts
 * its surface as output. Every reachable mistake lands on the safe side.
 */
class DocumentBlankGuardBoundary extends NodeErrorBoundary {
  protected override countsRenderedErrorAsOutput(error: Error): boolean {
    return !(error instanceof UnknownVocabularyStructuralError)
  }
}

function renderChildren(nodes: readonly ProtocolNode[]): ReactNode[] {
  return nodes.map((node) =>
    createElement(ProtocolNodeView, {
      key: node.key,
      nodeKey: node.key,
    }),
  )
}

function developmentVocabularyWarningsEnabled(): boolean {
  const globalDevelopment = (globalThis as Readonly<{ __DEV__?: unknown }>).__DEV__
  if (typeof globalDevelopment === "boolean") return globalDevelopment
  const nodeEnvironment = (
    globalThis as Readonly<{
      process?: Readonly<{ env?: Readonly<{ NODE_ENV?: string }> }>
    }>
  ).process?.env?.NODE_ENV
  return nodeEnvironment !== "production"
}

function unknownVocabularyFingerprint(
  issue: RegistryVocabularyIssue,
  failure: VocabularyFailureSource | undefined,
): string {
  // The failing node participates so an element's own report and a report of
  // the same issue as the cause of a failed association stay separate
  // deliveries. It participates by identity rather than key: a replaced control
  // carries its predecessor's key, and its failure is a new one.
  return JSON.stringify([
    issue.kind,
    "attribute" in issue ? issue.attribute : "",
    failure?.identity ?? "",
  ])
}

function claimUnknownVocabularyDelivery(
  session: DocumentSession,
  node: ProtocolElement,
  generation: number,
  fingerprint: string,
  sink: "callback" | "warning",
): boolean {
  let sessionClaims = unknownVocabularyClaims.get(session)
  if (!sessionClaims) {
    sessionClaims = new WeakMap()
    unknownVocabularyClaims.set(session, sessionClaims)
  }
  let claim = sessionClaims.get(node)
  if (!claim || claim.generation !== generation) {
    claim = { fingerprints: new Set(), generation }
    sessionClaims.set(node, claim)
  }
  const sinkFingerprint = `${sink}:${fingerprint}`
  if (claim.fingerprints.has(sinkFingerprint)) return false
  claim.fingerprints.add(sinkFingerprint)
  return true
}

function deliverUnknownVocabularyIssues(
  session: DocumentSession,
  node: ProtocolElement,
  generation: number,
  issues: readonly RegistryVocabularyIssue[],
  handler: ExpoTurboUnknownVocabularyHandler | undefined,
  failure?: VocabularyFailureSource,
): void {
  const warn = developmentVocabularyWarningsEnabled()
  if (!handler && !warn) return
  for (const issue of issues) {
    const fingerprint = unknownVocabularyFingerprint(issue, failure)
    const event = Object.freeze({
      ...("attribute" in issue ? { attribute: issue.attribute } : {}),
      documentUrl: session.tree.document.url ?? "about:blank",
      ...(failure ? { failureNodeKey: failure.nodeKey } : {}),
      kind: issue.kind,
      nodeKey: node.key,
      tag: issue.tag,
    }) satisfies ExpoTurboUnknownVocabularyEvent
    if (
      handler &&
      claimUnknownVocabularyDelivery(session, node, generation, fingerprint, "callback")
    ) {
      try {
        const delivery = handler(event)
        if (delivery !== undefined) consumeThenableResult(delivery)
      } catch {
        // Telemetry must not change rendered document state.
      }
    }
    if (warn && claimUnknownVocabularyDelivery(session, node, generation, fingerprint, "warning")) {
      try {
        console.warn("Expo Turbo ignored unknown vocabulary", event)
      } catch {
        // Development warnings must not change rendered document state.
      }
    }
  }
}

function decodeRegisteredElement(
  registry: RenderRegistry,
  node: ProtocolElement,
): RegistryRenderDecodeResult<RegistryComponent> {
  return registry.decodeForRender(node)
}

const NO_VOCABULARY_ISSUES: readonly RegistryVocabularyIssue[] = Object.freeze([])

function useUnknownVocabularyReport(
  node: ProtocolElement | undefined,
  issues: readonly RegistryVocabularyIssue[],
): void {
  const { onUnknownVocabulary, session } = useRenderer()
  const generation = session.treeGeneration
  useEffect(() => {
    if (!node || issues.length === 0) return
    if (session.treeGeneration !== generation) return
    if (session.getNodeSnapshot(node.key)?.node !== node) return
    deliverUnknownVocabularyIssues(session, node, generation, issues, onUnknownVocabulary)
  }, [generation, issues, node, onUnknownVocabulary, session])
}

function UnknownVocabularyReporter(
  props: Readonly<{
    issues: readonly RegistryVocabularyIssue[]
    node: ProtocolElement
  }>,
): ReactNode {
  useUnknownVocabularyReport(props.node, props.issues)
  return null
}

function readMorphFocusedId(adapter: AutofocusAdapter, nodeKey: string): string | undefined {
  if (!adapter.getFocusedId) return undefined
  let focusedId: unknown
  try {
    focusedId = adapter.getFocusedId()
  } catch {
    throw new StateError("Component morph focus snapshot failed", { target: nodeKey })
  }
  if (focusedId !== undefined && typeof focusedId !== "string") {
    consumeUnexpectedAdapterResult(focusedId)
    throw new StateError("Component morph focus snapshot failed", { target: nodeKey })
  }
  return focusedId
}

function restoreComponentMorphFocus(
  adapter: AutofocusAdapter,
  scrollAdapter: AutofocusScrollAdapter | undefined,
  nodeKey: string,
  readFocusedId = readMorphFocusedId,
): void {
  const focusedId = readFocusedId(adapter, nodeKey)
  if (focusedId !== undefined) return

  let available: unknown
  try {
    available = adapter.canFocus(nodeKey)
  } catch {
    throw new StateError("Component morph focus availability check failed", { target: nodeKey })
  }
  if (typeof available !== "boolean") {
    consumeUnexpectedAdapterResult(available)
    throw new StateError("Component morph focus availability check failed", { target: nodeKey })
  }
  if (!available) return

  let result: unknown
  try {
    result = adapter.focus(nodeKey)
  } catch {
    throw new StateError("Component morph focus restoration failed", { target: nodeKey })
  }
  if (result !== undefined) {
    consumeUnexpectedAdapterResult(result)
    throw new StateError("Component morph focus restoration failed", { target: nodeKey })
  }
  if (scrollAdapter) applyAutofocusScroll(scrollAdapter, nodeKey, "Component morph")
}

function useComponentMorphFocus(
  adapter: AutofocusAdapter | undefined,
  scrollAdapter: AutofocusScrollAdapter | undefined,
  enabled: boolean,
  morphRevision: number,
  nodeKey: string,
): void {
  const committedMorphRevision = useRef(morphRevision)
  const restore = useRef(false)

  if (
    committedMorphRevision.current !== morphRevision &&
    adapter?.getFocusedId &&
    enabled &&
    readMorphFocusedId(adapter, nodeKey) === nodeKey
  ) {
    restore.current = true
  }

  useLayoutEffect(() => {
    committedMorphRevision.current = morphRevision
    if (restore.current) {
      restore.current = false
      if (adapter && enabled) restoreComponentMorphFocus(adapter, scrollAdapter, nodeKey)
    }
  }, [adapter, enabled, morphRevision, nodeKey, scrollAdapter])
}

function DecodedRegisteredElement(
  props: Readonly<{
    decoded: DecodedComponent
    issues: readonly RegistryVocabularyIssue[]
    morphRevision: number
    node: ProtocolElement
  }>,
): ReactNode {
  const { autofocus, autofocusScroll } = useRenderer()
  const inheritedDirection = useContext(DirectionContext)
  const inheritedFallback = useContext(DirectionFallbackContext)
  const direction = props.decoded.protocol.direction ?? inheritedDirection
  const directionFallback =
    direction === "ltr" || direction === "rtl" ? direction : inheritedFallback
  let children: ReactNode
  if (props.decoded.definition.children === "text") children = props.decoded.text ?? ""
  else if (props.decoded.definition.children === "nodes") {
    children = renderChildren(props.decoded.children)
  }
  const component = props.decoded.definition.component as ComponentType<
    Readonly<Record<string, unknown> & { children?: ReactNode }>
  >
  const componentProps = props.decoded.props as Readonly<Record<string, unknown>>
  useComponentMorphFocus(
    autofocus,
    autofocusScroll,
    props.decoded.definition.morphState === "reset",
    props.morphRevision,
    props.node.key,
  )
  const key = props.decoded.definition.morphState === "reset" ? props.morphRevision : undefined
  const rendered =
    children === undefined
      ? createElement(component, { ...componentProps, key })
      : createElement(component, { ...componentProps, key }, children)
  const contents = createElement(
    DirectionFallbackContext.Provider,
    { value: directionFallback },
    createElement(
      DirectionContext.Provider,
      { value: direction },
      createElement(
        ProtocolNodeContext.Provider,
        { value: props.node.key },
        createElement(
          ComponentDefinitionContext.Provider,
          { value: props.decoded.definition },
          createElement(
            ComponentTagContext.Provider,
            { value: props.decoded.definition.tag },
            rendered,
          ),
        ),
      ),
    ),
  )
  return createElement(
    Fragment,
    null,
    props.issues.length > 0
      ? createElement(UnknownVocabularyReporter, {
          issues: props.issues,
          node: props.node,
        })
      : null,
    createElement(DocumentOutputMarker, { kind: "output" }, contents),
  )
}

function TransparentRegisteredElement(
  props: Readonly<{
    definition?: RegistryComponent
    issues: readonly RegistryVocabularyIssue[]
    node: ProtocolElement
  }>,
): ReactNode {
  const children = createElement(Fragment, null, renderChildren(props.node.children))
  const fallback = props.definition?.formOwner
    ? createElement(
        ProtocolNodeContext.Provider,
        { value: props.node.key },
        createElement(
          ComponentDefinitionContext.Provider,
          { value: props.definition },
          createElement(
            ComponentTagContext.Provider,
            { value: props.definition.tag },
            createElement(ExpoTurboFormScope, null, children),
          ),
        ),
      )
    : children
  return createElement(
    ProtocolDirectionBoundary,
    { node: props.node },
    createElement(
      Fragment,
      null,
      createElement(UnknownVocabularyReporter, {
        issues: props.issues,
        node: props.node,
      }),
      fallback,
    ),
  )
}

function RegisteredElement(
  props: Readonly<{ morphRevision: number; node: ProtocolElement }>,
): ReactNode {
  const { registry } = useRenderer()
  const result = decodeRegisteredElement(registry, props.node)
  return result.status === "transparent"
    ? createElement(TransparentRegisteredElement, {
        ...(result.definition ? { definition: result.definition } : {}),
        issues: result.issues,
        node: props.node,
      })
    : createElement(DecodedRegisteredElement, {
        decoded: result.decoded,
        issues: result.issues,
        morphRevision: props.morphRevision,
        node: props.node,
      })
}

function ProtocolDirectionBoundary(
  props: Readonly<{ children?: ReactNode; node: ProtocolElement }>,
): ReactNode {
  const inheritedDirection = useContext(DirectionContext)
  const inheritedFallback = useContext(DirectionFallbackContext)
  const direction = protocolDirection(props.node) ?? inheritedDirection
  const directionFallback =
    direction === "ltr" || direction === "rtl" ? direction : inheritedFallback
  return createElement(
    DirectionFallbackContext.Provider,
    { value: directionFallback },
    createElement(DirectionContext.Provider, { value: direction }, props.children),
  )
}

function RootProtocolDirectionBoundary(
  props: Readonly<{ children?: ReactNode; node: ProtocolElement }>,
): ReactNode {
  return createElement(ProtocolDirectionBoundary, { node: props.node }, props.children)
}

interface RegisteredElementBoundaryProps {
  readonly morphRevision: number
  readonly node: ProtocolElement
  readonly onError: ((event: ExpoTurboRenderError) => void) | undefined
  readonly renderError: ((event: ExpoTurboRenderError) => ReactNode) | undefined
  readonly resetIdentity?: unknown
  readonly revision: number | string
}

function RegisteredElementBoundary(props: RegisteredElementBoundaryProps): ReactNode {
  return createElement(
    NodeErrorBoundary,
    {
      nodeKey: props.node.key,
      onError: props.onError,
      renderError: props.renderError,
      resetIdentity: props.resetIdentity,
      revision: props.revision,
    },
    createElement(RegisteredElement, {
      morphRevision: props.morphRevision,
      node: props.node,
    }),
  )
}

function AssociatedRegisteredElementBoundary(
  props: RegisteredElementBoundaryProps & Readonly<{ formId: string }>,
): ReactNode {
  const owner = useProtocolNode(`id:${props.formId}`)
  return createElement(RegisteredElementBoundary, {
    ...props,
    revision: `${props.revision}:${owner?.identity ?? "missing"}`,
  })
}

interface ConnectedFrameProps {
  readonly autofocus: AutofocusAdapter | undefined
  readonly autofocusScroll: AutofocusScrollAdapter | undefined
  readonly frameAutoscroll: FrameAutoscrollAdapter | undefined
  readonly frameComponent: ComponentType<ExpoTurboFrameBoundaryProps> | undefined
  readonly frameId: string
  readonly frames: FrameControllerCollection
  readonly node: ProtocolElement
  readonly onError: ((event: ExpoTurboRenderError) => void) | undefined
  readonly renderError: ((event: ExpoTurboRenderError) => ReactNode) | undefined
}

function consumeUnexpectedAdapterResult(result: unknown): void {
  if ((typeof result !== "object" || result === null) && typeof result !== "function") return
  try {
    void Promise.resolve(result).catch(() => undefined)
  } catch {
    // The redacted StateError from the caller is the only exposed host failure.
  }
}

function focusFirstAvailableCandidate(
  adapter: AutofocusAdapter,
  scrollAdapter: AutofocusScrollAdapter | undefined,
  candidates: readonly string[],
  scope: "Document" | "Frame" | "Stream",
  frameId?: string,
): void {
  const context = frameId ? { frameId } : {}
  for (const candidate of candidates) {
    let available: unknown
    try {
      available = adapter.canFocus(candidate)
    } catch {
      throw new StateError(`${scope} autofocus availability check failed`, context)
    }
    if (typeof available !== "boolean") {
      consumeUnexpectedAdapterResult(available)
      throw new StateError(`${scope} autofocus availability check failed`, context)
    }
    if (!available) continue

    let result: unknown
    try {
      result = adapter.focus(candidate)
    } catch {
      throw new StateError(`${scope} autofocus failed`, context)
    }
    if (result !== undefined) {
      consumeUnexpectedAdapterResult(result)
      throw new StateError(`${scope} autofocus failed`, context)
    }
    if (scrollAdapter) {
      applyAutofocusScroll(scrollAdapter, candidate, scope, frameId)
    }
    return
  }
}

function applyAutofocusScroll(
  adapter: AutofocusScrollAdapter,
  id: string,
  scope: "Component morph" | "Document" | "Frame" | "Stream",
  frameId?: string,
): void {
  const context = frameId ? { frameId } : {}
  let available: unknown
  try {
    available = adapter.canScroll(id)
  } catch {
    throw new StateError(`${scope} autofocus scroll availability check failed`, context)
  }
  if (typeof available !== "boolean") {
    consumeUnexpectedAdapterResult(available)
    throw new StateError(`${scope} autofocus scroll availability check failed`, context)
  }
  if (!available) return

  let result: unknown
  try {
    result = adapter.scrollTo(id)
  } catch {
    throw new StateError(`${scope} autofocus scroll failed`, context)
  }
  if (result !== undefined) {
    consumeUnexpectedAdapterResult(result)
    throw new StateError(`${scope} autofocus scroll failed`, context)
  }
}

function applyAutofocus(
  adapter: AutofocusAdapter,
  scrollAdapter: AutofocusScrollAdapter | undefined,
  candidates: readonly string[],
  nodeKey: string,
  onError: ((event: ExpoTurboRenderError) => void) | undefined,
  scope: "Document" | "Frame" | "Stream",
  frameId?: string,
): void {
  try {
    focusFirstAvailableCandidate(adapter, scrollAdapter, candidates, scope, frameId)
  } catch (error) {
    const reported = error instanceof Error ? error : new StateError(`${scope} autofocus failed`)
    if (!onError) throw reported
    try {
      onError({ error: reported, nodeKey, severity: "background" })
    } catch {
      const reportingError = new StateError(
        `${scope} autofocus error reporting failed`,
        frameId ? { frameId } : {},
      )
      alreadyReportedRenderErrors.add(reportingError)
      throw reportingError
    }
  }
}

function applyStandaloneStreamAutofocus(
  adapter: AutofocusAdapter | undefined,
  scrollAdapter: AutofocusScrollAdapter | undefined,
  candidates: readonly string[] | undefined,
  nodeKey: string,
  onError: ((event: ExpoTurboRenderError) => void) | undefined,
): void {
  if (!adapter || !candidates || !adapter.getFocusedId) return
  try {
    let focusedId: unknown
    try {
      focusedId = adapter.getFocusedId()
    } catch {
      throw new StateError("Stream autofocus active-focus check failed")
    }
    if (focusedId !== undefined && typeof focusedId !== "string") {
      consumeUnexpectedAdapterResult(focusedId)
      throw new StateError("Stream autofocus active-focus check failed")
    }
    if (focusedId !== undefined) return
    applyAutofocus(adapter, scrollAdapter, candidates, nodeKey, undefined, "Stream")
  } catch (error) {
    const reported = error instanceof Error ? error : new StateError("Stream autofocus failed")
    if (!onError) throw reported
    try {
      onError({ error: reported, nodeKey, severity: "background" })
    } catch {
      const reportingError = new StateError("Stream autofocus error reporting failed")
      alreadyReportedRenderErrors.add(reportingError)
      throw reportingError
    }
  }
}

function applyDocumentRefreshScroll(
  adapter: DocumentRefreshScrollAdapter | undefined,
  nodeKey: string,
  onError: ((event: ExpoTurboRenderError) => void) | undefined,
): void {
  if (!adapter) return
  try {
    let available: unknown
    try {
      available = adapter.canReset()
    } catch {
      throw new StateError("Document refresh scroll availability check failed")
    }
    if (typeof available !== "boolean") {
      consumeUnexpectedAdapterResult(available)
      throw new StateError("Document refresh scroll availability check failed")
    }
    if (!available) return

    let result: unknown
    try {
      result = adapter.reset()
    } catch {
      throw new StateError("Document refresh scroll reset failed")
    }
    if (result !== undefined) {
      consumeUnexpectedAdapterResult(result)
      throw new StateError("Document refresh scroll reset failed")
    }
  } catch (error) {
    const reported =
      error instanceof Error ? error : new StateError("Document refresh scroll reset failed")
    if (!onError) throw reported
    try {
      onError({ error: reported, nodeKey, severity: "background" })
    } catch {
      const reportingError = new StateError("Document refresh scroll error reporting failed")
      alreadyReportedRenderErrors.add(reportingError)
      throw reportingError
    }
  }
}

function applyDocumentHistoryScroll(
  adapter: DocumentHistoryScrollAdapter | undefined,
  position: Readonly<{ x: number; y: number }>,
  nodeKey: string,
  onError: ((event: ExpoTurboRenderError) => void) | undefined,
): void {
  if (!adapter) return
  try {
    let available: unknown
    try {
      available = adapter.canRestore()
    } catch {
      throw new StateError("Document history scroll availability check failed")
    }
    if (typeof available !== "boolean") {
      consumeUnexpectedAdapterResult(available)
      throw new StateError("Document history scroll availability check failed")
    }
    if (!available) return

    let result: unknown
    try {
      result = adapter.restore(position)
    } catch {
      throw new StateError("Document history scroll restoration failed")
    }
    if (result !== undefined) {
      consumeUnexpectedAdapterResult(result)
      throw new StateError("Document history scroll restoration failed")
    }
  } catch (error) {
    const reported =
      error instanceof Error ? error : new StateError("Document history scroll restoration failed")
    if (!onError) throw reported
    try {
      onError({ error: reported, nodeKey, severity: "background" })
    } catch {
      const reportingError = new StateError("Document history scroll error reporting failed")
      alreadyReportedRenderErrors.add(reportingError)
      throw reportingError
    }
  }
}

function applyFrameAutoscroll(
  adapter: FrameAutoscrollAdapter | undefined,
  intent: FrameAutoscrollIntent,
  nodeKey: string,
  onError: ((event: ExpoTurboRenderError) => void) | undefined,
): void {
  if (!adapter) return
  try {
    let available: unknown
    try {
      available = adapter.canScroll(intent.frameId)
    } catch {
      throw new StateError("Frame autoscroll availability check failed", {
        frameId: intent.frameId,
      })
    }
    if (typeof available !== "boolean") {
      consumeUnexpectedAdapterResult(available)
      throw new StateError("Frame autoscroll availability check failed", {
        frameId: intent.frameId,
      })
    }
    if (!available) return

    let result: unknown
    try {
      result = adapter.scrollTo({
        behavior: intent.behavior,
        block: intent.alignment,
        frameId: intent.frameId,
      })
    } catch {
      throw new StateError("Frame autoscroll failed", { frameId: intent.frameId })
    }
    if (result !== undefined) {
      consumeUnexpectedAdapterResult(result)
      throw new StateError("Frame autoscroll failed", { frameId: intent.frameId })
    }
  } catch (error) {
    const reported = error instanceof Error ? error : new StateError("Frame autoscroll failed")
    if (!onError) throw reported
    try {
      onError({ error: reported, nodeKey, severity: "background" })
    } catch {
      const reportingError = new StateError("Frame autoscroll error reporting failed", {
        frameId: intent.frameId,
      })
      alreadyReportedRenderErrors.add(reportingError)
      throw reportingError
    }
  }
}

function ConnectedFrame(props: ConnectedFrameProps): ReactNode {
  const { session } = useRenderer()
  const controller = props.frames.get(props.frameId)
  const state = useFrameControllerState(controller)
  const subscribeRenderLifecycle = useCallback(
    (listener: () => void) => subscribeFrameRenderLifecycle(session, listener),
    [session],
  )
  const renderLifecycleSnapshot = useCallback(
    () => frameRenderLifecycleRevision(session),
    [session],
  )
  const subscribeRevision = useCallback(
    (listener: () => void) => session.subscribeRevision(listener),
    [session],
  )
  const revisionSnapshot = useCallback(() => session.revision, [session])
  const coordinationRevision = useSyncExternalStore(
    subscribeRenderLifecycle,
    renderLifecycleSnapshot,
    renderLifecycleSnapshot,
  )
  const revision = useSyncExternalStore(subscribeRevision, revisionSnapshot, revisionSnapshot)
  const accessibilityState = useMemo<ExpoTurboFrameAccessibilityState>(
    () => Object.freeze({ busy: state.busy }),
    [state.busy],
  )
  const binding = useMemo<ExpoTurboFrameBinding>(
    () => Object.freeze({ accessibilityState, controller, state }),
    [accessibilityState, controller, state],
  )
  useEffect(() => {
    void controller.connect().catch(() => undefined)
    return () => controller.disconnect()
  }, [controller])
  useEffect(
    () =>
      controller.subscribeErrors((error) => {
        // A Frame that fails to load is navigation the user asked for failing,
        // not an accessory to a render that succeeded. `document` keeps today's
        // host behavior exactly.
        props.onError?.({ error, nodeKey: props.node.key, severity: "document" })
      }),
    [controller, props.node.key, props.onError],
  )
  useInsertionEffect(() => retainFrameRenderer(session, props.node), [session, props.node])
  useLayoutEffect(() => {
    if (coordinationRevision !== frameRenderLifecycleRevision(session)) return
    const pending = hasFrameRenderTicket(session, props.node, props.frameId)
    const acknowledgement = acknowledgeFrameRender(session, props.node, props.frameId, revision)
    if (pending && !acknowledgement) return
    try {
      const effects = consumeFrameRenderEffects(controller, state.revision)
      if (effects?.autoscroll) {
        applyFrameAutoscroll(
          props.frameAutoscroll,
          effects.autoscroll,
          props.node.key,
          props.onError,
        )
      }
      if (effects?.autofocus && props.autofocus) {
        applyAutofocus(
          props.autofocus,
          props.autofocusScroll,
          effects.autofocus,
          props.node.key,
          props.onError,
          "Frame",
          props.frameId,
        )
      }
    } catch (error) {
      acknowledgement?.fail()
      throw error
    }
    acknowledgement?.finish()
    void controller.reconcileAttributes().catch(() => undefined)
  }, [
    controller,
    coordinationRevision,
    props.autofocus,
    props.autofocusScroll,
    props.frameAutoscroll,
    props.frameId,
    props.node,
    props.node.key,
    props.onError,
    revision,
    session,
    state.revision,
  ])
  const children = useMemo(
    () => createElement(Fragment, null, renderChildren(props.node.children)),
    [props.node.children],
  )
  const rendered = props.frameComponent
    ? createElement(
        NodeErrorBoundary,
        {
          nodeKey: props.node.key,
          onError: props.onError,
          renderError: props.renderError,
          revision: state.revision,
        },
        createElement(props.frameComponent, binding, children),
      )
    : children
  return createElement(FrameContext.Provider, { value: binding }, rendered)
}

interface ConnectedDocumentProps {
  readonly children?: ReactNode
  readonly controller: DocumentVisitController
  readonly documentComponent: ComponentType<ExpoTurboDocumentBoundaryProps> | undefined
  readonly nodeKey: string
  readonly onError: ((event: ExpoTurboRenderError) => void) | undefined
  readonly renderError: ((event: ExpoTurboRenderError) => ReactNode) | undefined
}

interface DocumentRenderBoundaryProps {
  readonly children?: ReactNode
  readonly document: ProtocolDocument
  readonly generation: number
}

interface RetainedMorphFocusSnapshot {
  readonly key: string
  readonly morphRevision: number
  readonly node: ProtocolNode
}

function readRetainedMorphFocusedId(
  adapter: AutofocusAdapter,
  nodeKey: string,
): string | undefined {
  let key: unknown
  try {
    key = adapter.getMorphFocusedId?.()
  } catch {
    throw new StateError("Retained morph focus snapshot failed", { target: nodeKey })
  }
  if (key !== undefined && typeof key !== "string") {
    consumeUnexpectedAdapterResult(key)
    throw new StateError("Retained morph focus snapshot failed", { target: nodeKey })
  }
  return key
}

function retainedMorphFocusSnapshot(
  session: DocumentSession,
  adapter: AutofocusAdapter,
  nodeKey: string,
): RetainedMorphFocusSnapshot | undefined {
  const key = readRetainedMorphFocusedId(adapter, nodeKey)
  if (key === undefined) return undefined
  const snapshot = session.getNodeSnapshot(key)
  return snapshot ? { key, morphRevision: snapshot.morphRevision, node: snapshot.node } : undefined
}

function reportRetainedMorphFocusError(
  onError: ((event: ExpoTurboRenderError) => void) | undefined,
  nodeKey: string,
  error: unknown,
): void {
  const reported =
    error instanceof Error ? error : new StateError("Retained morph focus restoration failed")
  if (!onError) throw reported
  try {
    onError({ error: reported, nodeKey, severity: "background" })
  } catch {
    const reportingError = new StateError("Retained morph focus error reporting failed")
    alreadyReportedRenderErrors.add(reportingError)
    throw reportingError
  }
}

function useRetainedMorphFocus(
  session: DocumentSession,
  adapter: AutofocusAdapter | undefined,
  scrollAdapter: AutofocusScrollAdapter | undefined,
  nodeKey: string,
  onError: ((event: ExpoTurboRenderError) => void) | undefined,
): number {
  const baseline = useRef<RetainedMorphFocusSnapshot | undefined>(undefined)
  const pending = useRef<RetainedMorphFocusSnapshot | undefined>(undefined)
  const pendingError = useRef<unknown>(undefined)
  useLayoutEffect(
    () =>
      subscribeBeforeSessionMutation(session, () => {
        try {
          pendingError.current = undefined
          baseline.current =
            adapter?.getMorphFocusedId === undefined
              ? undefined
              : retainedMorphFocusSnapshot(session, adapter, nodeKey)
        } catch (error) {
          baseline.current = undefined
          pendingError.current = error
        }
      }),
    [adapter, nodeKey, session],
  )
  const subscribe = useCallback(
    (listener: () => void) =>
      session.subscribeRevision(() => {
        const previous = baseline.current
        const current = previous ? session.getNodeSnapshot(previous.key) : undefined
        pending.current =
          previous && current && previous.morphRevision !== current.morphRevision
            ? { ...current, key: previous.key }
            : undefined
        baseline.current = undefined
        listener()
      }),
    [session],
  )
  const snapshot = useCallback(() => session.revision, [session])
  const revision = useSyncExternalStore(subscribe, snapshot, snapshot)

  useLayoutEffect(() => {
    void revision
    try {
      if (pendingError.current !== undefined) {
        const error = pendingError.current
        pendingError.current = undefined
        throw error
      }
      const candidate = pending.current
      pending.current = undefined
      if (candidate && adapter) {
        const active = session.getNodeSnapshot(candidate.key)
        if (active?.node === candidate.node && active.morphRevision === candidate.morphRevision) {
          restoreComponentMorphFocus(
            adapter,
            scrollAdapter,
            candidate.key,
            readRetainedMorphFocusedId,
          )
        }
      }
    } catch (error) {
      reportRetainedMorphFocusError(onError, nodeKey, error)
    }
  }, [adapter, nodeKey, onError, revision, scrollAdapter, session])

  return revision
}

function DocumentRenderBoundary(props: DocumentRenderBoundaryProps): ReactNode {
  const {
    autofocus,
    autofocusScroll,
    documentHistoryScroll,
    documentRefreshScroll,
    onError,
    session,
  } = useRenderer()
  const subscribeRenderLifecycle = useCallback(
    (listener: () => void) => subscribeDocumentRenderLifecycle(session, listener),
    [session],
  )
  const renderLifecycleSnapshot = useCallback(
    () => documentRenderLifecycleRevision(session),
    [session],
  )
  const subscribeStreamAutofocus = useCallback(
    (listener: () => void) => subscribeStreamAutofocusLifecycle(session, listener),
    [session],
  )
  const streamAutofocusSnapshot = useCallback(
    () => streamAutofocusLifecycleRevision(session),
    [session],
  )
  const coordinationRevision = useSyncExternalStore(
    subscribeRenderLifecycle,
    renderLifecycleSnapshot,
    renderLifecycleSnapshot,
  )
  const streamAutofocusRevision = useSyncExternalStore(
    subscribeStreamAutofocus,
    streamAutofocusSnapshot,
    streamAutofocusSnapshot,
  )
  const revision = useRetainedMorphFocus(
    session,
    autofocus,
    autofocusScroll,
    props.document.key,
    onError,
  )
  useInsertionEffect(() => retainDocumentRenderer(session), [session])
  useLayoutEffect(() => {
    if (coordinationRevision !== documentRenderLifecycleRevision(session)) return
    const pending = hasDocumentRenderTicket(session, props.document, props.generation)
    const acknowledgement = acknowledgeDocumentRender(
      session,
      props.document,
      props.generation,
      revision,
    )
    if (pending && !acknowledgement) return
    try {
      const candidates = consumeDocumentAutofocus(session, props.document, props.generation)
      if (candidates && autofocus) {
        applyAutofocus(
          autofocus,
          autofocusScroll,
          candidates,
          props.document.key,
          onError,
          "Document",
        )
      }
    } catch (error) {
      acknowledgement?.fail()
      throw error
    }
    const rendered = acknowledgement?.finish() ?? false
    notifyDocumentMorphFrameReloads(session, props.document, props.generation)
    if (!rendered) {
      discardDocumentRefreshScroll(session, props.generation)
      return
    }
    const historyScroll = acknowledgement?.consumeHistoryScroll()
    if (historyScroll) {
      applyDocumentHistoryScroll(documentHistoryScroll, historyScroll, props.document.key, onError)
    }
    if (consumeDocumentRefreshScroll(session, props.document, props.generation)) {
      applyDocumentRefreshScroll(documentRefreshScroll, props.document.key, onError)
    }
  }, [
    autofocus,
    autofocusScroll,
    coordinationRevision,
    documentHistoryScroll,
    documentRefreshScroll,
    onError,
    props.document,
    props.generation,
    revision,
    session,
  ])
  useLayoutEffect(() => {
    if (streamAutofocusRevision !== streamAutofocusLifecycleRevision(session)) return
    applyStandaloneStreamAutofocus(
      autofocus,
      autofocusScroll,
      consumeStandaloneStreamAutofocus(session, revision),
      props.document.key,
      onError,
    )
  }, [
    autofocus,
    autofocusScroll,
    onError,
    props.document.key,
    revision,
    session,
    streamAutofocusRevision,
  ])
  return props.children
}

function ConnectedDocument(props: ConnectedDocumentProps): ReactNode {
  const { documentAnnouncements } = useRenderer()
  const state = useDocumentVisitControllerState(props.controller)
  const announcementBaseline = useRef({
    controller: props.controller,
    revision: state.revision,
    status: state.status,
  })
  const accessibilityState = useMemo<ExpoTurboDocumentAccessibilityState>(
    () => Object.freeze({ busy: state.busy }),
    [state.busy],
  )
  const binding = useMemo<ExpoTurboDocumentBinding>(
    () => Object.freeze({ accessibilityState, controller: props.controller, state }),
    [accessibilityState, props.controller, state],
  )
  useEffect(() => {
    const baseline = announcementBaseline.current
    announcementBaseline.current = {
      controller: props.controller,
      revision: state.revision,
      status: state.status,
    }
    if (
      baseline.controller !== props.controller ||
      baseline.revision === state.revision ||
      baseline.status === state.status ||
      state.status === "initialized" ||
      !documentAnnouncements ||
      props.controller.state !== state
    ) {
      return
    }
    const event = Object.freeze({ status: state.status }) satisfies DocumentVisitAnnouncementEvent
    if (!claimDocumentVisitAnnouncement(props.controller, state.revision, event.status)) return
    try {
      const delivery = documentAnnouncements.announce(event)
      if (delivery) {
        void Promise.resolve(delivery).catch((error: unknown) => {
          reportDocumentVisitAnnouncementError(props.onError, props.nodeKey, error)
        })
      }
    } catch (error) {
      reportDocumentVisitAnnouncementError(props.onError, props.nodeKey, error)
    }
  }, [documentAnnouncements, props.controller, props.nodeKey, props.onError, state])
  useEffect(
    () =>
      props.controller.subscribeErrors((error) => {
        // A failed visit is the navigation the user asked for failing.
        // `document` keeps today's host behavior exactly.
        props.onError?.({ error, nodeKey: props.nodeKey, severity: "document" })
      }),
    [props.controller, props.nodeKey, props.onError],
  )
  const rendered = props.documentComponent
    ? createElement(
        NodeErrorBoundary,
        {
          nodeKey: props.nodeKey,
          onError: props.onError,
          renderError: props.renderError,
          revision: state.revision,
        },
        // Host document chrome is visible output that belongs to no protocol
        // node, so nothing else would count it.
        createElement(
          DocumentOutputMarker,
          { kind: "output" },
          createElement(props.documentComponent, binding, props.children),
        ),
      )
    : props.children
  return createElement(DocumentContext.Provider, { value: binding }, rendered)
}

interface ConnectedCableStreamSourceProps {
  readonly node: ProtocolElement
  readonly streamSources: CableStreamSourceCollection
}

function ConnectedCableStreamSource(props: ConnectedCableStreamSourceProps): ReactNode {
  useLayoutEffect(() => {
    try {
      return props.streamSources.retain(props.node)
    } catch (error) {
      if (error instanceof Error && wasCableStreamSourceErrorReported(error)) {
        alreadyReportedRenderErrors.add(error)
      }
      throw error
    }
  }, [props.node, props.streamSources])
  return null
}

function ProtocolElementView(
  props: Readonly<{ morphRevision: number; node: ProtocolElement; revision: number }>,
): ReactNode {
  const context = useRenderer()
  if (props.node.kind === "stream-source") {
    return context.streamSources
      ? createElement(
          NodeErrorBoundary,
          {
            nodeKey: props.node.key,
            onError: context.onError,
            renderError: context.renderError,
            resetIdentity: context.streamSources,
            revision: props.revision,
          },
          createElement(
            DocumentOutputMarker,
            { kind: "output" },
            createElement(ConnectedCableStreamSource, {
              node: props.node,
              streamSources: context.streamSources,
            }),
          ),
        )
      : null
  }
  if (props.node.kind === "stream" || props.node.kind === "template") return null
  if (props.node.kind === "frame") {
    const frameId = attributeValue(props.node, "id")
    const rendered =
      context.frames && frameId
        ? createElement(ConnectedFrame, {
            autofocus: context.autofocus,
            autofocusScroll: context.autofocusScroll,
            frameAutoscroll: context.frameAutoscroll,
            frameComponent: context.frameComponent,
            frameId,
            frames: context.frames,
            node: props.node,
            onError: context.onError,
            renderError: context.renderError,
          })
        : createElement(
            FrameContext.Provider,
            { value: undefined },
            createElement(Fragment, null, renderChildren(props.node.children)),
          )
    return createElement(
      NodeErrorBoundary,
      {
        nodeKey: props.node.key,
        onError: context.onError,
        renderError: context.renderError,
        revision: props.revision,
      },
      createElement(
        ProtocolDirectionBoundary,
        { node: props.node },
        createElement(
          StateScopeBoundary,
          {
            kind: "frame",
            nodeKey: props.node.key,
          },
          // A Frame is a runtime-managed region that can produce output after
          // this commit, so it counts as output the moment it mounts.
          createElement(DocumentOutputMarker, { kind: "output" }, rendered),
        ),
      ),
    )
  }

  const formId = attributeValue(props.node, "form")
  const boundaryProps = {
    morphRevision: props.morphRevision,
    node: props.node,
    onError: context.onError,
    renderError: context.renderError,
    resetIdentity: context.registry,
    revision: props.revision,
  }
  return formId !== undefined && formId !== ""
    ? createElement(AssociatedRegisteredElementBoundary, { ...boundaryProps, formId })
    : createElement(RegisteredElementBoundary, boundaryProps)
}

function claimDroppedTextRunWarning(
  session: DocumentSession,
  node: ProtocolText,
  generation: number,
): boolean {
  let sessionClaims = droppedTextRunWarnings.get(session)
  if (!sessionClaims) {
    sessionClaims = new WeakMap()
    droppedTextRunWarnings.set(session, sessionClaims)
  }
  if (sessionClaims.get(node) === generation) return false
  sessionClaims.set(node, generation)
  return true
}

/**
 * One run of protocol text, placed by the renderer rather than by a component.
 *
 * The primitive-versus-host boundary this enforces runs between the two ways
 * text reaches the screen:
 *
 * - A component owns it. A `children: "text"` definition receives the decoded
 *   run as its React children and puts it in whatever primitive it draws with,
 *   so nothing here applies and nothing here changes it.
 * - The renderer places it. A text node rendered as a child node has no host of
 *   its own, so its React parent is whatever component the nearest decoded
 *   ancestor rendered. That ancestor declared `children: "nodes"`, which says
 *   it accepts elements and says nothing about text, and on React Native a
 *   component that accepts elements is `View`-like far more often than
 *   `Text`-like. A bare string there breaks the text-in-view rule: a nonfatal
 *   RedBox in development, silent in production, and older React Native
 *   versions raised it as an invariant failure.
 *
 * The renderer cannot ask which host a component renders, so it never guesses:
 * a run it places goes inside `textComponent`, the primitive the host supplied,
 * and each run is wrapped on its own so per-node subscriptions stay intact.
 *
 * With no primitive configured the run is dropped instead of emitted. Issue
 * #405 chose that as the explicit last resort over both alternatives: refusing
 * to unwrap the unknown element would take the valid components nested in it
 * along with the text, and emitting the string is the defect itself. A drop is
 * registered rather than nothing, so unsafe text can never stand in for screen
 * output — a document whose only content was unsafe text is blank and reports
 * as blank.
 */
function ProtocolTextRun(
  props: Readonly<{ node: ProtocolText; nodeKey: string; text: string }>,
): ReactNode {
  const { session, textComponent } = useRenderer()
  const generation = session.treeGeneration
  const dropped = textComponent === undefined
  const { node, nodeKey } = props
  useEffect(() => {
    if (!dropped || !developmentVocabularyWarningsEnabled()) return
    if (session.treeGeneration !== generation) return
    if (session.getNodeSnapshot(nodeKey)?.node !== node) return
    if (!claimDroppedTextRunWarning(session, node, generation)) return
    try {
      console.warn(
        "Expo Turbo dropped text with no host text primitive",
        Object.freeze({
          documentUrl: session.tree.document.url ?? "about:blank",
          nodeKey,
        }),
      )
    } catch {
      // Development warnings must not change rendered document state.
    }
  }, [dropped, generation, node, nodeKey, session])
  return textComponent
    ? createElement(
        DocumentOutputMarker,
        { kind: "output" },
        createElement(textComponent, null, props.text),
      )
    : createElement(DocumentOutputMarker, { kind: "drop" })
}

function ProtocolNodeView(props: Readonly<{ nodeKey: string }>): ReactNode {
  const snapshot = useProtocolNode(props.nodeKey)
  if (!snapshot) return null
  const node = snapshot.node
  if (node.kind === "comment") return null
  if (node.kind === "text") {
    // Insignificant whitespace renders as nothing and always has. It is neither
    // output nor a drop: counting it either way would let indentation decide
    // whether a document reads as blank.
    const text = renderedTextValue(node)
    return text ? createElement(ProtocolTextRun, { node, nodeKey: props.nodeKey, text }) : null
  }
  if (node.kind === "document") return createElement(Fragment, null, renderChildren(node.children))
  return createElement(ProtocolElementView, {
    key: snapshot.identity,
    morphRevision: snapshot.morphRevision,
    node,
    revision: snapshot.revision,
  })
}

function DocumentStructuralOutputGuard(
  props: Readonly<{
    analysis: RegistryStructuralOutputAnalysis
    blank: boolean
    children?: ReactNode
    generation: number
    handler: ExpoTurboUnknownVocabularyHandler | undefined
    root: ProtocolElement
    session: DocumentSession
  }>,
): ReactNode {
  if (props.blank) {
    throw new UnknownVocabularyStructuralError(
      Object.freeze({
        diagnostics: props.analysis.diagnostics,
        generation: props.generation,
        handler: props.handler,
        root: props.root,
        session: props.session,
      }),
    )
  }
  return props.children
}

interface DocumentBlankVerdict {
  readonly blank: boolean
  readonly generation: number
  readonly registry: unknown
  readonly revision: number
}

/** The open interval, mutated in place so no render is scheduled from it. */
interface OpenDocumentBlankInterval {
  attempt: number
  readonly documentUrl: string
  readonly nodeKey: string
  readonly since: number
}

function reportDocumentBlankRecovery(
  handler: ExpoTurboDocumentBlankRecoveryHandler | undefined,
  interval: OpenDocumentBlankInterval,
  until: number,
): void {
  if (!handler) return
  try {
    handler(
      Object.freeze({
        attempt: interval.attempt,
        documentUrl: interval.documentUrl,
        nodeKey: interval.nodeKey,
        runtimeVersion: EXPO_TURBO_RUNTIME_VERSION,
        since: interval.since,
        until,
      }),
    )
  } catch {
    queueMicrotask(() => {
      throw new StateError("Document blank recovery reporting failed")
    })
  }
}

const EMPTY_DOCUMENT_CHILDREN: readonly ProtocolNode[] = Object.freeze([])

/**
 * The session revision, observed while the blank-root guard could be holding a
 * surface.
 *
 * The guard replaces the whole subtree with its error surface, so once it is up
 * no subscription survives below it. The root's own two node subscriptions --
 * the document and the root element -- wake it for a Stream that targets the
 * root, and for nothing else. A Stream that restores content to a nested node
 * notifies that node's key, nobody is listening, and the surface stays up for
 * the life of the process.
 *
 * Session revision is the closed set that covers this. Every mutation path in
 * `DocumentSession` -- `commit`, `installTree` and `morphCurrentDocument` --
 * bumps the revision and notifies revision listeners in the same step, so
 * observing it cannot miss a mutation and cannot drift from one. It is also
 * already the token the verdict is keyed on: the guard was reading
 * `session.revision` to decide whether its verdict had gone stale without
 * subscribing to the value it was reading. Subscribing to whichever keys a
 * Stream might target instead would mean predicting an open-ended set, which is
 * the mistake this guard has already been rewritten once to stop making.
 *
 * The subscription is gated because a root that re-renders on every commit
 * re-renders every node in the document, and a document that can raise this
 * guard at all is the rare case. The gate is deliberately wider than the guard:
 * `blank` implies this predicate, so the subscription is live whenever a
 * surface is up, and at worst stays live for a document that went blank once
 * and recovered. Under-subscribing would restore the bug; over-subscribing
 * costs renders on a document that has already shown a protocol error.
 */
function useDocumentBlankRetryRevision(session: DocumentSession, guarded: boolean): number {
  const subscribe = useCallback(
    (listener: () => void) => (guarded ? session.subscribeRevision(listener) : () => undefined),
    [guarded, session],
  )
  const snapshot = useCallback(() => session.revision, [session])
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

export function ExpoTurboRoot(): ReactNode {
  const context = useRenderer()
  const { session } = context
  const outputLedger = useContext(DocumentOutputContext) ?? EMPTY_DOCUMENT_OUTPUT_LEDGER
  useDocumentOutputVersion(outputLedger)
  const [verdict, setVerdict] = useState<DocumentBlankVerdict | undefined>(undefined)
  const root = useProtocolNode(session.tree.document.key)
  const rootElement =
    root?.node.kind === "document" ? root.node.children.find(isElement) : undefined
  const rootElementSnapshot = useProtocolNode(rootElement?.key ?? session.tree.document.key)
  const generation = session.treeGeneration
  const structuralOutput = analyzeRegistryStructuralOutput(
    context.registry,
    root?.node.kind === "document" ? root.node.children : EMPTY_DOCUMENT_CHILDREN,
  )
  // A tree that cannot render anything is decided from the tree, which involves
  // no component lifetime at all. Everything else is decided from what the last
  // commit actually produced.
  const blankByTree = !structuralOutput.hasOutput && structuralOutput.hasVocabularyIssues
  // Any tree mutation retries the verdict. The token can be broader than the
  // cause without harm: a retry that changes nothing costs one render, and the
  // commit it retries into is observed rather than predicted. The read is
  // subscribed while a surface could be up, because otherwise a mutation that
  // does not touch the root never re-renders this component to notice that its
  // verdict has gone stale.
  const revision = useDocumentBlankRetryRevision(session, blankByTree || verdict !== undefined)
  const settled =
    verdict &&
    verdict.generation === generation &&
    verdict.registry === context.registry &&
    verdict.revision === revision
      ? verdict
      : undefined
  const blank = blankByTree || settled !== undefined
  const documentUrl = session.tree.document.url ?? "about:blank"
  const documentKey = session.tree.document.key
  // The interval belongs here rather than to the boundary that raises the
  // guard, for two reasons this codebase has already paid for. A component the
  // guard unmounts can never signal its own recovery, and this component is
  // above the boundary the guard replaces, so it survives the whole interval.
  // And a ref rather than state means the falling edge schedules no render, so
  // the guard cannot observe an effect of its own reporting.
  const openBlankInterval = useRef<OpenDocumentBlankInterval | undefined>(undefined)
  // Read at record time so the interval is stamped with the document that was
  // on screen when it opened, and keeps that identity if a later commit is
  // blank too. A recovery ends the interval; nothing else re-stamps it.
  const blankDocument = useRef({ documentUrl, nodeKey: documentKey })
  blankDocument.current = { documentUrl, nodeKey: documentKey }
  const recordBlankInterval = useCallback((): ExpoTurboDocumentBlankInterval => {
    const open = openBlankInterval.current ?? {
      attempt: 0,
      documentUrl: blankDocument.current.documentUrl,
      nodeKey: blankDocument.current.nodeKey,
      since: Date.now(),
    }
    open.attempt += 1
    openBlankInterval.current = open
    return Object.freeze({
      attempt: open.attempt,
      documentUrl: open.documentUrl,
      nodeKey: open.nodeKey,
      runtimeVersion: EXPO_TURBO_RUNTIME_VERSION,
      since: open.since,
    })
  }, [])
  const onDocumentBlankRecovery = context.onDocumentBlankRecovery
  // Runs after every descendant effect in the commit, so it reads what this
  // commit produced rather than predicting it. The verdict is sticky for its
  // token: once the guard is up the subtree is gone and would observe as empty
  // forever, so only a new tree revision, generation or registry retries it. A
  // stale retry costs one render and cannot produce a wrong verdict, because
  // the commit it retries into is observed too.
  useLayoutEffect(() => {
    // The render-time verdict alone is not the blank state: a retry renders
    // with `blank` false so the subtree can be observed again, and that commit
    // is still blank if everything in it dropped. Reading both is what keeps a
    // retry from being reported as a recovery.
    const stillBlank = blank || documentOutputIsBlank(outputLedger)
    const open = openBlankInterval.current
    if (open && !stillBlank) {
      openBlankInterval.current = undefined
      reportDocumentBlankRecovery(onDocumentBlankRecovery, open, Date.now())
    }
    // Sticky for its token: once the guard is up the subtree is unmounted and
    // would observe as empty forever, so only a new revision, generation or
    // registry retries it. Nothing is stored for a healthy document, so the
    // common case never schedules a render from here.
    if (settled || !documentOutputIsBlank(outputLedger)) return
    setVerdict({ blank: true, generation, registry: context.registry, revision })
  })
  if (root?.node.kind !== "document" || !rootElement) return null
  const rootDirectionElement =
    rootElementSnapshot && isElement(rootElementSnapshot.node)
      ? rootElementSnapshot.node
      : rootElement
  const children = createElement(Fragment, null, renderChildren(root.node.children))
  const rendered = context.documentController
    ? createElement(
        ConnectedDocument,
        {
          controller: context.documentController,
          documentComponent: context.documentComponent,
          nodeKey: root.node.key,
          onError: context.onError,
          renderError: context.renderError,
        },
        children,
      )
    : children
  const guardedRendered = !blank
    ? rendered
    : createElement(
        DocumentStructuralOutputGuard,
        {
          analysis: structuralOutput,
          blank,
          generation: session.treeGeneration,
          handler: context.onUnknownVocabulary,
          root: rootDirectionElement,
          session,
        },
        rendered,
      )
  return createElement(
    NodeErrorBoundary,
    {
      nodeKey: root.node.key,
      onError: context.onError,
      renderError: context.renderError,
      resetIdentity: context.registry,
      revision: `${root.revision}:${rootElementSnapshot?.revision ?? "missing"}`,
    },
    createElement(
      RootProtocolDirectionBoundary,
      { node: rootDirectionElement },
      createElement(
        DocumentRenderBoundary,
        {
          document: root.node,
          generation: session.treeGeneration,
        },
        createElement(
          DocumentBlankGuardBoundary,
          {
            nodeKey: root.node.key,
            onError: context.onError,
            // Only while the guard is in place, which is the same positional
            // decision that keeps the guard's own surface out of the output
            // ledger: with the guard rendered, it is the only thing below this
            // boundary that can throw.
            ...(blank ? { recordBlankInterval } : {}),
            renderError: context.renderError,
            resetIdentity: context.registry,
            // The blank verdict participates in the reset key so restoring
            // renderable content clears the blank-output error. It has to be
            // the verdict rather than the tree analysis: the analysis cannot
            // see that a node rendered nothing, which is the whole reason the
            // verdict is observed.
            revision: `${root.revision}:${blank}`,
          },
          guardedRendered,
        ),
      ),
    ),
  )
}
