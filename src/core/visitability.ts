import { TargetError } from "./errors.js"
import { resolveProtocolUrl } from "./protocol-request.js"
import { attributeValue, type DocumentTree, isElement } from "./tree.js"

export const TURBO_UNVISITABLE_EXTENSIONS = Object.freeze([
  ".7z",
  ".aac",
  ".apk",
  ".avi",
  ".bmp",
  ".bz2",
  ".css",
  ".csv",
  ".deb",
  ".dmg",
  ".doc",
  ".docx",
  ".exe",
  ".gif",
  ".gz",
  ".heic",
  ".heif",
  ".ico",
  ".iso",
  ".jpeg",
  ".jpg",
  ".js",
  ".json",
  ".m4a",
  ".mkv",
  ".mov",
  ".mp3",
  ".mp4",
  ".mpeg",
  ".mpg",
  ".msi",
  ".ogg",
  ".ogv",
  ".pdf",
  ".pkg",
  ".png",
  ".ppt",
  ".pptx",
  ".rar",
  ".rtf",
  ".svg",
  ".tar",
  ".tif",
  ".tiff",
  ".txt",
  ".wav",
  ".webm",
  ".webp",
  ".wma",
  ".wmv",
  ".xls",
  ".xlsx",
  ".xml",
  ".zip",
] as const)

const unvisitableExtensions = new Set<string>(TURBO_UNVISITABLE_EXTENSIONS)

export type TopLevelLocationClassification =
  | "external"
  | "outside-root"
  | "unvisitable-extension"
  | "visitable"

type TopLevelLocationDetails = Readonly<{
  rootLocation: string
  url: string
}>

export type TopLevelLocationDisposition =
  | (TopLevelLocationDetails & Readonly<{ classification: "external" }>)
  | (TopLevelLocationDetails & Readonly<{ classification: "outside-root" }>)
  | (TopLevelLocationDetails & Readonly<{ classification: "unvisitable-extension" }>)
  | (TopLevelLocationDetails & Readonly<{ classification: "visitable" }>)

function addTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`
}

function extension(url: URL): string {
  const component = url.pathname.split("/").slice(-1)[0] ?? ""
  return component.match(/\.[^.]*$/)?.[0] ?? ""
}

function isPrefixedBy(location: URL, rootLocation: URL): boolean {
  const prefix = addTrailingSlash(rootLocation.origin + rootLocation.pathname)
  return addTrailingSlash(location.href) === prefix || location.href.startsWith(prefix)
}

export function locationIsVisitable(location: URL, rootLocation: URL): boolean {
  return isPrefixedBy(location, rootLocation) && !unvisitableExtensions.has(extension(location))
}

export function documentRootLocation(tree: DocumentTree): string {
  const documentUrl = tree.document.url
  if (!documentUrl) throw new TargetError("Document root visitability requires an active URL")

  const root = tree.document.children.find(isElement)
  if (!root) throw new TargetError("Document root visitability requires a root element")

  return resolveProtocolUrl(attributeValue(root, "data-turbo-root") ?? "/", documentUrl).url
}

export function classifyTopLevelLocation(
  tree: DocumentTree,
  source: string,
): TopLevelLocationDisposition {
  const documentUrl = tree.document.url
  if (!documentUrl) throw new TargetError("Top-level visits require an active document URL")

  return classifyTopLevelLocationAgainstRoot(source, documentUrl, documentRootLocation(tree))
}

export function classifyTopLevelLocationAgainstRoot(
  source: string,
  documentUrl: string,
  rootSource: string,
): TopLevelLocationDisposition {
  const resolved = resolveProtocolUrl(source, documentUrl)
  const rootResolved = resolveProtocolUrl(rootSource, documentUrl)

  const url = new URL(resolved.url)
  const rootLocation = new URL(rootResolved.url)
  const classification =
    resolved.urlOrigin !== resolved.documentOrigin
      ? "external"
      : !isPrefixedBy(url, rootLocation)
        ? "outside-root"
        : unvisitableExtensions.has(extension(url))
          ? "unvisitable-extension"
          : "visitable"

  return Object.freeze({
    classification,
    rootLocation: rootLocation.toString(),
    url: url.toString(),
  })
}
