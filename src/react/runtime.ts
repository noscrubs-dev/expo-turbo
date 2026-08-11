import { createElement, type ReactNode, useCallback, useEffect, useRef, useState } from "react"

import {
  ExpoTurboProvider,
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

export interface ExpoTurboProps extends CreateExpoTurboRuntimeOptions {
  readonly loading?: ReactNode
  readonly onError?: (error: Error) => void
  readonly onUnknownVocabulary?: ExpoTurboUnknownVocabularyHandler
  readonly renderError?: (error: Error, retry: () => void) => ReactNode
}

/**
 * Renders a complete Expo Turbo document runtime from the four host-owned
 * inputs: URL, registry, fetch adapter, and optional navigation adapter.
 */
export function ExpoTurbo({
  fetch,
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
  const [status, setStatus] = useState<
    | Readonly<{ state: "loading" }>
    | Readonly<{ error: Error; state: "error" }>
    | Readonly<{ runtime: ExpoTurboRuntime; state: "ready" }>
  >({ state: "loading" })

  const fail = useCallback((reason: unknown) => {
    const error =
      reason instanceof Error ? reason : new Error("Expo Turbo document could not be loaded")
    onErrorRef.current?.(error)
    setStatus({ error, state: "error" })
  }, [])

  // URL changes are visits on the current runtime. The remaining inputs define
  // the runtime itself and replace it when their identities change.
  // biome-ignore lint/correctness/useExhaustiveDependencies: url is handled by the visit effect
  useEffect(() => {
    const runtime = createExpoTurboRuntime({
      fetch,
      ...(history ? { history } : {}),
      ...(navigation ? { navigation } : {}),
      registry,
      url,
    })
    currentRuntimeRef.current = runtime
    setStatus({ state: "loading" })
    return () => {
      if (currentRuntimeRef.current === runtime) currentRuntimeRef.current = undefined
      runtime.dispose()
    }
  }, [attempt, fetch, history, navigation, registry])

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
  }, [attempt, fail, fetch, history, navigation, registry, url])

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
        if (currentRuntimeRef.current !== runtime) return
        onErrorRef.current?.(error)
        setStatus({ error, state: "error" })
      },
      onUnknownVocabulary: forwardUnknownVocabulary,
      registry,
      scopes: runtime.scopes,
      session: runtime.session,
      state: runtime.state,
    },
    createElement(ExpoTurboRoot),
  )
}
