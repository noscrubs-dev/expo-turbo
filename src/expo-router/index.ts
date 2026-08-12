import { usePathname, useRouter } from "expo-router"
import { useMemo, useRef } from "react"
import {
  assertExpoRouterAdapterHost,
  createExpoRouterAdapters,
  defaultExpoRouterHrefForDocument,
  type ExpoRouterAdapterHost,
  type ExpoRouterAdapterOptions,
  type ExpoRouterAdapters,
  type ExpoRouterHref,
} from "./adapters.js"

export {
  assertExpoRouterAdapterHost,
  createExpoRouterAdapters,
  defaultExpoRouterHrefForDocument,
  type ExpoRouterAdapterHost,
  type ExpoRouterAdapterOptions,
  type ExpoRouterAdapters,
  type ExpoRouterHref,
} from "./adapters.js"

/**
 * The mounted Expo Router pathname, used as the default document path.
 *
 * This module is the package's only permitted importer of `expo-router`, so
 * every other entrypoint reaches the router through here.
 */
export function useExpoRouterDocumentPath(): string {
  return usePathname()
}

/**
 * Builds the Expo Router history and navigation adapters once per mount.
 *
 * The returned adapters are the runtime's identity: `ExpoTurbo` tears down and
 * rebuilds its whole runtime when they change, so a hook that memoized on the
 * caller's callback identities turned the ordinary inline-arrow call site into
 * an unbounded refetch loop and a permanently blank screen (issue #403).
 * Options are therefore read through a ref at call time, and only the
 * *presence* of `openExternal` participates in memoization, because presence is
 * the one thing that changes behavior: an absent handler keeps the Expo Router
 * push fallback for external URLs.
 */
export function useExpoRouterAdapters(options: ExpoRouterAdapterOptions = {}): ExpoRouterAdapters {
  const router = useRouter()
  const latestOptions = useRef(options)
  latestOptions.current = options
  const latestRouter = useRef(router)
  latestRouter.current = router
  const hasOpenExternal = options.openExternal !== undefined

  // Cheap enough to run every render, and it keeps the eager diagnostic a
  // caller would otherwise only see at the first navigation.
  assertExpoRouterAdapterHost(router)

  return useMemo(() => {
    const host: ExpoRouterAdapterHost = {
      back: () => latestRouter.current.back(),
      canGoBack: () => latestRouter.current.canGoBack(),
      push: (href: ExpoRouterHref) => latestRouter.current.push(href),
      replace: (href: ExpoRouterHref) => latestRouter.current.replace(href),
    }
    return createExpoRouterAdapters(host, {
      hrefForDocument: (url: string) =>
        (latestOptions.current.hrefForDocument ?? defaultExpoRouterHrefForDocument)(url),
      ...(hasOpenExternal
        ? { openExternal: (url: string) => latestOptions.current.openExternal?.(url) }
        : {}),
    })
  }, [hasOpenExternal])
}
