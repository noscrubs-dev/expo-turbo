import type { TurboResponse } from "../adapters/index.js"
import { type ExpoTurboErrorContext, RequestError, TargetError } from "./errors.js"
import { EXPO_TURBO_PROTOCOL_VERSION, EXPO_TURBO_RUNTIME_VERSION } from "./versions.js"

export const EXPO_TURBO_MIME_TYPE = "application/vnd.expo-turbo+xml" as const
export const TURBO_STREAM_MIME_TYPE = "text/vnd.turbo-stream.html" as const

export interface ProtocolRequestHeaderOptions {
  readonly acceptsTurboStream?: boolean
  readonly capabilityHash?: string
  readonly frameId?: string
  readonly requestId: string
}

export interface ProtocolUrlResolution {
  readonly documentOrigin: string
  readonly url: string
  readonly urlOrigin: string
}

export type ExternalDocumentLinkScheme = "mailto" | "tel"

export type DocumentLinkUrlResolution =
  | Readonly<{
      kind: "external"
      scheme: ExternalDocumentLinkScheme
      url: string
    }>
  | Readonly<{
      kind: "protocol"
      resolution: ProtocolUrlResolution
    }>

export interface DocumentLinkAnchorResolution {
  readonly targetId: string
  readonly url: string
}

export interface DocumentLinkFragmentResolution extends DocumentLinkAnchorResolution {
  readonly requestUrl: string
}

function requestHeaderValue(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0)
      return codePoint !== undefined && (codePoint <= 31 || codePoint === 127)
    })
  ) {
    throw new RequestError("Protocol request header metadata is invalid")
  }
  return value
}

export function protocolRequestHeaders(
  options: ProtocolRequestHeaderOptions,
): Readonly<Record<string, string>> {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new RequestError("Protocol request header options must be an object")
  }
  if (options.acceptsTurboStream !== undefined && typeof options.acceptsTurboStream !== "boolean") {
    throw new RequestError("Protocol request Stream negotiation metadata is invalid")
  }
  const requestId = requestHeaderValue(options.requestId)
  const capabilityHash =
    options.capabilityHash === undefined ? undefined : requestHeaderValue(options.capabilityHash)
  const frameId = options.frameId === undefined ? undefined : requestHeaderValue(options.frameId)
  return Object.freeze({
    Accept: options.acceptsTurboStream
      ? `${TURBO_STREAM_MIME_TYPE}, ${EXPO_TURBO_MIME_TYPE}`
      : EXPO_TURBO_MIME_TYPE,
    "X-Expo-Turbo-Protocol": EXPO_TURBO_PROTOCOL_VERSION,
    "X-Expo-Turbo-Runtime": EXPO_TURBO_RUNTIME_VERSION,
    "X-Turbo-Request-Id": requestId,
    ...(capabilityHash ? { "X-Expo-Turbo-Capabilities": capabilityHash } : {}),
    ...(frameId ? { "Turbo-Frame": frameId } : {}),
  })
}

export function responseContentType(response: Pick<TurboResponse, "headers">): string | undefined {
  const value = Object.entries(response.headers).find(
    ([name]) => name.toLowerCase() === "content-type",
  )?.[1]
  return value?.split(";", 1)[0]?.trim().toLowerCase()
}

export function resolveProtocolUrl(
  source: string,
  originUrl: string,
  baseUrl: string = originUrl,
  context: ExpoTurboErrorContext = {},
): ProtocolUrlResolution {
  try {
    const origin = new URL(originUrl)
    const resolved = new URL(source, baseUrl)
    if (
      !["http:", "https:"].includes(origin.protocol) ||
      origin.username !== "" ||
      origin.password !== ""
    ) {
      throw new TargetError("Protocol origin must use HTTP or HTTPS without credentials", context)
    }
    if (
      !["http:", "https:"].includes(resolved.protocol) ||
      resolved.username !== "" ||
      resolved.password !== ""
    ) {
      throw new TargetError("Protocol URL must use HTTP or HTTPS without credentials", context)
    }
    return Object.freeze({
      documentOrigin: origin.origin,
      url: resolved.toString(),
      urlOrigin: resolved.origin,
    })
  } catch (error) {
    if (error instanceof TargetError) throw error
    throw new TargetError("Protocol URL is invalid", context)
  }
}

export function resolveDocumentLinkUrl(
  source: string,
  documentUrl: string,
  context: ExpoTurboErrorContext = {},
): DocumentLinkUrlResolution {
  assertDocumentLinkSource(source, context)

  try {
    const document = resolveProtocolUrl(documentUrl, documentUrl, documentUrl, context)
    const resolved = new URL(source, document.url)
    const url = resolved.toString()
    if (url.includes("#")) {
      throw new TargetError("Document link fragments require navigation support", context)
    }
    if (resolved.username !== "" || resolved.password !== "") {
      throw new TargetError("Document link URLs cannot contain credentials", context)
    }
    if (resolved.protocol === "mailto:" || resolved.protocol === "tel:") {
      if (
        url.slice(resolved.protocol.length).startsWith("//") ||
        resolved.host !== "" ||
        (resolved.protocol === "tel:" && resolved.pathname === "")
      ) {
        throw new TargetError("Document link URL is invalid", context)
      }
      return Object.freeze({
        kind: "external",
        scheme: resolved.protocol.slice(0, -1) as ExternalDocumentLinkScheme,
        url,
      })
    }
    return Object.freeze({
      kind: "protocol",
      resolution: resolveProtocolUrl(source, document.url, document.url, context),
    })
  } catch (error) {
    if (error instanceof TargetError) throw error
    throw new TargetError("Document link URL is invalid", context)
  }
}

/** Resolves only a nonempty same-document fragment for native anchor scrolling. */
export function resolveDocumentLinkAnchor(
  source: string,
  documentUrl: string,
  context: ExpoTurboErrorContext = {},
): DocumentLinkAnchorResolution | undefined {
  const resolution = resolveDocumentLinkFragment(source, documentUrl, context)
  if (!resolution) return undefined
  const current = new URL(resolveProtocolUrl(documentUrl, documentUrl, documentUrl, context).url)
  current.hash = ""
  return resolution.requestUrl === current.toString()
    ? Object.freeze({ targetId: resolution.targetId, url: resolution.url })
    : undefined
}

/** Resolves a nonempty HTTP(S) fragment while retaining its fragment-free request URL. */
export function resolveDocumentLinkFragment(
  source: string,
  documentUrl: string,
  context: ExpoTurboErrorContext = {},
): DocumentLinkFragmentResolution | undefined {
  assertDocumentLinkSource(source, context)
  try {
    const document = resolveProtocolUrl(documentUrl, documentUrl, documentUrl, context)
    const resolution = resolveProtocolUrl(source, document.url, document.url, context)
    const target = new URL(resolution.url)
    const hash = target.hash
    if (hash === "") return undefined
    target.hash = ""
    let targetId: string
    try {
      targetId = decodeURIComponent(hash.slice(1))
    } catch {
      throw new TargetError("Document link anchor is invalid", context)
    }
    if (
      targetId.trim() === "" ||
      [...targetId].some((character) => {
        const codePoint = character.codePointAt(0)
        return codePoint !== undefined && (codePoint <= 31 || codePoint === 127)
      })
    ) {
      throw new TargetError("Document link anchor is invalid", context)
    }
    return Object.freeze({ requestUrl: target.toString(), targetId, url: resolution.url })
  } catch (error) {
    if (error instanceof TargetError) throw error
    throw new TargetError("Document link URL is invalid", context)
  }
}

function assertDocumentLinkSource(source: string, context: ExpoTurboErrorContext): void {
  if (
    typeof source !== "string" ||
    source.trim() === "" ||
    [...source].some((character) => {
      const codePoint = character.codePointAt(0)
      return codePoint !== undefined && (codePoint <= 31 || codePoint === 127)
    })
  ) {
    throw new TargetError("Document link URL is invalid", context)
  }
}

export function resolveSameOriginProtocolUrl(
  source: string,
  originUrl: string,
  baseUrl: string = originUrl,
  context: ExpoTurboErrorContext = {},
): string {
  const resolved = resolveProtocolUrl(source, originUrl, baseUrl, context)
  if (resolved.urlOrigin !== resolved.documentOrigin) {
    throw new TargetError(
      "Protocol request must be same-origin HTTP(S) without credentials",
      context,
    )
  }
  return resolved.url
}
