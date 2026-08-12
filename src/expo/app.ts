import { createElement, type ReactNode, useMemo } from "react"
import { AccessibilityInfo, I18nManager, Linking } from "react-native"

import { createDefaultFetchAdapter } from "../adapters/fetch.js"
import type {
  AutofocusAdapter,
  AutofocusScrollAdapter,
  DocumentAnchorScrollAdapter,
  DocumentAutomaticPreloadPolicy,
  DocumentHistoryHostAdapter,
  DocumentHistoryScrollAdapter,
  DocumentLinkAdapter,
  DocumentPrefetchPolicy,
  DocumentRefreshScrollAdapter,
  DocumentVisitAnnouncementAdapter,
  DocumentVisitAnnouncementEvent,
  FetchAdapter,
  FocusAdapter,
  FormSubmissionAnnouncementAdapter,
  FormSubmissionAnnouncementEvent,
  FrameAutoscrollAdapter,
  NavigationAdapter,
  StyleAdapter,
} from "../adapters/index.js"
import { StateError } from "../core/errors.js"
import { useExpoRouterAdapters, useExpoRouterDocumentPath } from "../expo-router/index.js"
import {
  ExpoTurbo,
  type ExpoTurboBoundaries,
  type ExpoTurboRenderAdapters,
  type ExpoTurboUnknownVocabularyHandler,
} from "../react/index.js"
import type { ComponentRegistry, RegistryComponent } from "../registry/index.js"
import { ExpoTurboErrorSurface, ExpoTurboLoadingSurface } from "./surfaces.js"

/**
 * Every adapter `ExpoTurboApp` wires, with three states per key:
 *
 * - absent (or `undefined`) — use the packaged default, if the key has one
 * - an object — use exactly this adapter
 * - `null` — explicitly off, even where a default exists
 *
 * Keys documented as having no default treat `null` and absent identically.
 * They are listed so an application can supply its host-owned implementation
 * without dropping down to `ExpoTurbo`.
 */
export interface ExpoTurboAppAdapters {
  /** No default: logical focus needs host-owned native node references. */
  readonly autofocus?: AutofocusAdapter | null
  /** No default: revealing a focused node needs a host scroll container. */
  readonly autofocusScroll?: AutofocusScrollAdapter | null
  /** No default: anchor scrolling needs a host scroll container. */
  readonly documentAnchorScroll?: DocumentAnchorScrollAdapter | null
  /** Default: announces visit status through `AccessibilityInfo`. */
  readonly documentAnnouncements?: DocumentVisitAnnouncementAdapter | null
  /** Default: same-origin URLs only. */
  readonly documentAutomaticPreloadPolicy?: DocumentAutomaticPreloadPolicy | null
  /** No default: restoring scroll needs a host scroll container. */
  readonly documentHistoryScroll?: DocumentHistoryScrollAdapter | null
  /** Default: `Linking.openURL` for both browsing contexts and downloads. */
  readonly documentLinks?: DocumentLinkAdapter | null
  /** Default: same-origin URLs only. */
  readonly documentPrefetchPolicy?: DocumentPrefetchPolicy | null
  /** No default: resetting scroll needs a host scroll container. */
  readonly documentRefreshScroll?: DocumentRefreshScrollAdapter | null
  /** Default: `createDefaultFetchAdapter()`. */
  readonly fetch?: FetchAdapter | null
  /**
   * No default: logical focus needs host-owned native node references.
   *
   * Supply it once here. When the object also satisfies `AutofocusAdapter`,
   * the library hands the same instance to form validation and to the
   * renderer, so an application never keeps two owners of one adapter in step
   * by hand.
   */
  readonly focus?: FocusAdapter | null
  /** Default: announces settled submissions through `AccessibilityInfo`. */
  readonly formAnnouncements?: FormSubmissionAnnouncementAdapter | null
  /** No default: Frame autoscroll needs a host scroll container. */
  readonly frameAutoscroll?: FrameAutoscrollAdapter | null
  /** Default: the Expo Router history-write bridge. */
  readonly history?: DocumentHistoryHostAdapter | null
  /** Default: the Expo Router navigation bridge. */
  readonly navigation?: NavigationAdapter | null
  /** No default: style tokens are application vocabulary. */
  readonly styles?: StyleAdapter | null
}

export interface ExpoTurboAppProps {
  readonly adapters?: ExpoTurboAppAdapters
  readonly boundaries?: ExpoTurboBoundaries
  /** Replaces the packaged spinner. */
  readonly loading?: ReactNode
  readonly onError?: (error: Error) => void
  readonly onUnknownVocabulary?: ExpoTurboUnknownVocabularyHandler
  /** Absolute origin of the Rails application, such as `https://example.com`. */
  readonly origin: string
  /**
   * Document path. Defaults to the mounted Expo Router pathname, which is what
   * makes a catch-all route zero-configuration. Search parameters are not
   * inferred from the router: pass them here when a document needs them.
   */
  readonly path?: string
  readonly registry: ComponentRegistry<RegistryComponent>
  /** Replaces the packaged error surface. */
  readonly renderError?: (error: Error, retry: () => void) => ReactNode
}

const NO_ADAPTERS: ExpoTurboAppAdapters = Object.freeze({})
const DEFAULT_FETCH: FetchAdapter = createDefaultFetchAdapter()
const DEFAULT_LOADING: ReactNode = createElement(ExpoTurboLoadingSurface)

const DOCUMENT_ANNOUNCEMENTS: Readonly<Record<string, string>> = Object.freeze({
  canceled: "Navigation canceled",
  completed: "Page loaded",
  failed: "Page failed to load",
  started: "Loading page",
})

const DEFAULT_DOCUMENT_ANNOUNCEMENTS: DocumentVisitAnnouncementAdapter = Object.freeze({
  announce(event: DocumentVisitAnnouncementEvent): void {
    const message = DOCUMENT_ANNOUNCEMENTS[event.status]
    if (message) AccessibilityInfo.announceForAccessibility(message)
  },
})

const FORM_ANNOUNCEMENTS: Readonly<Record<string, string>> = Object.freeze({
  applied: "Form submitted",
  canceled: "Form submission canceled",
  "committed-error": "Form submission returned an error",
  empty: "Form submitted with no changes",
  failed: "Form submission failed",
  unapplied: "Form submission was not applied",
})

const DEFAULT_FORM_ANNOUNCEMENTS: FormSubmissionAnnouncementAdapter = Object.freeze({
  announce(event: FormSubmissionAnnouncementEvent): void {
    const message = FORM_ANNOUNCEMENTS[event.terminalState.status]
    if (message) AccessibilityInfo.announceForAccessibility(message)
  },
})

const DEFAULT_DOCUMENT_LINKS: DocumentLinkAdapter = Object.freeze({
  async download(request: Readonly<{ url: string }>): Promise<void> {
    await Linking.openURL(request.url)
  },
  async openBrowsingContext(request: Readonly<{ url: string }>): Promise<void> {
    await Linking.openURL(request.url)
  },
})

function sameOrigin(url: string, origin: string): boolean {
  try {
    return new URL(url, origin).origin === new URL(origin).origin
  } catch {
    return false
  }
}

/**
 * Resolves one adapter key. `null` means the host turned the key off, so the
 * packaged default must not quietly reappear.
 */
function resolveAdapter<T>(override: T | null | undefined, fallback: T | undefined): T | undefined {
  if (override === null) return undefined
  if (override !== undefined) return override
  return fallback
}

function isAutofocusAdapter(
  value: FocusAdapter | null | undefined,
): value is AutofocusAdapter & FocusAdapter {
  return (
    !!value &&
    typeof (value as Partial<AutofocusAdapter>).canFocus === "function" &&
    typeof (value as Partial<AutofocusAdapter>).focus === "function"
  )
}

function documentUrl(origin: string, path: string): string {
  let resolved: URL
  try {
    resolved = new URL(path, origin)
  } catch {
    throw new StateError("Expo Turbo app origin and path must form a valid URL")
  }
  if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
    throw new StateError("Expo Turbo app origin must be HTTP(S)")
  }
  return resolved.toString()
}

/**
 * The zero-configuration Expo entrypoint.
 *
 * ```tsx
 * <ExpoTurboApp origin="https://example.com" registry={registry} />
 * ```
 *
 * It owns the document URL, the Expo Router history and navigation bridge, the
 * transport, the runtime and its disposal, and visible loading and error
 * surfaces. It deliberately mounts no provider between the host tree and the
 * renderer, so anything the application wraps around it stays an ancestor of
 * the `boundaries` components that render inside the document.
 */
export function ExpoTurboApp({
  adapters = NO_ADAPTERS,
  boundaries,
  loading,
  onError,
  onUnknownVocabulary,
  origin,
  path,
  registry,
  renderError,
}: ExpoTurboAppProps): ReactNode {
  const routerPath = useExpoRouterDocumentPath()
  const routerAdapters = useExpoRouterAdapters()
  const url = documentUrl(origin, path ?? routerPath)

  const fetchAdapter = resolveAdapter(adapters.fetch, DEFAULT_FETCH)
  const history = resolveAdapter(adapters.history, routerAdapters.history)
  const navigation = resolveAdapter(adapters.navigation, routerAdapters.navigation)
  const focus = resolveAdapter(adapters.focus, undefined)
  // One supplied focus object reaches both consumers from a single input.
  const autofocus = resolveAdapter(
    adapters.autofocus,
    isAutofocusAdapter(adapters.focus) ? adapters.focus : undefined,
  )

  const {
    autofocusScroll,
    documentAnchorScroll,
    documentAnnouncements,
    documentAutomaticPreloadPolicy,
    documentHistoryScroll,
    documentLinks,
    documentPrefetchPolicy,
    documentRefreshScroll,
    formAnnouncements,
    frameAutoscroll,
    styles,
  } = adapters

  const renderAdapters = useMemo<ExpoTurboRenderAdapters>(() => {
    const preload = resolveAdapter(
      documentAutomaticPreloadPolicy,
      Object.freeze({ canPreload: (value: string) => sameOrigin(value, origin) }),
    )
    const prefetch = resolveAdapter(
      documentPrefetchPolicy,
      Object.freeze({ canPrefetch: (value: string) => sameOrigin(value, origin) }),
    )
    const announcements = resolveAdapter(documentAnnouncements, DEFAULT_DOCUMENT_ANNOUNCEMENTS)
    const forms = resolveAdapter(formAnnouncements, DEFAULT_FORM_ANNOUNCEMENTS)
    const links = resolveAdapter(documentLinks, DEFAULT_DOCUMENT_LINKS)
    const anchorScroll = resolveAdapter(documentAnchorScroll, undefined)
    const historyScroll = resolveAdapter(documentHistoryScroll, undefined)
    const refreshScroll = resolveAdapter(documentRefreshScroll, undefined)
    const focusScroll = resolveAdapter(autofocusScroll, undefined)
    const autoscroll = resolveAdapter(frameAutoscroll, undefined)
    const styleAdapter = resolveAdapter(styles, undefined)

    return {
      ...(autofocus ? { autofocus } : {}),
      ...(focusScroll ? { autofocusScroll: focusScroll } : {}),
      defaultDirection: I18nManager?.isRTL ? "rtl" : "ltr",
      ...(anchorScroll ? { documentAnchorScroll: anchorScroll } : {}),
      ...(announcements ? { documentAnnouncements: announcements } : {}),
      ...(preload ? { documentAutomaticPreloadPolicy: preload } : {}),
      ...(historyScroll ? { documentHistoryScroll: historyScroll } : {}),
      ...(links ? { documentLinks: links } : {}),
      ...(prefetch ? { documentPrefetchPolicy: prefetch } : {}),
      ...(refreshScroll ? { documentRefreshScroll: refreshScroll } : {}),
      ...(forms ? { formAnnouncements: forms } : {}),
      ...(autoscroll ? { frameAutoscroll: autoscroll } : {}),
      ...(styleAdapter ? { styles: styleAdapter } : {}),
    }
  }, [
    autofocus,
    autofocusScroll,
    documentAnchorScroll,
    documentAnnouncements,
    documentAutomaticPreloadPolicy,
    documentHistoryScroll,
    documentLinks,
    documentPrefetchPolicy,
    documentRefreshScroll,
    formAnnouncements,
    frameAutoscroll,
    origin,
    styles,
  ])

  const surface = useMemo(
    () =>
      renderError ??
      ((error: Error, retry: () => void) => createElement(ExpoTurboErrorSurface, { error, retry })),
    [renderError],
  )

  if (!fetchAdapter) throw new StateError("Expo Turbo app requires a fetch adapter")

  return createElement(ExpoTurbo, {
    adapters: renderAdapters,
    ...(boundaries ? { boundaries } : {}),
    fetch: fetchAdapter,
    ...(focus ? { focus } : {}),
    ...(history ? { history } : {}),
    loading: loading ?? DEFAULT_LOADING,
    ...(navigation ? { navigation } : {}),
    ...(onError ? { onError } : {}),
    ...(onUnknownVocabulary ? { onUnknownVocabulary } : {}),
    registry,
    renderError: surface,
    url,
  })
}
