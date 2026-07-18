import { StateError } from "./errors"
import type { FormRequestPlan } from "./form-request"
import type { ExactFormSubmissionActivity } from "./form-submission-activity"
import type { FormSubmissionDestination } from "./frames"
import type { DocumentSession } from "./session"
import { attributeValue, type ProtocolElement } from "./tree"

declare const FORM_SUBMISSION_PROPOSAL: unique symbol

export interface FormSubmissionProposal {
  readonly [FORM_SUBMISSION_PROPOSAL]: true
  readonly destination: FormSubmissionDestination
  readonly plan: FormRequestPlan
}

export interface FormSubmissionProposalIdentity {
  readonly confirmationMessage?: string
  readonly destination: FormSubmissionDestination
  readonly destinationFrame?: ProtocolElement
  readonly destinationFrameId?: string
  readonly form: ProtocolElement
  readonly originFrame?: ProtocolElement
  readonly originFrameId?: string
  readonly session: DocumentSession
  readonly submissionActivity: ExactFormSubmissionActivity
  readonly submitter?: ProtocolElement
  readonly treeGeneration: number
}

const admittedProposals = new WeakMap<object, FormSubmissionProposalIdentity>()

export function admitFormSubmissionProposal(
  proposal: FormSubmissionProposal,
  identity: FormSubmissionProposalIdentity,
): FormSubmissionProposal {
  admittedProposals.set(proposal, Object.freeze({ ...identity }))
  return proposal
}

/** Internal admission gate used by the destination-ownership controller. */
export function assertActiveFormSubmissionProposal(
  session: DocumentSession,
  proposal: FormSubmissionProposal,
): FormSubmissionProposalIdentity {
  const identity = admittedProposals.get(proposal)
  if (!identity || identity.session !== session) {
    throw new StateError("Form submission proposal was not issued by this document session")
  }
  if (proposal.destination !== identity.destination) {
    throw new StateError("Form submission proposal destination identity is invalid")
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
  if (identity.submitter) {
    const formId = attributeValue(identity.submitter, "form")
    let ownsForm = false
    if (formId !== undefined) {
      ownsForm = formId !== "" && session.tree.getElementById(formId) === identity.form
    } else {
      let parent = identity.submitter.parent
      while (parent && parent !== identity.form) parent = parent.parent
      ownsForm = parent === identity.form
    }
    if (!ownsForm) {
      throw new StateError("Form submission proposal submitter no longer owns its form", {
        target: identity.submitter.key,
      })
    }
  }
  if (identity.destinationFrame) {
    const frameId = identity.destinationFrameId
    if (!frameId || session.tree.getElementById(frameId) !== identity.destinationFrame) {
      throw new StateError("Form submission proposal no longer owns its destination Frame", {
        ...(frameId ? { frameId } : {}),
      })
    }
  }
  if (identity.originFrame) {
    const frameId = identity.originFrameId
    if (!frameId || session.tree.getElementById(frameId) !== identity.originFrame) {
      throw new StateError("Form submission proposal no longer owns its origin Frame", {
        ...(frameId ? { frameId } : {}),
      })
    }
  }
  return identity
}
