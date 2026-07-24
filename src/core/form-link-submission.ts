import type { RequestIdAdapter, VisitAction } from "../adapters/index.js"
import { PropsError, RequestError, StateError, TargetError } from "./errors.js"
import { buildFormRequest, type FormRequestPlan } from "./form-request.js"
import { formSubmissionActivity } from "./form-submission-activity.js"
import type {
  FormSubmissionController,
  FormSubmissionControllerSubmitOptions,
  FormSubmissionReport,
} from "./form-submission-controller.js"
import {
  admitFormSubmissionProposal,
  type FormSubmissionProposal,
} from "./form-submission-proposal.js"
import type { FormMode, SuccessfulFormEntry } from "./forms.js"
import { type FormSubmissionDestination, resolveFormSubmissionDestination } from "./frames.js"
import type { DocumentSession } from "./session.js"
import { attributeValue, isElement, type ProtocolElement, type ProtocolNode } from "./tree.js"
import { classifyTopLevelLocation } from "./visitability.js"

export interface FormLinkSubmissionControllerOptions {
  readonly capabilityHash?: string
  readonly formMode?: FormMode
}

export interface FormLinkSubmissionProposalOptions {
  readonly signal?: AbortSignal
}

interface GeneratedFormLinkMetadata {
  readonly action: string
  readonly confirmationMessage?: string
  readonly destination: FormSubmissionDestination
  readonly destinationFrame?: ProtocolElement
  readonly entries: readonly SuccessfulFormEntry[]
  readonly link: ProtocolElement
  readonly method?: string
  readonly streamAttributePresent: boolean
  readonly visitAction?: VisitAction
}

function hasAttribute(node: ProtocolElement, name: string): boolean {
  return node.attributes.some((attribute) => attribute.name === name)
}

function exactVisitAction(value: string | undefined): VisitAction | undefined {
  return value === "advance" || value === "replace" || value === "restore" ? value : undefined
}

function normalizeFormMode(value: unknown): FormMode {
  if (value === undefined) return "on"
  if (value !== "off" && value !== "on" && value !== "optin") {
    throw new PropsError("Generated form-link mode must be off, on, or optin")
  }
  return value
}

function closestTurboSetting(node: ProtocolElement): string | undefined {
  let current: ProtocolNode | null = node
  while (current && current.kind !== "document") {
    if (isElement(current)) {
      const setting = attributeValue(current, "data-turbo")
      if (setting !== undefined) return setting
    }
    current = current.parent
  }
  return undefined
}

function isCharsetControlName(name: string): boolean {
  if (name.length !== "_charset_".length) return false
  for (let index = 0; index < name.length; index += 1) {
    const code = name.charCodeAt(index)
    const normalized = code >= 65 && code <= 90 ? code + 32 : code
    if (normalized !== "_charset_".charCodeAt(index)) return false
  }
  return true
}

function generatedEntries(
  href: string,
  documentUrl: string,
): Readonly<{ action: string; entries: readonly SuccessfulFormEntry[] }> {
  if (typeof href !== "string") throw new TargetError("Generated form-link URL must be a string")
  let resource: URL
  try {
    resource = new URL(href, documentUrl)
  } catch {
    throw new TargetError("Generated form-link URL is invalid")
  }

  const entries: SuccessfulFormEntry[] = []
  for (const [name, value] of resource.searchParams) {
    // Turbo materializes query pairs as hidden controls. Empty-name controls
    // are not successful form controls and therefore do not enter FormData.
    if (name !== "") {
      entries.push(
        Object.freeze({
          name,
          value: isCharsetControlName(name) ? "UTF-8" : value,
        }),
      )
    }
  }
  resource.search = ""
  return Object.freeze({
    action: resource.toString(),
    entries: Object.freeze(entries),
  })
}

/**
 * Owns Turbo 8.0.23's temporary-form path for links carrying
 * `data-turbo-method` or `data-turbo-stream`.
 *
 * Unlike registered Rails forms, generated form links send PUT, PATCH, and
 * DELETE directly. Ordered query pairs become the form entries and `_method`
 * remains ordinary data. The exact active link is the proposal/activity owner;
 * it is never treated as a submitter and its enclosing Frame is never recorded
 * as the form origin.
 */
export class FormLinkSubmissionController {
  private readonly capabilityHash: string | undefined
  private readonly formMode: FormMode

  constructor(
    private readonly session: DocumentSession,
    private readonly submissionController: Pick<FormSubmissionController, "submit">,
    private readonly requestIds: RequestIdAdapter,
    options: FormLinkSubmissionControllerOptions = {},
  ) {
    if (
      !submissionController ||
      typeof submissionController !== "object" ||
      typeof submissionController.submit !== "function"
    ) {
      throw new RequestError("Generated form links require a form submission controller")
    }
    if (!requestIds || typeof requestIds !== "object" || typeof requestIds.next !== "function") {
      throw new RequestError("Generated form links require a request-ID adapter")
    }
    if (!options || typeof options !== "object" || Array.isArray(options)) {
      throw new PropsError("Generated form-link options must be an object")
    }
    if (options.capabilityHash !== undefined && typeof options.capabilityHash !== "string") {
      throw new PropsError("Generated form-link capability hash must be a string")
    }
    this.capabilityHash = options.capabilityHash
    this.formMode = normalizeFormMode(options.formMode)
  }

  shouldInterceptSubmission(linkNodeKey: string): boolean {
    return this.shouldInterceptLink(this.activeLink(linkNodeKey))
  }

  submissionProposal(
    linkNodeKey: string,
    href: string,
    options: FormLinkSubmissionProposalOptions = {},
  ): FormSubmissionProposal {
    if (!options || typeof options !== "object" || Array.isArray(options)) {
      throw new RequestError("Generated form-link proposal options must be an object")
    }
    const metadata = this.metadata(linkNodeKey, href)
    const requestId = this.nextRequestId()
    this.assertExactLink(metadata.link)
    const plan = this.requestPlan(metadata, requestId, options.signal)
    this.assertExactLink(metadata.link)
    if (
      metadata.destination.kind === "frame" &&
      this.session.tree.getElementById(metadata.destination.frameId) !== metadata.destinationFrame
    ) {
      throw new StateError("Generated form-link destination Frame is no longer active", {
        frameId: metadata.destination.frameId,
      })
    }

    const proposal = Object.freeze({
      destination: metadata.destination,
      plan,
    }) as FormSubmissionProposal
    return admitFormSubmissionProposal(proposal, {
      ...(metadata.confirmationMessage !== undefined
        ? { confirmationMessage: metadata.confirmationMessage }
        : {}),
      destination: metadata.destination,
      ...(metadata.destination.kind === "frame"
        ? {
            destinationFrame: metadata.destinationFrame as ProtocolElement,
            destinationFrameId: metadata.destination.frameId,
          }
        : {}),
      form: metadata.link,
      session: this.session,
      submissionActivity: formSubmissionActivity(this.session, metadata.link),
      treeGeneration: this.session.treeGeneration,
      ...(metadata.visitAction ? { visitAction: metadata.visitAction } : {}),
    })
  }

  submit(
    linkNodeKey: string,
    href: string,
    options: FormSubmissionControllerSubmitOptions = {},
  ): Promise<FormSubmissionReport> {
    return this.submissionController.submit(
      (signal) => this.submissionProposal(linkNodeKey, href, { signal }),
      options,
    )
  }

  private activeLink(linkNodeKey: string): ProtocolElement {
    if (typeof linkNodeKey !== "string" || linkNodeKey === "") {
      throw new TargetError("Generated form links require a node key")
    }
    const link = this.session.tree.getNodeByKey(linkNodeKey)
    if (!link || !isElement(link) || !this.session.tree.contains(link)) {
      throw new TargetError("Generated form link is outside the active document", {
        target: linkNodeKey,
      })
    }
    return link
  }

  private assertExactLink(link: ProtocolElement): void {
    if (this.session.tree.getNodeByKey(link.key) !== link || !this.session.tree.contains(link)) {
      throw new StateError("Generated form link no longer owns its exact node", {
        target: link.key,
      })
    }
  }

  private metadata(linkNodeKey: string, href: string): GeneratedFormLinkMetadata {
    const link = this.activeLink(linkNodeKey)
    if (!hasAttribute(link, "data-turbo-method") && !hasAttribute(link, "data-turbo-stream")) {
      throw new TargetError("Generated form links require method or Stream metadata", {
        target: link.key,
      })
    }
    if (!this.shouldInterceptLink(link)) {
      throw new TargetError("Generated form link is not interceptable", {
        target: link.key,
      })
    }

    const streamAttributePresent = hasAttribute(link, "data-turbo-stream")
    const methodValue = attributeValue(link, "data-turbo-method")
    if (methodValue === "dialog") {
      throw new TargetError("Generated form links do not support dialog submission", {
        target: link.key,
      })
    }
    const method = methodValue === undefined || methodValue === "" ? undefined : methodValue
    const formTarget = attributeValue(link, "data-turbo-frame")
    const destination = resolveFormSubmissionDestination(this.session.tree, link, {
      ...(formTarget !== undefined ? { formTarget } : {}),
    })
    const destinationFrame =
      destination.kind === "frame"
        ? this.session.tree.getElementById(destination.frameId)
        : undefined
    if (destination.kind === "frame" && destinationFrame?.kind !== "frame") {
      throw new StateError("Generated form-link destination Frame is no longer active", {
        frameId: destination.frameId,
      })
    }

    const explicitAction = exactVisitAction(attributeValue(link, "data-turbo-action"))
    const inheritedAction =
      explicitAction === undefined && destinationFrame?.kind === "frame"
        ? exactVisitAction(attributeValue(destinationFrame, "data-turbo-action"))
        : undefined
    if (destination.kind === "document" && explicitAction === "restore") {
      throw new TargetError("Generated form-link restore actions require restoration support", {
        target: link.key,
      })
    }
    const frameAction =
      destination.kind === "frame" ? (explicitAction ?? inheritedAction) : undefined
    if (destination.kind === "frame" && frameAction === "restore") {
      throw new TargetError(
        "Generated form-link Frame restore actions require restoration support",
        {
          frameId: destination.frameId,
          target: link.key,
        },
      )
    }

    const documentUrl = this.session.tree.document.url
    if (!documentUrl) {
      throw new RequestError("Generated form links require an active document URL")
    }
    const generated = generatedEntries(href, documentUrl)
    const visitability = classifyTopLevelLocation(this.session.tree, generated.action)
    if (visitability.classification !== "visitable") {
      throw new TargetError("Generated form-link URL is not visitable", {
        target: link.key,
      })
    }
    if (generated.action.includes("#")) {
      throw new TargetError("Generated form-link fragments require navigation support", {
        target: link.key,
      })
    }
    const confirmationValue = attributeValue(link, "data-turbo-confirm")
    const confirmationMessage =
      confirmationValue === undefined || confirmationValue === "" ? undefined : confirmationValue
    const visitAction = destination.kind === "document" ? explicitAction : frameAction
    return Object.freeze({
      action: generated.action,
      ...(confirmationMessage !== undefined ? { confirmationMessage } : {}),
      destination,
      ...(destination.kind === "frame"
        ? { destinationFrame: destinationFrame as ProtocolElement }
        : {}),
      entries: generated.entries,
      link,
      ...(method !== undefined ? { method } : {}),
      streamAttributePresent,
      ...(visitAction ? { visitAction } : {}),
    })
  }

  private nextRequestId(): string {
    try {
      return this.requestIds.next()
    } catch {
      throw new RequestError("Generated form-link request-ID allocation failed")
    }
  }

  private shouldInterceptLink(link: ProtocolElement): boolean {
    if (!hasAttribute(link, "data-turbo-method") && !hasAttribute(link, "data-turbo-stream")) {
      return false
    }
    return this.formMode !== "off" && closestTurboSetting(link) !== "false"
  }

  private requestPlan(
    metadata: GeneratedFormLinkMetadata,
    requestId: string,
    signal: AbortSignal | undefined,
  ): FormRequestPlan {
    return buildFormRequest({
      documentUrl: this.session.tree.document.url as string,
      entries: metadata.entries,
      form: {
        action: metadata.action,
        ...(metadata.method !== undefined ? { method: metadata.method } : {}),
        ...(metadata.streamAttributePresent ? { streamAttributePresent: true } : {}),
      },
      protocol: {
        ...(this.capabilityHash !== undefined ? { capabilityHash: this.capabilityHash } : {}),
        ...(metadata.destination.kind === "frame" ? { frameId: metadata.destination.frameId } : {}),
        requestId,
      },
      ...(signal !== undefined ? { signal } : {}),
      unsafeMethodTransport: "direct",
    })
  }
}
