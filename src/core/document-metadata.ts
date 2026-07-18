import { attributeValue, type DocumentTree, isElement } from "./tree"

export interface DocumentCachePolicy {
  readonly cacheable: boolean
  readonly previewable: boolean
}

const cacheablePolicy = Object.freeze({ cacheable: true, previewable: true })
const noCachePolicy = Object.freeze({ cacheable: false, previewable: true })
const noPreviewPolicy = Object.freeze({ cacheable: true, previewable: false })

/** Reads the native cache-control equivalent from the sole XML document root. */
export function documentCachePolicy(tree: DocumentTree): DocumentCachePolicy {
  const root = tree.document.children.find(isElement)
  const value = root ? attributeValue(root, "data-turbo-cache-control") : undefined
  if (value === "no-cache") return noCachePolicy
  if (value === "no-preview") return noPreviewPolicy
  return cacheablePolicy
}
