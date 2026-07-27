import { createElement, type ReactNode, useCallback, useEffect, useRef, useState } from "react"

import { ExpoTurboProvider, ExpoTurboRoot } from "./renderer.js"
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
    let active = true
    const runtime = createExpoTurboRuntime({
      fetch,
      ...(history ? { history } : {}),
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
        if (active) fail(reason)
      },
    )
    return () => {
      active = false
      runtime.dispose()
    }
  }, [attempt, fail, fetch, history, navigation, registry])

  useEffect(() => {
    if (status.state !== "ready" || status.runtime.session.tree.document.url === url) return
    let active = true
    void status.runtime.controller.visit(url, { action: "replace" }).catch((reason: unknown) => {
      if (active) fail(reason)
    })
    return () => {
      active = false
    }
  }, [fail, status, url])

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
