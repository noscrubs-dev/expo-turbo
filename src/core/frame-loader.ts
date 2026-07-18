import type { FetchAdapter, RequestIdAdapter } from "../adapters"
import {
  type DestinationRequestLease,
  destinationRequestOwnership,
} from "./destination-request-ownership"
import {
  ContentTypeError,
  ExpoTurboError,
  FrameMissingError,
  RequestError,
  TargetError,
} from "./errors"
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
  commitPreparedFrameMutation,
  dispatchPreparedFrameResponseStreams,
  prepareFrameMutation,
  prepareFrameResponseTree,
} from "./frame-response-application"
import type { FrameResponseReport } from "./frames"
import { parseExpoTurboDocument } from "./parser"
import {
  EXPO_TURBO_MIME_TYPE,
  protocolRequestHeaders,
  resolveSameOriginProtocolUrl,
  responseContentType,
} from "./protocol-request"
import type { DocumentSession } from "./session"
import type { StreamActionDispatchOptions } from "./streams"
import { attributeValue, type ProtocolElement } from "./tree"

export { EXPO_TURBO_MIME_TYPE } from "./protocol-request"

export type FrameLoadStatus = "canceled" | "completed" | "empty"

export interface FrameLoadReport {
  readonly frame?: FrameResponseReport
  readonly frameId: string
  readonly requestId: string
  readonly requestIds: readonly string[]
  readonly responseStatus?: number
  readonly status: FrameLoadStatus
  readonly url: string
}

export interface FrameTreeCommitCandidate {
  readonly frameId: string
  readonly redirected: boolean
  readonly requestId: string
  readonly requestIds: readonly string[]
  readonly requestedUrl: string
  readonly responseStatus: number
  readonly url: string
}

export interface FrameLoadOptions {
  /**
   * Runs synchronously after response extraction and structural preflight but before the
   * prepared Frame mutation begins. The callback must be atomic-on-error and must not mutate
   * the document session or reenter package controllers.
   */
  readonly beforeFrameCommit?: (candidate: FrameTreeCommitCandidate) => undefined
  /** Exact owner token used by cancellation and controller lifecycle coordination. */
  readonly owner?: object
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
  readonly maxRecurseDepth?: number
}

interface ActiveFrameRequest {
  readonly controller: AbortController
  readonly frame: ProtocolElement
  lease?: DestinationRequestLease
  readonly owner?: object
}

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
      (key) => key !== "beforeFrameCommit" && key !== "owner" && key !== FRAME_HISTORY_PLAN_OPTION,
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
  if (historyPlan && beforeFrameCommit) {
    throw new RequestError("Frame history plans cannot be combined with commit callbacks", {
      method: "GET",
    })
  }
  return Object.freeze({
    ...(beforeFrameCommit ? { beforeFrameCommit } : {}),
    ...(owner ? { owner } : {}),
    ...(historyPlan ? { [FRAME_HISTORY_PLAN_OPTION]: historyPlan } : {}),
  })
}

export class FrameRequestLoader {
  private readonly active = new Map<string, ActiveFrameRequest>()
  private readonly capabilityHash: string | undefined
  private readonly maxRecurseDepth: number
  private readonly ownership: ReturnType<typeof destinationRequestOwnership>
  private readonly streamOptions: StreamActionDispatchOptions

  constructor(
    private readonly session: DocumentSession,
    private readonly fetchAdapter: FetchAdapter,
    private readonly requestIds: RequestIdAdapter,
    options: FrameRequestLoaderOptions = {},
  ) {
    this.capabilityHash = options.capabilityHash
    this.maxRecurseDepth = options.maxRecurseDepth ?? 5
    this.ownership = destinationRequestOwnership(session)
    this.streamOptions = Object.freeze({
      ...(options.customActions ? { customActions: options.customActions } : {}),
      ...(options.onActionError ? { onActionError: options.onActionError } : {}),
      ...(options.refresh ? { refresh: options.refresh } : {}),
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

  async load(
    frameId: string,
    source: string,
    options: FrameLoadOptions = {},
  ): Promise<FrameLoadReport> {
    const loadOptions = frameLoadOptions(options)
    const owner = loadOptions.owner
    const url = this.resolveSameOrigin(source, undefined, frameId)
    const frame = this.session.tree.getElementById(frameId)
    if (frame?.kind !== "frame") {
      throw new FrameMissingError(`Active frame ${JSON.stringify(frameId)} is missing`, { frameId })
    }
    const controller = new AbortController()
    const firstRequestId = this.requestIds.next()
    const firstHeaders = protocolRequestHeaders({
      ...(this.capabilityHash ? { capabilityHash: this.capabilityHash } : {}),
      frameId,
      requestId: firstRequestId,
    })
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
      if (this.active.get(frameId) === active) {
        if (previous) this.active.set(frameId, previous)
        else this.active.delete(frameId)
      }
      throw error
    }
    const historyPlan = loadOptions[FRAME_HISTORY_PLAN_OPTION]

    try {
      if (historyPlan) {
        beginFrameHistoryRequest(historyPlan, this.session, frame, url)
        if (!this.owns(frameId, active)) {
          return this.canceled(frameId, [], url, active)
        }
      }
      let requestFrameId = frameId
      let requestUrl = url
      let recurseDepth = 0
      let responseStatus: number | undefined
      let responseUrl = url
      let responseRedirected = false
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
        requestIds.push(requestId)
        this.session.recentRequestIds.add(requestId)
        const response = await this.fetchAdapter.fetch({
          headers,
          method: "GET",
          signal: active.controller.signal,
          url: requestUrl,
        })
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
          responseRedirected = response.redirected || finalUrl !== url
          if (historyPlan && responseRedirected) {
            updateFrameHistoryResponseSource(historyPlan, this.session, frame, finalUrl)
            if (!this.owns(frameId, active)) {
              return this.canceled(frameId, requestIds, responseUrl, active)
            }
          }
        }
        if (response.status === 204) {
          if (recurseDepth > 0) {
            throw new FrameMissingError(
              `Recurse response is missing frame ${JSON.stringify(frameId)}`,
              { frameId },
            )
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
        const xml = await response.text()
        if (
          !this.owns(frameId, active) ||
          (historyPlan && !frameHistoryPlanCurrent(historyPlan, this.session, frame))
        ) {
          return this.canceled(frameId, requestIds, responseUrl, active)
        }
        const document = parseExpoTurboDocument(xml, { url: finalUrl })
        const matchingFrame = document
          .getFrames()
          .find((frame) => attributeValue(frame, "id") === frameId)
        if (matchingFrame) {
          const prepared = prepareFrameResponseTree(frameId, document)
          const candidate: FrameTreeCommitCandidate = Object.freeze({
            frameId,
            redirected: responseRedirected,
            requestId: requestIds[0] ?? requestId,
            requestIds: Object.freeze([...requestIds]),
            requestedUrl: url,
            responseStatus: responseStatus ?? response.status,
            url: responseUrl,
          })
          const documentUrl = historyPlan
            ? frameHistoryDocumentUrl(historyPlan, this.session, frame, candidate)
            : undefined
          const mutation = prepareFrameMutation(this.session, frame, prepared, {
            ...(documentUrl ? { documentUrl } : {}),
            finalUrl: responseUrl,
          })
          if (loadOptions.beforeFrameCommit || historyPlan) {
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
            try {
              const acquired = this.ownership.commitFrame(lease, () => {
                callbackEntered = true
                const result = historyPlan
                  ? commitFrameHistoryPlan(historyPlan, this.session, frame, candidate)
                  : loadOptions.beforeFrameCommit?.(candidate)
                if (result !== undefined) {
                  if (!historyPlan) {
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
                }
              })
              if (!acquired) return this.canceled(frameId, requestIds, responseUrl, active)
            } catch (error) {
              if (error === callbackContractError) throw error
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
            commitPreparedFrameMutation(this.session, mutation)
            const streams = dispatchPreparedFrameResponseStreams(
              this.session,
              prepared,
              this.streamOptions,
              {
                shouldContinue: () => Boolean(active.lease && this.ownership.retains(active.lease)),
              },
            )
            frameReport = Object.freeze({ finalUrl: responseUrl, frameId, streams })
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
