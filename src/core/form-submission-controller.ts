import type {
  FetchAdapter,
  FormConfirmationAdapter,
  NavigationAdapter,
  VisitAction,
} from "../adapters"
import {
  type DestinationRequestLease,
  destinationRequestOwnership,
  type FrameRequestCheckpoint,
} from "./destination-request-ownership"
import type {
  DocumentHistory,
  DocumentHistoryEntry,
  DocumentHistoryProposal,
} from "./document-history"
import { documentCachePolicy, documentVisitControl } from "./document-metadata"
import {
  beginDocumentNavigation,
  currentDocumentNavigationEpoch,
} from "./document-navigation-epoch"
import {
  dispatchDocumentLoad,
  type PreparedDocumentRender,
  prepareDocumentRender,
} from "./document-render-lifecycle-internal"
import type { DocumentSnapshotCache } from "./document-snapshot-cache"
import {
  BeforeCacheEvent,
  BeforeVisitEvent,
  DOCUMENT_VISIT_LIFECYCLE_BEFORE_CACHE_DISPATCH,
  DOCUMENT_VISIT_LIFECYCLE_BEFORE_DISPATCH,
  DOCUMENT_VISIT_LIFECYCLE_VISIT_DISPATCH,
  type DocumentVisitLifecycle,
  documentVisitLifecycleOption,
  runBeforeDocumentRender,
  VisitEvent,
} from "./document-visit-lifecycle"
import {
  ExpoTurboError,
  type ExpoTurboErrorCode,
  FrameMissingError,
  RequestError,
  StateError,
  TargetError,
} from "./errors"
import type { FormRequestPlan, FormSubmissionMethod } from "./form-request"
import type {
  FormRequestExecutionReport,
  FormResponseCandidate,
  FormResponseClassification,
} from "./form-request-transport"
import {
  admitFormRequestPlan,
  executeAdmittedFormRequest,
  replaceAdmittedFormRequest,
} from "./form-request-transport"
import type {
  FormSubmissionActivityLease,
  FormSubmissionDuplicateBehavior,
  FormSubmissionTerminalFailureInput,
  FormSubmissionTerminalReportInput,
  FormSubmissionUnappliedReason,
} from "./form-submission-activity"
import {
  createFormSubmissionHandle,
  FORM_SUBMISSION_LIFECYCLE_END_DISPATCH,
  FORM_SUBMISSION_LIFECYCLE_START_DISPATCH,
  type FormSubmissionEndOutcome,
  type FormSubmissionHandle,
  type FormSubmissionLifecycle,
  finishFormSubmissionHandle,
  formSubmissionLifecycleOption,
  SubmitEndEvent,
  SubmitStartEvent,
} from "./form-submission-lifecycle"
import {
  assertActiveFormSubmissionProposal,
  type FormSubmissionProposal,
  type FormSubmissionProposalIdentity,
} from "./form-submission-proposal"
import { notifyMountedFrameAutofocus, recordFrameAutofocusReport } from "./frame-autofocus-internal"
import type { FrameControllerRegistry } from "./frame-controller-registry"
import {
  admitFrameFormHistoryResponse,
  assertFrameFormHistoryPlanCurrent,
  commitFrameFormHistoryPlan,
  type FrameFormHistoryPlan,
  finalizeFrameFormHistoryVisit,
  frameFormHistoryPlanCurrent,
  invalidateFrameFormHistoryCache,
  prepareFrameFormHistoryCommit,
  stageFrameFormHistoryResponse,
} from "./frame-history"
import { resolveMountedFrameHistory } from "./frame-history-internal"
import {
  createFrameMissingEvent,
  discardFrameMissingResponseBody,
  executeFrameMissingVisit,
  executeFrameVisitControlReload,
  FRAME_LIFECYCLE_MISSING_DISPATCH,
  type FrameLifecycle,
  type FrameMissingEvent,
  frameLifecycleOption,
} from "./frame-lifecycle"
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
  dispatchPreparedFrameResponseStreams,
  frameAutoscrollIntent,
  type PreparedFrameResponse,
  prepareFrameBeforeRender,
  prepareFrameMutation,
  prepareFrameResponseTree,
  renderPreparedFrameMutation,
} from "./frame-response-application"
import type { FormSubmissionDestination, FrameResponseReport } from "./frames"
import { type ParseLimits, parseExpoTurboDocument, parseTurboStreamFragment } from "./parser"
import {
  EXPO_TURBO_MIME_TYPE,
  resolveProtocolUrl,
  TURBO_STREAM_MIME_TYPE,
} from "./protocol-request"
import {
  type RequestLifecycle,
  requestLifecycleDefaultHandlingPrevented,
  requestLifecycleOption,
  settleRequestOperation,
} from "./request-lifecycle"
import type { DocumentSession } from "./session"
import { streamLifecycleOption } from "./stream-lifecycle"
import {
  dispatchEmbeddedTurboStreamElements,
  dispatchGuardedTurboStreamElements,
  type StreamActionDispatchOptions,
  type StreamDispatchReport,
  streamRenderSchedulerOption,
} from "./streams"
import { type DocumentTree, isElement, type ProtocolElement, type ProtocolNode } from "./tree"
import { classifyTopLevelLocation } from "./visitability"

export type FormSubmissionProposalFactory = (signal: AbortSignal) => FormSubmissionProposal

interface FormSubmissionRequestMetadata {
  readonly effectiveMethod: FormSubmissionMethod
  readonly requestId: string
  readonly requestedUrl: string
  readonly sourceMethod: FormSubmissionMethod
  readonly transportMethod: FormSubmissionMethod
}

interface FormSubmissionTransportResponseMetadata extends FormSubmissionRequestMetadata {
  readonly redirected: boolean
  /** Validated final transport URL; it does not necessarily become document/Frame state. */
  readonly responseUrl: string
  readonly responseStatus: number
}

interface FormSubmissionPreventedCandidate extends FormSubmissionRequestMetadata {
  readonly redirected: boolean
  readonly responseStatus: number
  readonly url: string
}

interface FormSubmissionResponseMetadata extends FormSubmissionTransportResponseMetadata {
  readonly classification: FormResponseClassification
}

type DocumentSubmissionDestination = Extract<FormSubmissionDestination, { kind: "document" }>
type FrameSubmissionDestination = Extract<FormSubmissionDestination, { kind: "frame" }>

interface DocumentFormHistoryPlan {
  readonly action?: "advance" | "replace"
  readonly base: DocumentHistoryEntry
  readonly history: DocumentHistory
  readonly navigationEpoch: number
}

export type FormSubmissionReport =
  | Readonly<
      FormSubmissionRequestMetadata & {
        destination: FormSubmissionDestination
        status: "canceled"
      }
    >
  | Readonly<
      FormSubmissionTransportResponseMetadata & {
        destination: FormSubmissionDestination
        status: "prevented"
      }
    >
  | Readonly<
      FormSubmissionResponseMetadata & {
        application: "empty"
        destination: FormSubmissionDestination
        status: "empty"
      }
    >
  | Readonly<
      Omit<FormSubmissionResponseMetadata, "classification"> & {
        action: Extract<VisitAction, "advance" | "replace">
        classification: "success"
        destination: DocumentSubmissionDestination
        reason: FormSubmissionUnappliedReason
        status: "unapplied"
      }
    >
  | Readonly<
      FormSubmissionResponseMetadata & {
        action: "advance"
        applicationDestination: FrameSubmissionDestination
        destination: FrameSubmissionDestination
        reason: "visit-control-reload"
        status: "promoted"
      }
    >
  | Readonly<
      FormSubmissionResponseMetadata & {
        application: "document"
        applicationDestination: DocumentSubmissionDestination
        destination: DocumentSubmissionDestination
        status: "applied"
        streams: StreamDispatchReport
      }
    >
  | Readonly<
      FormSubmissionResponseMetadata & {
        application: "frame"
        applicationDestination: FrameSubmissionDestination
        destination: FrameSubmissionDestination
        frame: FrameResponseReport
        status: "applied"
      }
    >
  | Readonly<
      FormSubmissionResponseMetadata & {
        application: "stream"
        destination: FormSubmissionDestination
        status: "applied"
        streams: StreamDispatchReport
      }
    >

type FormSubmissionCommitContext =
  | Readonly<{
      application: "document"
      applicationDestination: DocumentSubmissionDestination
      destination: DocumentSubmissionDestination
    }>
  | Readonly<{
      application: "frame"
      applicationDestination: FrameSubmissionDestination
      destination: FrameSubmissionDestination
    }>
  | Readonly<{ application: "stream"; destination: FormSubmissionDestination }>

export type FormSubmissionCommittedOutcome = Readonly<
  FormSubmissionResponseMetadata & FormSubmissionCommitContext & { status: "applied" }
>

export class FormSubmissionCommitError extends RequestError {
  readonly outcome: FormSubmissionCommittedOutcome

  constructor(candidate: FormResponseCandidate, context: FormSubmissionCommitContext) {
    super("Form response committed but session finalization failed", {
      method: candidate.transportMethod,
      responseStatus: candidate.responseStatus,
    })
    this.outcome = Object.freeze({
      ...responseMetadata(candidate),
      ...context,
      status: "applied",
    })
  }
}

export interface FormSubmissionControllerOptions extends StreamActionDispatchOptions {
  readonly confirmation?: FormConfirmationAdapter
  readonly frameControllers?: FrameControllerRegistry
  readonly frameLifecycle?: FrameLifecycle
  readonly history?: DocumentHistory
  readonly limits?: Partial<ParseLimits>
  readonly navigation?: NavigationAdapter
  readonly requestLifecycle?: RequestLifecycle
  readonly snapshotCache?: DocumentSnapshotCache
  readonly submissionLifecycle?: FormSubmissionLifecycle
  readonly visitLifecycle?: DocumentVisitLifecycle
}

export interface FormSubmissionControllerSubmitOptions {
  readonly duplicateBehavior?: FormSubmissionDuplicateBehavior
}

const TERMINAL_ERROR_MESSAGES: Readonly<Record<ExpoTurboErrorCode, string>> = Object.freeze({
  action: "Form response Stream action failed",
  auth: "Form submission authorization failed",
  content_type: "Form response content type is unsupported",
  disposal: "Form response cleanup failed",
  frame_missing: "Form response is missing the required Frame",
  parse: "Form response XML is invalid",
  props: "Form response component properties are invalid",
  registry: "Form response component registration failed",
  request: "Form submission request failed",
  state: "Form submission state is invalid",
  subscription: "Form response subscription failed",
  target: "Form response target is invalid",
})

const TERMINAL_ERROR_NAMES: Readonly<Record<ExpoTurboErrorCode, string>> = Object.freeze({
  action: "ActionError",
  auth: "AuthError",
  content_type: "ContentTypeError",
  disposal: "DisposalError",
  frame_missing: "FrameMissingError",
  parse: "ParseError",
  props: "PropsError",
  registry: "RegistryError",
  request: "RequestError",
  state: "StateError",
  subscription: "SubscriptionError",
  target: "TargetError",
})

function terminalLocation(
  location: ExpoTurboError["context"]["location"],
): Readonly<{ column?: number; line?: number; offset?: number }> | undefined {
  if (!location) return undefined
  const column =
    Number.isSafeInteger(location.column) && (location.column as number) >= 0
      ? location.column
      : undefined
  const line =
    Number.isSafeInteger(location.line) && (location.line as number) >= 0
      ? location.line
      : undefined
  const offset =
    Number.isSafeInteger(location.offset) && (location.offset as number) >= 0
      ? location.offset
      : undefined
  if (column === undefined && line === undefined && offset === undefined) return undefined
  return Object.freeze({
    ...(column !== undefined ? { column } : {}),
    ...(line !== undefined ? { line } : {}),
    ...(offset !== undefined ? { offset } : {}),
  })
}

function duplicateBehavior(
  options: FormSubmissionControllerSubmitOptions,
): FormSubmissionDuplicateBehavior {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new RequestError("Form submission controller options must be an object")
  }
  const behavior = options.duplicateBehavior ?? "prevent"
  if (behavior !== "prevent" && behavior !== "supersede") {
    throw new RequestError("Form submission duplicate behavior is unsupported")
  }
  return behavior
}

function responseMetadata(candidate: FormResponseCandidate): FormSubmissionResponseMetadata {
  return {
    classification: candidate.classification,
    effectiveMethod: candidate.effectiveMethod,
    redirected: candidate.redirected,
    requestId: candidate.requestId,
    requestedUrl: candidate.requestedUrl,
    responseUrl: candidate.url,
    responseStatus: candidate.responseStatus,
    sourceMethod: candidate.sourceMethod,
    transportMethod: candidate.transportMethod,
  }
}

function embeddedStreams(tree: DocumentTree): ProtocolElement[] {
  const streams: ProtocolElement[] = []
  const visit = (node: ProtocolNode) => {
    if (!isElement(node)) return
    if (node.kind === "stream") {
      streams.push(node)
      return
    }
    if (node.kind === "template") return
    for (const child of node.children) visit(child)
  }
  for (const child of tree.document.children) visit(child)
  return streams
}

/**
 * Owns the complete native form path: one fetch, exact destination admission,
 * response disposition, and staged synchronous application guarded by that lease.
 */
export class FormSubmissionController {
  private readonly options: FormSubmissionControllerOptions
  private readonly ownership: ReturnType<typeof destinationRequestOwnership>

  constructor(
    private readonly session: DocumentSession,
    private readonly fetchAdapter: FetchAdapter,
    options: FormSubmissionControllerOptions = {},
  ) {
    const requestLifecycle = requestLifecycleOption(options, "Form submission controller")
    const frameLifecycle = frameLifecycleOption(options, "Form submission controller")
    const submissionLifecycle = formSubmissionLifecycleOption(options, "Form submission controller")
    const streamLifecycle = streamLifecycleOption(options, "Form submission controller")
    const streamRenderScheduler = streamRenderSchedulerOption(options, "Form submission controller")
    const visitLifecycle = documentVisitLifecycleOption(options, "Form submission controller")
    const navigation = options.navigation
    this.options = Object.freeze({
      ...(options.confirmation ? { confirmation: options.confirmation } : {}),
      ...(options.customActions ? { customActions: options.customActions } : {}),
      ...(options.frameControllers ? { frameControllers: options.frameControllers } : {}),
      ...(frameLifecycle ? { frameLifecycle } : {}),
      ...(options.history ? { history: options.history } : {}),
      ...(options.limits ? { limits: Object.freeze({ ...options.limits }) } : {}),
      ...(navigation ? { navigation } : {}),
      ...(options.onActionError ? { onActionError: options.onActionError } : {}),
      ...(options.refresh ? { refresh: options.refresh } : {}),
      ...(requestLifecycle ? { requestLifecycle } : {}),
      ...(options.snapshotCache ? { snapshotCache: options.snapshotCache } : {}),
      ...(submissionLifecycle ? { submissionLifecycle } : {}),
      ...(streamLifecycle ? { streamLifecycle } : {}),
      ...(streamRenderScheduler ? { streamRenderScheduler } : {}),
      ...(visitLifecycle ? { visitLifecycle } : {}),
    })
    this.ownership = destinationRequestOwnership(session)
  }

  async submit(
    createProposal: FormSubmissionProposalFactory,
    options: FormSubmissionControllerSubmitOptions = {},
  ): Promise<FormSubmissionReport> {
    if (typeof createProposal !== "function") {
      throw new RequestError("Form submission controller requires a proposal factory")
    }
    const behavior = duplicateBehavior(options)

    const controller = new AbortController()
    let proposal: FormSubmissionProposal
    let identity: FormSubmissionProposalIdentity
    let plan: FormRequestPlan
    try {
      proposal = createProposal(controller.signal)
      identity = assertActiveFormSubmissionProposal(this.session, proposal)
      plan = admitFormRequestPlan(proposal.plan, controller.signal)
      identity = assertActiveFormSubmissionProposal(this.session, proposal)
      if (identity.requiresSafeTransport && plan.request.method !== "GET") {
        throw new RequestError("A safely retryable form submission must remain a GET request", {
          method: plan.request.method,
        })
      }
    } catch (error) {
      controller.abort()
      if (error instanceof ExpoTurboError) throw error
      throw new RequestError("Form submission planning failed")
    }

    let historyPlan: DocumentFormHistoryPlan | undefined
    let frameHistoryPlan: FrameFormHistoryPlan | undefined
    try {
      if (proposal.destination.kind === "document") {
        historyPlan = this.prepareDocumentHistory(identity)
      }
    } catch (error) {
      controller.abort()
      if (error instanceof ExpoTurboError) throw error
      throw new RequestError("Form submission history admission failed")
    }

    const confirmationMessage = identity.confirmationMessage
    const confirmation = confirmationMessage !== undefined ? this.options.confirmation : undefined
    if (
      confirmationMessage !== undefined &&
      (!confirmation || typeof confirmation.confirm !== "function")
    ) {
      controller.abort()
      throw new RequestError("Form submission confirmation requires a configured adapter", {
        target: identity.form.key,
      })
    }

    let activityLease: FormSubmissionActivityLease | undefined
    try {
      activityLease = identity.submissionActivity.admit(
        controller,
        plan.request.headers["X-Turbo-Request-Id"] as string,
        identity.submitter,
        behavior,
        confirmationMessage !== undefined,
      )
    } catch (error) {
      controller.abort()
      if (error instanceof ExpoTurboError) throw error
      throw new RequestError("Form submission activity admission failed")
    }
    if (!activityLease) return this.canceledPlan(plan, proposal.destination)
    const submissionActivity = identity.submissionActivity
    let fetchInvoked = false
    let lifecycleHandle: FormSubmissionHandle | undefined
    let requestFinished = false
    const finishRequest = (outcome?: FormSubmissionEndOutcome): void => {
      if (requestFinished) return
      requestFinished = true
      submissionActivity.finish(activityLease)
      if (!lifecycleHandle || !this.options.submissionLifecycle) return

      finishFormSubmissionHandle(lifecycleHandle)
      this.options.submissionLifecycle[FORM_SUBMISSION_LIFECYCLE_END_DISPATCH](
        new SubmitEndEvent(lifecycleHandle, outcome),
      )
    }
    const settle = (report: FormSubmissionReport): FormSubmissionReport => {
      submissionActivity.settleReport(activityLease, this.terminalReport(report))
      return report
    }
    let frameRender: PreparedFrameRender | undefined
    let frameRendered = false
    let frameLifecycleDispatched = false

    try {
      if (confirmation && confirmationMessage !== undefined) {
        try {
          const accepted = await this.confirm(
            confirmation,
            confirmationMessage,
            controller,
            identity,
            activityLease,
          )
          if (accepted !== true) {
            controller.abort()
            identity.submissionActivity.finish(activityLease)
            return settle(this.canceledPlan(plan, proposal.destination))
          }
          identity = assertActiveFormSubmissionProposal(this.session, proposal)
          if (frameHistoryPlan)
            this.assertFrameHistory(frameHistoryPlan, identity, plan.request.url)
        } catch (error) {
          controller.abort()
          identity.submissionActivity.finish(activityLease)
          if (error instanceof ExpoTurboError) throw error
          throw new RequestError("Form submission confirmation failed", {
            target: identity.form.key,
          })
        }
      }

      let lease: DestinationRequestLease | undefined
      let originCheckpoint: FrameRequestCheckpoint | undefined
      try {
        if (proposal.destination.kind === "frame") {
          if (
            !identity.destinationFrame ||
            identity.destinationFrameId !== proposal.destination.frameId
          ) {
            throw new StateError("Form submission proposal has no exact destination Frame", {
              frameId: proposal.destination.frameId,
            })
          }
          if (frameHistoryPlan)
            this.assertFrameHistory(frameHistoryPlan, identity, plan.request.url)
          if (identity.originFrame && identity.originFrameId !== proposal.destination.frameId) {
            originCheckpoint = this.ownership.checkpointFrame(identity.originFrame)
          }
          lease = this.ownership.claimFrame(identity.destinationFrame, controller, identity.form)
        } else {
          if (historyPlan) this.assertDocumentHistory(historyPlan)
          lease = this.ownership.claimDocument(controller, identity.treeGeneration, identity.form)
        }
        // A displaced request's abort listener may synchronously mutate the tree
        // or submit newer work. Re-admit the exact proposal before any fetch.
        if (this.ownership.owns(lease)) {
          assertActiveFormSubmissionProposal(this.session, proposal)
          if (historyPlan) this.assertDocumentHistory(historyPlan)
          if (frameHistoryPlan)
            this.assertFrameHistory(frameHistoryPlan, identity, plan.request.url)
        }
      } catch (error) {
        if (lease) this.ownership.cancel(lease)
        else controller.abort()
        identity.submissionActivity.finish(activityLease)
        if (error instanceof ExpoTurboError) throw error
        throw new RequestError("Form submission ownership admission failed")
      }
      if (!lease) throw new RequestError("Form submission ownership admission failed")
      let activeLease = lease

      try {
        if (historyPlan) this.assertDocumentHistory(historyPlan)
        if (frameHistoryPlan) this.assertFrameHistory(frameHistoryPlan, identity, plan.request.url)
      } catch (error) {
        this.ownership.cancel(activeLease)
        if (error instanceof ExpoTurboError) throw error
        throw new RequestError("Form submission history changed before transport")
      }
      let response: FormRequestExecutionReport | undefined
      let admittedTransportResponse:
        | Readonly<{ redirected: boolean; responseStatus: number }>
        | undefined
      let transportFailure: unknown
      try {
        response = await executeAdmittedFormRequest(this.fetchAdapter, plan, {
          beforeRequest: (request) => {
            if (!this.isCurrent(activeLease, proposal)) return false
            plan = replaceAdmittedFormRequest(plan, request)
            identity = assertActiveFormSubmissionProposal(this.session, proposal)
            if (identity.requiresSafeTransport && request.method !== "GET") {
              throw new RequestError(
                "A safely retryable form submission must remain a GET request",
                { method: request.method },
              )
            }
            if (proposal.destination.kind === "frame" && identity.visitAction) {
              frameHistoryPlan = this.prepareFrameHistory(identity, request.url)
            }
            if (historyPlan) this.assertDocumentHistory(historyPlan)
            if (frameHistoryPlan) this.assertFrameHistory(frameHistoryPlan, identity, request.url)
            if (historyPlan) {
              const navigationEpoch = beginDocumentNavigation(this.session)
              historyPlan = Object.freeze({ ...historyPlan, navigationEpoch })
            } else if (proposal.destination.kind === "document") {
              beginDocumentNavigation(this.session)
            }
            if (!this.isCurrent(activeLease, proposal)) return false
            if (
              !identity.submissionActivity.start(activityLease) ||
              !this.isCurrent(activeLease, proposal)
            ) {
              return false
            }
            if (historyPlan) this.assertDocumentHistory(historyPlan)
            if (frameHistoryPlan) this.assertFrameHistory(frameHistoryPlan, identity, request.url)
            if (!this.isCurrent(activeLease, proposal)) return false
            if (this.options.submissionLifecycle) {
              lifecycleHandle = createFormSubmissionHandle({
                controller,
                destination: proposal.destination,
                formNodeKey: identity.form.key,
                requestId: plan.request.headers["X-Turbo-Request-Id"] as string,
                stop: () => {
                  controller.signal.removeEventListener("abort", activityLease.abortListener)
                  controller.abort()
                },
                ...(identity.submitter ? { submitterNodeKey: identity.submitter.key } : {}),
              })
              this.options.submissionLifecycle[FORM_SUBMISSION_LIFECYCLE_START_DISPATCH](
                new SubmitStartEvent(lifecycleHandle),
              )
            }
            if (!this.isCurrent(activeLease, proposal)) return false
            fetchInvoked = true
            this.session.recentRequestIds.add(plan.request.headers["X-Turbo-Request-Id"] as string)
            return this.isCurrent(activeLease, proposal)
          },
          beforeResponseBody: (admittedResponse) => {
            admittedTransportResponse = Object.freeze({
              redirected: admittedResponse.redirected,
              responseStatus: admittedResponse.responseStatus,
            })
            finishRequest(this.submissionLifecycleOutcome(undefined, admittedTransportResponse))
            if (proposal.destination.kind !== "frame" || !this.isCurrent(activeLease, proposal)) {
              return undefined
            }
            const invalidatesCache =
              admittedResponse.contentType !== TURBO_STREAM_MIME_TYPE &&
              (admittedResponse.classification !== "success" ||
                admittedResponse.transportMethod !== "GET")
            if (frameHistoryPlan) {
              const destinationFrame = identity.destinationFrame
              if (
                !destinationFrame ||
                !frameFormHistoryPlanCurrent(
                  frameHistoryPlan,
                  this.session,
                  destinationFrame,
                  plan.request.url,
                )
              ) {
                controller.abort()
                return undefined
              }
              if (
                admittedResponse.classification === "success" &&
                admittedResponse.responseStatus !== 204 &&
                admittedResponse.contentType === EXPO_TURBO_MIME_TYPE
              ) {
                try {
                  stageFrameFormHistoryResponse(
                    frameHistoryPlan,
                    this.session,
                    destinationFrame,
                    plan.request.url,
                    admittedResponse.url,
                    {
                      invalidateCache: invalidatesCache,
                      publishSource: admittedResponse.responseStatus !== 201,
                    },
                  )
                } finally {
                  if (invalidatesCache) this.options.snapshotCache?.clear()
                }
                return undefined
              }
              if (invalidatesCache) invalidateFrameFormHistoryCache(frameHistoryPlan)
            }
            if (invalidatesCache) this.options.snapshotCache?.clear()
            return undefined
          },
          controller,
          owns: () => this.ownership.owns(activeLease),
          release: () => this.ownership.release(activeLease),
          retainCandidate: true,
          ...(this.options.requestLifecycle
            ? {
                requestContext: {
                  formNodeKey: identity.form.key,
                  kind: "form" as const,
                  requestId: plan.request.headers["X-Turbo-Request-Id"] as string,
                },
                requestLifecycle: this.options.requestLifecycle,
              }
            : {}),
        })
      } catch (error) {
        transportFailure = error
        throw error
      } finally {
        // A received response finishes the request before body buffering; this
        // fallback settles only prevented responses, pre-response failure, or abort.
        finishRequest(
          this.submissionLifecycleOutcome(
            response,
            admittedTransportResponse,
            plan,
            controller.signal.aborted,
            transportFailure,
          ),
        )
      }
      if (!response) throw new StateError("Form submission transport produced no result")
      if (response.status === "canceled") {
        return settle(this.canceled(response, proposal.destination))
      }
      if (response.status === "prevented") {
        if (response.transportMethod !== "GET") {
          if (frameHistoryPlan) invalidateFrameFormHistoryCache(frameHistoryPlan)
          this.options.snapshotCache?.clear()
        }
        return settle(this.prevented(response, proposal.destination))
      }

      let missingEvent: FrameMissingEvent | undefined
      let documentRender: PreparedDocumentRender | undefined
      let documentRendered = false
      let visitControlReload:
        | Readonly<{
            body: string
            frameId: string
            response: Readonly<{ redirected: boolean; status: number; url: string }>
          }>
        | undefined
      let application: FormSubmissionReport
      try {
        if (!this.isCurrent(activeLease, proposal)) {
          return settle(this.canceled(response, proposal.destination))
        }
        if (
          frameHistoryPlan &&
          response.status === "xml" &&
          response.classification === "success" &&
          proposal.destination.kind === "frame"
        ) {
          const destinationFrame = identity.destinationFrame
          if (
            !destinationFrame ||
            !frameFormHistoryPlanCurrent(
              frameHistoryPlan,
              this.session,
              destinationFrame,
              plan.request.url,
            )
          ) {
            return settle(this.canceled(response, proposal.destination))
          }
          admitFrameFormHistoryResponse(
            frameHistoryPlan,
            this.session,
            destinationFrame,
            plan.request.url,
            response.url,
          )
          if (!this.isCurrent(activeLease, proposal)) {
            return settle(this.canceled(response, proposal.destination))
          }
        }
        let preparedFrame: PreparedFrameResponse | undefined
        let pendingMissingError: FrameMissingError | undefined
        let pendingMissingEvent: FrameMissingEvent | undefined
        let pendingVisitControlReload: typeof visitControlReload
        if (response.status === "xml" && proposal.destination.kind === "frame") {
          const frameId =
            response.classification === "success"
              ? proposal.destination.frameId
              : (identity.originFrameId ?? proposal.destination.frameId)
          const document = parseExpoTurboDocument(response.body, {
            ...(this.options.limits ? { limits: this.options.limits } : {}),
            url: response.url,
          })
          if (documentVisitControl(document) === "reload") {
            pendingVisitControlReload = Object.freeze({
              body: response.body,
              frameId,
              response: {
                redirected: response.redirected,
                status: response.responseStatus,
                url: response.url,
              },
            })
          } else {
            try {
              preparedFrame = prepareFrameResponseTree(frameId, document)
            } catch (error) {
              const lifecycle = this.options.frameLifecycle
              if (!(error instanceof FrameMissingError) || !lifecycle) throw error
              pendingMissingError = error
              pendingMissingEvent = createFrameMissingEvent({
                body: response.body,
                frameId,
                response: {
                  redirected: response.redirected,
                  status: response.responseStatus,
                  url: response.url,
                },
              })
            }
          }
        }
        if (
          (preparedFrame || pendingMissingEvent || pendingVisitControlReload) &&
          response.classification !== "success" &&
          proposal.destination.kind === "frame" &&
          identity.originFrame &&
          identity.originFrameId &&
          identity.originFrameId !== proposal.destination.frameId
        ) {
          if (!originCheckpoint) {
            throw new StateError("Form submission proposal has no origin Frame checkpoint", {
              frameId: identity.originFrameId,
            })
          }
          const transferred = this.ownership.transferFrame(activeLease, originCheckpoint)
          if (!transferred) return settle(this.canceled(response, proposal.destination))
          activeLease = transferred
          if (!this.isCurrent(activeLease, proposal)) {
            return settle(this.canceled(response, proposal.destination))
          }
        }
        if (pendingVisitControlReload) {
          if (!this.isCurrent(activeLease, proposal)) {
            return settle(this.canceled(response, proposal.destination))
          }
          if (
            frameHistoryPlan &&
            response.classification === "success" &&
            proposal.destination.kind === "frame"
          ) {
            const destinationFrame = identity.destinationFrame
            if (
              !destinationFrame ||
              !frameFormHistoryPlanCurrent(
                frameHistoryPlan,
                this.session,
                destinationFrame,
                plan.request.url,
              )
            ) {
              return settle(this.canceled(response, proposal.destination))
            }
          }
          const activeFrame =
            pendingVisitControlReload.frameId === identity.originFrameId
              ? identity.originFrame
              : identity.destinationFrame
          if (!activeFrame) {
            throw new StateError("Form submission proposal has no exact promotion Frame", {
              frameId: pendingVisitControlReload.frameId,
            })
          }
          if (response.redirected || response.classification === "success") {
            this.session.setAttribute(activeFrame.key, "src", response.url)
            if (!this.isCurrent(activeLease, proposal)) {
              return settle(this.canceled(response, proposal.destination))
            }
          }
          visitControlReload = pendingVisitControlReload
        }
        if (pendingMissingEvent) {
          const lifecycle = this.options.frameLifecycle
          if (!lifecycle || !pendingMissingError) {
            discardFrameMissingResponseBody(pendingMissingEvent)
            throw new StateError("Frame-missing response has no lifecycle state")
          }
          try {
            lifecycle[FRAME_LIFECYCLE_MISSING_DISPATCH](pendingMissingEvent)
          } catch (error) {
            discardFrameMissingResponseBody(pendingMissingEvent)
            throw error
          }
          if (!this.isCurrent(activeLease, proposal)) {
            discardFrameMissingResponseBody(pendingMissingEvent)
            return settle(this.canceled(response, proposal.destination))
          }
          if (
            frameHistoryPlan &&
            response.classification === "success" &&
            proposal.destination.kind === "frame"
          ) {
            const destinationFrame = identity.destinationFrame
            if (
              !destinationFrame ||
              !frameFormHistoryPlanCurrent(
                frameHistoryPlan,
                this.session,
                destinationFrame,
                plan.request.url,
              )
            ) {
              discardFrameMissingResponseBody(pendingMissingEvent)
              return settle(this.canceled(response, proposal.destination))
            }
          }
          if (!pendingMissingEvent.defaultPrevented) {
            discardFrameMissingResponseBody(pendingMissingEvent)
            throw pendingMissingError
          }
          missingEvent = pendingMissingEvent
        }
        application = visitControlReload
          ? this.promoted(response, proposal.destination, visitControlReload.frameId)
          : missingEvent
            ? this.prevented(response, proposal.destination)
            : await this.apply(
                response,
                proposal,
                identity,
                activeLease,
                preparedFrame,
                historyPlan,
                frameHistoryPlan,
                (prepared) => {
                  documentRender = prepared
                },
                (prepared) => {
                  frameRender = prepared
                },
              )
      } finally {
        // Exact release cannot detach newer reentrant work that superseded this lease.
        this.ownership.release(activeLease)
        if (documentRender) {
          documentRender.seal()
          if (this.session.treeGeneration !== documentRender.commit.generation) {
            documentRender.cancel()
          }
          documentRendered = (await documentRender.rendered) === "rendered"
        }
        if (frameRender) {
          frameRender.seal()
          frameRendered = (await frameRender.rendered) === "rendered"
        }
      }
      if (missingEvent && this.options.frameLifecycle) {
        await executeFrameMissingVisit(this.options.frameLifecycle, missingEvent)
      }
      if (visitControlReload) {
        await executeFrameVisitControlReload(this.options.frameLifecycle, visitControlReload)
        return settle(application)
      }
      if (
        documentRendered &&
        documentRender &&
        response.classification === "success" &&
        this.session.treeGeneration === documentRender.commit.generation &&
        this.options.visitLifecycle
      ) {
        dispatchDocumentLoad(this.options.visitLifecycle, documentRender.commit)
      }
      if (
        frameRendered &&
        frameRender &&
        application.status === "applied" &&
        application.application === "frame" &&
        this.options.frameLifecycle
      ) {
        if (dispatchFrameRender(this.options.frameLifecycle, frameRender)) {
          frameLifecycleDispatched = true
          dispatchFrameLoad(this.options.frameLifecycle, frameRender)
        }
      }
      if (
        frameHistoryPlan &&
        response.status === "xml" &&
        response.classification === "success" &&
        application.status === "applied" &&
        application.application === "frame"
      ) {
        try {
          await finalizeFrameFormHistoryVisit(
            frameHistoryPlan,
            // The response lease is deliberately released before renderer acknowledgement.
            // The committed plan retains the exact navigation, mount, and Frame checkpoint guards.
            () => true,
            activeLease.controller.signal,
          )
        } catch {
          throw new FormSubmissionCommitError(response, {
            application: "frame",
            applicationDestination: application.applicationDestination,
            destination: application.destination,
          })
        }
      }
      return settle(application)
    } catch (error) {
      controller.abort()
      const reported =
        error instanceof ExpoTurboError
          ? error
          : new RequestError("Form submission failed", { method: plan.request.method })
      if (requestLifecycleDefaultHandlingPrevented(error)) {
        submissionActivity.settleSuppressedFailure(activityLease)
      } else {
        submissionActivity.settleFailure(
          activityLease,
          this.terminalFailure(reported, plan, fetchInvoked),
          identity.requiresSafeTransport || (fetchInvoked && plan.request.method === "GET"),
        )
        if (
          error instanceof FormSubmissionCommitError &&
          error.outcome.application === "frame" &&
          !frameLifecycleDispatched &&
          frameRendered &&
          frameRender &&
          this.options.frameLifecycle
        ) {
          if (dispatchFrameRender(this.options.frameLifecycle, frameRender)) {
            dispatchFrameLoad(this.options.frameLifecycle, frameRender)
          }
        }
      }
      throw reported
    }
  }

  private submissionLifecycleOutcome(
    response: FormRequestExecutionReport | undefined,
    admittedResponse: Readonly<{ redirected: boolean; responseStatus: number }> | undefined,
    plan?: FormRequestPlan,
    aborted = false,
    failure?: unknown,
  ): FormSubmissionEndOutcome | undefined {
    const transportResponse =
      admittedResponse ?? (response?.status !== "canceled" ? response : undefined)
    if (transportResponse) {
      return Object.freeze({
        fetchResponse: Object.freeze({
          redirected: transportResponse.redirected,
          status: transportResponse.responseStatus,
        }),
        success: transportResponse.responseStatus >= 200 && transportResponse.responseStatus < 300,
      })
    }
    if (failure && requestLifecycleDefaultHandlingPrevented(failure)) return undefined
    if (response?.status === "canceled" || (!response && aborted)) return undefined
    return Object.freeze({
      error: new RequestError("Form submission request failed", {
        ...(plan ? { method: plan.request.method } : {}),
      }),
      success: false,
    })
  }

  private terminalFailure(
    error: ExpoTurboError,
    plan: FormRequestPlan,
    fetchInvoked: boolean,
  ): FormSubmissionTerminalFailureInput {
    const location = terminalLocation(error.context.location)
    const responseStatus =
      Number.isSafeInteger(error.context.responseStatus) &&
      (error.context.responseStatus as number) >= 100 &&
      (error.context.responseStatus as number) <= 599
        ? error.context.responseStatus
        : undefined
    const committed = error instanceof FormSubmissionCommitError
    const terminalError = Object.freeze({
      code: error.code,
      context: Object.freeze({
        ...(location ? { location } : {}),
        ...(responseStatus !== undefined ? { responseStatus } : {}),
      }),
      message: committed
        ? "Form submission committed but finalization failed"
        : TERMINAL_ERROR_MESSAGES[error.code],
      name: committed ? "FormSubmissionCommitError" : TERMINAL_ERROR_NAMES[error.code],
    })
    if (committed) {
      return Object.freeze({
        application: error.outcome.application,
        classification: error.outcome.classification,
        effectiveMethod: error.outcome.effectiveMethod,
        error: terminalError,
        requestId: error.outcome.requestId,
        responseStatus: error.outcome.responseStatus,
        retryDisposition: "committed",
        status: "committed-error",
      })
    }
    return Object.freeze({
      effectiveMethod: plan.effectiveMethod,
      error: terminalError,
      requestId: plan.request.headers["X-Turbo-Request-Id"] as string,
      retryDisposition: !fetchInvoked || plan.request.method === "GET" ? "safe" : "unsafe",
      status: "failed",
    })
  }

  private terminalReport(report: FormSubmissionReport): FormSubmissionTerminalReportInput {
    if (report.status === "canceled" || report.status === "prevented") {
      return Object.freeze({
        effectiveMethod: report.effectiveMethod,
        requestId: report.requestId,
        status: "canceled",
      })
    }
    if (report.status === "unapplied" || report.status === "promoted") {
      return Object.freeze({
        classification: report.classification,
        effectiveMethod: report.effectiveMethod,
        reason: report.reason,
        requestId: report.requestId,
        responseStatus: report.responseStatus,
        status: "unapplied",
      })
    }
    if (report.status === "empty") {
      return Object.freeze({
        classification: report.classification,
        effectiveMethod: report.effectiveMethod,
        requestId: report.requestId,
        responseStatus: report.responseStatus,
        status: "empty",
      })
    }
    return Object.freeze({
      application: report.application,
      classification: report.classification,
      effectiveMethod: report.effectiveMethod,
      requestId: report.requestId,
      responseStatus: report.responseStatus,
      status: "applied",
    })
  }

  private async apply(
    candidate: FormResponseCandidate,
    proposal: FormSubmissionProposal,
    identity: FormSubmissionProposalIdentity,
    lease: DestinationRequestLease,
    preparedFrame?: PreparedFrameResponse,
    historyPlan?: DocumentFormHistoryPlan,
    frameHistoryPlan?: FrameFormHistoryPlan,
    onDocumentRender?: (prepared: PreparedDocumentRender) => void,
    onFrameRender?: (prepared: PreparedFrameRender) => void,
  ): Promise<FormSubmissionReport> {
    const destination = proposal.destination
    const metadata = responseMetadata(candidate)
    if (candidate.status === "empty") {
      if (candidate.redirected && destination.kind === "frame") {
        const activeFrame = identity.destinationFrame
        if (!activeFrame) {
          throw new StateError("Form submission proposal has no exact destination Frame", {
            frameId: destination.frameId,
          })
        }
        const revision = this.session.revision
        try {
          this.session.setAttribute(activeFrame.key, "src", candidate.url)
          return Object.freeze({
            ...metadata,
            application: "frame",
            applicationDestination: destination,
            destination,
            frame: Object.freeze({
              finalUrl: candidate.url,
              frameId: destination.frameId,
              streams: Object.freeze({ actions: Object.freeze([]), interrupted: false }),
            }),
            status: "applied",
          })
        } catch (error) {
          throw this.applicationError(
            candidate,
            { application: "frame", applicationDestination: destination, destination },
            revision,
            error,
          )
        }
      }
      return Object.freeze({ ...metadata, application: "empty", destination, status: "empty" })
    }

    if (candidate.status === "stream") {
      const fragment = parseTurboStreamFragment(candidate.body, {
        ...(this.options.limits ? { limits: this.options.limits } : {}),
      })
      const streams = fragment.document.children.filter(
        (node): node is ProtocolElement => isElement(node) && node.kind === "stream",
      )
      if (!this.isCurrent(lease, proposal)) return this.canceled(candidate, destination)
      const revision = this.session.revision
      try {
        const report = await dispatchGuardedTurboStreamElements(
          this.session,
          streams,
          this.options,
          {
            shouldContinue: () => this.ownership.retains(lease),
          },
        )
        return Object.freeze({
          ...metadata,
          application: "stream",
          destination,
          status: "applied",
          streams: report,
        })
      } catch (error) {
        throw this.applicationError(
          candidate,
          { application: "stream", destination },
          revision,
          error,
        )
      }
    }

    if (destination.kind === "frame") {
      if (!preparedFrame) throw new StateError("Form submission Frame response was not prepared")
      const frameId = preparedFrame.frameId
      const applicationDestination: FrameSubmissionDestination =
        frameId === destination.frameId ? destination : Object.freeze({ frameId, kind: "frame" })
      if (!this.isCurrent(lease, proposal)) return this.canceled(candidate, destination)
      const activeFrame =
        frameId === identity.originFrameId ? identity.originFrame : identity.destinationFrame
      if (!activeFrame) {
        throw new StateError("Form submission proposal has no exact destination Frame", {
          frameId,
        })
      }
      const revision = this.session.revision
      const promotedHistory = candidate.classification === "success" ? frameHistoryPlan : undefined
      let historyCommitted = false
      try {
        const finalUrl =
          candidate.classification === "success" || candidate.redirected ? candidate.url : undefined
        const mutation = prepareFrameMutation(this.session, activeFrame, preparedFrame, {
          ...(promotedHistory ? { documentUrl: candidate.url } : {}),
          ...(finalUrl ? { finalUrl } : {}),
        })
        if (promotedHistory || this.options.frameLifecycle) {
          const acquired = this.ownership.commitFrame(lease, () => {
            const beforeFrameRenderer = prepareFrameBeforeRender(
              this.options.frameLifecycle,
              preparedFrame,
              candidate.url,
            )
            renderPreparedFrameMutation(preparedFrame, beforeFrameRenderer)
            assertPreparedFrameMutationCurrent(this.session, mutation)
            if (promotedHistory) {
              this.assertFrameHistory(promotedHistory, identity, candidate.requestedUrl)
              commitFrameFormHistoryPlan(
                promotedHistory,
                this.session,
                activeFrame,
                candidate.requestedUrl,
                candidate.url,
                revision,
              )
              historyCommitted = true
            }
          })
          if (!acquired) return this.canceled(candidate, destination)
          if (!this.isCurrent(lease, proposal)) return this.canceled(candidate, destination)
        }
        if (onFrameRender && this.options.frameLifecycle) {
          const checkpoint = this.ownership.checkpointFrame(activeFrame)
          onFrameRender?.(
            prepareFrameRender(this.session, {
              frame: activeFrame,
              frameId,
              ownerIsCurrent: () => this.ownership.frameCheckpointCurrent(checkpoint),
              url: candidate.url,
            }),
          )
        }
        commitPreparedFrameMutation(this.session, mutation)
        const streams = await dispatchPreparedFrameResponseStreams(
          this.session,
          preparedFrame,
          this.options,
          {
            shouldContinue: () => this.ownership.retains(lease),
          },
        )
        const frame: FrameResponseReport = recordFrameAutofocusReport(
          Object.freeze({
            ...(finalUrl ? { finalUrl } : {}),
            frameId,
            streams,
          }),
          this.session,
          activeFrame,
          activeFrameAutofocusCandidates(this.session, activeFrame),
          frameAutoscrollIntent(this.session, activeFrame, preparedFrame),
        )
        if (this.ownership.retains(lease) && this.options.frameControllers) {
          notifyMountedFrameAutofocus(this.options.frameControllers, frame)
        }
        return Object.freeze({
          ...metadata,
          application: "frame",
          applicationDestination,
          destination,
          frame,
          status: "applied",
        })
      } catch (error) {
        throw this.applicationError(
          candidate,
          { application: "frame", applicationDestination, destination },
          revision,
          error,
          historyCommitted,
        )
      }
    }

    if (
      candidate.transportMethod !== "GET" &&
      candidate.responseStatus === 200 &&
      !candidate.redirected
    ) {
      throw new RequestError("Unsafe document form responses must redirect", {
        method: candidate.transportMethod,
        responseStatus: candidate.responseStatus,
      })
    }

    if (candidate.classification === "success" && candidate.transportMethod !== "GET") {
      this.options.snapshotCache?.clear()
    }

    if (candidate.classification === "success") {
      const action = this.documentVisitAction(candidate, identity)
      if (this.options.visitLifecycle) {
        const beforeVisit = this.options.visitLifecycle[DOCUMENT_VISIT_LIFECYCLE_BEFORE_DISPATCH](
          new BeforeVisitEvent(candidate.url),
        )
        if (beforeVisit.defaultPrevented) {
          return this.unapplied(candidate, destination, action, "visit-prevented")
        }
        if (!this.isCurrent(lease, proposal)) {
          return this.unapplied(candidate, destination, action, "superseded")
        }
      }
      const disposition = classifyTopLevelLocation(this.session.tree, candidate.url)
      if (disposition.classification !== "visitable") {
        if (disposition.classification === "external") {
          throw new StateError("Form response location escaped same-origin transport")
        }
        const navigation = this.options.navigation
        if (!navigation) {
          throw new TargetError("Unvisitable form response locations require navigation", {
            method: candidate.transportMethod,
            responseStatus: candidate.responseStatus,
          })
        }
        const navigated = await settleRequestOperation(lease.controller.signal, () =>
          navigation.visit(disposition.url, action),
        )
        if (!this.isCurrent(lease, proposal) || navigated.status === "canceled") {
          return this.unapplied(candidate, destination, action, "superseded")
        }
        if (navigated.status === "rejected") {
          throw new RequestError("Form submission failed", {
            method: candidate.transportMethod,
            responseStatus: candidate.responseStatus,
          })
        }
        return this.unapplied(candidate, destination, action, disposition.classification)
      }
      if (this.options.visitLifecycle) {
        this.options.visitLifecycle[DOCUMENT_VISIT_LIFECYCLE_VISIT_DISPATCH](
          new VisitEvent(candidate.url, action),
        )
        if (!this.isCurrent(lease, proposal)) {
          return this.unapplied(candidate, destination, action, "superseded")
        }
      }
    }

    const activeUrl = this.session.tree.document.url
    const appliedUrl = candidate.classification === "success" ? candidate.url : activeUrl
    if (!appliedUrl) {
      throw new RequestError("Form response application requires an active document URL", {
        method: candidate.transportMethod,
        responseStatus: candidate.responseStatus,
      })
    }
    const tree = parseExpoTurboDocument(candidate.body, {
      ...(this.options.limits ? { limits: this.options.limits } : {}),
      url: appliedUrl,
    })
    const streams = embeddedStreams(tree)
    for (const stream of streams) tree.removeNode(stream)
    if (!this.isCurrent(lease, proposal)) return this.canceled(candidate, destination)
    const visitLifecycle = this.options.visitLifecycle
    if (candidate.classification === "success" && visitLifecycle) {
      const beforeRender = await settleRequestOperation(lease.controller.signal, () =>
        runBeforeDocumentRender(visitLifecycle, {
          currentDocument: this.session.tree.document,
          newDocument: tree.document,
          renderMethod: "replace",
          url: appliedUrl,
        }),
      )
      const action = this.documentVisitAction(candidate, identity)
      if (beforeRender.status === "canceled" || !this.isCurrent(lease, proposal)) {
        return this.unapplied(candidate, destination, action, "superseded")
      }
      if (beforeRender.status === "rejected") throw beforeRender.error
      if (!beforeRender.value) {
        return this.unapplied(candidate, destination, action, "render-prevented")
      }
    }

    const snapshotCache =
      candidate.classification === "success" && candidate.transportMethod === "GET"
        ? this.options.snapshotCache
        : undefined
    const historyProposal =
      candidate.classification === "success" && historyPlan
        ? this.proposeDocumentHistory(historyPlan, candidate.url)
        : undefined
    if (historyProposal && !this.isCurrent(lease, proposal)) {
      return this.canceled(candidate, destination)
    }
    let beforeCacheDispatched = false
    if (
      snapshotCache &&
      this.options.visitLifecycle &&
      documentCachePolicy(this.session.tree).cacheable
    ) {
      this.options.visitLifecycle[DOCUMENT_VISIT_LIFECYCLE_BEFORE_CACHE_DISPATCH](
        new BeforeCacheEvent(),
      )
      beforeCacheDispatched = true
      if (!this.ownership.owns(lease)) return this.canceled(candidate, destination)
      if (historyPlan) this.assertDocumentHistory(historyPlan)
    }
    const revision = this.session.revision
    let historyCommitted = false
    try {
      if (snapshotCache || historyProposal) {
        const acquired = this.ownership.commitDocument(lease, () => {
          if (historyPlan) this.assertDocumentHistory(historyPlan)
          if (snapshotCache) this.session.captureSnapshot(snapshotCache)
          if (historyPlan) this.assertDocumentHistory(historyPlan)
          if (historyProposal && historyPlan) {
            historyPlan.history.commitProposal(historyProposal)
            historyCommitted = true
          }
        })
        if (!acquired) return this.canceled(candidate, destination)
        const current = beforeCacheDispatched
          ? this.ownership.owns(lease)
          : this.isCurrent(lease, proposal)
        if (!current) return this.canceled(candidate, destination)
      }
      try {
        if (this.options.visitLifecycle) {
          onDocumentRender?.(
            prepareDocumentRender(this.session, this.options.visitLifecycle, {
              preview: false,
              url: appliedUrl,
            }),
          )
        }
        this.session.replaceTree(tree)
      } finally {
        if (candidate.classification !== "success" && this.session.tree === tree) {
          this.options.snapshotCache?.clear()
        }
      }
      const streamReport = await dispatchEmbeddedTurboStreamElements(
        this.session,
        streams,
        this.options,
        {
          shouldContinue: () => this.ownership.retains(lease),
        },
      )
      return Object.freeze({
        ...metadata,
        application: "document",
        applicationDestination: destination,
        destination,
        status: "applied",
        streams: streamReport,
      })
    } catch (error) {
      throw this.applicationError(
        candidate,
        { application: "document", applicationDestination: destination, destination },
        revision,
        error,
        historyCommitted,
      )
    }
  }

  private applicationError(
    candidate: FormResponseCandidate,
    context: FormSubmissionCommitContext,
    revision: number,
    error: unknown,
    committed = false,
  ): ExpoTurboError {
    if (committed || this.session.revision !== revision) {
      return new FormSubmissionCommitError(candidate, context)
    }
    if (error instanceof ExpoTurboError) return error
    return new RequestError("Form response application failed", {
      method: candidate.transportMethod,
      responseStatus: candidate.responseStatus,
    })
  }

  private prepareDocumentHistory(
    identity: FormSubmissionProposalIdentity,
  ): DocumentFormHistoryPlan | undefined {
    const action = identity.visitAction
    if (action === "restore") {
      throw new TargetError("Document form restore actions require restoration support", {
        target: identity.form.key,
      })
    }
    const history = this.options.history
    if (!history) {
      if (action === "replace") {
        throw new TargetError("Document form replace actions require configured history", {
          target: identity.form.key,
        })
      }
      return undefined
    }
    const base = history.current
    if (!base || this.canonicalDocumentUrl() !== base.url) {
      throw new StateError("Document history must match the active document before form submission")
    }
    return Object.freeze({
      ...(action ? { action } : {}),
      base,
      history,
      navigationEpoch: currentDocumentNavigationEpoch(this.session),
    })
  }

  private prepareFrameHistory(
    identity: FormSubmissionProposalIdentity,
    requestedUrl: string,
  ): FrameFormHistoryPlan {
    const action = identity.visitAction
    const frame = identity.destinationFrame
    const frameId = identity.destinationFrameId
    if (!action || !frame || !frameId) {
      throw new StateError("Frame form history requires an exact destination Frame")
    }
    if (action === "restore") {
      throw new TargetError("Frame form restore actions require whole-document traversal", {
        frameId,
        target: identity.form.key,
      })
    }
    const registry = this.options.frameControllers
    const binding = registry ? resolveMountedFrameHistory(registry, frameId, frame) : undefined
    if (!binding) {
      throw new TargetError("Frame form actions require mounted Frame history coordination", {
        frameId,
        target: identity.form.key,
      })
    }
    return prepareFrameFormHistoryCommit(
      binding.coordinator,
      binding.scope,
      binding.isCurrent,
      binding.invalidationSignal,
      frame,
      requestedUrl,
      action,
    )
  }

  private assertFrameHistory(
    plan: FrameFormHistoryPlan,
    identity: FormSubmissionProposalIdentity,
    requestedUrl: string,
  ): void {
    const frame = identity.destinationFrame
    if (!frame) throw new StateError("Frame form history requires an exact destination Frame")
    assertFrameFormHistoryPlanCurrent(plan, this.session, frame, requestedUrl)
  }

  private assertDocumentHistory(plan: DocumentFormHistoryPlan): void {
    if (
      currentDocumentNavigationEpoch(this.session) !== plan.navigationEpoch ||
      plan.history.current !== plan.base ||
      this.canonicalDocumentUrl() !== plan.base.url
    ) {
      throw new StateError("Document history or the active document changed during form submission")
    }
  }

  private proposeDocumentHistory(
    plan: DocumentFormHistoryPlan,
    finalUrl: string,
  ): DocumentHistoryProposal {
    this.assertDocumentHistory(plan)
    const proposal =
      plan.action === "replace"
        ? plan.history.proposeReplace(finalUrl)
        : plan.history.proposeAdvance(finalUrl)
    this.assertDocumentHistory(plan)
    return proposal
  }

  private canonicalDocumentUrl(): string {
    const url = this.session.tree.document.url
    if (!url) throw new StateError("Document form history requires an active document URL")
    try {
      return resolveProtocolUrl(url, url).url
    } catch {
      throw new StateError("Document form history requires a valid credential-free HTTP(S) URL")
    }
  }

  private documentVisitAction(
    candidate: FormResponseCandidate,
    identity: FormSubmissionProposalIdentity,
  ): Extract<VisitAction, "advance" | "replace"> {
    if (identity.visitAction === "advance" || identity.visitAction === "replace") {
      return identity.visitAction
    }
    return candidate.redirected && candidate.url === this.canonicalDocumentUrl()
      ? "replace"
      : "advance"
  }

  private unapplied(
    candidate: FormResponseCandidate,
    destination: DocumentSubmissionDestination,
    action: Extract<VisitAction, "advance" | "replace">,
    reason: FormSubmissionUnappliedReason,
  ): FormSubmissionReport {
    return Object.freeze({
      ...responseMetadata(candidate),
      action,
      classification: "success",
      destination,
      reason,
      status: "unapplied",
    })
  }

  private promoted(
    candidate: FormResponseCandidate,
    destination: FormSubmissionDestination,
    frameId: string,
  ): FormSubmissionReport {
    if (destination.kind !== "frame") {
      throw new StateError("Frame visit-control promotion requires a Frame destination")
    }
    return Object.freeze({
      ...responseMetadata(candidate),
      action: "advance",
      applicationDestination:
        frameId === destination.frameId ? destination : Object.freeze({ frameId, kind: "frame" }),
      destination,
      reason: "visit-control-reload",
      status: "promoted",
    })
  }

  private canceled(
    candidate: FormRequestExecutionReport,
    destination: FormSubmissionDestination,
  ): FormSubmissionReport {
    return Object.freeze({
      effectiveMethod: candidate.effectiveMethod,
      requestId: candidate.requestId,
      requestedUrl: candidate.requestedUrl,
      sourceMethod: candidate.sourceMethod,
      transportMethod: candidate.transportMethod,
      destination,
      status: "canceled",
    })
  }

  private prevented(
    candidate: FormSubmissionPreventedCandidate,
    destination: FormSubmissionDestination,
  ): FormSubmissionReport {
    return Object.freeze({
      destination,
      effectiveMethod: candidate.effectiveMethod,
      redirected: candidate.redirected,
      requestId: candidate.requestId,
      requestedUrl: candidate.requestedUrl,
      responseStatus: candidate.responseStatus,
      responseUrl: candidate.url,
      sourceMethod: candidate.sourceMethod,
      status: "prevented",
      transportMethod: candidate.transportMethod,
    })
  }

  private async confirm(
    adapter: FormConfirmationAdapter,
    message: string,
    controller: AbortController,
    identity: FormSubmissionProposalIdentity,
    activityLease: FormSubmissionActivityLease,
  ): Promise<boolean | undefined> {
    let confirmation: boolean | Promise<boolean>
    try {
      confirmation = adapter.confirm(message, controller.signal)
    } catch {
      if (!identity.submissionActivity.owns(activityLease)) return undefined
      throw new RequestError("Form submission confirmation failed", {
        target: identity.form.key,
      })
    }

    const settled = Promise.resolve(confirmation).then(
      (value) => Object.freeze({ status: "resolved" as const, value }),
      () => Object.freeze({ status: "rejected" as const }),
    )
    if (!identity.submissionActivity.owns(activityLease)) return undefined

    let cancel: () => void = () => undefined
    const canceled = new Promise<Readonly<{ status: "canceled" }>>((resolve) => {
      cancel = () => resolve(Object.freeze({ status: "canceled" }))
      controller.signal.addEventListener("abort", cancel, { once: true })
      if (!identity.submissionActivity.owns(activityLease)) cancel()
    })
    const result = await Promise.race([settled, canceled])
    controller.signal.removeEventListener("abort", cancel)
    if (!identity.submissionActivity.owns(activityLease) || result.status === "canceled") {
      return undefined
    }
    if (result.status === "rejected") {
      throw new RequestError("Form submission confirmation failed", {
        target: identity.form.key,
      })
    }
    if (typeof result.value !== "boolean") {
      throw new RequestError("Form submission confirmation must return a boolean", {
        target: identity.form.key,
      })
    }
    return result.value
  }

  private canceledPlan(
    plan: FormRequestPlan,
    destination: FormSubmissionDestination,
  ): FormSubmissionReport {
    return Object.freeze({
      destination,
      effectiveMethod: plan.effectiveMethod,
      requestId: plan.request.headers["X-Turbo-Request-Id"] as string,
      requestedUrl: plan.request.url,
      sourceMethod: plan.sourceMethod,
      status: "canceled",
      transportMethod: plan.request.method as FormSubmissionMethod,
    })
  }

  private isCurrent(lease: DestinationRequestLease, proposal: FormSubmissionProposal): boolean {
    if (!this.ownership.owns(lease)) return false
    try {
      assertActiveFormSubmissionProposal(this.session, proposal)
      return true
    } catch (error) {
      if (error instanceof StateError) return false
      throw error
    }
  }
}
