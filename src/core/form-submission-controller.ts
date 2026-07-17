import type { FetchAdapter } from "../adapters"
import {
  type DestinationRequestLease,
  destinationRequestOwnership,
} from "./destination-request-ownership"
import { ExpoTurboError, RequestError, StateError } from "./errors"
import type { FormRequestPlan } from "./form-request"
import type { FormRequestExecutionReport } from "./form-request-executor"
import { admitFormRequestPlan, executeAdmittedFormRequest } from "./form-request-transport"
import {
  assertActiveFormSubmissionProposal,
  type FormSubmissionProposal,
  type FormSubmissionProposalIdentity,
} from "./form-submission-proposal"
import type { FormSubmissionDestination } from "./frames"
import type { DocumentSession } from "./session"

export type FormSubmissionProposalFactory = (signal: AbortSignal) => FormSubmissionProposal

export type FormSubmissionReport = FormRequestExecutionReport &
  Readonly<{ destination: FormSubmissionDestination }>

/**
 * Coordinates one-fetch form transport with the active document or exact Frame
 * request lane. It returns buffered response candidates and never applies them.
 */
export class FormSubmissionController {
  private readonly ownership: ReturnType<typeof destinationRequestOwnership>

  constructor(
    private readonly session: DocumentSession,
    private readonly fetchAdapter: FetchAdapter,
  ) {
    this.ownership = destinationRequestOwnership(session)
  }

  async submit(createProposal: FormSubmissionProposalFactory): Promise<FormSubmissionReport> {
    if (typeof createProposal !== "function") {
      throw new RequestError("Form submission controller requires a proposal factory")
    }

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

    let lease: DestinationRequestLease | undefined
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
      if (error instanceof ExpoTurboError) throw error
      throw new RequestError("Form submission ownership admission failed")
    }
    if (!lease) throw new RequestError("Form submission ownership admission failed")
    const activeLease = lease

    const response = await executeAdmittedFormRequest(this.fetchAdapter, plan, {
      controller,
      owns: () => this.ownership.owns(activeLease),
      release: () => this.ownership.release(activeLease),
    })
    return Object.freeze({ ...response, destination: proposal.destination })
  }
}
