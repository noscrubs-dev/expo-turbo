import { useRouter } from "expo-router"
import { useMemo } from "react"
import {
  createExpoRouterAdapters,
  defaultExpoRouterHrefForDocument,
  type ExpoRouterAdapterOptions,
  type ExpoRouterAdapters,
} from "./adapters.js"

export {
  createExpoRouterAdapters,
  defaultExpoRouterHrefForDocument,
  type ExpoRouterAdapterHost,
  type ExpoRouterAdapterOptions,
  type ExpoRouterAdapters,
  type ExpoRouterHref,
} from "./adapters.js"

export function useExpoRouterAdapters(options: ExpoRouterAdapterOptions = {}): ExpoRouterAdapters {
  const router = useRouter()
  const mapper = options.hrefForDocument ?? defaultExpoRouterHrefForDocument
  const openExternal = options.openExternal

  return useMemo(
    () =>
      createExpoRouterAdapters(router, {
        hrefForDocument: mapper,
        ...(openExternal ? { openExternal } : {}),
      }),
    [mapper, openExternal, router],
  )
}
