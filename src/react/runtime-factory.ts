import type {
  CableAdapter,
  ClockAdapter,
  DocumentHistoryHostAdapter,
  FetchAdapter,
  FocusAdapter,
  NavigationAdapter,
} from "../adapters/index.js"
import {
  CableStreamSourceRegistry,
  DocumentFormControls,
  DocumentHistory,
  DocumentReconnectReconciler,
  DocumentRefreshController,
  DocumentRequestLoader,
  DocumentSession,
  DocumentSnapshotCache,
  DocumentStateScopes,
  DocumentStateStore,
  DocumentVisitController,
  DocumentVisitLifecycle,
  type DocumentVisitResult,
  FormSubmissionController,
  FrameControllerRegistry,
  FrameHistoryCoordinator,
  FrameRequestLoader,
  parseExpoTurboDocument,
} from "../core/index.js"
import { serializeModuleVersionsHeader } from "../core/protocol-request.js"
import type { ComponentRegistry, RegistryComponent } from "../registry/index.js"
import { CableDocumentRecovery, type CableRecoveryFreshness } from "./cable-recovery-internal.js"

const clock: ClockAdapter = {
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: Date.now,
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
}

/** Matches the core controllers' own fallback when no observer was supplied. */
function rethrowUnobserved(error: Error): void {
  queueMicrotask(() => {
    throw error
  })
}

function canonicalUrl(url: string): string {
  try {
    return new URL(url).toString()
  } catch {
    return url
  }
}

/**
 * Wraps the host transport so that GETs for a document owing Cable reconnect
 * recovery must come from the origin.
 *
 * This is what makes the recovery's refresh fresh *by construction*. Nothing in
 * the returned report can prove it otherwise: the loader mints the request id
 * before it ever calls the adapter, so a transport that answers from a cache
 * produces a perfectly well-formed report over stale bytes.
 *
 * Both signals are sent, because they reach different layers: `cache` for
 * adapters that read the field, and the HTTP request headers for adapters or
 * proxies that only forward headers.
 */
function createFreshnessTransport(fetchAdapter: FetchAdapter): {
  readonly fetch: FetchAdapter
  readonly freshness: CableRecoveryFreshness
} {
  const claimed = new Set<string>()
  return {
    fetch: {
      fetch(request) {
        if (request.method !== "GET" || !claimed.has(canonicalUrl(request.url))) {
          return fetchAdapter.fetch(request)
        }
        return fetchAdapter.fetch(
          Object.freeze({
            ...request,
            cache: "no-store" as const,
            headers: Object.freeze({
              ...request.headers,
              "Cache-Control": "no-cache",
              Pragma: "no-cache",
            }),
          }),
        )
      },
    },
    freshness: {
      claim(url) {
        claimed.add(canonicalUrl(url))
      },
      release(url) {
        claimed.delete(canonicalUrl(url))
      },
    },
  }
}

const PLACEHOLDER_DOCUMENT =
  '<turbo-frame id="expo-turbo-placeholder" disabled="" data-turbo-cache-control="no-cache" />'

export interface ExpoTurboRuntime {
  readonly controller: DocumentVisitController
  readonly forms: DocumentFormControls
  readonly frames: FrameControllerRegistry
  readonly scopes: DocumentStateScopes
  readonly session: DocumentSession
  readonly state: DocumentStateStore
  /** Present only when a Cable adapter was supplied. */
  readonly streamSources?: CableStreamSourceRegistry
  dispose(): void
  load(): Promise<DocumentVisitResult>
}

export interface CreateExpoTurboRuntimeOptions {
  /**
   * Transport for `turbo-cable-stream-source` elements. Supplying it is what
   * creates the Stream source registry; the runtime owns its disposal.
   */
  readonly cable?: CableAdapter
  readonly fetch: FetchAdapter
  /**
   * Logical focus for form validation. The runtime is the single owner: it
   * hands this one adapter to every consumer that needs it, so a host never
   * has to pass the same object to two places and keep their lifetimes in step.
   */
  readonly focus?: FocusAdapter
  readonly history?: DocumentHistoryHostAdapter
  readonly navigation?: NavigationAdapter
  /**
   * Receives faults from background work: Cable subscription and dispatch,
   * document refresh, and Cable reconnect recovery. These are not document
   * faults, so they are reported rather than replacing the mounted document
   * with an error surface — but they must be reported, because the alternative
   * is an uncaught microtask throw the host can neither see nor catch.
   */
  readonly onBackgroundError?: (error: Error) => void
  readonly registry: ComponentRegistry<RegistryComponent>
  readonly url: string
}

export function createExpoTurboRuntime(options: CreateExpoTurboRuntimeOptions): ExpoTurboRuntime {
  let requestId = 0
  const requestIds = {
    next: () => `expo-turbo-${++requestId}`,
  }
  const session = new DocumentSession(
    parseExpoTurboDocument(PLACEHOLDER_DOCUMENT, { url: options.url }),
  )
  const state = new DocumentStateStore()
  const scopes = new DocumentStateScopes(session)
  const visitLifecycle = new DocumentVisitLifecycle()
  const snapshots = new DocumentSnapshotCache()
  const history = options.history
    ? new DocumentHistory({ next: () => `expo-turbo-history-${++requestId}` }, options.history)
    : undefined
  history?.initialize({ kind: "unmanaged", url: options.url })
  const moduleVersions = serializeModuleVersionsHeader(options.registry.capabilities.modules)
  const transport = createFreshnessTransport(options.fetch)
  const loader = new DocumentRequestLoader(session, transport.fetch, requestIds, {
    capabilityHash: options.registry.capabilities.hash,
    moduleVersions,
  })
  const controller = new DocumentVisitController(loader, clock, {
    ...(history ? { history } : {}),
    snapshotCache: snapshots,
    visitLifecycle,
  })
  const onBackgroundError = options.onBackgroundError
  // Spread rather than a wrapper: an always-present callback would replace each
  // controller's own fallback reporting with a no-op when the host supplied
  // nothing, which is worse than the default it displaced.
  const backgroundErrorOption = onBackgroundError ? { onError: onBackgroundError } : {}
  const refresh = new DocumentRefreshController(session, controller, clock, backgroundErrorOption)
  const frameHistory = history
    ? new FrameHistoryCoordinator(session, {
        history,
        ...(options.navigation ? { navigation: options.navigation } : {}),
        snapshotCache: snapshots,
        visitLifecycle,
      })
    : undefined
  const frames = new FrameControllerRegistry(
    session,
    new FrameRequestLoader(session, transport.fetch, requestIds, {
      capabilityHash: options.registry.capabilities.hash,
      moduleVersions,
      refresh,
    }),
    undefined,
    options.navigation,
    controller,
    frameHistory ? { frameHistory } : undefined,
  )
  const submission = new FormSubmissionController(session, transport.fetch, {
    frameControllers: frames,
    ...(history ? { history } : {}),
    ...(options.navigation ? { navigation: options.navigation } : {}),
    refresh,
    snapshotCache: snapshots,
    visitLifecycle,
  })
  const forms = new DocumentFormControls(session, {
    ...(options.focus ? { focus: options.focus } : {}),
    formSemantics: options.registry,
    moduleVersions,
    submissionController: submission,
  })
  // A Cable adapter that reconnects has to recover the document it was
  // disconnected from, or messages missed during the gap leave the screen
  // silently stale. The reconciler defers the handoff until the active visit
  // settles; the recovery scheduler then owns the debounce and, crucially,
  // survives a navigation that starts inside it and does not complete.
  const cableRecovery = options.cable
    ? new CableDocumentRecovery(controller, clock, {
        ...backgroundErrorOption,
        freshness: transport.freshness,
      })
    : undefined
  const reconnectRefresh =
    options.cable && cableRecovery
      ? new DocumentReconnectReconciler(cableRecovery, controller, backgroundErrorOption)
      : undefined
  const streamSources =
    options.cable && reconnectRefresh
      ? new CableStreamSourceRegistry(session, options.cable, {
          // This registry requires an observer, so the fallback has to be the
          // loud one rather than a no-op that swallows the fault.
          onError: onBackgroundError ?? rethrowUnobserved,
          reconnectRefresh,
          // Without this, a Cable-delivered `<turbo-stream action="refresh">`
          // silently does nothing at all: no request, no error.
          streamOptions: { refresh },
        })
      : undefined
  let disposed = false

  return Object.freeze({
    controller,
    forms,
    frames,
    scopes,
    session,
    state,
    ...(streamSources ? { streamSources } : {}),
    dispose(): void {
      if (disposed) return
      disposed = true
      forms.dispose()
      frames.dispose()
      streamSources?.dispose()
      reconnectRefresh?.dispose()
      cableRecovery?.dispose()
      refresh.dispose()
      controller.cancel()
      loader.cancel()
      scopes.dispose()
      state.dispose()
    },
    load(): Promise<DocumentVisitResult> {
      return controller.visit(options.url)
    },
  })
}
