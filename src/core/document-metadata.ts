import { attributeValue, type DocumentTree, isElement } from "./tree.js"

export interface DocumentCachePolicy {
  readonly cacheable: boolean
  readonly previewable: boolean
}

export interface DocumentRefreshSettings {
  readonly method: "morph" | "replace"
  readonly scroll: "preserve" | "reset"
}

export type DocumentVisitControl = "reload" | undefined

const cacheablePolicy = Object.freeze({ cacheable: true, previewable: true })
const noCachePolicy = Object.freeze({ cacheable: false, previewable: true })
const noPreviewPolicy = Object.freeze({ cacheable: true, previewable: false })
const defaultRefreshSettings = Object.freeze({
  method: "replace" as const,
  scroll: "reset" as const,
})
const morphPreservingRefreshSettings = Object.freeze({
  method: "morph" as const,
  scroll: "preserve" as const,
})
const morphResettingRefreshSettings = Object.freeze({
  method: "morph" as const,
  scroll: "reset" as const,
})
const replacePreservingRefreshSettings = Object.freeze({
  method: "replace" as const,
  scroll: "preserve" as const,
})

/** Reads the native cache-control equivalent from the sole XML document root. */
export function documentCachePolicy(tree: DocumentTree): DocumentCachePolicy {
  const root = tree.document.children.find(isElement)
  const value = root ? attributeValue(root, "data-turbo-cache-control") : undefined
  if (value === "no-cache") return noCachePolicy
  if (value === "no-preview") return noPreviewPolicy
  return cacheablePolicy
}

/** Reads the native visit-control equivalent from the sole XML document root. */
export function documentVisitControl(tree: DocumentTree): DocumentVisitControl {
  const root = tree.document.children.find(isElement)
  return root && attributeValue(root, "data-turbo-visit-control") === "reload"
    ? "reload"
    : undefined
}

/** Reads same-path replace settings from the sole XML document root. */
export function documentRefreshSettings(tree: DocumentTree): DocumentRefreshSettings {
  const root = tree.document.children.find(isElement)
  const method =
    root && attributeValue(root, "data-turbo-refresh-method") === "morph" ? "morph" : "replace"
  const scroll =
    root && attributeValue(root, "data-turbo-refresh-scroll") === "preserve" ? "preserve" : "reset"
  if (method === "morph") {
    return scroll === "preserve" ? morphPreservingRefreshSettings : morphResettingRefreshSettings
  }
  return scroll === "preserve" ? replacePreservingRefreshSettings : defaultRefreshSettings
}
