import type { FetchAdapter, TurboRequest, TurboRequestBody, TurboResponse } from "../adapters"
import { RequestError } from "./errors"
import { CancellableEvent, PausableEvent } from "./events"

export type RequestLifecycleContext =
  | Readonly<{
      kind: "document"
      purpose: "load" | "preload"
      requestId: string
    }>
  | Readonly<{
      frameId: string
      kind: "frame"
      recurseDepth: number
      requestFrameId: string
      requestId: string
    }>
  | Readonly<{
      formNodeKey?: string
      kind: "form"
      requestId: string
    }>

export interface RequestLifecycleResponse {
  readonly headers: Readonly<Record<string, string>>
  readonly redirected: boolean
  readonly status: number
  readonly url: string
}

export class RequestMutation {
  private currentBody: TurboRequestBody | undefined
  private currentHeaders: Readonly<Record<string, string>>
  private currentMethod: string
  private currentUrl: string

  constructor(private readonly original: TurboRequest) {
    this.currentBody = cloneBody(original.body)
    this.currentHeaders = cloneHeaders(original.headers, "Request lifecycle headers are invalid")
    this.currentMethod = scalar(original.method, "Request lifecycle method must be a string")
    this.currentUrl = scalar(original.url, "Request lifecycle URL must be a string")
  }

  get body(): TurboRequestBody | undefined {
    return cloneBody(this.currentBody)
  }

  get headers(): Readonly<Record<string, string>> {
    return this.currentHeaders
  }

  get method(): string {
    return this.currentMethod
  }

  get signal(): AbortSignal | undefined {
    return this.original.signal
  }

  get url(): string {
    return this.currentUrl
  }

  deleteHeader(name: string): void {
    const admittedName = headerName(name)
    const headers = { ...this.currentHeaders }
    const existing = Object.keys(headers).find(
      (candidate) => candidate.toLowerCase() === admittedName.toLowerCase(),
    )
    if (existing !== undefined) delete headers[existing]
    this.currentHeaders = Object.freeze(headers)
  }

  setBody(body: TurboRequestBody | undefined): void {
    this.currentBody = cloneBody(body)
  }

  setHeader(name: string, value: string): void {
    const admittedName = headerName(name)
    const admittedValue = headerValue(value)
    const headers = { ...this.currentHeaders }
    const existing = Object.keys(headers).find(
      (candidate) => candidate.toLowerCase() === admittedName.toLowerCase(),
    )
    if (existing !== undefined && existing !== admittedName) delete headers[existing]
    headers[admittedName] = admittedValue
    this.currentHeaders = Object.freeze(headers)
  }

  setHeaders(headers: Readonly<Record<string, string>>): void {
    this.currentHeaders = cloneHeaders(headers, "Request lifecycle headers are invalid")
  }

  setMethod(method: string): void {
    this.currentMethod = scalar(method, "Request lifecycle method must be a string")
  }

  setUrl(url: string): void {
    this.currentUrl = scalar(url, "Request lifecycle URL must be a string")
  }

  snapshot(): TurboRequest {
    const body = cloneBody(this.currentBody)
    return Object.freeze({
      ...(body ? { body } : {}),
      headers: this.currentHeaders,
      method: this.currentMethod,
      ...(this.original.signal ? { signal: this.original.signal } : {}),
      url: this.currentUrl,
    })
  }
}

export class BeforeFetchRequestEvent extends PausableEvent<
  "before-fetch-request",
  Readonly<{
    context: RequestLifecycleContext
    request: RequestMutation
  }>
> {
  constructor(context: RequestLifecycleContext, request: RequestMutation) {
    super(
      "before-fetch-request",
      Object.freeze({
        context,
        request,
      }),
    )
  }
}

export class BeforeFetchResponseEvent extends CancellableEvent<
  "before-fetch-response",
  Readonly<{
    context: RequestLifecycleContext
    request: TurboRequest
    response: RequestLifecycleResponse
  }>
> {
  constructor(
    context: RequestLifecycleContext,
    request: TurboRequest,
    response: RequestLifecycleResponse,
  ) {
    super(
      "before-fetch-response",
      Object.freeze({
        context,
        request,
        response,
      }),
    )
  }
}

export class FetchRequestErrorEvent extends CancellableEvent<
  "fetch-request-error",
  Readonly<{
    context: RequestLifecycleContext
    error: RequestError
    request: TurboRequest
  }>
> {
  constructor(context: RequestLifecycleContext, request: TurboRequest) {
    super(
      "fetch-request-error",
      Object.freeze({
        context,
        error: new RequestError("Fetch request failed", { method: request.method }),
        request,
      }),
    )
  }
}

export type RequestLifecycleEvent =
  | BeforeFetchRequestEvent
  | BeforeFetchResponseEvent
  | FetchRequestErrorEvent

export interface RequestLifecycleEventMap {
  readonly "before-fetch-request": BeforeFetchRequestEvent
  readonly "before-fetch-response": BeforeFetchResponseEvent
  readonly "fetch-request-error": FetchRequestErrorEvent
}

type RequestLifecycleEventType = keyof RequestLifecycleEventMap
type RequestLifecycleListener<Type extends RequestLifecycleEventType> = (
  event: RequestLifecycleEventMap[Type],
) => unknown

export const REQUEST_LIFECYCLE_DISPATCH = Symbol("expo-turbo.request-lifecycle.dispatch")

/**
 * Shared host subscription surface for logical request events. Dispatch is
 * independent per request so one paused Frame cannot block another request.
 */
export class RequestLifecycle {
  private readonly listeners = new Map<
    RequestLifecycleEventType,
    Set<(event: RequestLifecycleEvent) => unknown>
  >()

  subscribe<Type extends RequestLifecycleEventType>(
    type: Type,
    listener: RequestLifecycleListener<Type>,
  ): () => void {
    if (typeof listener !== "function") {
      throw new RequestError("Request lifecycle listener must be a function")
    }
    let listeners = this.listeners.get(type)
    if (!listeners) {
      listeners = new Set()
      this.listeners.set(type, listeners)
    }
    const admitted = listener as (event: RequestLifecycleEvent) => unknown
    listeners.add(admitted)
    return () => {
      listeners?.delete(admitted)
      if (listeners?.size === 0) this.listeners.delete(type)
    }
  }

  async [REQUEST_LIFECYCLE_DISPATCH](event: RequestLifecycleEvent): Promise<void> {
    const listeners = [...(this.listeners.get(event.type) ?? [])]
    for (const listener of listeners) await listener(event)
    if (event instanceof PausableEvent) await event.waitUntilResumed()
  }
}

export interface RequestLifecycleAdmission {
  readonly admitUrl: (url: string) => string
  readonly allowBody: boolean
  readonly allowedMethods: readonly string[]
  readonly maxBodyBytes?: number
  readonly protectedHeaders: readonly string[]
}

export type RequestLifecycleFetchResult =
  | Readonly<{
      request: TurboRequest
      status: "canceled"
    }>
  | Readonly<{
      request: TurboRequest
      response: TurboResponse
      status: "prevented" | "response"
    }>

export interface FetchWithRequestLifecycleOptions {
  readonly admission: RequestLifecycleAdmission
  readonly context: RequestLifecycleContext
  readonly fetchAdapter: FetchAdapter
  readonly lifecycle: RequestLifecycle
  readonly request: TurboRequest
}

export async function fetchWithRequestLifecycle(
  options: FetchWithRequestLifecycleOptions,
): Promise<RequestLifecycleFetchResult> {
  const context = Object.freeze({ ...options.context }) as RequestLifecycleContext
  const mutation = new RequestMutation(options.request)
  const beforeRequest = new BeforeFetchRequestEvent(context, mutation)
  const requestDispatch = dispatchWithAbort(
    options.lifecycle,
    beforeRequest,
    options.request.signal,
    "Before-fetch-request listener failed",
  )
  if (!(await requestDispatch) || beforeRequest.defaultPrevented) {
    return Object.freeze({ request: options.request, status: "canceled" })
  }

  const request = admitLifecycleRequest(mutation.snapshot(), options.request, options.admission)
  if (request.signal?.aborted) return Object.freeze({ request, status: "canceled" })

  let response: TurboResponse
  try {
    response = await options.fetchAdapter.fetch(request)
  } catch (error) {
    if (request.signal?.aborted) return Object.freeze({ request, status: "canceled" })
    const failure = new FetchRequestErrorEvent(context, request)
    await dispatchWithAbort(
      options.lifecycle,
      failure,
      request.signal,
      "Fetch-request-error listener failed",
    )
    throw error
  }
  if (request.signal?.aborted) return Object.freeze({ request, status: "canceled" })

  const admittedResponse = admitLifecycleResponse(response)
  const beforeResponse = new BeforeFetchResponseEvent(
    context,
    request,
    responseSnapshot(admittedResponse),
  )
  const responseDispatch = dispatchWithAbort(
    options.lifecycle,
    beforeResponse,
    request.signal,
    "Before-fetch-response listener failed",
  )
  if (!(await responseDispatch)) return Object.freeze({ request, status: "canceled" })
  return Object.freeze({
    request,
    response: admittedResponse,
    status: beforeResponse.defaultPrevented ? "prevented" : "response",
  })
}

function admitLifecycleRequest(
  candidate: TurboRequest,
  original: TurboRequest,
  admission: RequestLifecycleAdmission,
): TurboRequest {
  const headers = cloneHeaders(candidate.headers, "Request lifecycle headers are invalid")
  const originalHeaders = cloneHeaders(original.headers, "Request lifecycle headers are invalid")
  const protectedHeaders = new Set(admission.protectedHeaders.map((name) => name.toLowerCase()))
  for (const name of protectedHeaders) {
    const originalEntry = headerEntry(originalHeaders, name)
    const candidateEntry = headerEntry(headers, name)
    if (!originalEntry || !candidateEntry || originalEntry[1] !== candidateEntry[1]) {
      throw new RequestError("Request lifecycle cannot change protected protocol headers")
    }
  }

  const method = scalar(candidate.method, "Request lifecycle method must be a string").toUpperCase()
  if (!admission.allowedMethods.includes(method)) {
    throw new RequestError("Request lifecycle method is not allowed", { method })
  }
  const url = admission.admitUrl(scalar(candidate.url, "Request lifecycle URL must be a string"))
  if (candidate.signal !== original.signal) {
    throw new RequestError("Request lifecycle cannot replace the owning abort signal", { method })
  }

  const body = cloneBody(candidate.body)
  if (body && !admission.allowBody) {
    throw new RequestError("Request lifecycle body is not allowed", { method })
  }
  if (body && method === "GET") {
    throw new RequestError("Request lifecycle GET requests cannot include a body", { method })
  }
  if (body && admission.maxBodyBytes !== undefined) {
    const size =
      typeof body.value === "string"
        ? new TextEncoder().encode(body.value).byteLength
        : body.value.byteLength
    if (size > admission.maxBodyBytes) {
      throw new RequestError("Request lifecycle body exceeds the configured limit", { method })
    }
  }

  return Object.freeze({
    ...(body ? { body } : {}),
    headers,
    method,
    ...(original.signal ? { signal: original.signal } : {}),
    url,
  })
}

async function dispatchWithAbort(
  lifecycle: RequestLifecycle,
  event: RequestLifecycleEvent,
  signal: AbortSignal | undefined,
  failureMessage: string,
): Promise<boolean> {
  const dispatched = lifecycle[REQUEST_LIFECYCLE_DISPATCH](event).then(
    () => true,
    () => {
      throw new RequestError(failureMessage)
    },
  )
  if (!signal) return dispatched
  if (signal.aborted) {
    void dispatched.catch(() => undefined)
    return false
  }

  let cancel: () => void = () => undefined
  const canceled = new Promise<false>((resolve) => {
    cancel = () => resolve(false)
    signal.addEventListener("abort", cancel, { once: true })
  })
  const result = await Promise.race([dispatched, canceled])
  signal.removeEventListener("abort", cancel)
  if (!result) void dispatched.catch(() => undefined)
  return result
}

function admitLifecycleResponse(response: TurboResponse): TurboResponse {
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    throw new RequestError("Fetch response is invalid")
  }
  let headers: unknown
  let redirected: unknown
  let status: unknown
  let text: unknown
  let url: unknown
  try {
    headers = response.headers
    redirected = response.redirected
    status = response.status
    text = response.text
    url = response.url
  } catch {
    throw new RequestError("Fetch response metadata could not be read")
  }
  if (typeof status !== "number" || !Number.isInteger(status) || status < 100 || status > 599) {
    throw new RequestError("Fetch response status is invalid")
  }
  if (typeof redirected !== "boolean") {
    throw new RequestError("Fetch response redirect metadata is invalid", {
      responseStatus: status,
    })
  }
  if (typeof url !== "string" || url.trim() === "") {
    throw new RequestError("Fetch response URL is invalid", { responseStatus: status })
  }
  if (typeof text !== "function") {
    throw new RequestError("Fetch response body reader is invalid", { responseStatus: status })
  }
  const admittedHeaders = cloneHeaders(headers, "Fetch response headers are invalid")
  return Object.freeze({
    headers: admittedHeaders,
    redirected,
    status,
    text: () => Promise.resolve(text.call(response)),
    url,
  })
}

function responseSnapshot(response: TurboResponse): RequestLifecycleResponse {
  return Object.freeze({
    headers: response.headers,
    redirected: response.redirected,
    status: response.status,
    url: response.url,
  })
}

function cloneBody(body: TurboRequestBody | undefined): TurboRequestBody | undefined {
  if (body === undefined) return undefined
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new RequestError("Request lifecycle body is invalid")
  }
  let contentType: unknown
  let value: unknown
  try {
    contentType = body.contentType
    value = body.value
  } catch {
    throw new RequestError("Request lifecycle body could not be read")
  }
  if (contentType !== undefined) {
    headerValue(contentType)
  }
  if (typeof value !== "string" && !(value instanceof Uint8Array)) {
    throw new RequestError("Request lifecycle body value must be text or bytes")
  }
  return Object.freeze({
    ...(typeof contentType === "string" ? { contentType } : {}),
    value: typeof value === "string" ? value : value.slice(),
  })
}

function cloneHeaders(value: unknown, message: string): Readonly<Record<string, string>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RequestError(message)
  }
  let entries: [string, unknown][]
  try {
    entries = Object.entries(value)
  } catch {
    throw new RequestError(message)
  }
  const headers: Record<string, string> = {}
  const names = new Set<string>()
  for (const [name, value] of entries) {
    const admittedName = headerName(name)
    const normalized = admittedName.toLowerCase()
    if (names.has(normalized)) throw new RequestError("Request lifecycle headers are duplicated")
    names.add(normalized)
    headers[admittedName] = headerValue(value)
  }
  return Object.freeze(headers)
}

function headerEntry(
  headers: Readonly<Record<string, string>>,
  normalizedName: string,
): readonly [string, string] | undefined {
  const entry = Object.entries(headers).find(([name]) => name.toLowerCase() === normalizedName)
  return entry ? Object.freeze(entry) : undefined
}

function headerName(value: unknown): string {
  if (typeof value !== "string" || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(value)) {
    throw new RequestError("Request lifecycle header name is invalid")
  }
  return value
}

function headerValue(value: unknown): string {
  if (
    typeof value !== "string" ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0)
      return codePoint !== undefined && (codePoint <= 31 || codePoint === 127)
    })
  ) {
    throw new RequestError("Request lifecycle header value is invalid")
  }
  return value
}

function scalar(value: unknown, message: string): string {
  if (typeof value !== "string") throw new RequestError(message)
  return value
}
