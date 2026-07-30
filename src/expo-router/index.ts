import { useRouter } from "expo-router"
import { useMemo, useRef } from "react"
import {
  createExpoRouterAdapters,
  defaultExpoRouterHrefForDocument,
  type ExpoRouterAdapterOptions,
  type ExpoRouterAdapters,
  type ExpoRouterHref,
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
  const mapper = options.hrefForDocument
  const mapperRef = useRef<typeof mapper>(mapper)
  mapperRef.current = mapper

  return useMemo(
    () =>
      createExpoRouterAdapters(router, {
        hrefForDocument(url): ExpoRouterHref {
          return (mapperRef.current ?? defaultExpoRouterHrefForDocument)(url)
        },
      }),
    [router],
  )
}
