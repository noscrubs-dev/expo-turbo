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
import {
  classifyTopLevelLocation,
  documentRootLocation,
  type TopLevelLocationDisposition,
} from "./visitability"

export type DocumentResponseClassification = "client-error" | "server-error" | "success"

export interface DocumentResponseOutcome {
  readonly classification: DocumentResponseClassification
  readonly redirected: boolean
  readonly responseStatus: number
}

interface DocumentResponseReport extends DocumentResponseOutcome {
  readonly requestId: string
  readonly requestedUrl: string
  readonly url: string
}

export type DocumentLoadReport =
  | (DocumentResponseReport & Readonly<{ status: "committed" | "empty" }>)
  | (DocumentResponseReport &
      Readonly<{
        candidateStatus: "committed" | "empty"
        status: "discarded"
      }>)
  | Readonly<{
      requestId: string
      requestedUrl: string
      status: "canceled"
      url: string
    }>

export type DocumentCommitCandidate =
  | (DocumentResponseReport &
      Readonly<{
        rootLocation: string
        status: "committed"
      }>)
  | (DocumentResponseReport & Readonly<{ rootLocation: string; status: "empty" }>)

export type DocumentCommitDisposition = "commit" | "discard"

export interface DocumentLoadOptions {
  readonly beforeCommit?: (candidate: DocumentCommitCandidate) => DocumentCommitDisposition
}

export interface DocumentRequestLoaderOptions {
  readonly capabilityHash?: string
  readonly limits?: Partial<ParseLimits>
}

export interface DocumentCommittedOutcome extends DocumentResponseOutcome {
  readonly status: "committed"
}

export class DocumentCommitError extends RequestError {
  readonly outcome: DocumentCommittedOutcome

  constructor(outcome: DocumentResponseOutcome) {
    super("Document committed but session finalization failed", {
      method: "GET",
      responseStatus: outcome.responseStatus,
    })
    this.outcome = Object.freeze({
      classification: outcome.classification,
      redirected: outcome.redirected,
      responseStatus: outcome.responseStatus,
      status: "committed",
    })
  }
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

  classifyTopLevelSource(source: string): TopLevelLocationDisposition {
    return classifyTopLevelLocation(this.session.tree, source)
  }

  cancel(owner?: object): void {
    const active = this.active
    if (!active || (owner && active.owner !== owner)) return
    active.controller.abort()
    this.active = undefined
  }

  resolveSource(source: string): string {
    const documentUrl = this.session.tree.document.url
    if (!documentUrl) throw new RequestError("Document requests require an active document URL")
    return resolveSameOriginProtocolUrl(source, documentUrl)
  }

  async load(
    source: string,
    owner?: object,
    options: DocumentLoadOptions = {},
  ): Promise<DocumentLoadReport> {
    const requestedUrl = this.resolveSource(source)
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
          tree?: DocumentTree
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
        commit = { classification, finalUrl, redirected, response }
      } else {
        let xml: string
        if (response.status === 201) {
          xml = await response.text()
          if (!this.owns(active)) return this.canceled(active, finalUrl)
          if (xml.trim() === "") {
            commit = { classification, finalUrl, redirected, response }
          }
        } else {
          this.assertContentType(response)
          xml = await response.text()
          if (!this.owns(active)) return this.canceled(active, finalUrl)
        }
        if (!commit) {
          if (response.status === 201) this.assertContentType(response)
          const tree = parseExpoTurboDocument(xml, {
            ...(this.options.limits ? { limits: this.options.limits } : {}),
            url: finalUrl,
          })
          if (!this.owns(active)) return this.canceled(active, finalUrl)
          commit = { classification, finalUrl, redirected, response, tree }
        }
      }
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
    const candidateStatus = commit.tree ? ("committed" as const) : ("empty" as const)
    let disposition: DocumentCommitDisposition = "commit"
    if (options.beforeCommit) {
      try {
        const candidate: DocumentCommitCandidate = Object.freeze({
          classification: commit.classification,
          redirected: commit.redirected,
          requestId,
          requestedUrl,
          responseStatus: commit.response.status,
          rootLocation: documentRootLocation(commit.tree ?? this.session.tree),
          status: candidateStatus,
          url: commit.finalUrl,
        })
        disposition = options.beforeCommit(candidate)
        if (disposition !== "commit" && disposition !== "discard") {
          throw new RequestError("Document commit disposition must be commit or discard", {
            method: "GET",
            responseStatus: candidate.responseStatus,
          })
        }
      } catch (error) {
        this.release(active)
        if (error instanceof ExpoTurboError) throw error
        throw new RequestError("Document commit admission failed", {
          method: "GET",
          responseStatus: commit.response.status,
        })
      }
    }
    if (!this.owns(active)) return this.canceled(active, commit.finalUrl)
    this.release(active)
    if (disposition === "discard") {
      return Object.freeze({
        classification: commit.classification,
        redirected: commit.redirected,
        requestId,
        requestedUrl,
        responseStatus: commit.response.status,
        candidateStatus,
        status: "discarded",
        url: commit.finalUrl,
      })
    }
    const report = Object.freeze({
      classification: commit.classification,
      redirected: commit.redirected,
      requestId,
      requestedUrl,
      responseStatus: commit.response.status,
      status: candidateStatus,
      url: commit.finalUrl,
    })
    if (candidateStatus === "empty") return report
    if (!commit.tree) {
      throw new RequestError("Committed document candidate requires a parsed tree", {
        method: "GET",
        responseStatus: commit.response.status,
      })
    }
    try {
      this.session.replaceTree(commit.tree)
    } catch {
      throw new DocumentCommitError(report)
    }
    return report
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
