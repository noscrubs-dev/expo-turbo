import type { FetchAdapter, RequestIdAdapter, TurboRequest, TurboResponse } from "../adapters"
import { documentCachePolicy } from "./document-metadata"
import type { DocumentSnapshotCache } from "./document-snapshot-cache"
import { ContentTypeError, ParseError, PropsError, RequestError, TargetError } from "./errors"
import { type ParseLimits, parseExpoTurboDocument } from "./parser"
import {
  EXPO_TURBO_MIME_TYPE,
  protocolRequestHeaders,
  resolveSameOriginProtocolUrl,
  responseContentType,
} from "./protocol-request"
import {
  admitRequestLifecycle,
  fetchWithRequestLifecycle,
  type RequestLifecycle,
  RequestLifecycleTransportError,
  settleRequestOperation,
} from "./request-lifecycle"
import type { DocumentSession } from "./session"
import { classifyTopLevelLocation } from "./visitability"

export interface DocumentPreloaderOptions {
  readonly capabilityHash?: string
  readonly limits?: Partial<ParseLimits>
  readonly requestLifecycle?: RequestLifecycle
}

type MutableParseLimits = {
  -readonly [Key in keyof ParseLimits]?: ParseLimits[Key]
}

export type DocumentPreloadReport =
  | Readonly<{
      requestId: string
      responseStatus: number
      status: "cached" | "not-cacheable" | "prevented" | "superseded"
      url: string
    }>
  | Readonly<{
      requestId?: string
      status: "canceled"
      url: string
    }>
  | Readonly<{
      status: "hit"
      url: string
    }>

export interface DocumentPreloadRequester {
  preload(source: string): Promise<DocumentPreloadReport>
}

interface ActiveDocumentPreload {
  readonly controller: AbortController
  readonly promise: Promise<DocumentPreloadReport>
  readonly state: { cacheCommitProtected: boolean }
  readonly url: string
}

const PARSE_LIMIT_KEYS = Object.freeze([
  "maxAttributesPerElement",
  "maxBytes",
  "maxDepth",
  "maxNodes",
  "maxStreamActions",
  "maxTextBytes",
] as const satisfies readonly (keyof ParseLimits)[])

/**
 * Performs explicit, non-owning full-document preload GETs into a shared
 * snapshot cache. It does not publish visit lifecycle, history, recent request
 * IDs, or document-tree mutations.
 */
export class DocumentPreloader {
  private readonly active = new Map<string, ActiveDocumentPreload>()
  private readonly capabilityHash: string | undefined
  private readonly limits: Partial<ParseLimits> | undefined
  private readonly requestLifecycle: RequestLifecycle | undefined

  constructor(
    private readonly session: DocumentSession,
    private readonly fetchAdapter: FetchAdapter,
    private readonly requestIds: RequestIdAdapter,
    private readonly cache: DocumentSnapshotCache,
    options: DocumentPreloaderOptions = {},
  ) {
    if (!options || typeof options !== "object") {
      throw new PropsError("Document preloader options must be an object")
    }
    let optionsAreArray: boolean
    try {
      optionsAreArray = Array.isArray(options)
    } catch {
      throw new PropsError("Document preloader options could not be read")
    }
    if (optionsAreArray) throw new PropsError("Document preloader options must be an object")

    let capabilityHash: unknown
    let configuredLimits: unknown
    let requestLifecycle: unknown
    try {
      capabilityHash = options.capabilityHash
      configuredLimits = options.limits
      requestLifecycle = options.requestLifecycle
    } catch {
      throw new PropsError("Document preloader options could not be read")
    }
    if (capabilityHash !== undefined && typeof capabilityHash !== "string") {
      throw new PropsError("Document preloader capability hash must be a string")
    }
    this.capabilityHash = capabilityHash
    this.requestLifecycle = admitRequestLifecycle(
      requestLifecycle,
      "Document preloader request lifecycle is invalid",
    )

    if (configuredLimits === undefined) {
      this.limits = undefined
      return
    }
    if (!configuredLimits || typeof configuredLimits !== "object") {
      throw new PropsError("Document preloader parse limits must be an object")
    }
    let limitsAreArray: boolean
    try {
      limitsAreArray = Array.isArray(configuredLimits)
    } catch {
      throw new PropsError("Document preloader parse limits could not be read")
    }
    if (limitsAreArray) {
      throw new PropsError("Document preloader parse limits must be an object")
    }

    const limits: MutableParseLimits = {}
    const configuredValues: MutableParseLimits = {}
    try {
      for (const key of PARSE_LIMIT_KEYS) {
        const value = (configuredLimits as Partial<ParseLimits>)[key]
        if (value !== undefined) configuredValues[key] = value
      }
    } catch {
      throw new PropsError("Document preloader parse limits could not be read")
    }
    for (const key of PARSE_LIMIT_KEYS) {
      const value = configuredValues[key]
      if (
        value !== undefined &&
        (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
      ) {
        throw new PropsError("Document preloader parse limits must be positive integers")
      }
      if (value !== undefined) limits[key] = value
    }
    this.limits = Object.freeze(limits)
  }

  preload(source: string): Promise<DocumentPreloadReport> {
    let url: string
    try {
      if (
        typeof source !== "string" ||
        source.trim() === "" ||
        [...source].some((character) => {
          const codePoint = character.codePointAt(0)
          return codePoint !== undefined && (codePoint <= 31 || codePoint === 127)
        })
      ) {
        throw new TargetError("Document preload source is invalid")
      }
      const disposition = classifyTopLevelLocation(this.session.tree, source)
      if (disposition.classification !== "visitable") {
        throw new TargetError("Document preload requires a root-visitable location", {
          target: disposition.classification,
        })
      }
      if (disposition.url.includes("#")) {
        throw new TargetError("Document preload fragments require anchor preload support")
      }
      url = disposition.url
      const current = this.active.get(url)
      if (current) return current.promise

      const controller = new AbortController()
      const state = { cacheCommitProtected: false }
      let active: ActiveDocumentPreload
      const promise = Promise.resolve()
        .then(() => this.perform(url, controller))
        .finally(() => {
          if (this.active.get(url) === active) this.active.delete(url)
        })
      active = Object.freeze({ controller, promise, state, url })
      this.active.set(url, active)
      return promise
    } catch (error) {
      return Promise.reject(error)
    }
  }

  cancel(source: string): boolean {
    const disposition = classifyTopLevelLocation(this.session.tree, source)
    const active = this.active.get(disposition.url)
    if (!active || active.state.cacheCommitProtected) return false
    this.active.delete(active.url)
    active.controller.abort()
    return true
  }

  cancelAll(): void {
    const canceled: ActiveDocumentPreload[] = []
    for (const preload of this.active.values()) {
      if (preload.state.cacheCommitProtected) continue
      this.active.delete(preload.url)
      canceled.push(preload)
    }
    for (const preload of canceled) preload.controller.abort()
  }

  private async perform(url: string, controller: AbortController): Promise<DocumentPreloadReport> {
    if (controller.signal.aborted) return this.canceled(undefined, url)
    let hit: boolean
    try {
      hit = this.cacheContains(url)
    } catch (error) {
      if (controller.signal.aborted) return this.canceled(undefined, url)
      throw error
    }
    if (controller.signal.aborted) return this.canceled(undefined, url)
    if (hit) return Object.freeze({ status: "hit", url })

    let requestId: string
    try {
      requestId = this.requestIds.next()
    } catch {
      if (controller.signal.aborted) return this.canceled(undefined, url)
      throw new RequestError("Document preload request ID could not be generated", {
        method: "GET",
      })
    }
    if (controller.signal.aborted) return this.canceled(requestId, url)
    const request = Object.freeze({
      headers: Object.freeze({
        ...protocolRequestHeaders({
          ...(this.capabilityHash !== undefined ? { capabilityHash: this.capabilityHash } : {}),
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
              if (candidate !== request.url) {
                throw new RequestError("Document preload lifecycle cannot retarget the cache key", {
                  method: "GET",
                })
              }
              return candidate
            },
            allowBody: false,
            allowedMethods: ["GET"],
            protectedHeaders: Object.keys(request.headers),
          },
          context: { kind: "document", purpose: "preload", requestId },
          fetchAdapter: this.fetchAdapter,
          lifecycle: this.requestLifecycle,
          request,
        })
        if (fetched.status === "canceled") return this.canceled(requestId, request.url)
        response = fetched.response
        if (fetched.status === "prevented") {
          return Object.freeze({
            requestId,
            responseStatus: response.status,
            status: "prevented",
            url: request.url,
          })
        }
      } else {
        const fetched = await settleRequestOperation(controller.signal, () =>
          this.fetchAdapter.fetch(request),
        )
        if (fetched.status === "canceled") return this.canceled(requestId, request.url)
        if (fetched.status === "rejected") throw fetched.error
        response = fetched.value
      }
    } catch (error) {
      if (controller.signal.aborted) return this.canceled(requestId, request.url)
      if (error instanceof RequestLifecycleTransportError) {
        throw error.relabel("Document preload request failed", { method: "GET" })
      }
      throw new RequestError("Document preload request failed", { method: "GET" })
    }
    if (controller.signal.aborted) return this.canceled(requestId, request.url)

    let responseStatus: unknown
    let responseUrl: unknown
    let redirected: unknown
    try {
      responseStatus = response.status
      responseUrl = response.url
      redirected = response.redirected
    } catch {
      if (controller.signal.aborted) return this.canceled(requestId, request.url)
      throw new RequestError("Document preload response metadata is invalid", { method: "GET" })
    }
    if (controller.signal.aborted) return this.canceled(requestId, request.url)
    if (
      typeof responseStatus !== "number" ||
      !Number.isInteger(responseStatus) ||
      responseStatus < 200 ||
      responseStatus >= 300
    ) {
      throw new RequestError("Document preload requires a successful response", {
        method: "GET",
        ...(typeof responseStatus === "number" && Number.isInteger(responseStatus)
          ? { responseStatus }
          : {}),
      })
    }
    if (typeof responseUrl !== "string" || responseUrl.trim() === "") {
      throw new RequestError("Document preload response requires a final URL", {
        method: "GET",
        responseStatus,
      })
    }
    if (typeof redirected !== "boolean") {
      throw new RequestError("Document preload redirect metadata is invalid", {
        method: "GET",
        responseStatus,
      })
    }
    resolveSameOriginProtocolUrl(responseUrl, request.url, request.url)

    let contentType: string | undefined
    try {
      const headers = response.headers
      contentType = responseContentType({ headers })
    } catch {
      if (controller.signal.aborted) return this.canceled(requestId, request.url)
      throw new ContentTypeError(`Expected ${EXPO_TURBO_MIME_TYPE}`)
    }
    if (controller.signal.aborted) return this.canceled(requestId, request.url)
    if (contentType !== EXPO_TURBO_MIME_TYPE) {
      throw new ContentTypeError(`Expected ${EXPO_TURBO_MIME_TYPE}`, {
        contentType: contentType ?? "missing",
      })
    }

    let text: TurboResponse["text"]
    try {
      text = response.text
      if (typeof text !== "function") {
        throw new RequestError("Document preload response body reader is invalid")
      }
    } catch {
      if (controller.signal.aborted) return this.canceled(requestId, request.url)
      throw new RequestError("Document preload response body could not be read", {
        method: "GET",
        responseStatus,
      })
    }
    if (controller.signal.aborted) return this.canceled(requestId, request.url)

    let xml: string
    try {
      const body = await settleRequestOperation(controller.signal, () => text.call(response))
      if (body.status === "canceled") return this.canceled(requestId, request.url)
      if (body.status === "rejected") throw body.error
      xml = body.value
    } catch {
      if (controller.signal.aborted) return this.canceled(requestId, request.url)
      throw new RequestError("Document preload response body could not be read", {
        method: "GET",
        responseStatus,
      })
    }
    if (controller.signal.aborted) return this.canceled(requestId, request.url)
    if (typeof xml !== "string" || xml.trim() === "") {
      throw new RequestError("Document preload requires a nonempty XML response", {
        method: "GET",
        responseStatus,
      })
    }

    let tree: ReturnType<typeof parseExpoTurboDocument>
    try {
      tree = parseExpoTurboDocument(xml, {
        ...(this.limits ? { limits: this.limits } : {}),
        url: request.url,
      })
    } catch (error) {
      const location = error instanceof ParseError ? error.context.location : undefined
      throw new ParseError("Document preload XML could not be parsed", location ? { location } : {})
    }
    if (controller.signal.aborted) return this.canceled(requestId, request.url)
    const cacheable = documentCachePolicy(tree).cacheable
    if (cacheable) {
      let superseded: boolean
      try {
        superseded = this.cacheContains(request.url)
      } catch (error) {
        if (controller.signal.aborted) return this.canceled(requestId, request.url)
        throw error
      }
      if (controller.signal.aborted) return this.canceled(requestId, request.url)
      if (superseded) {
        return Object.freeze({
          requestId,
          responseStatus,
          status: "superseded",
          url: request.url,
        })
      }
      if (!this.protectCacheCommit(request.url, controller)) {
        return this.canceled(requestId, request.url)
      }
      this.cacheSnapshot(request.url, tree, responseStatus)
    }
    return Object.freeze({
      requestId,
      responseStatus,
      status: cacheable ? "cached" : "not-cacheable",
      url: request.url,
    })
  }

  private cacheContains(url: string): boolean {
    try {
      const present = this.cache.has(url)
      if (typeof present !== "boolean") {
        throw new RequestError("Document preload cache lookup must return a boolean")
      }
      return present
    } catch {
      throw new RequestError("Document preload cache lookup failed", { method: "GET" })
    }
  }

  private cacheSnapshot(
    url: string,
    tree: ReturnType<typeof parseExpoTurboDocument>,
    responseStatus: number,
  ): void {
    try {
      this.cache.put(url, tree)
    } catch {
      throw new RequestError("Document preload cache write failed", {
        method: "GET",
        responseStatus,
      })
    }
  }

  private protectCacheCommit(url: string, controller: AbortController): boolean {
    const active = this.active.get(url)
    if (!active || active.controller !== controller || controller.signal.aborted) return false
    active.state.cacheCommitProtected = true
    return true
  }

  private canceled(requestId: string | undefined, url: string): DocumentPreloadReport {
    return Object.freeze({
      ...(requestId !== undefined ? { requestId } : {}),
      status: "canceled",
      url,
    })
  }
}
