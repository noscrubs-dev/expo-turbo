import { FrameMissingError, TargetError } from "./errors.js"
import { commitPreparedFrameResponse, prepareFrameResponse } from "./frame-response-application.js"
import type { ParseLimits } from "./parser.js"
import type { DocumentSession } from "./session.js"
import type { StreamActionDispatchOptions, StreamDispatchReport } from "./streams.js"
import {
  attributeValue,
  type DocumentTree,
  isElement,
  type ProtocolElement,
  type ProtocolNode,
} from "./tree.js"

export interface ResolveFrameTargetOptions {
  readonly elementTarget?: string | null
  readonly submitterTarget?: string | null
}

export type ResolvedFrameTarget =
  | Readonly<{ frameId: string; kind: "frame"; requestedTarget?: string }>
  | Readonly<{ kind: "top"; requestedTarget?: string }>

export type FormSubmissionDestination =
  | Extract<ResolvedFrameTarget, { kind: "frame" }>
  | Readonly<{ kind: "document"; requestedTarget?: string }>

export interface ResolveFormSubmissionDestinationOptions {
  readonly formTarget?: string | null
  readonly submitterTarget?: string | null
}

function isDisabled(frame: ProtocolElement): boolean {
  return attributeValue(frame, "disabled") !== undefined
}

function parentFrame(frame: ProtocolElement): ProtocolElement | undefined {
  let parent = frame.parent
  while (parent && parent.kind !== "document") {
    if (parent.kind === "frame") return parent
    parent = parent.parent
  }
  return undefined
}

export function resolveFrameTarget(
  tree: DocumentTree,
  currentFrameId: string,
  options: ResolveFrameTargetOptions = {},
): ResolvedFrameTarget {
  const current = tree.getElementById(currentFrameId)
  if (current?.kind !== "frame") {
    throw new FrameMissingError(`Active frame ${JSON.stringify(currentFrameId)} is missing`, {
      frameId: currentFrameId,
    })
  }

  const explicitTarget =
    options.submitterTarget !== undefined && options.submitterTarget !== null
      ? options.submitterTarget
      : options.elementTarget
  const requestedTarget = explicitTarget || attributeValue(current, "target")

  if (isDisabled(current)) {
    return Object.freeze({
      kind: "top",
      ...(requestedTarget ? { requestedTarget } : {}),
    })
  }
  if (!requestedTarget || requestedTarget === "_self") {
    return Object.freeze({
      frameId: currentFrameId,
      kind: "frame",
      ...(requestedTarget ? { requestedTarget } : {}),
    })
  }
  if (requestedTarget === "_top") {
    return Object.freeze({ kind: "top", requestedTarget })
  }
  if (requestedTarget === "_parent") {
    const parent = parentFrame(current)
    const parentId = parent && !isDisabled(parent) ? attributeValue(parent, "id") : undefined
    return parentId
      ? Object.freeze({ frameId: parentId, kind: "frame", requestedTarget })
      : Object.freeze({ kind: "top", requestedTarget })
  }

  const named = tree.getElementById(requestedTarget)
  if (named?.kind === "frame" && isDisabled(named)) {
    return Object.freeze({ kind: "top", requestedTarget })
  }
  if (named?.kind === "frame") {
    return Object.freeze({ frameId: requestedTarget, kind: "frame", requestedTarget })
  }
  return Object.freeze({ frameId: currentFrameId, kind: "frame", requestedTarget })
}

function enclosingFrame(node: ProtocolElement): ProtocolElement | undefined {
  let parent = node.parent
  while (parent && parent.kind !== "document") {
    if (parent.kind === "frame") return parent
    parent = parent.parent
  }
  return undefined
}

function formSubmissionTargetOptions(
  value: ResolveFormSubmissionDestinationOptions,
): ResolveFormSubmissionDestinationOptions {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TargetError("Form submission destination options must be an object")
  }
  const formTarget = value.formTarget
  const submitterTarget = value.submitterTarget
  for (const target of [formTarget, submitterTarget]) {
    if (target !== undefined && target !== null && typeof target !== "string") {
      throw new TargetError("Form submission Frame targets must be strings")
    }
  }
  return Object.freeze({
    ...(formTarget !== undefined ? { formTarget } : {}),
    ...(submitterTarget !== undefined ? { submitterTarget } : {}),
  })
}

/**
 * Resolves the Turbo Frame destination for an exact active form. Turbo uses
 * subtly different fallback rules inside and outside a Frame: a present blank
 * submitter target masks the form target inside a Frame, but falls through to
 * the form target at document level.
 */
export function resolveFormSubmissionDestination(
  tree: DocumentTree,
  form: ProtocolElement,
  options: ResolveFormSubmissionDestinationOptions = {},
): FormSubmissionDestination {
  const targets = formSubmissionTargetOptions(options)
  if (!form || typeof form !== "object") {
    throw new FrameMissingError("Form submission destination requires an active form")
  }
  const node = form as ProtocolNode
  if (!tree.contains(node) || !isElement(node)) {
    throw new FrameMissingError("Form submission destination requires an active form", {
      ...(typeof node.key === "string" ? { target: node.key } : {}),
    })
  }

  const current = enclosingFrame(form)
  if (current) {
    const currentFrameId = attributeValue(current, "id")
    if (!currentFrameId) {
      throw new FrameMissingError("Enclosing form Frame requires a nonblank id", {
        target: current.key,
      })
    }
    const target = resolveFrameTarget(tree, currentFrameId, {
      ...(targets.formTarget !== undefined ? { elementTarget: targets.formTarget } : {}),
      ...(targets.submitterTarget !== undefined
        ? { submitterTarget: targets.submitterTarget }
        : {}),
    })
    return target.kind === "frame"
      ? target
      : Object.freeze({
          kind: "document",
          ...(target.requestedTarget ? { requestedTarget: target.requestedTarget } : {}),
        })
  }

  const requestedTarget = targets.submitterTarget || targets.formTarget || undefined
  if (
    requestedTarget &&
    requestedTarget !== "_top" &&
    requestedTarget !== "_self" &&
    requestedTarget !== "_parent"
  ) {
    const named = tree.getElementById(requestedTarget)
    if (named?.kind === "frame" && !isDisabled(named)) {
      return Object.freeze({ frameId: requestedTarget, kind: "frame", requestedTarget })
    }
  }
  return Object.freeze({
    kind: "document",
    ...(requestedTarget ? { requestedTarget } : {}),
  })
}

export interface ApplyFrameResponseOptions extends StreamActionDispatchOptions {
  readonly finalUrl?: string
  readonly limits?: Partial<ParseLimits>
}

export interface FrameResponseReport {
  readonly finalUrl?: string
  readonly frameId: string
  readonly streams: StreamDispatchReport
}

export async function applyFrameResponse(
  session: DocumentSession,
  frameId: string,
  xml: string,
  options: ApplyFrameResponseOptions = {},
): Promise<FrameResponseReport> {
  if (!frameId.trim()) throw new FrameMissingError("Frame id must not be blank")
  const activeFrame = session.tree.getElementById(frameId)
  if (activeFrame?.kind !== "frame") {
    throw new FrameMissingError(`Active frame ${JSON.stringify(frameId)} is missing`, {
      frameId,
    })
  }

  const prepared = prepareFrameResponse(frameId, xml, {
    ...(options.finalUrl ? { url: options.finalUrl } : {}),
    ...(options.limits ? { limits: options.limits } : {}),
  })
  return await commitPreparedFrameResponse(session, activeFrame, prepared, options)
}
