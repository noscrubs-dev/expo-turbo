import type { FetchAdapter, RequestIdAdapter, TurboRequest, TurboResponse } from "../adapters"
import {
  type DestinationRequestLease,
  destinationRequestOwnership,
} from "./destination-request-ownership"
import { documentVisitControl } from "./document-metadata"
import {
  ContentTypeError,
  ExpoTurboError,
  FrameMissingError,
  PropsError,
  RequestError,
  StateError,
  TargetError,
} from "./errors"
import { recordFrameAutofocusReport } from "./frame-autofocus-internal"
import {
  assertFrameHistoryCommitPlan,
  beginFrameHistoryRequest,
  commitFrameHistoryPlan,
  FRAME_HISTORY_PLAN_OPTION,
  type FrameHistoryCommitPlan,
  frameHistoryDocumentUrl,
  frameHistoryPlanCurrent,
  updateFrameHistoryResponseSource,
} from "./frame-history"
import { registerFrameCommitProtection } from "./frame-history-internal"
import {
  BeforeFrameMorphEvent,
  createFrameMissingEvent,
  discardFrameMissingResponseBody,
  executeFrameMissingVisit,
  executeFrameVisitControlReload,
  FRAME_LIFECYCLE_BEFORE_MORPH_DISPATCH,
  FRAME_LIFECYCLE_MISSING_DISPATCH,
  type FrameLifecycle,
  type FrameMissingEvent,
  type FrameRenderMethod,
  frameLifecycleOption,
} from "./frame-lifecycle"
import { frameLoadRenderMethod } from "./frame-load-render-method-internal"
import { recordFrameMorphReloadReport } from "./frame-morph-reload-internal"
import { FramePreloadCache, type FramePreloadEntry } from "./frame-preload-cache"
import {
  dispatchFrameLoad,
  dispatchFrameRender,
  type PreparedFrameRender,
  prepareFrameRender,
} from "./frame-render-lifecycle-internal"
import {
  activeFrameAutofocusCandidates,
  assertPreparedFrameMutationCurrent,
  commitPreparedFrameMutation,
  discardPreparedFrameMutation,
  dispatchPreparedFrameResponseStreams,
  frameAutoscrollIntent,
  type PreparedFrameBeforeRender,
  prepareFrameBeforeRender,
  prepareFrameMutation,
  prepareFrameResponseTree,
  renderPreparedFrameMutation,
  waitForPreparedFrameBeforeRender,
} from "./frame-response-application"
import type { FrameResponseReport } from "./frames"
import { parseExpoTurboDocument } from "./parser"
import {
  EXPO_TURBO_MIME_TYPE,
  protocolRequestHeaders,
  resolveSameOriginProtocolUrl,
  responseContentType,
} from "./protocol-request"
import {
  fetchWithRequestLifecycle,
  type RequestLifecycle,
  requestLifecycleOption,
  settleRequestOperation,
} from "./request-lifecycle"
import type { DocumentSession } from "./session"
import { streamLifecycleOption } from "./stream-lifecycle"
import { type StreamActionDispatchOptions, streamRenderSchedulerOption } from "./streams"
import { attributeValue, type ProtocolElement } from "./tree"

export { EXPO_TURBO_MIME_TYPE } from "./protocol-request"

export type FrameLoadStatus = "canceled" | "completed" | "empty" | "prevented" | "promoted"

interface FrameLoadReportBase {
  readonly frameId: string
  readonly requestId: string
  readonly requestIds: readonly string[]
  readonly responseStatus?: number
  readonly url: string
}

export type FrameLoadReport =
  | Readonly<
      FrameLoadReportBase & {
        readonly reason: "visit-control-reload"
        readonly status: "promoted"
      }
    >
  | Readonly<
      FrameLoadReportBase & {
        readonly frame?: FrameResponseReport
        readonly reason?: never
        readonly status: Exclude<FrameLoadStatus, "promoted">
      }
    >

export interface FrameTreeCommitCandidate {
  readonly frameId: string
  readonly redirected: boolean
  readonly requestId: string
  readonly requestIds: readonly string[]
  readonly requestedUrl: string
  readonly responseStatus: number
  readonly url: string
}

/** @internal Coordinates renderer acknowledgement for controller-owned Frame loads. */
export const FRAME_RENDER_PREPARE_OPTION = Symbol("expo-turbo.frame-render.prepare")

/** @internal Lets the Frame controller obtain renderer coordination for a matching response. */
export const FRAME_REQUEST_LOADER_PREPARE_RENDER = Symbol(
  "expo-turbo.frame-request-loader.prepare-render",
)

/** @internal Dispatches render from this loader's admitted lifecycle after renderer acknowledgement. */
export const FRAME_REQUEST_LOADER_DISPATCH_FRAME_RENDER = Symbol(
  "expo-turbo.frame-request-loader.dispatch-frame-render",
)

/** @internal Dispatches load from this loader's admitted lifecycle after a current render event. */
export const FRAME_REQUEST_LOADER_DISPATCH_FRAME_LOAD = Symbol(
  "expo-turbo.frame-request-loader.dispatch-frame-load",
)

export interface FrameLoadOptions {
  /**
   * Runs synchronously after response extraction and structural preflight but before the
   * prepared Frame mutation begins. The callback must be atomic-on-error and must not mutate
   * the document session or reenter package controllers.
   */
  readonly beforeFrameCommit?: (candidate: FrameTreeCommitCandidate) => undefined
  /** Exact owner token used by cancellation and controller lifecycle coordination. */
  readonly owner?: object
  /** @internal */
  readonly [FRAME_RENDER_PREPARE_OPTION]?: (
    frame: ProtocolElement,
    candidate: FrameTreeCommitCandidate,
    renderMethod: FrameRenderMethod,
  ) => undefined
}

interface InternalFrameLoadOptions extends FrameLoadOptions {
  readonly [FRAME_HISTORY_PLAN_OPTION]?: FrameHistoryCommitPlan
}

export interface FrameCommittedOutcome extends FrameTreeCommitCandidate {
  readonly status: "completed"
}

export class FrameCommitError extends RequestError {
  readonly outcome: FrameCommittedOutcome

  constructor(candidate: FrameTreeCommitCandidate) {
    super("Frame committed but session finalization failed", {
      frameId: candidate.frameId,
      method: "GET",
      responseStatus: candidate.responseStatus,
    })
    this.outcome = Object.freeze({ ...candidate, status: "completed" })
  }
}

export interface FrameRequestLoaderOptions extends StreamActionDispatchOptions {
  readonly capabilityHash?: string
  readonly frameLifecycle?: FrameLifecycle
  readonly maxRecurseDepth?: number
  readonly preloadCache?: FramePreloadCache
  readonly preloadBehavior?: "consume" | "preview"
  readonly requestLifecycle?: RequestLifecycle
}

type FramePreloadMode = "consume" | "ignore" | "require"

interface ActiveFrameRequest {
  readonly controller: AbortController
  readonly frame: ProtocolElement
  lease?: DestinationRequestLease
  readonly owner?: object
}

interface BufferedMissingFrameResponse {
  readonly body: string
  readonly redirected: boolean
  readonly status: number
  readonly url: string
}

interface BufferedFrameVisitControlReload {
  readonly body: string
  readonly report: FrameLoadReport
  readonly response: Readonly<{
    redirected: boolean
    status: number
    url: string
  }>
}

type FrameMissingDispatchOutcome =
  | Readonly<{ kind: "default" }>
  | Readonly<{ kind: "canceled"; report: FrameLoadReport }>
  | Readonly<{ event: FrameMissingEvent; kind: "prevented"; report: FrameLoadReport }>

function recurseFrame(
  frames: readonly ProtocolElement[],
  targetFrameId: string,
): ProtocolElement | undefined {
  return frames.find((frame) => {
    const id = attributeValue(frame, "id")
    const source = attributeValue(frame, "src")
    const recurse = attributeValue(frame, "recurse")?.split(/\s+/).filter(Boolean)
    return Boolean(id && source && recurse?.includes(targetFrameId))
  })
}

function frameLoadOptions(options: FrameLoadOptions): InternalFrameLoadOptions {
  if (!options || typeof options !== "object") {
    throw new RequestError("Frame load options must be an object", { method: "GET" })
  }
  let isArray: boolean
  try {
    isArray = Array.isArray(options)
  } catch {
    throw new RequestError("Frame load options could not be read", { method: "GET" })
  }
  if (isArray) {
    throw new RequestError("Frame load options must be an object", { method: "GET" })
  }

  let descriptors: Record<PropertyKey, PropertyDescriptor>
  try {
    descriptors = Object.getOwnPropertyDescriptors(options) as Record<
      PropertyKey,
      PropertyDescriptor
    >
  } catch {
    throw new RequestError("Frame load options could not be read", { method: "GET" })
  }
  const keys = Reflect.ownKeys(descriptors)
  if (
    keys.some(
      (key) =>
        key !== "beforeFrameCommit" &&
        key !== "owner" &&
        key !== FRAME_HISTORY_PLAN_OPTION &&
        key !== FRAME_RENDER_PREPARE_OPTION,
    )
  ) {
    throw new RequestError("Frame load options contain unsupported fields", { method: "GET" })
  }
  if (
    keys.some((key) => {
      const descriptor = descriptors[key]
      return !descriptor || !("value" in descriptor)
    })
  ) {
    throw new RequestError("Frame load options must use data properties", { method: "GET" })
  }

  const beforeFrameCommit = descriptors.beforeFrameCommit?.value
  if (beforeFrameCommit !== undefined && typeof beforeFrameCommit !== "function") {
    throw new RequestError("Frame commit callback must be a function", { method: "GET" })
  }
  const owner = descriptors.owner?.value
  if (owner !== undefined && (!owner || typeof owner !== "object")) {
    throw new RequestError("Frame load owner must be an object", { method: "GET" })
  }
  const historyPlan = descriptors[FRAME_HISTORY_PLAN_OPTION]?.value
  if (historyPlan !== undefined) {
    assertFrameHistoryCommitPlan(historyPlan)
  }
  const prepareRender = descriptors[FRAME_RENDER_PREPARE_OPTION]?.value
  if (prepareRender !== undefined && typeof prepareRender !== "function") {
    throw new RequestError("Frame render preparation callback must be a function", {
      method: "GET",
    })
  }
  if (historyPlan && beforeFrameCommit) {
    throw new RequestError("Frame history plans cannot be combined with commit callbacks", {
      method: "GET",
    })
  }
  return Object.freeze({
    ...(beforeFrameCommit ? { beforeFrameCommit } : {}),
    ...(owner ? { owner } : {}),
    ...(historyPlan ? { [FRAME_HISTORY_PLAN_OPTION]: historyPlan } : {}),
    ...(prepareRender ? { [FRAME_RENDER_PREPARE_OPTION]: prepareRender } : {}),
  })
}

export class FrameRequestLoader {
  private readonly active = new Map<string, ActiveFrameRequest>()
  private readonly capabilityHash: string | undefined
  private readonly frameLifecycle: FrameLifecycle | undefined
  private readonly maxRecurseDepth: number
  private readonly ownership: ReturnType<typeof destinationRequestOwnership>
  private readonly preloadCache: FramePreloadCache | undefined
  readonly preloadBehavior: "consume" | "preview"
  private readonly requestLifecycle: RequestLifecycle | undefined
  private readonly streamOptions: StreamActionDispatchOptions

  constructor(
    private readonly session: DocumentSession,
    private readonly fetchAdapter: FetchAdapter,
    private readonly requestIds: RequestIdAdapter,
    options: FrameRequestLoaderOptions = {},
  ) {
    this.frameLifecycle = frameLifecycleOption(options, "Frame request loader")
    this.requestLifecycle = requestLifecycleOption(options, "Frame request loader")
    const streamLifecycle = streamLifecycleOption(options, "Frame request loader")
    const streamRenderScheduler = streamRenderSchedulerOption(options, "Frame request loader")
    this.capabilityHash = options.capabilityHash
    this.maxRecurseDepth = options.maxRecurseDepth ?? 5
    this.preloadBehavior = options.preloadBehavior ?? "consume"
    if (
      options.preloadCache !== undefined &&
      !(options.preloadCache instanceof FramePreloadCache)
    ) {
      throw new PropsError("Frame request loader preload cache is invalid")
    }
    this.preloadCache = options.preloadCache
    if (this.preloadBehavior !== "consume" && this.preloadBehavior !== "preview") {
      throw new PropsError("Frame request loader preload behavior is invalid")
    }
    if (this.preloadBehavior === "preview" && !this.preloadCache) {
      throw new PropsError("Frame preview behavior requires a preload cache")
    }
    this.ownership = destinationRequestOwnership(session)
    this.streamOptions = Object.freeze({
      ...(options.customActions ? { customActions: options.customActions } : {}),
      ...(options.onActionError ? { onActionError: options.onActionError } : {}),
      ...(options.refresh ? { refresh: options.refresh } : {}),
      ...(streamLifecycle ? { streamLifecycle } : {}),
      ...(streamRenderScheduler ? { streamRenderScheduler } : {}),
    })
    if (!Number.isInteger(this.maxRecurseDepth) || this.maxRecurseDepth < 0) {
      throw new TargetError("Frame recurse depth must be a non-negative integer")
    }
    registerFrameCommitProtection(this, (frameId, owner) => {
      const active = this.active.get(frameId)
      return Boolean(
        active?.owner === owner && active.lease && this.ownership.isCommitting(active.lease),
      )
    })
  }

  cancel(frameId: string, owner?: object): boolean {
    const active = this.active.get(frameId)
    if (!active || (owner && active.owner !== owner)) return false
    if (active.lease) {
      if (!this.ownership.cancel(active.lease)) return false
    } else {
      active.controller.abort()
    }
    if (this.active.get(frameId) === active) this.active.delete(frameId)
    return true
  }

  [FRAME_REQUEST_LOADER_PREPARE_RENDER](
    frame: ProtocolElement,
    candidate: FrameTreeCommitCandidate,
    renderMethod: FrameRenderMethod = "replace",
  ): PreparedFrameRender | undefined {
    const checkpoint = this.ownership.checkpointFrame(frame)
    return prepareFrameRender(this.session, {
      frame,
      frameId: candidate.frameId,
      ownerIsCurrent: () => this.ownership.frameCheckpointCurrent(checkpoint),
      renderMethod,
      url: candidate.url,
    })
  }

  [FRAME_REQUEST_LOADER_DISPATCH_FRAME_RENDER](prepared: PreparedFrameRender): boolean {
    return this.frameLifecycle ? dispatchFrameRender(this.frameLifecycle, prepared) : false
  }

  [FRAME_REQUEST_LOADER_DISPATCH_FRAME_LOAD](prepared: PreparedFrameRender): boolean {
    return this.frameLifecycle ? dispatchFrameLoad(this.frameLifecycle, prepared) : false
  }

  async load(
    frameId: string,
    source: string,
    options: FrameLoadOptions = {},
  ): Promise<FrameLoadReport> {
    const report = await this.loadWithPreloadMode(frameId, source, options, "consume")
    if (!report) {
      throw new StateError("Frame load unexpectedly missed its required response", { frameId })
    }
    return report
  }

  /** @internal Consumes only an exact cached response and starts no request on a miss. */
  loadPreloaded(
    frameId: string,
    source: string,
    options: FrameLoadOptions = {},
  ): Promise<FrameLoadReport | undefined> {
    return this.loadWithPreloadMode(frameId, source, options, "require")
  }

  /** @internal Performs the canonical request without consuming an exact cached response. */
  async loadCanonical(
    frameId: string,
    source: string,
    options: FrameLoadOptions = {},
  ): Promise<FrameLoadReport> {
    const report = await this.loadWithPreloadMode(frameId, source, options, "ignore")
    if (!report) {
      throw new StateError("Canonical Frame load unexpectedly produced no response", { frameId })
    }
    return report
  }

  private async loadWithPreloadMode(
    frameId: string,
    source: string,
    options: FrameLoadOptions,
    preloadMode: FramePreloadMode,
  ): Promise<FrameLoadReport | undefined> {
    const renderMethod = frameLoadRenderMethod(options)
    const loadOptions = frameLoadOptions(options)
    const owner = loadOptions.owner
    const url = this.resolveSameOrigin(source, undefined, frameId)
    const frame = this.session.tree.getElementById(frameId)
    if (frame?.kind !== "frame") {
      throw new FrameMissingError(`Active frame ${JSON.stringify(frameId)} is missing`, { frameId })
    }
    let cachedPreload: FramePreloadEntry | undefined
    let firstRequestId: string
    let firstHeaders: ReturnType<typeof protocolRequestHeaders>
    try {
      cachedPreload = preloadMode === "ignore" ? undefined : this.preloadCache?.take(frameId, url)
      if (preloadMode === "require" && !cachedPreload) return undefined
      firstRequestId = cachedPreload?.requestId ?? this.requestIds.next()
      firstHeaders = protocolRequestHeaders({
        ...(this.capabilityHash ? { capabilityHash: this.capabilityHash } : {}),
        frameId,
        requestId: firstRequestId,
      })
    } catch (error) {
      if (cachedPreload) this.preloadCache?.put(cachedPreload)
      throw error
    }
    const controller = new AbortController()
    const requestIds: string[] = []
    const active: ActiveFrameRequest = {
      controller,
      frame,
      ...(owner ? { owner } : {}),
    }
    const previous = this.active.get(frameId)
    this.active.set(frameId, active)
    try {
      active.lease = this.ownership.claimFrame(frame, controller)
    } catch (error) {
      controller.abort()
      if (cachedPreload) this.preloadCache?.put(cachedPreload)
      if (this.active.get(frameId) === active) {
        if (previous) this.active.set(frameId, previous)
        else this.active.delete(frameId)
      }
      throw error
    }
    const historyPlan = loadOptions[FRAME_HISTORY_PLAN_OPTION]
    let handledMissing: Readonly<{ event: FrameMissingEvent; report: FrameLoadReport }> | undefined
    let promoted: BufferedFrameVisitControlReload | undefined

    try {
      let requestFrameId = frameId
      let requestUrl = url
      let primaryRequestedUrl = url
      let recurseDepth = 0
      let historyStarted = false
      let responseStatus: number | undefined
      let responseUrl = url
      let responseRedirected = false
      let primaryMissingResponse: BufferedMissingFrameResponse | undefined
      const visited = new Set([url])
      let preparedRequest:
        | Readonly<{ headers: Readonly<Record<string, string>>; requestId: string }>
        | undefined = Object.freeze({ headers: firstHeaders, requestId: firstRequestId })

      while (true) {
        if (
          !this.owns(frameId, active) ||
          (historyPlan && !frameHistoryPlanCurrent(historyPlan, this.session, frame))
        ) {
          return this.canceled(frameId, requestIds, responseUrl, active)
        }
        const requestId = preparedRequest?.requestId ?? this.requestIds.next()
        const headers =
          preparedRequest?.headers ??
          protocolRequestHeaders({
            ...(this.capabilityHash ? { capabilityHash: this.capabilityHash } : {}),
            frameId: requestFrameId,
            requestId,
          })
        preparedRequest = undefined
        const request: TurboRequest = Object.freeze({
          headers,
          method: "GET",
          signal: active.controller.signal,
          url: requestUrl,
        })
        const startRequest = (effectiveRequest: TurboRequest): boolean => {
          if (
            !this.owns(frameId, active) ||
            (historyPlan && !frameHistoryPlanCurrent(historyPlan, this.session, frame))
          ) {
            return false
          }
          if (effectiveRequest.url !== requestUrl) {
            if (visited.has(effectiveRequest.url)) {
              throw new FrameMissingError(
                `Frame ${JSON.stringify(frameId)} has a recurse URL loop`,
                { frameId },
              )
            }
            requestUrl = effectiveRequest.url
            visited.add(requestUrl)
          }
          if (recurseDepth === 0) primaryRequestedUrl = requestUrl
          if (historyPlan && recurseDepth === 0 && !historyStarted) {
            beginFrameHistoryRequest(historyPlan, this.session, frame, requestUrl, url)
            historyStarted = true
            if (
              !this.owns(frameId, active) ||
              !frameHistoryPlanCurrent(historyPlan, this.session, frame)
            ) {
              return false
            }
          }
          requestIds.push(requestId)
          this.session.recentRequestIds.add(requestId)
          return true
        }
        let response: TurboResponse
        const preload = recurseDepth === 0 && requestUrl === url ? cachedPreload : undefined
        cachedPreload = undefined
        if (preload) {
          if (!startRequest(request)) {
            return this.canceled(frameId, requestIds, responseUrl, active)
          }
          response = Object.freeze({
            headers: Object.freeze({ "Content-Type": EXPO_TURBO_MIME_TYPE }),
            redirected: preload.redirected,
            status: preload.responseStatus,
            text: () => Promise.resolve(preload.body),
            url: preload.responseUrl,
          })
        } else if (this.requestLifecycle) {
          const fetched = await fetchWithRequestLifecycle({
            admission: {
              admitUrl: (candidate) => this.resolveSameOrigin(candidate, requestUrl, frameId),
              allowBody: false,
              allowedMethods: ["GET"],
              protectedHeaders: Object.keys(headers),
            },
            beforeFetch: startRequest,
            context: {
              frameId,
              kind: "frame",
              recurseDepth,
              requestFrameId,
              requestId,
            },
            fetchAdapter: this.fetchAdapter,
            lifecycle: this.requestLifecycle,
            request,
          })
          if (fetched.status === "canceled") {
            return this.canceled(frameId, requestIds, responseUrl, active)
          }
          response = fetched.response
          if (fetched.status === "prevented") {
            const finalUrl = this.resolveSameOrigin(response.url, requestUrl, frameId)
            this.release(frameId, active)
            return Object.freeze({
              frameId,
              requestId: requestIds[0] ?? requestId,
              requestIds: Object.freeze([...requestIds]),
              responseStatus: response.status,
              status: "prevented",
              url: finalUrl,
            })
          }
        } else {
          if (!startRequest(request)) {
            return this.canceled(frameId, requestIds, responseUrl, active)
          }
          const fetched = await settleRequestOperation(active.controller.signal, () =>
            this.fetchAdapter.fetch(request),
          )
          if (fetched.status === "canceled") {
            return this.canceled(frameId, requestIds, responseUrl, active)
          }
          if (fetched.status === "rejected") throw fetched.error
          response = fetched.value
        }
        if (
          !this.owns(frameId, active) ||
          (historyPlan && !frameHistoryPlanCurrent(historyPlan, this.session, frame))
        ) {
          return this.canceled(frameId, requestIds, responseUrl, active)
        }

        const finalUrl = this.resolveSameOrigin(response.url, requestUrl, frameId)
        visited.add(finalUrl)
        if (recurseDepth === 0) {
          responseStatus = response.status
          responseUrl = finalUrl
          responseRedirected = response.redirected || finalUrl !== primaryRequestedUrl
          if (historyPlan && responseRedirected) {
            updateFrameHistoryResponseSource(historyPlan, this.session, frame, finalUrl)
            if (!this.owns(frameId, active)) {
              return this.canceled(frameId, requestIds, responseUrl, active)
            }
          }
        }
        if (response.status === 204) {
          if (recurseDepth > 0) {
            if (!primaryMissingResponse) {
              throw new FrameMissingError(
                `Recurse response is missing frame ${JSON.stringify(frameId)}`,
                { frameId },
              )
            }
            const missing = this.dispatchFrameMissing(
              frameId,
              requestIds,
              active,
              primaryMissingResponse,
              historyPlan,
            )
            if (missing.kind === "canceled") return missing.report
            if (missing.kind === "prevented") {
              handledMissing = { event: missing.event, report: missing.report }
              break
            }
            throw new FrameMissingError(
              `Recurse response is missing frame ${JSON.stringify(frameId)}`,
              { frameId },
            )
          }
          if (!historyPlan) {
            this.session.setAttribute(frame.key, "src", responseUrl)
            if (!this.owns(frameId, active)) {
              return this.canceled(frameId, requestIds, responseUrl, active)
            }
          }
          this.release(frameId, active)
          return Object.freeze({
            frameId,
            requestId: requestIds[0] ?? requestId,
            requestIds: Object.freeze([...requestIds]),
            responseStatus: responseStatus ?? response.status,
            status: "empty",
            url: responseUrl,
          })
        }

        const contentType = responseContentType(response)
        if (
          historyPlan &&
          recurseDepth === 0 &&
          !response.redirected &&
          response.status >= 200 &&
          response.status < 300 &&
          contentType === EXPO_TURBO_MIME_TYPE
        ) {
          updateFrameHistoryResponseSource(historyPlan, this.session, frame, finalUrl)
          if (!this.owns(frameId, active)) {
            return this.canceled(frameId, requestIds, responseUrl, active)
          }
        }
        if (contentType !== EXPO_TURBO_MIME_TYPE) {
          throw new ContentTypeError(`Expected ${EXPO_TURBO_MIME_TYPE}`, {
            contentType: contentType ?? "missing",
            frameId,
          })
        }
        const body = await settleRequestOperation(active.controller.signal, () => response.text())
        if (body.status === "canceled") {
          return this.canceled(frameId, requestIds, responseUrl, active)
        }
        if (body.status === "rejected") throw body.error
        const xml = body.value
        if (
          !this.owns(frameId, active) ||
          (historyPlan && !frameHistoryPlanCurrent(historyPlan, this.session, frame))
        ) {
          return this.canceled(frameId, requestIds, responseUrl, active)
        }
        const document = parseExpoTurboDocument(xml, { url: finalUrl })
        if (documentVisitControl(document) === "reload") {
          if (
            recurseDepth === 0 &&
            !historyPlan &&
            (responseRedirected || (response.status >= 200 && response.status < 300))
          ) {
            this.session.setAttribute(frame.key, "src", finalUrl)
            if (!this.owns(frameId, active)) {
              return this.canceled(frameId, requestIds, finalUrl, active)
            }
          }
          const requestId = requestIds[0]
          if (!requestId) {
            throw new StateError("Frame visit-control promotion requires a recorded request", {
              frameId,
            })
          }
          promoted = Object.freeze({
            body: xml,
            report: Object.freeze({
              frameId,
              reason: "visit-control-reload",
              requestId,
              requestIds: Object.freeze([...requestIds]),
              responseStatus: response.status,
              status: "promoted",
              url: finalUrl,
            }),
            response: Object.freeze({
              redirected: response.redirected || finalUrl !== requestUrl,
              status: response.status,
              url: finalUrl,
            }),
          })
          this.release(frameId, active)
          break
        }
        if (recurseDepth === 0) {
          primaryMissingResponse = Object.freeze({
            body: xml,
            redirected: responseRedirected,
            status: responseStatus ?? response.status,
            url: responseUrl,
          })
        }
        const matchingFrame = document
          .getFrames()
          .find((frame) => attributeValue(frame, "id") === frameId)
        if (matchingFrame) {
          const responseRenderMethod =
            preloadMode === "require" ? "replace" : recurseDepth === 0 ? renderMethod : "replace"
          const prepared = prepareFrameResponseTree(frameId, document)
          const candidate: FrameTreeCommitCandidate = Object.freeze({
            frameId,
            redirected: responseRedirected,
            requestId: requestIds[0] ?? requestId,
            requestIds: Object.freeze([...requestIds]),
            requestedUrl: primaryRequestedUrl,
            responseStatus: responseStatus ?? response.status,
            url: responseUrl,
          })
          const documentUrl = historyPlan
            ? frameHistoryDocumentUrl(historyPlan, this.session, frame, candidate)
            : undefined
          let mutation = prepareFrameMutation(this.session, frame, prepared, {
            ...(documentUrl ? { documentUrl } : {}),
            finalUrl: responseUrl,
            renderMethod: responseRenderMethod,
          })
          if (
            loadOptions.beforeFrameCommit ||
            historyPlan ||
            loadOptions[FRAME_RENDER_PREPARE_OPTION] ||
            this.frameLifecycle
          ) {
            const lease = active.lease
            if (!lease) {
              throw new RequestError("Frame commit requires active request ownership", {
                frameId,
                method: "GET",
                responseStatus: candidate.responseStatus,
              })
            }
            let callbackEntered = false
            let callbackContractError: RequestError | undefined
            let beforeFrameRenderEntered = false
            let beforeFrameRender: PreparedFrameBeforeRender | undefined
            try {
              const admitted = this.ownership.commitFrame(lease, () => {
                callbackEntered = true
                const result = loadOptions.beforeFrameCommit?.(candidate)
                if (result !== undefined) {
                  void Promise.resolve(result).catch(() => undefined)
                  callbackContractError = new RequestError(
                    "Frame commit callback must not return a value",
                    {
                      frameId,
                      method: "GET",
                      responseStatus: candidate.responseStatus,
                    },
                  )
                  throw callbackContractError
                }
                beforeFrameRenderEntered = true
                beforeFrameRender = prepareFrameBeforeRender(
                  this.frameLifecycle,
                  prepared,
                  candidate.url,
                  responseRenderMethod,
                )
              })
              if (!admitted) return this.canceled(frameId, requestIds, responseUrl, active)
              if (
                beforeFrameRender?.event.paused &&
                !(await waitForPreparedFrameBeforeRender(
                  beforeFrameRender,
                  active.controller.signal,
                ))
              ) {
                return this.canceled(frameId, requestIds, responseUrl, active)
              }
              if (!this.owns(frameId, active)) {
                return this.canceled(frameId, requestIds, responseUrl, active)
              }

              const acquired = this.ownership.commitFrame(lease, () => {
                const selectedRenderMethod = renderPreparedFrameMutation(
                  prepared,
                  beforeFrameRender,
                  responseRenderMethod,
                )
                if (selectedRenderMethod !== responseRenderMethod) {
                  discardPreparedFrameMutation(mutation)
                  mutation = prepareFrameMutation(this.session, frame, prepared, {
                    ...(documentUrl ? { documentUrl } : {}),
                    finalUrl: responseUrl,
                    renderMethod: selectedRenderMethod,
                  })
                }
                assertPreparedFrameMutationCurrent(this.session, mutation)
                if (selectedRenderMethod === "morph" && this.frameLifecycle) {
                  this.frameLifecycle[FRAME_LIFECYCLE_BEFORE_MORPH_DISPATCH](
                    new BeforeFrameMorphEvent({
                      currentFrame: frame,
                      frameId,
                      newFrame: prepared.responseFrame,
                      url: candidate.url,
                    }),
                  )
                  assertPreparedFrameMutationCurrent(this.session, mutation)
                }
                if (historyPlan) {
                  commitFrameHistoryPlan(historyPlan, this.session, frame, candidate)
                }
                const renderResult = loadOptions[FRAME_RENDER_PREPARE_OPTION]?.(
                  frame,
                  candidate,
                  selectedRenderMethod,
                )
                if (renderResult !== undefined) {
                  callbackContractError = new RequestError(
                    "Frame render preparation callback must not return a value",
                    {
                      frameId,
                      method: "GET",
                      responseStatus: candidate.responseStatus,
                    },
                  )
                  throw callbackContractError
                }
              })
              if (!acquired) return this.canceled(frameId, requestIds, responseUrl, active)
            } catch (error) {
              if (error === callbackContractError) throw error
              if (beforeFrameRenderEntered && error instanceof ExpoTurboError) throw error
              if (historyPlan && error instanceof ExpoTurboError) throw error
              if (callbackEntered) {
                throw new RequestError("Frame commit callback failed", {
                  frameId,
                  method: "GET",
                  responseStatus: candidate.responseStatus,
                })
              }
              throw error
            }
            if (!this.owns(frameId, active)) {
              return this.canceled(frameId, requestIds, responseUrl, active)
            }
          }

          const revision = this.session.revision
          let frameReport: FrameResponseReport
          try {
            const nestedFrames = commitPreparedFrameMutation(this.session, mutation)
            if (preloadMode === "require") {
              frameReport = Object.freeze({
                finalUrl: responseUrl,
                frameId,
                streams: Object.freeze({ actions: Object.freeze([]), interrupted: false }),
              })
            } else {
              const streams = await dispatchPreparedFrameResponseStreams(
                this.session,
                prepared,
                this.streamOptions,
                {
                  shouldContinue: () =>
                    Boolean(active.lease && this.ownership.retains(active.lease)),
                },
              )
              frameReport = recordFrameMorphReloadReport(
                recordFrameAutofocusReport(
                  Object.freeze({
                    finalUrl: responseUrl,
                    frameId,
                    streams,
                  }),
                  this.session,
                  frame,
                  activeFrameAutofocusCandidates(this.session, frame),
                  frameAutoscrollIntent(this.session, frame, prepared),
                ),
                this.session,
                frame,
                nestedFrames,
              )
            }
          } catch (error) {
            if (this.session.revision !== revision) throw new FrameCommitError(candidate)
            throw error
          }
          this.release(frameId, active)
          return Object.freeze({
            frame: frameReport,
            frameId,
            requestId: candidate.requestId,
            requestIds: candidate.requestIds,
            responseStatus: candidate.responseStatus,
            status: "completed",
            url: responseUrl,
          })
        }

        const intermediary = recurseFrame(document.getFrames(), frameId)
        if (!intermediary) {
          if (recurseDepth === 0 && !historyPlan) {
            this.session.setAttribute(frame.key, "src", responseUrl)
            if (!this.owns(frameId, active)) {
              return this.canceled(frameId, requestIds, responseUrl, active)
            }
          }
          const missing = this.dispatchFrameMissing(
            frameId,
            requestIds,
            active,
            primaryMissingResponse ??
              Object.freeze({
                body: xml,
                redirected: responseRedirected,
                status: responseStatus ?? response.status,
                url: responseUrl,
              }),
            historyPlan,
          )
          if (missing.kind === "canceled") return missing.report
          if (missing.kind === "prevented") {
            handledMissing = { event: missing.event, report: missing.report }
            break
          }
          throw new FrameMissingError(`Response is missing frame ${JSON.stringify(frameId)}`, {
            frameId,
          })
        }
        if (recurseDepth >= this.maxRecurseDepth) {
          throw new FrameMissingError(
            `Frame ${JSON.stringify(frameId)} exceeds recurse depth ${this.maxRecurseDepth}`,
            { frameId },
          )
        }

        const intermediaryId = attributeValue(intermediary, "id")
        const intermediarySource = attributeValue(intermediary, "src")
        if (!intermediaryId || !intermediarySource) {
          throw new FrameMissingError(`Response is missing frame ${JSON.stringify(frameId)}`, {
            frameId,
          })
        }
        const nextUrl = this.resolveSameOrigin(intermediarySource, finalUrl, frameId)
        if (visited.has(nextUrl)) {
          throw new FrameMissingError(`Frame ${JSON.stringify(frameId)} has a recurse URL loop`, {
            frameId,
          })
        }
        visited.add(nextUrl)
        requestFrameId = intermediaryId
        requestUrl = nextUrl
        recurseDepth += 1
      }
    } catch (error) {
      if (error instanceof FrameCommitError) {
        this.release(frameId, active)
        throw error
      }
      if (active.controller.signal.aborted || !this.owns(frameId, active)) {
        return this.canceled(frameId, requestIds, url, active)
      }
      this.release(frameId, active)
      throw error
    }

    if (promoted) {
      await executeFrameVisitControlReload(this.frameLifecycle, {
        body: promoted.body,
        frameId,
        response: promoted.response,
      })
      return promoted.report
    }

    if (!handledMissing || !this.frameLifecycle) {
      if (handledMissing) discardFrameMissingResponseBody(handledMissing.event)
      throw new StateError("Prevented Frame-missing handling produced no result", { frameId })
    }
    await executeFrameMissingVisit(this.frameLifecycle, handledMissing.event)
    return handledMissing.report
  }

  private dispatchFrameMissing(
    frameId: string,
    requestIds: readonly string[],
    active: ActiveFrameRequest,
    response: BufferedMissingFrameResponse,
    historyPlan: FrameHistoryCommitPlan | undefined,
  ): FrameMissingDispatchOutcome {
    const lifecycle = this.frameLifecycle
    if (!lifecycle) return Object.freeze({ kind: "default" })

    const event = createFrameMissingEvent({
      body: response.body,
      frameId,
      response: {
        redirected: response.redirected,
        status: response.status,
        url: response.url,
      },
    })
    try {
      lifecycle[FRAME_LIFECYCLE_MISSING_DISPATCH](event)
    } catch (error) {
      discardFrameMissingResponseBody(event)
      throw error
    }
    if (
      !this.owns(frameId, active) ||
      (historyPlan && !frameHistoryPlanCurrent(historyPlan, this.session, active.frame))
    ) {
      discardFrameMissingResponseBody(event)
      return Object.freeze({
        kind: "canceled",
        report: this.canceled(frameId, requestIds, response.url, active),
      })
    }
    if (!event.defaultPrevented) {
      discardFrameMissingResponseBody(event)
      return Object.freeze({ kind: "default" })
    }

    const requestId = requestIds[0]
    if (!requestId) {
      throw new StateError("Frame-missing handling requires a recorded request", { frameId })
    }
    const report = Object.freeze({
      frameId,
      requestId,
      requestIds: Object.freeze([...requestIds]),
      responseStatus: response.status,
      status: "prevented" as const,
      url: response.url,
    })
    this.release(frameId, active)
    return Object.freeze({ event, kind: "prevented", report })
  }

  private canceled(
    frameId: string,
    requestIds: readonly string[],
    url: string,
    request: ActiveFrameRequest,
  ): FrameLoadReport {
    this.release(frameId, request)
    return Object.freeze({
      frameId,
      requestId: requestIds[0] ?? "canceled",
      requestIds: Object.freeze([...requestIds]),
      status: "canceled",
      url,
    })
  }

  private owns(frameId: string, request: ActiveFrameRequest): boolean {
    return (
      this.active.get(frameId) === request &&
      Boolean(request.lease && this.ownership.owns(request.lease)) &&
      this.session.tree.getElementById(frameId) === request.frame
    )
  }

  private release(frameId: string, request: ActiveFrameRequest): void {
    if (request.lease) this.ownership.release(request.lease)
    if (this.active.get(frameId) === request) this.active.delete(frameId)
  }

  private resolveSameOrigin(source: string, baseUrl: string | undefined, frameId: string): string {
    const documentUrl = this.session.tree.document.url
    if (!documentUrl) throw new TargetError("Frame requests require an active document URL")
    return resolveSameOriginProtocolUrl(source, documentUrl, baseUrl ?? documentUrl, { frameId })
  }
}
