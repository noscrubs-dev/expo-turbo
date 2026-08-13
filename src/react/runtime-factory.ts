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
import { serializeClientDescriptor } from "../core/protocol-request.js"
import type { ComponentRegistry, RegistryComponent } from "../registry/index.js"

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
   * Receives faults from background work: Cable subscription and dispatch, and
   * document refresh. These are not document faults, so they are reported
   * rather than replacing the mounted document with an error surface — but they
   * must be reported, because the alternative is an uncaught microtask throw
   * the host can neither see nor catch.
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
  const clientDescriptor = serializeClientDescriptor(options.registry.capabilities.hash)
  const loader = new DocumentRequestLoader(session, options.fetch, requestIds, {
    clientDescriptor,
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
    new FrameRequestLoader(session, options.fetch, requestIds, {
      clientDescriptor,
      refresh,
    }),
    undefined,
    options.navigation,
    controller,
    frameHistory ? { frameHistory } : undefined,
  )
  const submission = new FormSubmissionController(session, options.fetch, {
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
    moduleVersions: clientDescriptor,
    submissionController: submission,
  })
  // Cable delivers Stream actions, including `refresh`, for as long as the
  // socket is up. It does NOT recover the document after a reconnect: a
  // broadcast missed while the socket was down leaves the mounted document
  // stale until something else refreshes it. That is a known limitation rather
  // than an oversight — it matches the behavior before `cable` existed — and
  // `runtime.test.ts` pins it. Recovery is tracked in
  // https://github.com/noscrubs-dev/expo-turbo/pull/418.
  const streamSources = options.cable
    ? new CableStreamSourceRegistry(session, options.cable, {
        // This registry requires an observer, so the fallback has to be the
        // loud one rather than a no-op that swallows the fault.
        onError: onBackgroundError ?? rethrowUnobserved,
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
