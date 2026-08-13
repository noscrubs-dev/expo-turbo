import type { NavigationAdapter, VisitAction } from "../adapters/index.js"
import type {
  DocumentHistoryEntry,
  DocumentHistoryHostAdapter,
  DocumentHistoryWriteMethod,
} from "../core/document-history.js"
import { StateError } from "../core/errors.js"

export type ExpoRouterHref =
  | string
  | Readonly<{
      params?: Readonly<Record<string, (string | number)[] | null | number | string | undefined>>
      pathname: string
    }>

export interface ExpoRouterAdapterHost {
  back(): void
  canGoBack(): boolean
  push(href: ExpoRouterHref): void
  replace(href: ExpoRouterHref): void
}

export interface ExpoRouterAdapterOptions {
  /** Maps an absolute document URL to the host application's Expo Router href. */
  readonly hrefForDocument?: (url: string) => ExpoRouterHref
  /**
   * Opens a URL outside the app. When omitted, external URLs retain the
   * compatibility behavior of an Expo Router push.
   */
  readonly openExternal?: (url: string) => unknown
}

export interface ExpoRouterAdapters {
  readonly history: DocumentHistoryHostAdapter
  readonly navigation: NavigationAdapter
}

export function defaultExpoRouterHrefForDocument(url: string): string {
  let documentUrl: URL
  try {
    documentUrl = new URL(url)
  } catch {
    throw new StateError("Expo Router document URL is invalid")
  }
  if (
    (documentUrl.protocol !== "http:" && documentUrl.protocol !== "https:") ||
    documentUrl.username !== "" ||
    documentUrl.password !== ""
  ) {
    throw new StateError("Expo Router document URL must be credential-free HTTP(S)")
  }
  if (documentUrl.pathname.startsWith("//")) {
    throw new StateError("Expo Router document URL must map to an internal path")
  }
  return `${documentUrl.pathname}${documentUrl.search}${documentUrl.hash}`
}

function hrefForDocument(
  url: string,
  mapper: NonNullable<ExpoRouterAdapterOptions["hrefForDocument"]>,
): ExpoRouterHref {
  let href: ExpoRouterHref
  try {
    href = mapper(url)
  } catch {
    throw new StateError("Expo Router document URL mapping failed")
  }
  if (
    (typeof href !== "string" || href.trim() === "") &&
    (!href ||
      typeof href !== "object" ||
      Array.isArray(href) ||
      typeof href.pathname !== "string" ||
      href.pathname.trim() === "")
  ) {
    throw new StateError("Expo Router document URL mapping returned an invalid href")
  }
  return href
}

function routerWrite(
  router: ExpoRouterAdapterHost,
  method: DocumentHistoryWriteMethod,
  href: ExpoRouterHref,
): undefined {
  try {
    const result = method === "push" ? router.push(href) : router.replace(href)
    if (result !== undefined) throw new StateError("Expo Router history writes must be synchronous")
  } catch {
    throw new StateError("Expo Router history write failed")
  }
  return undefined
}

function routerBack(router: ExpoRouterAdapterHost): void {
  try {
    if (router.canGoBack() !== true) throw new StateError("Expo Router history cannot go back")
    const result = router.back()
    if (result !== undefined) throw new StateError("Expo Router back must be synchronous")
  } catch {
    throw new StateError("Expo Router back failed")
  }
}

async function openExternal(
  handler: NonNullable<ExpoRouterAdapterOptions["openExternal"]>,
  url: string,
): Promise<void> {
  try {
    await handler(url)
  } catch {
    throw new StateError("Expo Router external navigation failed")
  }
}

function visitMethod(action: VisitAction): DocumentHistoryWriteMethod | undefined {
  if (action === "advance") return "push"
  if (action === "replace") return "replace"
  if (action === "restore") return undefined
  throw new StateError("Expo Router visit action is invalid")
}

/**
 * Validates an imperative router before it is wrapped. Exported so the React
 * hook can keep checking the live router it was handed even though it builds
 * its adapters once.
 */
export function assertExpoRouterAdapterHost(router: ExpoRouterAdapterHost): void {
  if (!router || typeof router !== "object" || Array.isArray(router)) {
    throw new StateError("Expo Router host must be an object")
  }
  if (
    typeof router.back !== "function" ||
    typeof router.canGoBack !== "function" ||
    typeof router.push !== "function" ||
    typeof router.replace !== "function"
  ) {
    throw new StateError("Expo Router host is invalid")
  }
}

export function createExpoRouterAdapters(
  router: ExpoRouterAdapterHost,
  options: ExpoRouterAdapterOptions = {},
): ExpoRouterAdapters {
  assertExpoRouterAdapterHost(router)
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new StateError("Expo Router adapter options must be an object")
  }
  const mapper = options.hrefForDocument ?? defaultExpoRouterHrefForDocument
  const externalHandler = options.openExternal
  if (typeof mapper !== "function") {
    throw new StateError("Expo Router hrefForDocument must be a function")
  }
  if (externalHandler !== undefined && typeof externalHandler !== "function") {
    throw new StateError("Expo Router openExternal must be a function")
  }

  const navigation: NavigationAdapter = Object.freeze({
    back(): void {
      routerBack(router)
    },
    openExternal(url: string): Promise<void> | void {
      if (externalHandler) return openExternal(externalHandler, url)
      routerWrite(router, "push", url)
    },
    visit(url: string, action: VisitAction): void {
      const method = visitMethod(action)
      if (!method) {
        routerBack(router)
        return
      }
      routerWrite(router, method, hrefForDocument(url, mapper))
    },
  })
  const history: DocumentHistoryHostAdapter = Object.freeze({
    write(method: DocumentHistoryWriteMethod, entry: DocumentHistoryEntry): undefined {
      return routerWrite(router, method, hrefForDocument(entry.url, mapper))
    },
  })

  return Object.freeze({ history, navigation })
}
