import type { FetchAdapter, RequestIdAdapter, TurboRequest, TurboResponse } from "../adapters"
import {
  type DestinationRequestLease,
  destinationRequestOwnership,
} from "./destination-request-ownership"
import type { DocumentScrollPosition } from "./document-history"
import {
  documentLoadRefreshScroll,
  documentLoadRenderMethod,
} from "./document-load-render-method-internal"
import {
  createDocumentTransportError,
  DOCUMENT_BEFORE_SNAPSHOT_CAPTURE,
  DOCUMENT_LOAD_DISCARD_HANDLING,
  DOCUMENT_LOAD_REQUEST_DISPATCHED,
  markDocumentContentTypeError,
  markDocumentTransportError,
} from "./document-loader-lifecycle-internal"
import { documentCachePolicy } from "./document-metadata"
import { beginDocumentNavigation } from "./document-navigation-epoch"
import {
  discardDocumentRefreshScroll,
  prepareDocumentRefreshScroll,
  suppressPreparedDocumentRefreshScroll,
} from "./document-refresh-scroll-internal"
import {
  DOCUMENT_REQUEST_LOADER_PREPARE_RENDER,
  type PreparedDocumentRender,
  prepareDocumentRender,
} from "./document-render-lifecycle-internal"
import { morphCurrentDocument } from "./document-session-morph-internal"
import type { DocumentSnapshotCache } from "./document-snapshot-cache"
import type { DocumentRenderMethod, DocumentVisitLifecycle } from "./document-visit-lifecycle"
import { ContentTypeError, ExpoTurboError, RequestError, StateError } from "./errors"
import { type ParseLimits, parseExpoTurboDocument } from "./parser"
import {
  EXPO_TURBO_MIME_TYPE,
  protocolRequestHeaders,
  resolveSameOriginProtocolUrl,
  responseContentType,
} from "./protocol-request"
import {
  fetchWithRequestLifecycle,
  type RequestLifecycle,
  RequestLifecycleTransportError,
  requestLifecycleOption,
  settleRequestOperation,
} from "./request-lifecycle"
import type { DocumentSession } from "./session"
import { type DocumentTree, morphCurrentDocumentRoot } from "./tree"
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
      redirected: boolean
      requestId: string
      requestedUrl: string
      responseStatus: number
      status: "prevented"
      url: string
    }>
  | Readonly<{
      requestId: string
      requestedUrl: string
      status: "canceled"
      url: string
    }>

export type DocumentSnapshotRestoreReport = Readonly<{
  status: "canceled" | "committed" | "miss"
  url: string
}>

export interface DocumentSnapshotRestoreOptions {
  readonly beforeClaim?: () => undefined
  readonly beforeTreeCommit?: () => undefined
  readonly onRestoreStart?: () => undefined
}

export interface DocumentSnapshotPreviewOptions {
  readonly beforeClaim?: () => undefined
  readonly beforeTreeCommit?: () => undefined
  readonly onPreviewStart?: () => undefined
}

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
  readonly beforeClaim?: () => undefined
  readonly beforeCommit?: (candidate: DocumentCommitCandidate) => DocumentCommitDisposition
  readonly beforeTreeCommit?: (candidate: DocumentTreeCommitCandidate) => undefined
  readonly onRequestStart?: () => undefined
}

type InternalDocumentLoadOptions = DocumentLoadOptions &
  Readonly<{
    [DOCUMENT_BEFORE_SNAPSHOT_CAPTURE]?: () => undefined
    [DOCUMENT_LOAD_DISCARD_HANDLING]?: (
      controller: AbortController,
    ) => undefined | PromiseLike<undefined>
    [DOCUMENT_LOAD_REQUEST_DISPATCHED]?: () => undefined
  }>

type InternalDocumentSnapshotOptions = Readonly<{
  [DOCUMENT_BEFORE_SNAPSHOT_CAPTURE]?: () => undefined
}>

export interface DocumentRequestLoaderOptions {
  readonly capabilityHash?: string
  readonly limits?: Partial<ParseLimits>
  readonly requestLifecycle?: RequestLifecycle
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

/** A cached tree replaced the document, but synchronous finalization failed. */
export class DocumentSnapshotRestoreCommitError extends StateError {
  readonly outcome: DocumentSnapshotRestoreReport

  constructor(outcome: DocumentSnapshotRestoreReport) {
    super("Document snapshot restored but session finalization failed")
    this.outcome = outcome
  }
}

/** A cached preview replaced the document, but synchronous finalization failed. */
export class DocumentSnapshotPreviewCommitError extends StateError {
  readonly outcome: DocumentSnapshotRestoreReport

  constructor(outcome: DocumentSnapshotRestoreReport) {
    super("Document snapshot preview committed but session finalization failed")
    this.outcome = outcome
  }
}

interface DocumentSnapshotApplicationOptions {
  readonly [DOCUMENT_BEFORE_SNAPSHOT_CAPTURE]?: () => undefined
  readonly beforeClaim?: () => undefined
  readonly beforeTreeCommit?: () => undefined
  readonly onStart?: () => undefined
}

interface ActiveDocumentOperation {
  readonly controller: AbortController
  lease?: DestinationRequestLease
  readonly owner?: object
  readonly treeGeneration: number
}

interface ActiveDocumentRequest extends ActiveDocumentOperation {
  readonly requestId: string
  requestedUrl: string
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
  private active: ActiveDocumentOperation | undefined
  private readonly ownership: ReturnType<typeof destinationRequestOwnership>
  private readonly requestLifecycle: RequestLifecycle | undefined

  constructor(
    private readonly session: DocumentSession,
    private readonly fetchAdapter: FetchAdapter,
    private readonly requestIds: RequestIdAdapter,
    private readonly options: DocumentRequestLoaderOptions = {},
  ) {
    this.requestLifecycle = requestLifecycleOption(options, "Document request loader")
    this.ownership = destinationRequestOwnership(session)
  }

  classifyTopLevelSource(source: string): TopLevelLocationDisposition {
    return classifyTopLevelLocation(this.session.tree, source)
  }

  get currentUrl(): string | undefined {
    return this.session.tree.document.url
  }

  get documentClaimSerial(): number {
    return this.ownership.currentDocumentClaimSerial
  }

  get treeState(): DocumentSession["treeState"] {
    return this.session.treeState
  }

  subscribeTreeState(listener: () => void): () => void {
    return this.session.subscribeTreeState(listener)
  }

  discardDocumentRefreshScroll(generation: number): void {
    discardDocumentRefreshScroll(this.session, generation)
  }

  captureCurrentSnapshot(cache: DocumentSnapshotCache): void {
    this.session.captureSnapshot(cache)
  }

  [DOCUMENT_REQUEST_LOADER_PREPARE_RENDER](
    lifecycle: DocumentVisitLifecycle,
    detail: Readonly<{
      historyScroll?: DocumentScrollPosition
      preview: boolean
      renderMethod?: DocumentRenderMethod
      url: string
    }>,
  ): PreparedDocumentRender {
    return prepareDocumentRender(this.session, lifecycle, detail)
  }

  restoreSnapshot(
    cache: DocumentSnapshotCache,
    url: string,
    owner?: object,
    options: DocumentSnapshotRestoreOptions = {},
  ): DocumentSnapshotRestoreReport {
    return this.applySnapshot(cache, url, owner, {
      ...((options as InternalDocumentSnapshotOptions)[DOCUMENT_BEFORE_SNAPSHOT_CAPTURE]
        ? {
            [DOCUMENT_BEFORE_SNAPSHOT_CAPTURE]: (options as InternalDocumentSnapshotOptions)[
              DOCUMENT_BEFORE_SNAPSHOT_CAPTURE
            ],
          }
        : {}),
      ...(options.beforeClaim ? { beforeClaim: options.beforeClaim } : {}),
      ...(options.beforeTreeCommit ? { beforeTreeCommit: options.beforeTreeCommit } : {}),
      ...(options.onRestoreStart ? { onStart: options.onRestoreStart } : {}),
    })
  }

  previewSnapshot(
    cache: DocumentSnapshotCache,
    url: string,
    owner?: object,
    options: DocumentSnapshotPreviewOptions = {},
  ): DocumentSnapshotRestoreReport {
    return this.applySnapshot(
      cache,
      url,
      owner,
      {
        ...((options as InternalDocumentSnapshotOptions)[DOCUMENT_BEFORE_SNAPSHOT_CAPTURE]
          ? {
              [DOCUMENT_BEFORE_SNAPSHOT_CAPTURE]: (options as InternalDocumentSnapshotOptions)[
                DOCUMENT_BEFORE_SNAPSHOT_CAPTURE
              ],
            }
          : {}),
        ...(options.beforeClaim ? { beforeClaim: options.beforeClaim } : {}),
        ...(options.beforeTreeCommit ? { beforeTreeCommit: options.beforeTreeCommit } : {}),
        ...(options.onPreviewStart ? { onStart: options.onPreviewStart } : {}),
      },
      true,
    )
  }

  private applySnapshot(
    cache: DocumentSnapshotCache,
    url: string,
    owner: object | undefined,
    options: DocumentSnapshotApplicationOptions,
    preview = false,
  ): DocumentSnapshotRestoreReport {
    const restoredUrl = this.resolveSource(url)
    const cached = preview ? cache.getPreview(restoredUrl) : cache.get(restoredUrl)
    if (!cached) return Object.freeze({ status: "miss", url: restoredUrl })

    const tree = cached.clone({ documentUrl: restoredUrl })
    if (options.beforeClaim) {
      try {
        const result = options.beforeClaim()
        if (result !== undefined) {
          void Promise.resolve(result).catch(() => undefined)
          throw new StateError("Document snapshot claim callback must not return a value")
        }
      } catch (error) {
        if (error instanceof ExpoTurboError) throw error
        throw new StateError("Document snapshot claim callback failed")
      }
    }
    const active: ActiveDocumentOperation = {
      controller: new AbortController(),
      ...(owner ? { owner } : {}),
      treeGeneration: this.session.treeGeneration,
    }
    const previous = this.active
    this.active = active
    try {
      active.lease = this.ownership.claimDocument(active.controller, active.treeGeneration)
    } catch (error) {
      active.controller.abort()
      if (this.active === active) this.active = previous
      throw error
    }
    const canceled = Object.freeze({ status: "canceled" as const, url: restoredUrl })
    const committed = Object.freeze({ status: "committed" as const, url: restoredUrl })

    try {
      if (!this.owns(active)) {
        this.release(active)
        return canceled
      }
      if (options.onStart) {
        const result = options.onStart()
        if (result !== undefined) {
          void Promise.resolve(result).catch(() => undefined)
          throw new StateError(
            `Document snapshot ${preview ? "preview" : "restore"} start callback must not return a value`,
          )
        }
        if (!this.owns(active)) {
          this.release(active)
          return canceled
        }
      }
      const beforeSnapshotCapture = options[DOCUMENT_BEFORE_SNAPSHOT_CAPTURE]
      if (beforeSnapshotCapture && documentCachePolicy(this.session.tree).cacheable) {
        const result = beforeSnapshotCapture()
        if (result !== undefined) {
          void Promise.resolve(result).catch(() => undefined)
          throw new StateError("Document before-cache callback must not return a value")
        }
        if (!this.owns(active)) {
          this.release(active)
          return canceled
        }
      }
      beginDocumentNavigation(this.session)
      if (options.beforeTreeCommit) {
        const lease = active.lease
        if (!lease) throw new StateError("Document snapshot restore requires active ownership")
        const acquired = this.ownership.commitDocument(lease, () => {
          const result = options.beforeTreeCommit?.()
          if (result !== undefined) {
            void Promise.resolve(result).catch(() => undefined)
            throw new StateError("Document snapshot commit callback must not return a value")
          }
        })
        if (!acquired) {
          this.release(active)
          return canceled
        }
      }
      if (!this.owns(active)) {
        this.release(active)
        return canceled
      }
      this.release(active)
      try {
        if (preview) this.session.replaceTreePreview(tree)
        else this.session.replaceTree(tree)
      } catch {
        throw preview
          ? new DocumentSnapshotPreviewCommitError(committed)
          : new DocumentSnapshotRestoreCommitError(committed)
      }
      return committed
    } catch (error) {
      this.release(active)
      if (error instanceof ExpoTurboError) throw error
      throw new StateError(`Document snapshot ${preview ? "preview" : "restore"} failed`)
    }
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
    const renderMethod = documentLoadRenderMethod(options)
    const treeGeneration = this.session.treeGeneration
    let requestedUrl = this.resolveSource(source)
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
    if (options.beforeClaim) {
      try {
        const result = options.beforeClaim()
        if (result !== undefined) {
          void Promise.resolve(result).catch(() => undefined)
          throw new RequestError("Document request claim callback must not return a value", {
            method: "GET",
          })
        }
      } catch (error) {
        if (error instanceof ExpoTurboError) throw error
        throw new RequestError("Document request claim callback failed", { method: "GET" })
      }
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
      const requestDispatched = (): undefined => {
        const callback = (options as InternalDocumentLoadOptions)[DOCUMENT_LOAD_REQUEST_DISPATCHED]
        if (callback) {
          const result = callback()
          if (result !== undefined) {
            void Promise.resolve(result).catch(() => undefined)
            throw new RequestError("Document request dispatch callback must not return a value", {
              method: "GET",
            })
          }
        }
      }
      const startRequest = (effectiveRequest: TurboRequest): boolean => {
        if (!this.owns(active)) return false
        requestedUrl = effectiveRequest.url
        active.requestedUrl = requestedUrl
        beginDocumentNavigation(this.session)
        this.session.recentRequestIds.add(requestId)
        return this.owns(active)
      }
      let response: TurboResponse
      if (this.requestLifecycle) {
        const fetched = await fetchWithRequestLifecycle({
          admission: {
            admitUrl: (url) => this.resolveSource(url),
            allowBody: false,
            allowedMethods: ["GET"],
            protectedHeaders: Object.keys(request.headers),
          },
          afterBeforeRequestListeners: requestDispatched,
          beforeFetch: startRequest,
          context: { kind: "document", purpose: "load", requestId },
          fetchAdapter: this.fetchAdapter,
          lifecycle: this.requestLifecycle,
          request,
        })
        if (fetched.status === "canceled") return this.canceled(active)
        response = fetched.response
        if (fetched.status === "prevented") {
          responseStatus = response.status
          const finalUrl = this.finalUrl(response, active)
          const prevented = Object.freeze({
            redirected: response.redirected || finalUrl !== requestedUrl,
            requestId,
            requestedUrl,
            responseStatus: response.status,
            status: "prevented" as const,
            url: finalUrl,
          })
          this.release(active)
          return prevented
        }
      } else {
        requestDispatched()
        if (!startRequest(request)) return this.canceled(active)
        const fetched = await settleRequestOperation(active.controller.signal, () =>
          this.fetchAdapter.fetch(request),
        )
        if (fetched.status === "canceled") return this.canceled(active)
        if (fetched.status === "rejected") {
          if (fetched.error instanceof ExpoTurboError) {
            throw markDocumentTransportError(fetched.error)
          }
          throw createDocumentTransportError()
        }
        response = fetched.value
      }
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
          const body = await settleRequestOperation(active.controller.signal, () => response.text())
          if (body.status === "canceled") return this.canceled(active, finalUrl)
          if (body.status === "rejected") {
            if (body.error instanceof ExpoTurboError) {
              throw markDocumentTransportError(body.error)
            }
            throw createDocumentTransportError(responseStatus)
          }
          xml = body.value
          if (!this.owns(active)) return this.canceled(active, finalUrl)
          if (xml.trim() === "") {
            commit = { classification, finalUrl, redirected, response }
          }
        } else {
          this.assertContentType(response)
          const body = await settleRequestOperation(active.controller.signal, () => response.text())
          if (body.status === "canceled") return this.canceled(active, finalUrl)
          if (body.status === "rejected") {
            if (body.error instanceof ExpoTurboError) {
              throw markDocumentTransportError(body.error)
            }
            throw createDocumentTransportError(responseStatus)
          }
          xml = body.value
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
      if (error instanceof RequestLifecycleTransportError) {
        throw error.relabel("Document request failed", {
          method: "GET",
          ...(responseStatus !== undefined ? { responseStatus } : {}),
        })
      }
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
      const report = Object.freeze({
        classification: commit.classification,
        redirected: commit.redirected,
        requestId,
        requestedUrl,
        responseStatus: commit.response.status,
        candidateStatus,
        status: "discarded",
        url: commit.finalUrl,
      })
      const handleDiscard = (options as InternalDocumentLoadOptions)[DOCUMENT_LOAD_DISCARD_HANDLING]
      if (handleDiscard) {
        try {
          const result = await handleDiscard(active.controller)
          if (result !== undefined) {
            void Promise.resolve(result).catch(() => undefined)
            throw new RequestError("Document discard handler must not return a value", {
              method: "GET",
              responseStatus: commit.response.status,
            })
          }
        } catch (error) {
          if (active.controller.signal.aborted || !this.owns(active)) {
            return this.canceled(active, commit.finalUrl)
          }
          this.release(active)
          if (error instanceof ExpoTurboError) throw error
          throw new RequestError("Document discard handling failed", {
            method: "GET",
            responseStatus: commit.response.status,
          })
        }
        if (!this.owns(active)) return this.canceled(active, commit.finalUrl)
      }
      this.release(active)
      return report
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
    const effectiveRenderMethod =
      renderMethod === "morph" && commit.classification === "success" ? "morph" : "replace"
    const beforeSnapshotCapture = (options as InternalDocumentLoadOptions)[
      DOCUMENT_BEFORE_SNAPSHOT_CAPTURE
    ]
    if (beforeSnapshotCapture && documentCachePolicy(this.session.tree).cacheable) {
      try {
        const result = beforeSnapshotCapture()
        if (result !== undefined) {
          void Promise.resolve(result).catch(() => undefined)
          throw new RequestError("Document before-cache callback must not return a value", {
            method: "GET",
            responseStatus: commit.response.status,
          })
        }
      } catch (error) {
        this.release(active)
        if (error instanceof ExpoTurboError) throw error
        throw new RequestError("Document before-cache callback failed", {
          method: "GET",
          responseStatus: commit.response.status,
        })
      }
      if (!this.owns(active)) return this.canceled(active, commit.finalUrl)
    }
    if (effectiveRenderMethod === "morph") {
      try {
        morphCurrentDocumentRoot(this.session.tree.clone(), commit.tree)
      } catch (error) {
        this.release(active)
        if (error instanceof ExpoTurboError) throw error
        throw new RequestError("Document refresh morph preflight failed", {
          method: "GET",
          responseStatus: commit.response.status,
        })
      }
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
    const refreshScroll = documentLoadRefreshScroll(options)
    if (refreshScroll === "reset" && commit.classification === "success") {
      prepareDocumentRefreshScroll(this.session)
    }
    this.release(active)
    try {
      if (effectiveRenderMethod === "morph") morphCurrentDocument(this.session, commit.tree)
      else this.session.replaceTree(commit.tree)
    } catch {
      suppressPreparedDocumentRefreshScroll(this.session)
      discardDocumentRefreshScroll(this.session, this.session.treeGeneration)
      throw new DocumentCommitError(report)
    }
    return report
  }

  private assertContentType(response: TurboResponse): void {
    const contentType = responseContentType(response)
    if (contentType !== EXPO_TURBO_MIME_TYPE) {
      throw markDocumentContentTypeError(
        new ContentTypeError(`Expected ${EXPO_TURBO_MIME_TYPE}`, {
          contentType: contentType ?? "missing",
        }),
      )
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

  private owns(active: ActiveDocumentOperation): boolean {
    return Boolean(
      this.active === active &&
        active.lease &&
        this.ownership.owns(active.lease) &&
        this.session.treeGeneration === active.treeGeneration,
    )
  }

  private release(active: ActiveDocumentOperation): void {
    if (active.lease) this.ownership.release(active.lease)
    if (this.active === active) this.active = undefined
  }
}
