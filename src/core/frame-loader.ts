import type { FetchAdapter, RequestIdAdapter, TurboResponse } from "../adapters"
import { ContentTypeError, TargetError } from "./errors"
import { applyFrameResponse, type FrameResponseReport } from "./frames"
import type { DocumentSession } from "./session"
import { EXPO_TURBO_PROTOCOL_VERSION, EXPO_TURBO_RUNTIME_VERSION } from "./versions"

export const EXPO_TURBO_MIME_TYPE = "application/vnd.expo-turbo+xml" as const

export type FrameLoadStatus = "canceled" | "completed" | "empty"

export interface FrameLoadReport {
  readonly frame?: FrameResponseReport
  readonly frameId: string
  readonly requestId: string
  readonly responseStatus?: number
  readonly status: FrameLoadStatus
  readonly url: string
}

interface ActiveFrameRequest {
  readonly controller: AbortController
  readonly epoch: number
}

function header(response: TurboResponse, name: string): string | undefined {
  const expected = name.toLowerCase()
  return Object.entries(response.headers).find(([key]) => key.toLowerCase() === expected)?.[1]
}

export class FrameRequestLoader {
  private readonly active = new Map<string, ActiveFrameRequest>()
  private epoch = 0

  constructor(
    private readonly session: DocumentSession,
    private readonly fetchAdapter: FetchAdapter,
    private readonly requestIds: RequestIdAdapter,
  ) {}

  cancel(frameId: string): void {
    this.active.get(frameId)?.controller.abort()
    this.active.delete(frameId)
  }

  async load(frameId: string, source: string): Promise<FrameLoadReport> {
    const url = this.resolveSameOrigin(source)
    this.cancel(frameId)
    const requestId = this.requestIds.next()
    const active: ActiveFrameRequest = {
      controller: new AbortController(),
      epoch: this.epoch++,
    }
    this.active.set(frameId, active)

    try {
      const response = await this.fetchAdapter.fetch({
        headers: {
          Accept: EXPO_TURBO_MIME_TYPE,
          "Turbo-Frame": frameId,
          "X-Expo-Turbo-Protocol": EXPO_TURBO_PROTOCOL_VERSION,
          "X-Expo-Turbo-Runtime": EXPO_TURBO_RUNTIME_VERSION,
          "X-Turbo-Request-Id": requestId,
        },
        method: "GET",
        signal: active.controller.signal,
        url,
      })
      if (!this.owns(frameId, active)) return this.canceled(frameId, requestId, url)
      if (response.status === 204) {
        this.active.delete(frameId)
        return Object.freeze({
          frameId,
          requestId,
          responseStatus: response.status,
          status: "empty",
          url: response.url,
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
      if (!this.owns(frameId, active)) return this.canceled(frameId, requestId, url)
      const frame = applyFrameResponse(this.session, frameId, xml, { finalUrl: response.url })
      this.active.delete(frameId)
      return Object.freeze({
        frame,
        frameId,
        requestId,
        responseStatus: response.status,
        status: "completed",
        url: response.url,
      })
    } catch (error) {
      if (active.controller.signal.aborted || !this.owns(frameId, active)) {
        return this.canceled(frameId, requestId, url)
      }
      this.active.delete(frameId)
      throw error
    }
  }

  private canceled(frameId: string, requestId: string, url: string): FrameLoadReport {
    return Object.freeze({ frameId, requestId, status: "canceled", url })
  }

  private owns(frameId: string, request: ActiveFrameRequest): boolean {
    return this.active.get(frameId)?.epoch === request.epoch
  }

  private resolveSameOrigin(source: string): string {
    const documentUrl = this.session.tree.document.url
    if (!documentUrl) throw new TargetError("Frame requests require an active document URL")
    const base = new URL(documentUrl)
    const resolved = new URL(source, base)
    if (resolved.origin !== base.origin) {
      throw new TargetError("Frame source must be same-origin", { frameId: resolved.pathname })
    }
    return resolved.toString()
  }
}
