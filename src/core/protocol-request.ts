import type { TurboResponse } from "../adapters"
import { type ExpoTurboErrorContext, TargetError } from "./errors"
import { EXPO_TURBO_PROTOCOL_VERSION, EXPO_TURBO_RUNTIME_VERSION } from "./versions"

export const EXPO_TURBO_MIME_TYPE = "application/vnd.expo-turbo+xml" as const

export interface ProtocolRequestHeaderOptions {
  readonly capabilityHash?: string
  readonly frameId?: string
  readonly requestId: string
}

export interface ProtocolUrlResolution {
  readonly documentOrigin: string
  readonly url: string
  readonly urlOrigin: string
}

export function protocolRequestHeaders(
  options: ProtocolRequestHeaderOptions,
): Readonly<Record<string, string>> {
  return Object.freeze({
    Accept: EXPO_TURBO_MIME_TYPE,
    "X-Expo-Turbo-Protocol": EXPO_TURBO_PROTOCOL_VERSION,
    "X-Expo-Turbo-Runtime": EXPO_TURBO_RUNTIME_VERSION,
    "X-Turbo-Request-Id": options.requestId,
    ...(options.capabilityHash ? { "X-Expo-Turbo-Capabilities": options.capabilityHash } : {}),
    ...(options.frameId ? { "Turbo-Frame": options.frameId } : {}),
  })
}

export function responseContentType(response: TurboResponse): string | undefined {
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
