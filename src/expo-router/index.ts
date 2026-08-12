import * as ExpoRouter from "expo-router"
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
 * A base that only exists to parse a possibly-relative href. It is never the
 * origin a document is fetched from; only the path portion of the result is
 * used, and the caller resolves that against its own origin.
 */
const HREF_PARSE_BASE = "https://expo-turbo-router.invalid"

/**
 * Selected once, at module load.
 *
 * `useUnstableGlobalHref` is a private Expo Router export, so a rename or a
 * removal is a live possibility — and a static named import of a missing export
 * is a module-level `SyntaxError`, which takes the whole `expo-turbo/expo`
 * entrypoint down at import time and never lets a runtime fallback run. Binding
 * it through the namespace turns that into an ordinary absent value.
 *
 * Resolving it once rather than per render is what keeps the hook call order
 * fixed for the life of the process: the selected function is always called,
 * and the fallback consumes no hook slots either.
 */
const useRouterHref: () => string | undefined =
  typeof ExpoRouter.useUnstableGlobalHref === "function"
    ? ExpoRouter.useUnstableGlobalHref
    : () => undefined

export function expoRouterDocumentPath(href: unknown, pathname: string): string {
  if (typeof href !== "string" || href.trim() === "") return pathname
  try {
    const parsed = new URL(href, HREF_PARSE_BASE)
    return `${parsed.pathname}${parsed.search}${parsed.hash}`
  } catch {
    return pathname
  }
}

/**
 * The mounted Expo Router path, including search parameters.
 *
 * `usePathname()` drops the query, which would silently fetch the wrong
 * document for any route carrying one. `useUnstableGlobalHref()` keeps it, at
 * the cost of being a private Expo Router API that reserves the right to start
 * returning an absolute URL with a hostname. Taking only the path portion makes
 * that change a no-op here and keeps a router-supplied hostname from ever
 * redirecting a document request away from the host's own origin. If it yields
 * nothing usable, the pathname is still correct, just query-free.
 *
 * This module is the package's only permitted importer of `expo-router`, so
 * every other entrypoint reaches the router through here.
 */
export function useExpoRouterDocumentPath(): string {
  const pathname = ExpoRouter.usePathname()
  const href = useRouterHref()
  return expoRouterDocumentPath(href, pathname)
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
  const router = ExpoRouter.useRouter()
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
