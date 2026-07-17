import { FrameMissingError } from "./errors"
import { type ParseLimits, parseExpoTurboDocument } from "./parser"
import type { DocumentSession } from "./session"
import {
  dispatchTurboStreamElements,
  type StreamActionDispatchOptions,
  type StreamDispatchReport,
} from "./streams"
import {
  attributeValue,
  type DocumentTree,
  isElement,
  type ProtocolElement,
  type ProtocolNode,
} from "./tree"

export interface ResolveFrameTargetOptions {
  readonly elementTarget?: string | null
  readonly submitterTarget?: string | null
}

export type ResolvedFrameTarget =
  | Readonly<{ frameId: string; kind: "frame"; requestedTarget?: string }>
  | Readonly<{ kind: "top"; requestedTarget?: string }>

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

export interface ApplyFrameResponseOptions extends StreamActionDispatchOptions {
  readonly finalUrl?: string
  readonly limits?: Partial<ParseLimits>
}

export interface FrameResponseReport {
  readonly finalUrl?: string
  readonly frameId: string
  readonly streams: StreamDispatchReport
}

function embeddedStreams(frame: ProtocolElement): ProtocolElement[] {
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
  for (const child of frame.children) visit(child)
  return streams
}

export function applyFrameResponse(
  session: DocumentSession,
  frameId: string,
  xml: string,
  options: ApplyFrameResponseOptions = {},
): FrameResponseReport {
  if (!frameId.trim()) throw new FrameMissingError("Frame id must not be blank")
  const activeFrame = session.tree.getElementById(frameId)
  if (activeFrame?.kind !== "frame") {
    throw new FrameMissingError(`Active frame ${JSON.stringify(frameId)} is missing`, {
      frameId,
    })
  }

  const response = parseExpoTurboDocument(xml, {
    ...(options.finalUrl ? { url: options.finalUrl } : {}),
    ...(options.limits ? { limits: options.limits } : {}),
  })
  const responseFrame = response
    .getFrames()
    .find((frame) => attributeValue(frame, "id") === frameId)
  if (!responseFrame) {
    throw new FrameMissingError(`Response is missing frame ${JSON.stringify(frameId)}`, {
      frameId,
    })
  }

  const streams = embeddedStreams(responseFrame)
  for (const stream of streams) response.removeNode(stream)

  session.mutate((tree) => {
    const changed = tree.replaceChildrenWithClones(activeFrame, responseFrame.children)
    if (options.finalUrl) tree.setAttribute(activeFrame, "src", options.finalUrl)
    return changed
  })

  const streamReport = dispatchTurboStreamElements(session, streams, options)
  return Object.freeze({
    ...(options.finalUrl ? { finalUrl: options.finalUrl } : {}),
    frameId,
    streams: streamReport,
  })
}
