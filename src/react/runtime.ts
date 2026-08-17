import {
  type ComponentType,
  createElement,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
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
  FormSubmissionAnnouncementAdapter,
  FrameAutoscrollAdapter,
} from "../adapters/index.js"
import type { StyleAdapter } from "../adapters/styles.js"
import {
  type ExpoTurboDocumentBlankInterval,
  type ExpoTurboDocumentBoundaryProps,
  type ExpoTurboFormBoundaryProps,
  type ExpoTurboFrameBoundaryProps,
  ExpoTurboProvider,
  type ExpoTurboRenderError,
  type ExpoTurboRenderErrorSeverity,
  ExpoTurboRoot,
  type ExpoTurboUnknownVocabularyHandler,
} from "./renderer.js"
import {
  type CreateExpoTurboRuntimeOptions,
  createExpoTurboRuntime,
  type ExpoTurboRuntime,
} from "./runtime-factory.js"

export {
  type CreateExpoTurboRuntimeOptions,
  createExpoTurboRuntime,
  type ExpoTurboRuntime,
} from "./runtime-factory.js"

/**
 * Presentation-side adapters forwarded to `ExpoTurboProvider`. Every entry is
 * optional; an absent entry keeps the renderer's own behavior. Transport,
 * history, navigation, and focus stay on `ExpoTurboProps` because the runtime
 * itself consumes them.
 */
export interface ExpoTurboRenderAdapters {
  readonly autofocus?: AutofocusAdapter
  readonly autofocusScroll?: AutofocusScrollAdapter
  readonly defaultDirection?: "ltr" | "rtl"
  readonly documentAnchorScroll?: DocumentAnchorScrollAdapter
  readonly documentAnnouncements?: DocumentVisitAnnouncementAdapter
  readonly documentAutomaticPreloadPolicy?: DocumentAutomaticPreloadPolicy
  readonly documentHistoryScroll?: DocumentHistoryScrollAdapter
  readonly documentLinks?: DocumentLinkAdapter
  readonly documentPrefetchPolicy?: DocumentPrefetchPolicy
  readonly documentRefreshScroll?: DocumentRefreshScrollAdapter
  readonly formAnnouncements?: FormSubmissionAnnouncementAdapter
  readonly frameAutoscroll?: FrameAutoscrollAdapter
  readonly styles?: StyleAdapter
}

/**
 * Host chrome wrapped around every mounted document, Frame, and form.
 *
 * These components render *below* the renderer's provider but are authored by
 * the host, so they routinely read host contexts. Everything the host mounts
 * around `ExpoTurbo` therefore stays an ancestor of them: `ExpoTurbo` inserts
 * no provider of its own between the host tree and the renderer.
 */
export interface ExpoTurboBoundaries {
  readonly document?: ComponentType<ExpoTurboDocumentBoundaryProps>
  readonly form?: ComponentType<ExpoTurboFormBoundaryProps>
  readonly frame?: ComponentType<ExpoTurboFrameBoundaryProps>
}

/**
 * Everything about a failure that is not the `Error` itself.
 *
 * It arrives as a second argument so that a host written against
 * `(error) => void` keeps compiling and keeps working. Before this, the whole
 * event was dropped on the way to the host: a zero-configuration adopter's
 * error tracker received a fixed string and nothing else.
 */
export interface ExpoTurboErrorReport {
  /** Present only on the blank-root guard's reports. */
  readonly blank?: ExpoTurboDocumentBlankInterval
  /** Absent for failures that belong to no protocol node, such as configuration. */
  readonly nodeKey?: string
  readonly severity: ExpoTurboRenderErrorSeverity
}

const BACKGROUND_REPORT: ExpoTurboErrorReport = Object.freeze({ severity: "background" })
const DOCUMENT_REPORT: ExpoTurboErrorReport = Object.freeze({ severity: "document" })

function errorReport(event: ExpoTurboRenderError): ExpoTurboErrorReport {
  return Object.freeze({
    ...(event.blank ? { blank: event.blank } : {}),
    nodeKey: event.nodeKey,
    severity: event.severity,
  })
}

export interface ExpoTurboProps extends CreateExpoTurboRuntimeOptions {
  readonly adapters?: ExpoTurboRenderAdapters
  readonly boundaries?: ExpoTurboBoundaries
  readonly loading?: ReactNode
  /**
   * Receives every failure the renderer reports, whether or not it replaces the
   * document. `report.severity` says which: only `document` raises
   * `renderError`, so a failed press-in prefetch or a failed accessibility
   * announcement is observable here and invisible on screen.
   */
  readonly onError?: (error: Error, report: ExpoTurboErrorReport) => void
  readonly onUnknownVocabulary?: ExpoTurboUnknownVocabularyHandler
  /**
   * Required. A host-neutral component has no primitives to draw with, so it
   * cannot invent a failure surface, and it must not escalate: an unhandled
   * render throw is fatal on both React Native platforms. Making this the
   * host's decision at compile time is what keeps a failed document from
   * being either a blank screen or a crash.
   *
   * `ExpoTurboApp` from `expo-turbo/expo` supplies one for you. Pass
   * `() => null` to deliberately render nothing.
   */
  readonly renderError: (error: Error, retry: () => void) => ReactNode
}

const NO_RENDER_ADAPTERS: ExpoTurboRenderAdapters = Object.freeze({})
const NO_BOUNDARIES: ExpoTurboBoundaries = Object.freeze({})

/**
 * Reaches the platform console without depending on a DOM or Node type
 * declaration, so the host-neutral entrypoint keeps building with `types: []`.
 */
function reportMissingRenderError(error: Error): void {
  const diagnostics = (
    globalThis as { console?: { error?: (...values: readonly unknown[]) => void } }
  ).console
  diagnostics?.error?.(
    "[expo-turbo] ExpoTurbo received no renderError, so a failed document renders nothing. " +
      "Pass renderError, or use ExpoTurboApp from expo-turbo/expo, which ships a visible surface.",
    error,
  )
}

/**
 * Renders a complete Expo Turbo document runtime from the host-owned inputs:
 * URL, registry, fetch adapter, and optional history, navigation, and focus
 * adapters.
 */
export function ExpoTurbo({
  actions,
  adapters = NO_RENDER_ADAPTERS,
  boundaries = NO_BOUNDARIES,
  cable,
  fetch,
  focus,
  history,
  loading = null,
  navigation,
  onError,
  onUnknownVocabulary,
  registry,
  renderError,
  url,
}: ExpoTurboProps): ReactNode {
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError
  const onUnknownVocabularyRef = useRef(onUnknownVocabulary)
  onUnknownVocabularyRef.current = onUnknownVocabulary
  const currentRuntimeRef = useRef<ExpoTurboRuntime | undefined>(undefined)
  const latestUrlRef = useRef(url)
  latestUrlRef.current = url
  const [attempt, setAttempt] = useState(0)
  const retry = useCallback(() => setAttempt((current) => current + 1), [])
  // A stable identity keeps the provider from re-registering its structural
  // admission on every render.
  const forwardUnknownVocabulary = useCallback<ExpoTurboUnknownVocabularyHandler>(
    (event) => onUnknownVocabularyRef.current?.(event),
    [],
  )
  // Cable subscription and dispatch, and document refresh. The runtime factory
  // already treats these as reportable rather than fatal, so they carry the
  // severity that says so.
  const forwardBackgroundError = useCallback(
    (error: Error) => onErrorRef.current?.(error, BACKGROUND_REPORT),
    [],
  )
  const hasOnError = onError !== undefined
  const [status, setStatus] = useState<
    | Readonly<{ state: "loading" }>
    | Readonly<{ error: Error; state: "error" }>
    | Readonly<{ runtime: ExpoTurboRuntime; state: "ready" }>
  >({ state: "loading" })

  // An untyped host can still omit the required `renderError`. Say so where a
  // developer will see it — LogBox in development, the device log in release —
  // rather than throwing, which React Native escalates to a fatal.
  useEffect(() => {
    // `typeof`, not truthiness: the prop is required, so TypeScript narrows it
    // to always-defined and only an untyped host can arrive here without it.
    if (status.state !== "error" || typeof renderError === "function") return
    reportMissingRenderError(status.error)
  }, [renderError, status])

  const fail = useCallback((reason: unknown) => {
    const error =
      reason instanceof Error ? reason : new Error("Expo Turbo document could not be loaded")
    onErrorRef.current?.(error, DOCUMENT_REPORT)
    setStatus({ error, state: "error" })
  }, [])

  // URL changes are visits on the current runtime. The remaining inputs define
  // the runtime itself and replace it when their identities change.
  // biome-ignore lint/correctness/useExhaustiveDependencies: url is handled by the visit effect
  useEffect(() => {
    const runtime = createExpoTurboRuntime({
      ...(actions ? { actions } : {}),
      ...(cable ? { cable } : {}),
      fetch,
      ...(focus ? { focus } : {}),
      ...(history ? { history } : {}),
      ...(navigation ? { navigation } : {}),
      // Presence, not identity: an always-present wrapper would be a callback
      // that does nothing when the host supplied no `onError`, which suppresses
      // each controller's own fallback reporting just as effectively as a
      // no-op. Absent has to mean absent all the way down.
      ...(hasOnError ? { onBackgroundError: forwardBackgroundError } : {}),
      registry,
      url,
    })
    currentRuntimeRef.current = runtime
    setStatus({ state: "loading" })
    return () => {
      if (currentRuntimeRef.current === runtime) currentRuntimeRef.current = undefined
      runtime.dispose()
    }
  }, [
    attempt,
    actions,
    cable,
    fetch,
    focus,
    forwardBackgroundError,
    hasOnError,
    history,
    navigation,
    registry,
  ])

  // The preceding effect replaces this ref whenever a runtime-defining input
  // changes, so those inputs intentionally restart the visit effect too.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runtime identity is held in currentRuntimeRef
  useEffect(() => {
    const runtime = currentRuntimeRef.current
    if (!runtime) return
    const requestedUrl = new URL(url, runtime.session.tree.document.url).toString()
    if (runtime.session.treeGeneration > 0 && runtime.session.tree.document.url === requestedUrl) {
      setStatus({ runtime, state: "ready" })
      return
    }
    let active = true
    const initial =
      runtime.session.treeGeneration === 0 && runtime.session.tree.document.url === requestedUrl
    const visit = initial
      ? runtime.load()
      : history
        ? runtime.controller.visit(url, { action: "replace" })
        : runtime.controller.visit(url)
    void visit.then(
      (result) => {
        if (
          active &&
          currentRuntimeRef.current === runtime &&
          latestUrlRef.current === url &&
          result.status === "committed" &&
          "requestedUrl" in result &&
          result.requestedUrl === requestedUrl &&
          runtime.session.treeGeneration > 0
        ) {
          setStatus({ runtime, state: "ready" })
        }
      },
      (reason: unknown) => {
        if (active && currentRuntimeRef.current === runtime && latestUrlRef.current === url) {
          fail(reason)
        }
      },
    )
    return () => {
      active = false
    }
  }, [actions, attempt, cable, fail, fetch, focus, history, navigation, registry, url])

  if (status.state === "loading") return loading
  if (status.state === "error") {
    // `renderError` is required, so an untyped host is the only way to arrive
    // here without one. Rendering nothing is survivable; throwing would be
    // fatal in a release build, which is strictly worse than the blank screen
    // it was meant to replace. The effect above says so once, out loud.
    if (typeof renderError !== "function") return null
    return renderError(status.error, retry)
  }
  const { runtime } = status

  return createElement(
    ExpoTurboProvider,
    {
      ...(runtime.actions ? { actions: runtime.actions } : {}),
      ...(adapters.autofocus ? { autofocus: adapters.autofocus } : {}),
      ...(adapters.autofocusScroll ? { autofocusScroll: adapters.autofocusScroll } : {}),
      ...(adapters.defaultDirection ? { defaultDirection: adapters.defaultDirection } : {}),
      ...(adapters.documentAnchorScroll
        ? { documentAnchorScroll: adapters.documentAnchorScroll }
        : {}),
      ...(adapters.documentAnnouncements
        ? { documentAnnouncements: adapters.documentAnnouncements }
        : {}),
      ...(adapters.documentAutomaticPreloadPolicy
        ? { documentAutomaticPreloadPolicy: adapters.documentAutomaticPreloadPolicy }
        : {}),
      ...(boundaries.document ? { documentComponent: boundaries.document } : {}),
      documentController: runtime.controller,
      documentPreloader: runtime.documentPreloader,
      ...(adapters.documentHistoryScroll
        ? { documentHistoryScroll: adapters.documentHistoryScroll }
        : {}),
      ...(adapters.documentLinks ? { documentLinks: adapters.documentLinks } : {}),
      ...(adapters.documentPrefetchPolicy
        ? { documentPrefetchPolicy: adapters.documentPrefetchPolicy }
        : {}),
      ...(adapters.documentRefreshScroll
        ? { documentRefreshScroll: adapters.documentRefreshScroll }
        : {}),
      ...(adapters.formAnnouncements ? { formAnnouncements: adapters.formAnnouncements } : {}),
      ...(boundaries.form ? { formComponent: boundaries.form } : {}),
      // Issue #428: the renderer reads generated form-link submissions from
      // context, so a runtime that never receives them fails every link
      // carrying `data-turbo-method` — the Rails delete button — with a
      // TargetError that reaches neither `onError` nor `renderError`.
      formLinks: runtime.formLinks,
      forms: runtime.forms,
      ...(adapters.frameAutoscroll ? { frameAutoscroll: adapters.frameAutoscroll } : {}),
      ...(boundaries.frame ? { frameComponent: boundaries.frame } : {}),
      frames: runtime.frames,
      framePreloader: runtime.framePreloader,
      // Issue #404: the renderer reads navigation from context, so a runtime
      // that never receives it here fails every external-scheme, cross-origin,
      // and unvisitable link with a TargetError.
      ...(navigation ? { navigation } : {}),
      // Issue #435: this is the first consumer forced to decide "is this
      // fatal?". It used to have nothing to decide with, so it escalated
      // everything — including speculative and background failures, which
      // replaced a healthy screen the user was looking at and, with the
      // provider, released every live Cable stream-source subscription.
      onError: (event) => {
        if (currentRuntimeRef.current !== runtime) return
        onErrorRef.current?.(event.error, errorReport(event))
        if (event.severity !== "document") return
        setStatus({ error: event.error, state: "error" })
      },
      onUnknownVocabulary: forwardUnknownVocabulary,
      // The runtime created scopes and state and disposes them in its own
      // cleanup, so the provider must not dispose them a second time.
      ownsStateDisposal: false,
      registry,
      ...(typeof renderError === "function"
        ? { renderError: (event: ExpoTurboRenderError) => renderError(event.error, retry) }
        : {}),
      scopes: runtime.scopes,
      session: runtime.session,
      state: runtime.state,
      ...(runtime.streamSources ? { streamSources: runtime.streamSources } : {}),
      ...(adapters.styles ? { styles: adapters.styles } : {}),
    },
    createElement(ExpoTurboRoot),
  )
}
