import { FrameMissingError } from "./errors"
import { type ParseLimits, parseExpoTurboDocument } from "./parser"
import type { DocumentSession } from "./session"
import {
  dispatchGuardedTurboStreamElements,
  type StreamActionDispatchOptions,
  type StreamDispatchControl,
  type StreamDispatchReport,
} from "./streams"
import { attributeValue, isElement, type ProtocolElement, type ProtocolNode } from "./tree"

export interface PreparedFrameResponse {
  readonly frameId: string
  readonly responseFrame: ProtocolElement
  readonly streams: readonly ProtocolElement[]
}

export interface PrepareFrameResponseOptions {
  readonly limits?: Partial<ParseLimits>
  readonly url?: string
}

export interface CommitPreparedFrameResponseOptions extends StreamActionDispatchOptions {
  readonly finalUrl?: string
}

export interface CommittedFrameResponse {
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

export function prepareFrameResponse(
  frameId: string,
  xml: string,
  options: PrepareFrameResponseOptions = {},
): PreparedFrameResponse {
  const response = parseExpoTurboDocument(xml, options)
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
  return Object.freeze({ frameId, responseFrame, streams: Object.freeze(streams) })
}

export function commitPreparedFrameResponse(
  session: DocumentSession,
  activeFrame: ProtocolElement,
  prepared: PreparedFrameResponse,
  options: CommitPreparedFrameResponseOptions = {},
  control?: StreamDispatchControl,
): CommittedFrameResponse {
  if (
    activeFrame.kind !== "frame" ||
    session.tree.getElementById(prepared.frameId) !== activeFrame
  ) {
    throw new FrameMissingError(`Active frame ${JSON.stringify(prepared.frameId)} is missing`, {
      frameId: prepared.frameId,
    })
  }

  session.mutate((tree) => {
    const changed = tree.replaceChildrenWithClones(activeFrame, prepared.responseFrame.children)
    if (options.finalUrl) tree.setAttribute(activeFrame, "src", options.finalUrl)
    return changed
  })

  const streams = dispatchGuardedTurboStreamElements(session, prepared.streams, options, control)
  return Object.freeze({
    ...(options.finalUrl ? { finalUrl: options.finalUrl } : {}),
    frameId: prepared.frameId,
    streams,
  })
}
