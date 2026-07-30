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
  /** Timeout for fetch and response-body reads, in milliseconds. */
  readonly timeoutMs?: number
}

export interface DefaultFetchAdapterRequest {
  readonly headers: Readonly<Record<string, string>>
  readonly method: string
  readonly url: string
}

type FetchBody = FormData | string | Uint8Array

const maximumTimeoutMs = 2_147_483_647
const ownerAbort = Symbol("expo-turbo.fetch.owner-abort")
const timeoutAbort = Symbol("expo-turbo.fetch.timeout-abort")

function adapterOptions(options: DefaultFetchAdapterOptions): Readonly<{
  headers: Readonly<Record<string, string>>
  onRequest: DefaultFetchAdapterOptions["onRequest"]
  timeoutMs: number
}> {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new RequestError("Default fetch adapter options must be an object")
  }

  let configuredHeaders: Headers
  let onRequest: DefaultFetchAdapterOptions["onRequest"]
  let timeoutMs: number
  try {
    configuredHeaders = new Headers(options.headers)
    onRequest = options.onRequest
    timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS
  } catch {
    throw new RequestError("Default fetch adapter options could not be read")
  }

  if (onRequest !== undefined && typeof onRequest !== "function") {
    throw new RequestError("Default fetch onRequest must be a function")
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

function requestBody(request: TurboRequest): FetchBody | undefined {
  const body = request.body
  if (!body) return undefined
  if (!isTurboMultipartBody(body.value)) return body.value

  const formData = new FormData()
  for (const entry of body.value.entries) {
    if (typeof entry.value === "string") {
      formData.append(entry.name, entry.value)
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
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  let abortOwner: (() => void) | undefined

  const timedOut = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      controller.abort()
      reject(timeoutAbort)
    }, timeoutMs)
  })
  const aborted = new Promise<never>((_resolve, reject) => {
    if (!ownerSignal) return
    abortOwner = () => {
      controller.abort()
      reject(ownerAbort)
    }
    ownerSignal.addEventListener("abort", abortOwner, { once: true })
    if (ownerSignal.aborted) abortOwner()
  })

  try {
    return await Promise.race([operation(), timedOut, aborted])
  } catch (error) {
    if (error === timeoutAbort) {
      throw new RequestError("Default fetch request timed out", { method })
    }
    if (error === ownerAbort) {
      throw new RequestError("Default fetch request was aborted", { method })
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

      const body = requestBody(request)
      const headers = await requestHeaders(request, configured.headers, configured.onRequest)
      const controller = new AbortController()
      const response = await settleWithTimeout(
        () =>
          globalThis.fetch(request.url, {
            ...(body === undefined ? {} : { body: body as BodyInit }),
            credentials: "include",
            headers,
            method: request.method,
            redirect: "follow",
            signal: controller.signal,
          }),
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
        redirected = response.redirected
        status = response.status
        url = response.url
      } catch {
        throw new RequestError("Default fetch response metadata could not be read", {
          method: request.method,
        })
      }
      const headersSnapshot = responseHeaders(response, request.method)

      return Object.freeze({
        headers: headersSnapshot,
        redirected,
        status,
        text: () =>
          settleWithTimeout(
            () => response.text(),
            controller,
            request.signal,
            configured.timeoutMs,
            request.method,
            "Default fetch response body could not be read",
          ),
        url,
      })
    },
  })
}
