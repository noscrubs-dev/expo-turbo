import { createElement, type ReactNode, useCallback, useEffect, useRef, useState } from "react"
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

import { ExpoTurboProvider, ExpoTurboRoot } from "./renderer.js"

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

/**
 * Creates the standard document, Frame, form, refresh, and state runtime.
 * Applications needing custom lifecycle or history behavior can compose the
 * primitives exported by `expo-turbo/core` instead.
 */
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

export interface ExpoTurboProps extends CreateExpoTurboRuntimeOptions {
  readonly loading?: ReactNode
  readonly onError?: (error: Error) => void
  readonly renderError?: (error: Error, retry: () => void) => ReactNode
}

/**
 * Renders a complete Expo Turbo document runtime from the four host-owned
 * inputs: URL, registry, fetch adapter, and optional navigation adapter.
 */
export function ExpoTurbo({
  fetch,
  loading = null,
  navigation,
  onError,
  registry,
  renderError,
  url,
}: ExpoTurboProps): ReactNode {
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError
  const [attempt, setAttempt] = useState(0)
  const retry = useCallback(() => setAttempt((current) => current + 1), [])
  const [status, setStatus] = useState<
    | Readonly<{ state: "loading" }>
    | Readonly<{ error: Error; state: "error" }>
    | Readonly<{ runtime: ExpoTurboRuntime; state: "ready" }>
  >({ state: "loading" })

  // `attempt` is an intentional trigger-only dependency for retrying the same URL.
  // biome-ignore lint/correctness/useExhaustiveDependencies: retry must replace the runtime
  useEffect(() => {
    let active = true
    const runtime = createExpoTurboRuntime({
      fetch,
      ...(navigation ? { navigation } : {}),
      registry,
      url,
    })
    setStatus({ state: "loading" })
    void runtime.load().then(
      () => {
        if (active) setStatus({ runtime, state: "ready" })
      },
      (reason: unknown) => {
        if (!active) return
        const error =
          reason instanceof Error ? reason : new Error("Expo Turbo document could not be loaded")
        onErrorRef.current?.(error)
        setStatus({ error, state: "error" })
      },
    )
    return () => {
      active = false
      runtime.dispose()
    }
  }, [attempt, fetch, navigation, registry, url])

  if (status.state === "loading") return loading
  if (status.state === "error") return renderError?.(status.error, retry) ?? null
  const { runtime } = status

  return createElement(
    ExpoTurboProvider,
    {
      documentController: runtime.controller,
      forms: runtime.forms,
      frames: runtime.frames,
      onError: ({ error }) => {
        onErrorRef.current?.(error)
        setStatus({ error, state: "error" })
      },
      registry,
      scopes: runtime.scopes,
      session: runtime.session,
      state: runtime.state,
    },
    createElement(ExpoTurboRoot),
  )
}
