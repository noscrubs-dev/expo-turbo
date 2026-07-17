import type { FetchAdapter, RequestIdAdapter, TurboResponse } from "../adapters"
import { ContentTypeError, ExpoTurboError, RequestError } from "./errors"
import { type ParseLimits, parseExpoTurboDocument } from "./parser"
import {
  EXPO_TURBO_MIME_TYPE,
  protocolRequestHeaders,
  resolveSameOriginProtocolUrl,
  responseContentType,
} from "./protocol-request"
import type { DocumentSession } from "./session"
import type { DocumentTree } from "./tree"

export type DocumentResponseClassification = "client-error" | "server-error" | "success"

interface DocumentResponseReport {
  readonly classification: DocumentResponseClassification
  readonly redirected: boolean
  readonly requestId: string
  readonly requestedUrl: string
  readonly responseStatus: number
  readonly url: string
}

export type DocumentLoadReport =
  | (DocumentResponseReport & Readonly<{ status: "committed" | "empty" }>)
  | Readonly<{
      requestId: string
      requestedUrl: string
      status: "canceled"
      url: string
    }>

export interface DocumentRequestLoaderOptions {
  readonly capabilityHash?: string
  readonly limits?: Partial<ParseLimits>
}

interface ActiveDocumentRequest {
  readonly controller: AbortController
  readonly owner?: object
  readonly requestId: string
  readonly requestedUrl: string
  readonly treeGeneration: number
}

function classifyResponse(status: number): DocumentResponseClassification {
  if (status >= 200 && status < 300) return "success"
  if (status >= 400 && status < 500) return "client-error"
  if (status >= 500 && status < 600) return "server-error"
  throw new RequestError("Document response status is not renderable", {
    method: "GET",
    responseStatus: status,
  })
}

export class DocumentRequestLoader {
  private active: ActiveDocumentRequest | undefined

  constructor(
    private readonly session: DocumentSession,
    private readonly fetchAdapter: FetchAdapter,
    private readonly requestIds: RequestIdAdapter,
    private readonly options: DocumentRequestLoaderOptions = {},
  ) {}

  cancel(owner?: object): void {
    const active = this.active
    if (!active || (owner && active.owner !== owner)) return
    active.controller.abort()
    this.active = undefined
  }

  async load(source: string, owner?: object): Promise<DocumentLoadReport> {
    const documentUrl = this.session.tree.document.url
    if (!documentUrl) throw new RequestError("Document requests require an active document URL")
    const requestedUrl = resolveSameOriginProtocolUrl(source, documentUrl)
    this.cancel()

    const requestId = this.requestIds.next()
    const active: ActiveDocumentRequest = {
      controller: new AbortController(),
      ...(owner ? { owner } : {}),
      requestId,
      requestedUrl,
      treeGeneration: this.session.treeGeneration,
    }
    this.active = active
    let responseStatus: number | undefined
    let commit:
      | Readonly<{
          classification: DocumentResponseClassification
          finalUrl: string
          redirected: boolean
          response: TurboResponse
          tree: DocumentTree
        }>
      | undefined

    try {
      const response = await this.fetchAdapter.fetch({
        headers: protocolRequestHeaders({
          ...(this.options.capabilityHash ? { capabilityHash: this.options.capabilityHash } : {}),
          requestId,
        }),
        method: "GET",
        signal: active.controller.signal,
        url: requestedUrl,
      })
      if (!this.owns(active)) return this.canceled(active)

      responseStatus = response.status
      const finalUrl = this.finalUrl(response, active)
      const classification = classifyResponse(response.status)
      const redirected = response.redirected || finalUrl !== requestedUrl

      if (response.status === 204) {
        this.release(active)
        return Object.freeze({
          classification,
          redirected,
          requestId,
          requestedUrl,
          responseStatus: response.status,
          status: "empty",
          url: finalUrl,
        })
      }

      let xml: string
      if (response.status === 201) {
        xml = await response.text()
        if (!this.owns(active)) return this.canceled(active, finalUrl)
        if (xml.trim() === "") {
          this.release(active)
          return Object.freeze({
            classification,
            redirected,
            requestId,
            requestedUrl,
            responseStatus: response.status,
            status: "empty",
            url: finalUrl,
          })
        }
      } else {
        this.assertContentType(response)
        xml = await response.text()
        if (!this.owns(active)) return this.canceled(active, finalUrl)
      }
      if (response.status === 201) this.assertContentType(response)
      const tree = parseExpoTurboDocument(xml, {
        ...(this.options.limits ? { limits: this.options.limits } : {}),
        url: finalUrl,
      })
      if (!this.owns(active)) return this.canceled(active, finalUrl)
      commit = { classification, finalUrl, redirected, response, tree }
    } catch (error) {
      if (active.controller.signal.aborted || !this.owns(active)) {
        return this.canceled(active)
      }
      this.release(active)
      if (error instanceof ExpoTurboError) throw error
      throw new RequestError("Document request failed", {
        method: "GET",
        ...(responseStatus !== undefined ? { responseStatus } : {}),
      })
    }

    if (!commit) throw new RequestError("Document request did not produce a terminal outcome")
    this.release(active)
    this.session.replaceTree(commit.tree)
    return Object.freeze({
      classification: commit.classification,
      redirected: commit.redirected,
      requestId,
      requestedUrl,
      responseStatus: commit.response.status,
      status: "committed",
      url: commit.finalUrl,
    })
  }

  private assertContentType(response: TurboResponse): void {
    const contentType = responseContentType(response)
    if (contentType !== EXPO_TURBO_MIME_TYPE) {
      throw new ContentTypeError(`Expected ${EXPO_TURBO_MIME_TYPE}`, {
        contentType: contentType ?? "missing",
      })
    }
  }

  private canceled(
    active: ActiveDocumentRequest,
    url: string = active.requestedUrl,
  ): DocumentLoadReport {
    this.release(active)
    return Object.freeze({
      requestId: active.requestId,
      requestedUrl: active.requestedUrl,
      status: "canceled",
      url,
    })
  }

  private finalUrl(response: TurboResponse, active: ActiveDocumentRequest): string {
    if (!response.url.trim()) {
      throw new RequestError("Document response requires a final URL", {
        method: "GET",
        responseStatus: response.status,
      })
    }
    return resolveSameOriginProtocolUrl(response.url, active.requestedUrl, active.requestedUrl)
  }

  private owns(active: ActiveDocumentRequest): boolean {
    return this.active === active && this.session.treeGeneration === active.treeGeneration
  }

  private release(active: ActiveDocumentRequest): void {
    if (this.active === active) this.active = undefined
  }
}
