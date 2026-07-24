import type {
  FetchAdapter,
  RequestIdAdapter,
  TurboRequest,
  TurboResponse,
} from "../adapters/index.js"
import { documentVisitControl } from "./document-metadata.js"
import {
  ContentTypeError,
  FrameMissingError,
  ParseError,
  PropsError,
  RequestError,
  TargetError,
} from "./errors.js"
import type { FramePreloadCache, FramePreloadEntry } from "./frame-preload-cache.js"
import { parseExpoTurboDocument } from "./parser.js"
import {
  EXPO_TURBO_MIME_TYPE,
  protocolRequestHeaders,
  resolveSameOriginProtocolUrl,
  responseContentType,
} from "./protocol-request.js"
import {
  fetchWithRequestLifecycle,
  type RequestLifecycle,
  RequestLifecycleTransportError,
  requestLifecycleOption,
  settleRequestOperation,
} from "./request-lifecycle.js"
import type { DocumentSession } from "./session.js"
import { attributeValue } from "./tree.js"

export type FramePreloadReport = Readonly<{
  readonly frameId: string
  readonly requestId?: string
  readonly responseStatus?: number
  readonly status: "cached" | "canceled" | "hit" | "prevented" | "superseded"
  readonly url: string
}>

export interface FramePreloadRequester {
  preload(frameId: string, source: string): Promise<FramePreloadReport>
}

export interface FramePreloaderOptions {
  readonly capabilityHash?: string
  readonly requestLifecycle?: RequestLifecycle
}

interface ActiveFramePreload {
  readonly controller: AbortController
  readonly frameId: string
  readonly promise: Promise<FramePreloadReport>
  readonly url: string
}

function preloadKey(frameId: string, url: string): string {
  return `${frameId}\n${url}`
}

/** Warms one exact Frame response without mutating the active document tree. */
export class FramePreloader implements FramePreloadRequester {
  private readonly active = new Map<string, ActiveFramePreload>()
  private readonly capabilityHash: string | undefined
  private readonly requestLifecycle: RequestLifecycle | undefined

  constructor(
    private readonly session: DocumentSession,
    private readonly fetchAdapter: FetchAdapter,
    private readonly requestIds: RequestIdAdapter,
    private readonly cache: FramePreloadCache,
    options: FramePreloaderOptions = {},
  ) {
    this.requestLifecycle = requestLifecycleOption(options, "Frame preloader")
    let capabilityHash: unknown
    try {
      capabilityHash = options.capabilityHash
    } catch {
      throw new PropsError("Frame preloader options could not be read")
    }
    if (capabilityHash !== undefined && typeof capabilityHash !== "string") {
      throw new PropsError("Frame preloader capability hash must be a string")
    }
    this.capabilityHash = capabilityHash
  }

  preload(frameId: string, source: string): Promise<FramePreloadReport> {
    try {
      const url = this.resolve(frameId, source)
      const key = preloadKey(frameId, url)
      const existing = this.active.get(key)
      if (existing) return existing.promise
      const controller = new AbortController()
      let active!: ActiveFramePreload
      const promise = Promise.resolve()
        .then(() => this.perform(frameId, url, controller))
        .finally(() => {
          if (this.active.get(key) === active) this.active.delete(key)
        })
      active = Object.freeze({ controller, frameId, promise, url })
      this.active.set(key, active)
      return promise
    } catch (error) {
      return Promise.reject(error)
    }
  }

  cancel(frameId: string, source: string): boolean {
    const url = this.resolve(frameId, source)
    const key = preloadKey(frameId, url)
    const active = this.active.get(key)
    if (!active) return false
    this.active.delete(key)
    active.controller.abort()
    return true
  }

  cancelAll(): void {
    const active = [...this.active.values()]
    this.active.clear()
    for (const preload of active) preload.controller.abort()
  }

  private resolve(frameId: string, source: string): string {
    const documentUrl = this.session.tree.document.url
    if (!documentUrl) throw new TargetError("Frame preload requires an active document URL")
    const frame = this.session.tree.getElementById(frameId)
    if (frame?.kind !== "frame" || attributeValue(frame, "id") !== frameId) {
      throw new FrameMissingError(`Active frame ${JSON.stringify(frameId)} is missing`, { frameId })
    }
    const url = resolveSameOriginProtocolUrl(source, documentUrl, documentUrl, { frameId })
    if (new URL(url).hash !== "") {
      throw new TargetError("Frame preload URLs must be fragment-free", { frameId })
    }
    return url
  }

  private canceled(frameId: string, url: string, requestId?: string): FramePreloadReport {
    return Object.freeze({ frameId, ...(requestId ? { requestId } : {}), status: "canceled", url })
  }

  private async perform(
    frameId: string,
    url: string,
    controller: AbortController,
  ): Promise<FramePreloadReport> {
    if (controller.signal.aborted) return this.canceled(frameId, url)
    if (this.cacheHas(frameId, url)) {
      return Object.freeze({ frameId, status: "hit", url })
    }
    let requestId: string
    try {
      requestId = this.requestIds.next()
    } catch {
      throw new RequestError("Frame preload request ID could not be generated", {
        frameId,
        method: "GET",
      })
    }
    if (controller.signal.aborted) return this.canceled(frameId, url, requestId)
    const request = Object.freeze({
      headers: Object.freeze({
        ...protocolRequestHeaders({
          ...(this.capabilityHash ? { capabilityHash: this.capabilityHash } : {}),
          frameId,
          requestId,
        }),
        "X-Sec-Purpose": "prefetch",
      }),
      method: "GET",
      signal: controller.signal,
      url,
    }) satisfies TurboRequest
    let response: TurboResponse
    try {
      if (this.requestLifecycle) {
        const fetched = await fetchWithRequestLifecycle({
          admission: {
            admitUrl: (candidate) => {
              if (candidate !== url) {
                throw new RequestError("Frame preload lifecycle cannot retarget the cache key", {
                  frameId,
                  method: "GET",
                })
              }
              return candidate
            },
            allowBody: false,
            allowedMethods: ["GET"],
            protectedHeaders: Object.keys(request.headers),
          },
          context: { frameId, kind: "frame", purpose: "preload", requestId },
          fetchAdapter: this.fetchAdapter,
          lifecycle: this.requestLifecycle,
          request,
        })
        if (fetched.status === "canceled") return this.canceled(frameId, url, requestId)
        response = fetched.response
        if (fetched.status === "prevented") {
          let responseStatus: unknown
          try {
            responseStatus = response.status
          } catch {
            throw new RequestError("Frame preload response metadata is invalid", {
              frameId,
              method: "GET",
            })
          }
          return Object.freeze({
            frameId,
            requestId,
            ...(typeof responseStatus === "number" && Number.isInteger(responseStatus)
              ? { responseStatus }
              : {}),
            status: "prevented",
            url,
          })
        }
      } else {
        const fetched = await settleRequestOperation(controller.signal, () =>
          this.fetchAdapter.fetch(request),
        )
        if (fetched.status === "canceled") return this.canceled(frameId, url, requestId)
        if (fetched.status === "rejected") throw fetched.error
        response = fetched.value
      }
    } catch (error) {
      if (controller.signal.aborted) return this.canceled(frameId, url, requestId)
      if (error instanceof RequestLifecycleTransportError) {
        throw error.relabel("Frame preload request failed", { frameId, method: "GET" })
      }
      if (
        error instanceof RequestError &&
        error.message === "Frame preload response metadata is invalid"
      ) {
        throw error
      }
      throw new RequestError("Frame preload request failed", { frameId, method: "GET" })
    }
    if (controller.signal.aborted) return this.canceled(frameId, url, requestId)
    let responseStatus: unknown
    let rawResponseUrl: unknown
    let redirected: unknown
    try {
      responseStatus = response.status
      rawResponseUrl = response.url
      redirected = response.redirected
    } catch {
      throw new RequestError("Frame preload response metadata is invalid", {
        frameId,
        method: "GET",
      })
    }
    if (
      typeof responseStatus !== "number" ||
      !Number.isInteger(responseStatus) ||
      responseStatus < 200 ||
      responseStatus >= 300
    ) {
      throw new RequestError("Frame preload requires a successful response", {
        frameId,
        method: "GET",
        ...(typeof responseStatus === "number" && Number.isInteger(responseStatus)
          ? { responseStatus }
          : {}),
      })
    }
    if (typeof rawResponseUrl !== "string" || rawResponseUrl.trim() === "") {
      throw new RequestError("Frame preload response requires a final URL", {
        frameId,
        method: "GET",
        responseStatus,
      })
    }
    if (typeof redirected !== "boolean") {
      throw new RequestError("Frame preload redirect metadata is invalid", {
        frameId,
        method: "GET",
        responseStatus,
      })
    }
    const responseUrl = resolveSameOriginProtocolUrl(rawResponseUrl, url, url, { frameId })
    let contentType: string | undefined
    try {
      contentType = responseContentType({ headers: response.headers })
    } catch {
      throw new ContentTypeError(`Expected ${EXPO_TURBO_MIME_TYPE}`, { frameId })
    }
    if (contentType !== EXPO_TURBO_MIME_TYPE) {
      throw new ContentTypeError(`Expected ${EXPO_TURBO_MIME_TYPE}`, {
        contentType: contentType ?? "missing",
        frameId,
      })
    }
    let text: TurboResponse["text"]
    try {
      text = response.text
      if (typeof text !== "function") throw new TypeError("invalid body reader")
    } catch {
      throw new RequestError("Frame preload response body could not be read", {
        frameId,
        method: "GET",
        responseStatus,
      })
    }
    const body = await settleRequestOperation(controller.signal, () => text.call(response))
    if (body.status === "canceled") return this.canceled(frameId, url, requestId)
    if (body.status === "rejected" || typeof body.value !== "string" || body.value.trim() === "") {
      throw new RequestError("Frame preload response body could not be read", {
        frameId,
        method: "GET",
        responseStatus,
      })
    }
    let tree: ReturnType<typeof parseExpoTurboDocument>
    try {
      tree = parseExpoTurboDocument(body.value, { url: responseUrl })
    } catch (error) {
      const location = error instanceof ParseError ? error.context.location : undefined
      throw new ParseError("Frame preload XML could not be parsed", location ? { location } : {})
    }
    if (documentVisitControl(tree) === "reload") {
      throw new TargetError("Frame preload cannot cache a visit-control promotion", { frameId })
    }
    const matching = tree
      .getFrames()
      .find((candidate) => attributeValue(candidate, "id") === frameId)
    if (!matching) {
      throw new FrameMissingError(`Frame preload response is missing ${JSON.stringify(frameId)}`, {
        frameId,
      })
    }
    if (controller.signal.aborted) return this.canceled(frameId, url, requestId)
    if (this.cacheHas(frameId, url)) {
      return Object.freeze({
        frameId,
        requestId,
        responseStatus,
        status: "superseded",
        url,
      })
    }
    const entry: FramePreloadEntry = Object.freeze({
      body: body.value,
      frameId,
      redirected: redirected || responseUrl !== url,
      requestId,
      responseStatus,
      responseUrl,
      url,
    })
    this.cachePut(entry)
    return Object.freeze({
      frameId,
      requestId,
      responseStatus,
      status: "cached",
      url,
    })
  }

  private cacheHas(frameId: string, url: string): boolean {
    try {
      const present = this.cache.has(frameId, url)
      if (typeof present !== "boolean") throw new TypeError("invalid cache lookup")
      return present
    } catch {
      throw new RequestError("Frame preload cache lookup failed", { frameId, method: "GET" })
    }
  }

  private cachePut(entry: FramePreloadEntry): void {
    try {
      this.cache.put(entry)
    } catch {
      throw new RequestError("Frame preload cache write failed", {
        frameId: entry.frameId,
        method: "GET",
        responseStatus: entry.responseStatus,
      })
    }
  }
}
