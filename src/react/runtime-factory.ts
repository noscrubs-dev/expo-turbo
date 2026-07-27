import type { ClockAdapter, FetchAdapter, NavigationAdapter } from "../adapters/index.js"
import {
  DocumentFormControls,
  DocumentRefreshController,
  DocumentRequestLoader,
  DocumentSession,
  DocumentStateScopes,
  DocumentStateStore,
  DocumentVisitController,
  FormSubmissionController,
  FrameControllerRegistry,
  FrameRequestLoader,
  parseExpoTurboDocument,
} from "../core/index.js"
import type { ComponentRegistry, RegistryComponent } from "../registry/index.js"

const clock: ClockAdapter = {
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: Date.now,
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
}

const PLACEHOLDER_DOCUMENT = "<ExpoTurboPlaceholder />"

export interface ExpoTurboRuntime {
  readonly controller: DocumentVisitController
  readonly forms: DocumentFormControls
  readonly frames: FrameControllerRegistry
  readonly scopes: DocumentStateScopes
  readonly session: DocumentSession
  readonly state: DocumentStateStore
  dispose(): void
  load(): Promise<void>
}

export interface CreateExpoTurboRuntimeOptions {
  readonly fetch: FetchAdapter
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
  const loader = new DocumentRequestLoader(session, options.fetch, requestIds, {
    capabilityHash: options.registry.capabilities.hash,
  })
  const controller = new DocumentVisitController(loader, clock)
  const refresh = new DocumentRefreshController(session, controller, clock)
  const frames = new FrameControllerRegistry(
    session,
    new FrameRequestLoader(session, options.fetch, requestIds, {
      capabilityHash: options.registry.capabilities.hash,
      refresh,
    }),
    undefined,
    options.navigation,
    controller,
  )
  const submission = new FormSubmissionController(session, options.fetch, {
    frameControllers: frames,
    ...(options.navigation ? { navigation: options.navigation } : {}),
    refresh,
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
    async load(): Promise<void> {
      await controller.visit(options.url)
    },
  })
}
