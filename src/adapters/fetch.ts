import { RequestError } from "../core/errors.js"
import { EXPO_TURBO_MIME_TYPE } from "../core/protocol-request.js"
import {
  type FetchAdapter,
  isTurboMultipartBody,
  type TurboRequest,
  type TurboResponse,
} from "./index.js"

export const DEFAULT_FETCH_TIMEOUT_MS = 30_000

export interface DefaultFetchAdapterOptions {
  /** Static headers applied before request-owned protocol headers. */
  readonly headers?: Readonly<Record<string, string>>
  /**
   * Returns per-request headers, such as Authorization. Request-owned protocol
   * headers are applied last and cannot be replaced by this callback.
   */
  readonly onRequest?: (
    request: DefaultFetchAdapterRequest,
  ) =>
    | Promise<Readonly<Record<string, string>> | undefined>
    | Readonly<Record<string, string>>
    | undefined
  /**
   * Observes immutable response metadata before the adapter returns it.
   * Failures reject the request with a redacted RequestError.
   */
  readonly onResponse?: (response: DefaultFetchAdapterResponse) => Promise<void> | void
  /** Timeout for fetch and response-body reads, in milliseconds. */
  readonly timeoutMs?: number
}

export interface DefaultFetchAdapterRequest {
  readonly headers: Readonly<Record<string, string>>
  readonly method: string
  readonly url: string
}

export interface DefaultFetchAdapterResponse {
  readonly headers: Readonly<Record<string, string>>
  readonly redirected: boolean
  readonly status: number
  readonly url: string
}

type FetchBody = FormData | string | Uint8Array
type ReactNativeFormData = FormData & Readonly<{ getParts(): unknown }>
type ReactNativeFormDataFile = Readonly<{
  name: string
  type: string
  uri: string
}>

const maximumTimeoutMs = 2_147_483_647
const ownerAbort = Symbol("expo-turbo.fetch.owner-abort")
const requestPreparationFailure = Symbol("expo-turbo.fetch.request-preparation-failure")
const timeoutAbort = Symbol("expo-turbo.fetch.timeout-abort")

type RequestPreparationFailure = Readonly<{
  error: RequestError
  kind: typeof requestPreparationFailure
}>

function adapterOptions(options: DefaultFetchAdapterOptions): Readonly<{
  headers: Readonly<Record<string, string>>
  onRequest: DefaultFetchAdapterOptions["onRequest"]
  onResponse: DefaultFetchAdapterOptions["onResponse"]
  timeoutMs: number
}> {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new RequestError("Default fetch adapter options must be an object")
  }

  let configuredHeaders: Headers
  let onRequest: DefaultFetchAdapterOptions["onRequest"]
  let onResponse: DefaultFetchAdapterOptions["onResponse"]
  let timeoutMs: number
  try {
    configuredHeaders = new Headers(options.headers)
    onRequest = options.onRequest
    onResponse = options.onResponse
    timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS
  } catch {
    throw new RequestError("Default fetch adapter options could not be read")
  }

  if (onRequest !== undefined && typeof onRequest !== "function") {
    throw new RequestError("Default fetch onRequest must be a function")
  }
  if (onResponse !== undefined && typeof onResponse !== "function") {
    throw new RequestError("Default fetch onResponse must be a function")
  }
  if (
    typeof timeoutMs !== "number" ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > maximumTimeoutMs
  ) {
    throw new RequestError("Default fetch timeout must be a positive finite number")
  }

  return Object.freeze({
    headers: headerSnapshot(configuredHeaders),
    onRequest,
    onResponse,
    timeoutMs,
  })
}

function appendHeaders(target: Headers, source: Readonly<Record<string, string>>): void {
  for (const [name, value] of Object.entries(source)) target.set(name, value)
}

function headerSnapshot(headers: Headers): Readonly<Record<string, string>> {
  const snapshot: Record<string, string> = {}
  headers.forEach((value, name) => {
    snapshot[name] = value
  })
  return Object.freeze(snapshot)
}

function base64(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
  const chunks: string[] = []
  let chunk = ""
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0
    const second = bytes[index + 1] ?? 0
    const third = bytes[index + 2] ?? 0
    chunk += alphabet[first >> 2]
    chunk += alphabet[((first & 0x03) << 4) | (second >> 4)]
    chunk += index + 1 < bytes.length ? alphabet[((second & 0x0f) << 2) | (third >> 6)] : "="
    chunk += index + 2 < bytes.length ? alphabet[third & 0x3f] : "="
    if (chunk.length >= 16_384) {
      chunks.push(chunk)
      chunk = ""
    }
  }
  if (chunk) chunks.push(chunk)
  return chunks.join("")
}

async function blobDataUri(blob: Blob, type: string): Promise<string> {
  const contentType = type || "application/octet-stream"
  if (typeof FileReader === "function") {
    try {
      const encoded = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onabort = () => reject(new Error("aborted"))
        reader.onerror = () => reject(new Error("failed"))
        reader.onload = () => {
          try {
            if (typeof reader.result !== "string") throw new Error("invalid")
            const marker = reader.result.indexOf(";base64,")
            if (marker < 0) throw new Error("invalid")
            resolve(`data:${contentType};base64,${reader.result.slice(marker + 8)}`)
          } catch {
            reject(new Error("invalid"))
          }
        }
        reader.readAsDataURL(blob)
      })
      return encoded
    } catch {
      throw new RequestError("Default fetch multipart file could not be read")
    }
  }

  try {
    const buffer = await blob.arrayBuffer()
    return `data:${contentType};base64,${base64(new Uint8Array(buffer))}`
  } catch {
    throw new RequestError("Default fetch multipart file could not be read")
  }
}

async function requestBody(request: TurboRequest): Promise<FetchBody | undefined> {
  const body = request.body
  if (!body) return undefined
  if (!isTurboMultipartBody(body.value)) return body.value

  const formData = new FormData()
  let reactNative: boolean
  try {
    reactNative = typeof (formData as Partial<ReactNativeFormData>).getParts === "function"
  } catch {
    throw new RequestError("Default fetch multipart support could not be detected")
  }
  for (const entry of body.value.entries) {
    if (typeof entry.value === "string") {
      formData.append(entry.name, entry.value)
    } else if (reactNative) {
      let blob: Blob & Readonly<{ uri?: unknown }>
      let filename: unknown
      let type: unknown
      let uri: unknown
      try {
        blob = entry.value.blob as Blob & Readonly<{ uri?: unknown }>
        filename = entry.value.filename
        type = blob.type
        uri = blob.uri
      } catch {
        throw new RequestError("Default fetch multipart file metadata could not be read")
      }
      if (typeof filename !== "string" || typeof type !== "string") {
        throw new RequestError("Default fetch multipart file metadata is invalid")
      }
      const file: ReactNativeFormDataFile = {
        name: filename,
        type: type || "application/octet-stream",
        uri: typeof uri === "string" && uri.trim() !== "" ? uri : await blobDataUri(blob, type),
      }
      const nativeFormData = formData as unknown as {
        append(name: string, value: ReactNativeFormDataFile | string): void
      }
      nativeFormData.append(entry.name, file)
    } else {
      formData.append(entry.name, entry.value.blob, entry.value.filename)
    }
  }
  return formData
}

async function requestHeaders(
  request: TurboRequest,
  configuredHeaders: Readonly<Record<string, string>>,
  onRequest: DefaultFetchAdapterOptions["onRequest"],
): Promise<Headers> {
  let headers: Headers
  try {
    headers = new Headers({ Accept: EXPO_TURBO_MIME_TYPE })
    appendHeaders(headers, configuredHeaders)
    appendHeaders(headers, request.headers)
  } catch {
    throw new RequestError("Default fetch request headers are invalid", {
      method: request.method,
    })
  }

  if (onRequest) {
    let extraHeaders: Readonly<Record<string, string>> | undefined
    try {
      extraHeaders = await onRequest(
        Object.freeze({
          headers: headerSnapshot(headers),
          method: request.method,
          url: request.url,
        }),
      )
      if (extraHeaders !== undefined) appendHeaders(headers, extraHeaders)
    } catch {
      throw new RequestError("Default fetch request preparation failed", {
        method: request.method,
      })
    }
  }

  try {
    appendHeaders(headers, request.headers)
    if (request.body && isTurboMultipartBody(request.body.value)) {
      headers.delete("Content-Type")
    } else if (request.body?.contentType !== undefined) {
      headers.set("Content-Type", request.body.contentType)
    }
  } catch {
    throw new RequestError("Default fetch request headers are invalid", {
      method: request.method,
    })
  }
  return headers
}

async function settleWithTimeout<T>(
  operation: () => Promise<T>,
  controller: AbortController,
  ownerSignal: AbortSignal | undefined,
  timeoutMs: number,
  method: string,
  failureMessage: string,
): Promise<T> {
  let abortReason: typeof ownerAbort | typeof timeoutAbort | undefined
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  let abortOwner: (() => void) | undefined

  const timedOut = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      if (abortReason) return
      abortReason = timeoutAbort
      controller.abort()
      reject(timeoutAbort)
    }, timeoutMs)
  })
  const aborted = new Promise<never>((_resolve, reject) => {
    if (!ownerSignal) return
    abortOwner = () => {
      if (abortReason) return
      abortReason = ownerAbort
      controller.abort()
      reject(ownerAbort)
    }
    ownerSignal.addEventListener("abort", abortOwner, { once: true })
    if (ownerSignal.aborted) abortOwner()
  })

  try {
    return await Promise.race([operation(), timedOut, aborted])
  } catch (error) {
    if (abortReason === timeoutAbort || error === timeoutAbort) {
      throw new RequestError("Default fetch request timed out", { method })
    }
    if (abortReason === ownerAbort || error === ownerAbort) {
      throw new RequestError("Default fetch request was aborted", { method })
    }
    if (
      typeof error === "object" &&
      error !== null &&
      (error as Partial<RequestPreparationFailure>).kind === requestPreparationFailure
    ) {
      throw (error as RequestPreparationFailure).error
    }
    throw new RequestError(failureMessage, { method })
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)
    if (ownerSignal && abortOwner) ownerSignal.removeEventListener("abort", abortOwner)
  }
}

function responseHeaders(response: Response, method: string): Readonly<Record<string, string>> {
  const headers: Record<string, string> = {}
  try {
    response.headers.forEach((value, name) => {
      headers[name] = value
    })
  } catch {
    throw new RequestError("Default fetch response headers could not be read", { method })
  }
  return Object.freeze(headers)
}

/**
 * Creates the standard credentialed Expo Turbo transport. HTTP error statuses
 * remain ordinary TurboResponse values so the protocol can admit XML 4xx/5xx.
 */
export function createDefaultFetchAdapter(options: DefaultFetchAdapterOptions = {}): FetchAdapter {
  const configured = adapterOptions(options)

  return Object.freeze({
    async fetch(request: TurboRequest): Promise<TurboResponse> {
      if (typeof globalThis.fetch !== "function") {
        throw new RequestError("The Fetch API is unavailable", { method: request.method })
      }

      const controller = new AbortController()
      const response = await settleWithTimeout(
        async () => {
          if (controller.signal.aborted) throw ownerAbort

          let body: FetchBody | undefined
          let headers: Headers
          try {
            ;[body, headers] = await Promise.all([
              requestBody(request),
              requestHeaders(request, configured.headers, configured.onRequest),
            ])
          } catch (error) {
            throw Object.freeze({
              error:
                error instanceof RequestError
                  ? error
                  : new RequestError("Default fetch request preparation failed", {
                      method: request.method,
                    }),
              kind: requestPreparationFailure,
            }) satisfies RequestPreparationFailure
          }

          if (controller.signal.aborted) throw ownerAbort
          return globalThis.fetch(request.url, {
            ...(body === undefined ? {} : { body: body as BodyInit }),
            credentials: "include",
            headers,
            method: request.method,
            redirect: "follow",
            signal: controller.signal,
          })
        },
        controller,
        request.signal,
        configured.timeoutMs,
        request.method,
        "Default fetch request failed",
      )

      let redirected: boolean
      let status: number
      let url: string
      try {
        status = response.status
        url = response.url
        redirected = response.redirected === true || url !== request.url
      } catch {
        throw new RequestError("Default fetch response metadata could not be read", {
          method: request.method,
        })
      }
      const headersSnapshot = responseHeaders(response, request.method)

      const responseMetadata: DefaultFetchAdapterResponse = Object.freeze({
        headers: headersSnapshot,
        redirected,
        status,
        url,
      })
      const turboResponse: TurboResponse = Object.freeze({
        ...responseMetadata,
        text: () =>
          settleWithTimeout(
            () => response.text(),
            controller,
            request.signal,
            configured.timeoutMs,
            request.method,
            "Default fetch response body could not be read",
          ),
      })

      if (configured.onResponse) {
        await settleWithTimeout(
          async () => configured.onResponse?.(responseMetadata),
          controller,
          request.signal,
          configured.timeoutMs,
          request.method,
          "Default fetch response handling failed",
        )
      }

      return turboResponse
    },
  })
}
