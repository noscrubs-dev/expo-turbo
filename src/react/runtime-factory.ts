import type {
  ClockAdapter,
  DocumentHistoryHostAdapter,
  FetchAdapter,
  NavigationAdapter,
} from "../adapters/index.js"
import {
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
  dispose(): void
  load(): Promise<DocumentVisitResult>
}

export interface CreateExpoTurboRuntimeOptions {
  readonly fetch: FetchAdapter
  readonly history?: DocumentHistoryHostAdapter
  readonly navigation?: NavigationAdapter
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
  const loader = new DocumentRequestLoader(session, options.fetch, requestIds, {
    capabilityHash: options.registry.capabilities.hash,
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
    formSemantics: options.registry,
    submissionController: submission,
  })
  let disposed = false

  return Object.freeze({
    controller,
    forms,
    frames,
    scopes,
    session,
    state,
    dispose(): void {
      if (disposed) return
      disposed = true
      forms.dispose()
      frames.dispose()
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
