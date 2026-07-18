import type { FetchAdapter, RequestIdAdapter, TurboRequest, TurboResponse } from "../adapters"
import {
  type DestinationRequestLease,
  destinationRequestOwnership,
} from "./destination-request-ownership"
import type { DocumentSnapshotCache } from "./document-snapshot-cache"
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

export type DocumentTreeCommitCandidate = Extract<
  DocumentCommitCandidate,
  Readonly<{ status: "committed" }>
>

export type DocumentCommitDisposition = "commit" | "discard"

export interface DocumentLoadOptions {
  readonly beforeCommit?: (candidate: DocumentCommitCandidate) => DocumentCommitDisposition
  readonly beforeTreeCommit?: (candidate: DocumentTreeCommitCandidate) => undefined
  readonly onRequestStart?: () => undefined
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
  lease?: DestinationRequestLease
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
  private readonly ownership: ReturnType<typeof destinationRequestOwnership>

  constructor(
    private readonly session: DocumentSession,
    private readonly fetchAdapter: FetchAdapter,
    private readonly requestIds: RequestIdAdapter,
    private readonly options: DocumentRequestLoaderOptions = {},
  ) {
    this.ownership = destinationRequestOwnership(session)
  }

  classifyTopLevelSource(source: string): TopLevelLocationDisposition {
    return classifyTopLevelLocation(this.session.tree, source)
  }

  get currentUrl(): string | undefined {
    return this.session.tree.document.url
  }

  captureCurrentSnapshot(cache: DocumentSnapshotCache): void {
    this.session.captureSnapshot(cache)
  }

  cancel(owner?: object): boolean {
    const active = this.active
    if (!active || (owner && active.owner !== owner)) return false
    if (active.lease && !this.ownership.cancel(active.lease)) return false
    if (!active.lease) active.controller.abort()
    if (this.active === active) this.active = undefined
    return true
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
    const treeGeneration = this.session.treeGeneration
    const requestedUrl = this.resolveSource(source)
    const requestId = this.requestIds.next()
    const controller = new AbortController()
    const request: TurboRequest = Object.freeze({
      headers: protocolRequestHeaders({
        ...(this.options.capabilityHash ? { capabilityHash: this.options.capabilityHash } : {}),
        requestId,
      }),
      method: "GET",
      signal: controller.signal,
      url: requestedUrl,
    })
    const active: ActiveDocumentRequest = {
      controller,
      ...(owner ? { owner } : {}),
      requestId,
      requestedUrl,
      treeGeneration,
    }
    const previous = this.active
    this.active = active
    try {
      active.lease = this.ownership.claimDocument(controller, treeGeneration)
    } catch (error) {
      controller.abort()
      if (this.active === active) this.active = previous
      throw error
    }
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
      if (!this.owns(active)) return this.canceled(active)
      if (options.onRequestStart) {
        const result = options.onRequestStart()
        if (result !== undefined) {
          void Promise.resolve(result).catch(() => undefined)
          throw new RequestError("Document request start callback must not return a value", {
            method: "GET",
          })
        }
        if (!this.owns(active)) return this.canceled(active)
      }
      this.session.recentRequestIds.add(requestId)
      const response = await this.fetchAdapter.fetch(request)
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
    let candidate: DocumentCommitCandidate | undefined
    if (options.beforeCommit || (options.beforeTreeCommit && candidateStatus === "committed")) {
      try {
        candidate = Object.freeze({
          classification: commit.classification,
          redirected: commit.redirected,
          requestId,
          requestedUrl,
          responseStatus: commit.response.status,
          rootLocation: documentRootLocation(commit.tree ?? this.session.tree),
          status: candidateStatus,
          url: commit.finalUrl,
        })
      } catch (error) {
        this.release(active)
        if (error instanceof ExpoTurboError) throw error
        throw new RequestError("Document commit candidate creation failed", {
          method: "GET",
          responseStatus: commit.response.status,
        })
      }
    }
    let disposition: DocumentCommitDisposition = "commit"
    if (options.beforeCommit) {
      try {
        if (!candidate) throw new RequestError("Document commit candidate is unavailable")
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
    if (disposition === "discard") {
      this.release(active)
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
    if (candidateStatus === "empty") {
      this.release(active)
      return report
    }
    if (!commit.tree) {
      this.release(active)
      throw new RequestError("Committed document candidate requires a parsed tree", {
        method: "GET",
        responseStatus: commit.response.status,
      })
    }
    if (options.beforeTreeCommit) {
      const lease = active.lease
      if (!lease) {
        this.release(active)
        throw new RequestError("Document tree commit requires active request ownership", {
          method: "GET",
          responseStatus: commit.response.status,
        })
      }
      try {
        if (!candidate) {
          throw new RequestError("Document tree commit candidate is unavailable", {
            method: "GET",
            responseStatus: commit.response.status,
          })
        }
        const acquired = this.ownership.commitDocument(lease, () => {
          const result = options.beforeTreeCommit?.(candidate as DocumentTreeCommitCandidate)
          if (result !== undefined) {
            void Promise.resolve(result).catch(() => undefined)
            throw new RequestError("Document tree commit callback must not return a value", {
              method: "GET",
              responseStatus: commit.response.status,
            })
          }
        })
        if (!acquired) return this.canceled(active, commit.finalUrl)
      } catch (error) {
        this.release(active)
        if (error instanceof ExpoTurboError) throw error
        throw new RequestError("Document tree commit callback failed", {
          method: "GET",
          responseStatus: commit.response.status,
        })
      }
      if (!this.owns(active)) return this.canceled(active, commit.finalUrl)
    }
    this.release(active)
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
    return Boolean(
      this.active === active &&
        active.lease &&
        this.ownership.owns(active.lease) &&
        this.session.treeGeneration === active.treeGeneration,
    )
  }

  private release(active: ActiveDocumentRequest): void {
    if (active.lease) this.ownership.release(active.lease)
    if (this.active === active) this.active = undefined
  }
}
