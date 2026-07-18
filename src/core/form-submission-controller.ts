import type { FetchAdapter, FormConfirmationAdapter } from "../adapters"
import {
  type DestinationRequestLease,
  destinationRequestOwnership,
  type FrameRequestCheckpoint,
} from "./destination-request-ownership"
import { beginDocumentNavigation } from "./document-navigation-epoch"
import type { DocumentSnapshotCache } from "./document-snapshot-cache"
import { ExpoTurboError, type ExpoTurboErrorCode, RequestError, StateError } from "./errors"
import type { FormRequestPlan, FormSubmissionMethod } from "./form-request"
import type {
  FormRequestExecutionReport,
  FormResponseCandidate,
  FormResponseClassification,
} from "./form-request-transport"
import { admitFormRequestPlan, executeAdmittedFormRequest } from "./form-request-transport"
import type {
  FormSubmissionActivityLease,
  FormSubmissionDuplicateBehavior,
  FormSubmissionTerminalFailureInput,
  FormSubmissionTerminalReportInput,
} from "./form-submission-activity"
import {
  assertActiveFormSubmissionProposal,
  type FormSubmissionProposal,
  type FormSubmissionProposalIdentity,
} from "./form-submission-proposal"
import {
  commitPreparedFrameMutation,
  dispatchPreparedFrameResponseStreams,
  type PreparedFrameResponse,
  prepareFrameMutation,
  prepareFrameResponse,
} from "./frame-response-application"
import type { FormSubmissionDestination, FrameResponseReport } from "./frames"
import { type ParseLimits, parseExpoTurboDocument, parseTurboStreamFragment } from "./parser"
import { TURBO_STREAM_MIME_TYPE } from "./protocol-request"
import type { DocumentSession } from "./session"
import {
  dispatchGuardedTurboStreamElements,
  type StreamActionDispatchOptions,
  type StreamDispatchReport,
} from "./streams"
import { type DocumentTree, isElement, type ProtocolElement, type ProtocolNode } from "./tree"

export type FormSubmissionProposalFactory = (signal: AbortSignal) => FormSubmissionProposal

interface FormSubmissionRequestMetadata {
  readonly effectiveMethod: FormSubmissionMethod
  readonly requestId: string
  readonly requestedUrl: string
  readonly sourceMethod: FormSubmissionMethod
}

interface FormSubmissionResponseMetadata extends FormSubmissionRequestMetadata {
  readonly classification: FormResponseClassification
  readonly redirected: boolean
  /** Validated final transport URL; it does not necessarily become document/Frame state. */
  readonly responseUrl: string
  readonly responseStatus: number
}

type DocumentSubmissionDestination = Extract<FormSubmissionDestination, { kind: "document" }>
type FrameSubmissionDestination = Extract<FormSubmissionDestination, { kind: "frame" }>

export type FormSubmissionReport =
  | Readonly<
      FormSubmissionRequestMetadata & {
        destination: FormSubmissionDestination
        status: "canceled"
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
      method: candidate.effectiveMethod,
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
  readonly limits?: Partial<ParseLimits>
  readonly snapshotCache?: DocumentSnapshotCache
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
    this.options = Object.freeze({
      ...(options.confirmation ? { confirmation: options.confirmation } : {}),
      ...(options.customActions ? { customActions: options.customActions } : {}),
      ...(options.limits ? { limits: Object.freeze({ ...options.limits }) } : {}),
      ...(options.onActionError ? { onActionError: options.onActionError } : {}),
      ...(options.refresh ? { refresh: options.refresh } : {}),
      ...(options.snapshotCache ? { snapshotCache: options.snapshotCache } : {}),
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
    } catch (error) {
      controller.abort()
      if (error instanceof ExpoTurboError) throw error
      throw new RequestError("Form submission planning failed")
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
    const settle = (report: FormSubmissionReport): FormSubmissionReport => {
      submissionActivity.settleReport(activityLease, this.terminalReport(report))
      return report
    }

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
          if (identity.originFrame && identity.originFrameId !== proposal.destination.frameId) {
            originCheckpoint = this.ownership.checkpointFrame(identity.originFrame)
          }
          lease = this.ownership.claimFrame(identity.destinationFrame, controller, identity.form)
        } else {
          lease = this.ownership.claimDocument(controller, identity.treeGeneration, identity.form)
        }
        // A displaced request's abort listener may synchronously mutate the tree
        // or submit newer work. Re-admit the exact proposal before any fetch.
        if (this.ownership.owns(lease)) {
          assertActiveFormSubmissionProposal(this.session, proposal)
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

      if (!identity.submissionActivity.start(activityLease) || !this.ownership.owns(activeLease)) {
        this.ownership.cancel(activeLease)
        identity.submissionActivity.finish(activityLease)
        return settle(this.canceledPlan(plan, proposal.destination))
      }
      if (proposal.destination.kind === "document") beginDocumentNavigation(this.session)

      let response: FormRequestExecutionReport
      try {
        fetchInvoked = true
        this.session.recentRequestIds.add(plan.request.headers["X-Turbo-Request-Id"] as string)
        response = await executeAdmittedFormRequest(this.fetchAdapter, plan, {
          beforeResponseBody: (admittedResponse) => {
            if (
              proposal.destination.kind === "frame" &&
              admittedResponse.contentType !== TURBO_STREAM_MIME_TYPE &&
              (admittedResponse.classification !== "success" ||
                admittedResponse.effectiveMethod !== "GET") &&
              this.isCurrent(activeLease, proposal)
            ) {
              this.options.snapshotCache?.clear()
            }
            return undefined
          },
          controller,
          owns: () => this.ownership.owns(activeLease),
          release: () => this.ownership.release(activeLease),
          retainCandidate: true,
        })
      } finally {
        // Turbo clears form/submitter presentation before applying the response.
        // Exact activity ownership keeps an older finalizer from clearing newer work.
        identity.submissionActivity.finish(activityLease)
      }
      if (response.status === "canceled") {
        return settle(this.canceled(response, proposal.destination))
      }

      try {
        if (!this.isCurrent(activeLease, proposal)) {
          return settle(this.canceled(response, proposal.destination))
        }
        let preparedFrame: PreparedFrameResponse | undefined
        if (response.status === "xml" && proposal.destination.kind === "frame") {
          const frameId =
            response.classification === "success"
              ? proposal.destination.frameId
              : (identity.originFrameId ?? proposal.destination.frameId)
          preparedFrame = prepareFrameResponse(frameId, response.body, {
            ...(this.options.limits ? { limits: this.options.limits } : {}),
            url: response.url,
          })
        }
        if (
          preparedFrame &&
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
        return settle(this.apply(response, proposal, identity, activeLease, preparedFrame))
      } finally {
        // Exact release cannot detach newer reentrant work that superseded this lease.
        this.ownership.release(activeLease)
      }
    } catch (error) {
      controller.abort()
      const reported =
        error instanceof ExpoTurboError
          ? error
          : new RequestError("Form submission failed", { method: plan.effectiveMethod })
      submissionActivity.settleFailure(
        activityLease,
        this.terminalFailure(reported, plan, fetchInvoked),
      )
      throw reported
    }
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
      retryDisposition: !fetchInvoked || plan.effectiveMethod === "GET" ? "safe" : "unsafe",
      status: "failed",
    })
  }

  private terminalReport(report: FormSubmissionReport): FormSubmissionTerminalReportInput {
    if (report.status === "canceled") {
      return Object.freeze({
        effectiveMethod: report.effectiveMethod,
        requestId: report.requestId,
        status: "canceled",
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

  private apply(
    candidate: FormResponseCandidate,
    proposal: FormSubmissionProposal,
    identity: FormSubmissionProposalIdentity,
    lease: DestinationRequestLease,
    preparedFrame?: PreparedFrameResponse,
  ): FormSubmissionReport {
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
        const report = dispatchGuardedTurboStreamElements(this.session, streams, this.options, {
          shouldContinue: () => this.ownership.retains(lease),
        })
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
      try {
        const finalUrl =
          candidate.classification === "success" || candidate.redirected ? candidate.url : undefined
        const mutation = prepareFrameMutation(this.session, activeFrame, preparedFrame, {
          ...(finalUrl ? { finalUrl } : {}),
        })
        commitPreparedFrameMutation(this.session, mutation)
        const streams = dispatchPreparedFrameResponseStreams(
          this.session,
          preparedFrame,
          this.options,
          {
            shouldContinue: () => this.ownership.retains(lease),
          },
        )
        const frame: FrameResponseReport = Object.freeze({
          ...(finalUrl ? { finalUrl } : {}),
          frameId,
          streams,
        })
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
        )
      }
    }

    if (
      candidate.effectiveMethod !== "GET" &&
      candidate.responseStatus === 200 &&
      !candidate.redirected
    ) {
      throw new RequestError("Unsafe document form responses must redirect", {
        method: candidate.effectiveMethod,
        responseStatus: candidate.responseStatus,
      })
    }

    if (candidate.classification === "success" && candidate.effectiveMethod !== "GET") {
      this.options.snapshotCache?.clear()
    }

    const activeUrl = this.session.tree.document.url
    const appliedUrl = candidate.classification === "success" ? candidate.url : activeUrl
    if (!appliedUrl) {
      throw new RequestError("Form response application requires an active document URL", {
        method: candidate.effectiveMethod,
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

    const revision = this.session.revision
    try {
      try {
        this.session.replaceTree(tree)
      } finally {
        if (candidate.classification !== "success" && this.session.tree === tree) {
          this.options.snapshotCache?.clear()
        }
      }
      const streamReport = dispatchGuardedTurboStreamElements(this.session, streams, this.options, {
        shouldContinue: () => this.ownership.retains(lease),
      })
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
      )
    }
  }

  private applicationError(
    candidate: FormResponseCandidate,
    context: FormSubmissionCommitContext,
    revision: number,
    error: unknown,
  ): ExpoTurboError {
    if (this.session.revision !== revision) {
      return new FormSubmissionCommitError(candidate, context)
    }
    if (error instanceof ExpoTurboError) return error
    return new RequestError("Form response application failed", {
      method: candidate.effectiveMethod,
      responseStatus: candidate.responseStatus,
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
      destination,
      status: "canceled",
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
