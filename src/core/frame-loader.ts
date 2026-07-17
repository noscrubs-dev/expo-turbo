import type { FetchAdapter, RequestIdAdapter, TurboResponse } from "../adapters"
import { ContentTypeError, FrameMissingError, TargetError } from "./errors"
import { applyFrameResponse, type FrameResponseReport } from "./frames"
import { parseExpoTurboDocument } from "./parser"
import type { DocumentSession } from "./session"
import { attributeValue, type ProtocolElement } from "./tree"
import { EXPO_TURBO_PROTOCOL_VERSION, EXPO_TURBO_RUNTIME_VERSION } from "./versions"

export const EXPO_TURBO_MIME_TYPE = "application/vnd.expo-turbo+xml" as const

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

export interface FrameRequestLoaderOptions {
  readonly maxRecurseDepth?: number
}

interface ActiveFrameRequest {
  readonly controller: AbortController
  readonly epoch: number
}

function header(response: TurboResponse, name: string): string | undefined {
  const expected = name.toLowerCase()
  return Object.entries(response.headers).find(([key]) => key.toLowerCase() === expected)?.[1]
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

export class FrameRequestLoader {
  private readonly active = new Map<string, ActiveFrameRequest>()
  private epoch = 0
  private readonly maxRecurseDepth: number

  constructor(
    private readonly session: DocumentSession,
    private readonly fetchAdapter: FetchAdapter,
    private readonly requestIds: RequestIdAdapter,
    options: FrameRequestLoaderOptions = {},
  ) {
    this.maxRecurseDepth = options.maxRecurseDepth ?? 5
    if (!Number.isInteger(this.maxRecurseDepth) || this.maxRecurseDepth < 0) {
      throw new TargetError("Frame recurse depth must be a non-negative integer")
    }
  }

  cancel(frameId: string): void {
    this.active.get(frameId)?.controller.abort()
    this.active.delete(frameId)
  }

  async load(frameId: string, source: string): Promise<FrameLoadReport> {
    const url = this.resolveSameOrigin(source)
    this.cancel(frameId)
    const requestIds: string[] = []
    const active: ActiveFrameRequest = {
      controller: new AbortController(),
      epoch: this.epoch++,
    }
    this.active.set(frameId, active)

    try {
      let requestFrameId = frameId
      let requestUrl = url
      let recurseDepth = 0
      let responseStatus: number | undefined
      let responseUrl = url
      const visited = new Set([url])

      while (true) {
        const requestId = this.requestIds.next()
        requestIds.push(requestId)
        const response = await this.fetchAdapter.fetch({
          headers: {
            Accept: EXPO_TURBO_MIME_TYPE,
            "Turbo-Frame": requestFrameId,
            "X-Expo-Turbo-Protocol": EXPO_TURBO_PROTOCOL_VERSION,
            "X-Expo-Turbo-Runtime": EXPO_TURBO_RUNTIME_VERSION,
            "X-Turbo-Request-Id": requestId,
          },
          method: "GET",
          signal: active.controller.signal,
          url: requestUrl,
        })
        if (!this.owns(frameId, active)) return this.canceled(frameId, requestIds, responseUrl)

        const finalUrl = this.resolveSameOrigin(response.url, requestUrl)
        visited.add(finalUrl)
        if (recurseDepth === 0) {
          responseStatus = response.status
          responseUrl = finalUrl
        }
        if (response.status === 204) {
          if (recurseDepth > 0) {
            throw new FrameMissingError(
              `Recurse response is missing frame ${JSON.stringify(frameId)}`,
              { frameId },
            )
          }
          this.active.delete(frameId)
          return Object.freeze({
            frameId,
            requestId: requestIds[0] ?? requestId,
            requestIds: Object.freeze([...requestIds]),
            responseStatus: responseStatus ?? response.status,
            status: "empty",
            url: responseUrl,
          })
        }

        const contentType = header(response, "content-type")?.split(";", 1)[0]?.trim().toLowerCase()
        if (contentType !== EXPO_TURBO_MIME_TYPE) {
          throw new ContentTypeError(`Expected ${EXPO_TURBO_MIME_TYPE}`, {
            contentType: contentType ?? "missing",
            frameId,
          })
        }
        const xml = await response.text()
        if (!this.owns(frameId, active)) return this.canceled(frameId, requestIds, responseUrl)
        const document = parseExpoTurboDocument(xml, { url: finalUrl })
        const matchingFrame = document
          .getFrames()
          .find((frame) => attributeValue(frame, "id") === frameId)
        if (matchingFrame) {
          const frame = applyFrameResponse(this.session, frameId, xml, { finalUrl: responseUrl })
          this.active.delete(frameId)
          return Object.freeze({
            frame,
            frameId,
            requestId: requestIds[0] ?? requestId,
            requestIds: Object.freeze([...requestIds]),
            responseStatus: responseStatus ?? response.status,
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
        const nextUrl = this.resolveSameOrigin(intermediarySource, finalUrl)
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
      if (active.controller.signal.aborted || !this.owns(frameId, active)) {
        return this.canceled(frameId, requestIds, url)
      }
      this.active.delete(frameId)
      throw error
    }
  }

  private canceled(frameId: string, requestIds: readonly string[], url: string): FrameLoadReport {
    return Object.freeze({
      frameId,
      requestId: requestIds[0] ?? "canceled",
      requestIds: Object.freeze([...requestIds]),
      status: "canceled",
      url,
    })
  }

  private owns(frameId: string, request: ActiveFrameRequest): boolean {
    return this.active.get(frameId)?.epoch === request.epoch
  }

  private resolveSameOrigin(source: string, baseUrl?: string): string {
    const documentUrl = this.session.tree.document.url
    if (!documentUrl) throw new TargetError("Frame requests require an active document URL")
    const document = new URL(documentUrl)
    const resolved = new URL(source, baseUrl ?? document)
    if (resolved.origin !== document.origin) {
      throw new TargetError("Frame source must be same-origin", { frameId: resolved.pathname })
    }
    return resolved.toString()
  }
}
