import {
  type FetchAdapter,
  isTurboMultipartBody,
  type TurboMultipartBody,
  type TurboMultipartFile,
  type TurboRequest,
  type TurboRequestBody,
  type TurboResponse,
} from "../adapters"
import { ExpoTurboError, type ExpoTurboErrorContext, PropsError, RequestError } from "./errors"
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

type RequestLifecycleDispatchCallback = () => undefined

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

  async [REQUEST_LIFECYCLE_DISPATCH](
    event: RequestLifecycleEvent,
    afterListeners?: RequestLifecycleDispatchCallback,
  ): Promise<void> {
    const listeners = [...(this.listeners.get(event.type) ?? [])]
    let listenerError: unknown
    let listenerFailed = false
    try {
      for (const listener of listeners) {
        const result = listener(event)
        if (result !== undefined) await result
      }
    } catch (error) {
      listenerError = error
      listenerFailed = true
    }
    afterListeners?.()
    if (listenerFailed) throw listenerError
    if (event instanceof PausableEvent) await event.waitUntilResumed()
  }
}

export function admitRequestLifecycle(
  candidate: unknown,
  invalidMessage: string,
): RequestLifecycle | undefined {
  if (candidate === undefined) return undefined
  let valid = false
  try {
    valid = candidate instanceof RequestLifecycle
  } catch {
    // Hostile proxies are rejected through the same redacted option boundary.
  }
  if (!valid) throw new PropsError(invalidMessage)
  return candidate as RequestLifecycle
}

export function requestLifecycleOption(
  options: unknown,
  owner: string,
): RequestLifecycle | undefined {
  let candidate: unknown
  try {
    if (!options || typeof options !== "object" || Array.isArray(options)) {
      throw new TypeError("invalid options")
    }
    candidate = (options as { readonly requestLifecycle?: unknown }).requestLifecycle
  } catch {
    throw new PropsError(`${owner} options could not be read`)
  }
  return admitRequestLifecycle(candidate, `${owner} request lifecycle is invalid`)
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

export class RequestLifecycleTransportError extends RequestError {
  constructor(
    message: string,
    readonly defaultHandlingPrevented: boolean,
    context: ExpoTurboErrorContext,
  ) {
    super(message, context)
  }

  relabel(message: string, context: ExpoTurboErrorContext): RequestLifecycleTransportError {
    return new RequestLifecycleTransportError(message, this.defaultHandlingPrevented, context)
  }
}

export function requestLifecycleDefaultHandlingPrevented(error: unknown): boolean {
  return error instanceof RequestLifecycleTransportError && error.defaultHandlingPrevented
}

interface FetchWithRequestLifecycleOptions {
  readonly admission: RequestLifecycleAdmission
  readonly afterBeforeRequestListeners?: RequestLifecycleDispatchCallback
  readonly beforeFetch?: (request: TurboRequest) => boolean | undefined
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
  const original = mutation.snapshot()
  const beforeRequest = new BeforeFetchRequestEvent(context, mutation)
  const requestDispatch = dispatchWithAbort(
    options.lifecycle,
    beforeRequest,
    options.request.signal,
    "Before-fetch-request listener failed",
    options.afterBeforeRequestListeners,
  )
  if (!(await requestDispatch) || beforeRequest.defaultPrevented) {
    return Object.freeze({ request: options.request, status: "canceled" })
  }

  const request = admitLifecycleRequest(mutation.snapshot(), original, options.admission)
  if (request.signal?.aborted) return Object.freeze({ request, status: "canceled" })
  if (options.beforeFetch) {
    let proceed: boolean | undefined
    try {
      proceed = options.beforeFetch(request)
    } catch (error) {
      if (error instanceof ExpoTurboError) throw error
      throw new RequestError("Request lifecycle pre-fetch admission failed", {
        method: request.method,
      })
    }
    if (proceed !== undefined && typeof proceed !== "boolean") {
      throw new RequestError("Request lifecycle pre-fetch admission must return a boolean", {
        method: request.method,
      })
    }
    if (proceed === false || request.signal?.aborted) {
      return Object.freeze({ request, status: "canceled" })
    }
  }

  const fetched = await settleRequestOperation(request.signal, () =>
    options.fetchAdapter.fetch(request),
  )
  if (fetched.status === "canceled") return Object.freeze({ request, status: "canceled" })
  if (fetched.status === "rejected") {
    if (request.signal?.aborted) return Object.freeze({ request, status: "canceled" })
    const failure = new FetchRequestErrorEvent(context, request)
    const errorDispatch = await dispatchWithAbort(
      options.lifecycle,
      failure,
      request.signal,
      "Fetch-request-error listener failed",
    )
    if (!errorDispatch || request.signal?.aborted) {
      return Object.freeze({ request, status: "canceled" })
    }
    throw new RequestLifecycleTransportError(
      "Fetch request failed",
      failure.defaultPrevented,
      Object.freeze({ method: request.method }),
    )
  }
  const response = fetched.value
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
  if (body && admission.maxBodyBytes !== undefined && !sameBody(body, cloneBody(original.body))) {
    const size = isTurboMultipartBody(body.value)
      ? body.value.byteLength
      : typeof body.value === "string"
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

function sameBody(
  left: TurboRequestBody | undefined,
  right: TurboRequestBody | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right
  if (left.contentType !== right.contentType) return false
  const leftValue = left.value
  const rightValue = right.value
  if (isTurboMultipartBody(leftValue) || isTurboMultipartBody(rightValue)) {
    if (!isTurboMultipartBody(leftValue) || !isTurboMultipartBody(rightValue)) return false
    if (leftValue.byteLength !== rightValue.byteLength) return false
    if (leftValue.entries.length !== rightValue.entries.length) return false
    return leftValue.entries.every((entry, index) => {
      const other = rightValue.entries[index]
      if (!other || entry.name !== other.name || typeof entry.value !== typeof other.value) {
        return false
      }
      if (typeof entry.value === "string" || typeof other.value === "string") {
        return entry.value === other.value
      }
      return entry.value.blob === other.value.blob && entry.value.filename === other.value.filename
    })
  }
  if (typeof leftValue === "string" || typeof rightValue === "string") {
    return leftValue === rightValue
  }
  if (leftValue.byteLength !== rightValue.byteLength) return false
  return leftValue.every((value, index) => value === rightValue[index])
}

async function dispatchWithAbort(
  lifecycle: RequestLifecycle,
  event: RequestLifecycleEvent,
  signal: AbortSignal | undefined,
  failureMessage: string,
  afterListeners?: RequestLifecycleDispatchCallback,
): Promise<boolean> {
  if (signal?.aborted) return false
  const dispatched = lifecycle[REQUEST_LIFECYCLE_DISPATCH](event, afterListeners).then(
    () => true,
    () => {
      throw new RequestError(failureMessage)
    },
  )
  if (!signal) return dispatched

  let cancel: () => void = () => undefined
  const canceled = new Promise<false>((resolve) => {
    cancel = () => resolve(false)
    signal.addEventListener("abort", cancel, { once: true })
    if (signal.aborted) cancel()
  })
  const result = await Promise.race([dispatched, canceled])
  signal.removeEventListener("abort", cancel)
  if (!result) void dispatched.catch(() => undefined)
  return result
}

export type RequestOperationResult<T> =
  | Readonly<{ status: "canceled" }>
  | Readonly<{ error: unknown; status: "rejected" }>
  | Readonly<{ status: "resolved"; value: T }>

export async function settleRequestOperation<T>(
  signal: AbortSignal | undefined,
  operation: () => T | PromiseLike<T>,
): Promise<RequestOperationResult<T>> {
  if (signal?.aborted) return Object.freeze({ status: "canceled" })

  let pending: T | PromiseLike<T>
  try {
    pending = operation()
  } catch (error) {
    return Object.freeze({ error, status: "rejected" })
  }
  const settled: Promise<RequestOperationResult<T>> = Promise.resolve(pending).then(
    (value) => Object.freeze({ status: "resolved", value }),
    (error: unknown) => Object.freeze({ error, status: "rejected" }),
  )
  if (!signal) return settled
  if (signal.aborted) return Object.freeze({ status: "canceled" })

  let cancel: () => void = () => undefined
  const canceled = new Promise<RequestOperationResult<T>>((resolve) => {
    cancel = () => resolve(Object.freeze({ status: "canceled" }))
    signal.addEventListener("abort", cancel, { once: true })
    if (signal.aborted) cancel()
  })
  const result = await Promise.race([settled, canceled])
  signal.removeEventListener("abort", cancel)
  return signal.aborted ? Object.freeze({ status: "canceled" }) : result
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
  if (isTurboMultipartBody(value)) {
    return Object.freeze({
      ...(typeof contentType === "string" ? { contentType } : {}),
      value: cloneMultipartBody(value),
    })
  }
  if (typeof value !== "string" && !(value instanceof Uint8Array)) {
    throw new RequestError("Request lifecycle body value must be text or bytes")
  }
  return Object.freeze({
    ...(typeof contentType === "string" ? { contentType } : {}),
    value: typeof value === "string" ? value : value.slice(),
  })
}

function cloneMultipartBody(value: unknown): TurboMultipartBody {
  if (!isTurboMultipartBody(value)) {
    throw new RequestError("Request lifecycle multipart body is invalid")
  }
  let entries: unknown
  let byteLength: unknown
  try {
    entries = value.entries
    byteLength = value.byteLength
  } catch {
    throw new RequestError("Request lifecycle multipart body could not be read")
  }
  if (
    !Array.isArray(entries) ||
    typeof byteLength !== "number" ||
    !Number.isSafeInteger(byteLength) ||
    byteLength < 0
  ) {
    throw new RequestError("Request lifecycle multipart body is invalid")
  }
  const copied: TurboMultipartBody["entries"][number][] = []
  let actualByteLength = 0
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new RequestError("Request lifecycle multipart entries are invalid")
    }
    let keys: string[]
    let name: unknown
    let entryValue: unknown
    try {
      keys = Object.keys(entry)
      name = (entry as { readonly name?: unknown }).name
      entryValue = (entry as { readonly value?: unknown }).value
    } catch {
      throw new RequestError("Request lifecycle multipart entry could not be read")
    }
    if (keys.some((key) => key !== "name" && key !== "value") || typeof name !== "string") {
      throw new RequestError("Request lifecycle multipart entries are invalid")
    }
    actualByteLength += new TextEncoder().encode(name).byteLength
    if (typeof entryValue === "string") {
      actualByteLength += new TextEncoder().encode(entryValue).byteLength
      copied.push(Object.freeze({ name, value: entryValue }))
      continue
    }
    const file = cloneMultipartFile(entryValue)
    actualByteLength += new TextEncoder().encode(file.filename).byteLength + file.blob.size
    copied.push(Object.freeze({ name, value: file }))
  }
  if (actualByteLength !== byteLength) {
    throw new RequestError("Request lifecycle multipart body byte length is invalid")
  }
  return Object.freeze({
    byteLength,
    entries: Object.freeze(copied),
    kind: "multipart",
  })
}

function cloneMultipartFile(value: unknown): TurboMultipartFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RequestError("Request lifecycle multipart file is invalid")
  }
  let keys: string[]
  let blob: unknown
  let filename: unknown
  try {
    keys = Object.keys(value)
    blob = (value as TurboMultipartFile).blob
    filename = (value as TurboMultipartFile).filename
  } catch {
    throw new RequestError("Request lifecycle multipart file could not be read")
  }
  if (
    keys.some((key) => key !== "blob" && key !== "filename") ||
    !blob ||
    typeof blob !== "object" ||
    typeof filename !== "string" ||
    filename === "" ||
    /\p{Cc}/u.test(filename)
  ) {
    throw new RequestError("Request lifecycle multipart file is invalid")
  }
  let size: unknown
  let type: unknown
  try {
    size = (blob as Blob).size
    type = (blob as Blob).type
  } catch {
    throw new RequestError("Request lifecycle multipart file could not be read")
  }
  if (
    typeof size !== "number" ||
    !Number.isSafeInteger(size) ||
    size < 0 ||
    typeof type !== "string"
  ) {
    throw new RequestError("Request lifecycle multipart file is invalid")
  }
  return Object.freeze({ blob: blob as Blob, filename })
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
