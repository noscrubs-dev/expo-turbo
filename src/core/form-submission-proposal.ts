import { StateError } from "./errors"
import type { FormRequestPlan } from "./form-request"
import type { FormSubmissionDestination } from "./frames"
import type { DocumentSession } from "./session"
import type { ProtocolElement } from "./tree"

declare const FORM_SUBMISSION_PROPOSAL: unique symbol

export interface FormSubmissionProposal {
  readonly [FORM_SUBMISSION_PROPOSAL]: true
  readonly destination: FormSubmissionDestination
  readonly plan: FormRequestPlan
}

interface FormSubmissionProposalIdentity {
  readonly destinationFrame?: ProtocolElement
  readonly destinationFrameId?: string
  readonly form: ProtocolElement
  readonly session: DocumentSession
  readonly submitter?: ProtocolElement
  readonly treeGeneration: number
}

const admittedProposals = new WeakMap<object, FormSubmissionProposalIdentity>()

export function admitFormSubmissionProposal(
  proposal: FormSubmissionProposal,
  identity: FormSubmissionProposalIdentity,
): FormSubmissionProposal {
  admittedProposals.set(proposal, identity)
  return proposal
}

/** Internal admission gate used by the destination-ownership controller. */
export function assertActiveFormSubmissionProposal(
  session: DocumentSession,
  proposal: FormSubmissionProposal,
): void {
  const identity = admittedProposals.get(proposal)
  if (!identity || identity.session !== session) {
    throw new StateError("Form submission proposal was not issued by this document session")
  }
  if (
    session.treeGeneration !== identity.treeGeneration ||
    session.tree.getNodeByKey(identity.form.key) !== identity.form ||
    !session.tree.contains(identity.form)
  ) {
    throw new StateError("Form submission proposal no longer owns its form node", {
      target: identity.form.key,
    })
  }
  if (
    identity.submitter &&
    (session.tree.getNodeByKey(identity.submitter.key) !== identity.submitter ||
      !session.tree.contains(identity.submitter))
  ) {
    throw new StateError("Form submission proposal no longer owns its submitter node", {
      target: identity.submitter.key,
    })
  }
  if (identity.destinationFrame) {
    const frameId = identity.destinationFrameId
    if (!frameId || session.tree.getElementById(frameId) !== identity.destinationFrame) {
      throw new StateError("Form submission proposal no longer owns its destination Frame", {
        ...(frameId ? { frameId } : {}),
      })
    }
  }
}
