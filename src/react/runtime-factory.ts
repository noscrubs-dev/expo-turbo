import type {
  CableAdapter,
  ClockAdapter,
  DocumentHistoryHostAdapter,
  FetchAdapter,
  FocusAdapter,
  NavigationAdapter,
} from "../adapters/index.js"
import type { ExpoTurboError } from "../core/errors.js"
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
import { serializeModuleVersionsHeader } from "../core/protocol-request.js"
import type { ComponentRegistry, RegistryComponent } from "../registry/index.js"

const clock: ClockAdapter = {
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: Date.now,
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
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
   * Receives Cable subscription and dispatch failures. These are Stream
   * transport faults, not document faults, so they are reported rather than
   * replacing the mounted document with an error surface.
   */
  readonly onCableError?: (error: ExpoTurboError) => void
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
  const loader = new DocumentRequestLoader(session, options.fetch, requestIds, {
    capabilityHash: options.registry.capabilities.hash,
    moduleVersions,
  })
  const controller = new DocumentVisitController(loader, clock, {
    ...(history ? { history } : {}),
    snapshotCache: snapshots,
    visitLifecycle,
  })
  const refresh = new DocumentRefreshController(session, controller, clock)
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
      capabilityHash: options.registry.capabilities.hash,
      moduleVersions,
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
    moduleVersions,
    submissionController: submission,
  })
  const onCableError = options.onCableError
  const streamSources = options.cable
    ? new CableStreamSourceRegistry(session, options.cable, {
        onError: (error) => onCableError?.(error),
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
