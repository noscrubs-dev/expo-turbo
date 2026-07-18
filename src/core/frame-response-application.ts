import { FrameMissingError, StateError, TargetError } from "./errors"
import { type ParseLimits, parseExpoTurboDocument } from "./parser"
import type { DocumentSession } from "./session"
import {
  dispatchGuardedTurboStreamElements,
  type StreamActionDispatchOptions,
  type StreamDispatchControl,
  type StreamDispatchReport,
} from "./streams"
import {
  attributeValue,
  type DocumentTree,
  isElement,
  type ProtocolElement,
  type ProtocolNode,
} from "./tree"

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
  readonly documentUrl?: string
  readonly finalUrl?: string
}

export interface PreparedFrameMutation {
  readonly frameId: string
}

interface PreparedFrameMutationState {
  readonly activeFrame: ProtocolElement
  readonly documentUrl?: string
  readonly finalUrl?: string
  readonly responseFrame: ProtocolElement
  readonly revision: number
  readonly tree: DocumentTree
  readonly treeGeneration: number
}

export interface CommittedFrameResponse {
  readonly documentUrl?: string
  readonly finalUrl?: string
  readonly frameId: string
  readonly streams: StreamDispatchReport
}

const preparedFrameMutations = new WeakMap<PreparedFrameMutation, PreparedFrameMutationState>()

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
  return prepareFrameResponseTree(frameId, response)
}

export function prepareFrameResponseTree(
  frameId: string,
  response: DocumentTree,
): PreparedFrameResponse {
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

export function prepareFrameMutation(
  session: DocumentSession,
  activeFrame: ProtocolElement,
  prepared: PreparedFrameResponse,
  options: Pick<CommitPreparedFrameResponseOptions, "documentUrl" | "finalUrl"> = {},
): PreparedFrameMutation {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TargetError("Prepared Frame mutation options must be an object")
  }
  if (
    activeFrame.kind !== "frame" ||
    session.tree.getElementById(prepared.frameId) !== activeFrame
  ) {
    throw new FrameMissingError(`Active frame ${JSON.stringify(prepared.frameId)} is missing`, {
      frameId: prepared.frameId,
    })
  }

  const preflight = session.tree.clone()
  const responseFrame = preflight.getElementById(prepared.frameId)
  if (responseFrame?.kind !== "frame") {
    throw new FrameMissingError(`Active frame ${JSON.stringify(prepared.frameId)} is missing`, {
      frameId: prepared.frameId,
    })
  }
  preflight.replaceChildrenWithClones(responseFrame, prepared.responseFrame.children)
  if (options.finalUrl) preflight.setAttribute(responseFrame, "src", options.finalUrl)
  if (options.documentUrl !== undefined) preflight.retargetDocumentUrl(options.documentUrl)

  const mutation = Object.freeze({ frameId: prepared.frameId })
  preparedFrameMutations.set(mutation, {
    activeFrame,
    ...(options.documentUrl !== undefined ? { documentUrl: options.documentUrl } : {}),
    ...(options.finalUrl ? { finalUrl: options.finalUrl } : {}),
    responseFrame,
    revision: session.revision,
    tree: session.tree,
    treeGeneration: session.treeGeneration,
  })
  return mutation
}

export function commitPreparedFrameMutation(
  session: DocumentSession,
  mutation: PreparedFrameMutation,
): void {
  const state = preparedFrameMutations.get(mutation)
  if (!state) throw new StateError("Prepared Frame mutation is invalid")
  preparedFrameMutations.delete(mutation)
  if (
    session.tree !== state.tree ||
    session.treeGeneration !== state.treeGeneration ||
    session.revision !== state.revision ||
    session.tree.getElementById(mutation.frameId) !== state.activeFrame
  ) {
    throw new StateError("Prepared Frame mutation is stale", { frameId: mutation.frameId })
  }

  session.mutate((tree) => {
    const changed = [
      ...tree.replaceChildrenWithClones(state.activeFrame, state.responseFrame.children),
    ]
    if (state.finalUrl) tree.setAttribute(state.activeFrame, "src", state.finalUrl)
    if (state.documentUrl !== undefined && tree.document.url !== state.documentUrl) {
      tree.retargetDocumentUrl(state.documentUrl)
      changed.push(tree.document.key)
    }
    return changed
  })
}

export function dispatchPreparedFrameResponseStreams(
  session: DocumentSession,
  prepared: PreparedFrameResponse,
  options: StreamActionDispatchOptions = {},
  control?: StreamDispatchControl,
): StreamDispatchReport {
  return dispatchGuardedTurboStreamElements(session, prepared.streams, options, control)
}

export function commitPreparedFrameResponse(
  session: DocumentSession,
  activeFrame: ProtocolElement,
  prepared: PreparedFrameResponse,
  options: CommitPreparedFrameResponseOptions = {},
  control?: StreamDispatchControl,
): CommittedFrameResponse {
  const mutation = prepareFrameMutation(session, activeFrame, prepared, options)
  commitPreparedFrameMutation(session, mutation)
  const streams = dispatchPreparedFrameResponseStreams(session, prepared, options, control)
  return Object.freeze({
    ...(options.documentUrl !== undefined ? { documentUrl: options.documentUrl } : {}),
    ...(options.finalUrl ? { finalUrl: options.finalUrl } : {}),
    frameId: prepared.frameId,
    streams,
  })
}
