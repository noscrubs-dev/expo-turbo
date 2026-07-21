import type { FrameAutoscrollBehavior, ScrollAlignment } from "../adapters"
import { applicationAutofocusCandidates } from "./autofocus-candidates-internal"
import { FrameMissingError, StateError, TargetError } from "./errors"
import {
  createBeforeFrameRenderEvent,
  FRAME_LIFECYCLE_BEFORE_RENDER_DISPATCH,
  type FrameLifecycle,
  type FrameRenderer,
  type FrameRenderMethod,
} from "./frame-lifecycle"
import { type ParseLimits, parseExpoTurboDocument } from "./parser"
import type { DocumentSession } from "./session"
import {
  dispatchEmbeddedTurboStreamElements,
  type StreamActionDispatchOptions,
  type StreamDispatchControl,
  type StreamDispatchReport,
} from "./streams"
import { consumeThenableResult } from "./thenable-result"
import {
  attributeValue,
  type DocumentTree,
  isElement,
  morphFrameRefreshChildren,
  type ProtocolElement,
  type ProtocolNode,
  replaceFrameChildrenPreservingPermanents,
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

interface PrepareFrameMutationOptions
  extends Pick<CommitPreparedFrameResponseOptions, "documentUrl" | "finalUrl"> {
  readonly renderMethod?: FrameRenderMethod
}

interface PreparedFrameMutationState {
  readonly activeFrame: ProtocolElement
  readonly documentUrl?: string
  readonly finalUrl?: string
  readonly renderMethod: FrameRenderMethod
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

/** A one-shot native equivalent of Turbo Frame's post-render autoscroll request. */
export interface FrameAutoscrollIntent {
  readonly alignment: ScrollAlignment
  readonly behavior: FrameAutoscrollBehavior
  readonly frameId: string
}

const preparedFrameMutations = new WeakMap<PreparedFrameMutation, PreparedFrameMutationState>()

const defaultFrameRenderer: FrameRenderer = (context) => context.renderDefault()

function hasAttribute(element: ProtocolElement, name: string): boolean {
  return element.attributes.some((attribute) => attribute.name === name)
}

function autoscrollAlignment(frame: ProtocolElement): ScrollAlignment {
  const value = attributeValue(frame, "data-autoscroll-block")
  return value === "start" || value === "center" || value === "nearest" || value === "end"
    ? value
    : "end"
}

function autoscrollBehavior(frame: ProtocolElement): FrameAutoscrollBehavior {
  return attributeValue(frame, "data-autoscroll-behavior") === "smooth" ? "smooth" : "auto"
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

export function activeFrameAutofocusCandidates(
  session: DocumentSession,
  frame: ProtocolElement,
): readonly string[] {
  const frameId = attributeValue(frame, "id")
  if (!frameId || session.tree.getElementById(frameId) !== frame) return Object.freeze([])
  return applicationAutofocusCandidates(frame)
}

/**
 * Captures the native target after matching Frame children and embedded Streams
 * have committed. Turbo uses the mounted Frame's block/behavior settings while
 * either the mounted or incoming Frame can request the one-shot scroll.
 */
export function frameAutoscrollIntent(
  session: DocumentSession,
  frame: ProtocolElement,
  prepared: PreparedFrameResponse,
): FrameAutoscrollIntent | undefined {
  const frameId = attributeValue(frame, "id")
  if (
    !frameId ||
    prepared.frameId !== frameId ||
    session.tree.getElementById(frameId) !== frame ||
    (!hasAttribute(frame, "autoscroll") && !hasAttribute(prepared.responseFrame, "autoscroll"))
  ) {
    return undefined
  }
  return Object.freeze({
    alignment: autoscrollAlignment(frame),
    behavior: autoscrollBehavior(frame),
    frameId,
  })
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
  return Object.freeze({
    frameId,
    responseFrame,
    streams: Object.freeze(streams),
  })
}

export function prepareFrameMutation(
  session: DocumentSession,
  activeFrame: ProtocolElement,
  prepared: PreparedFrameResponse,
  options: PrepareFrameMutationOptions = {},
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

  const renderMethod = options.renderMethod ?? "replace"
  if (renderMethod !== "morph" && renderMethod !== "replace") {
    throw new TargetError("Prepared Frame mutation render method is invalid", {
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
  if (renderMethod === "morph") {
    morphFrameRefreshChildren(preflight, responseFrame, prepared.responseFrame)
  } else {
    replaceFrameChildrenPreservingPermanents(preflight, responseFrame, prepared.responseFrame)
  }
  if (options.finalUrl) preflight.setAttribute(responseFrame, "src", options.finalUrl)
  if (options.documentUrl !== undefined) preflight.retargetDocumentUrl(options.documentUrl)

  const mutation = Object.freeze({ frameId: prepared.frameId })
  preparedFrameMutations.set(mutation, {
    activeFrame,
    ...(options.documentUrl !== undefined ? { documentUrl: options.documentUrl } : {}),
    ...(options.finalUrl ? { finalUrl: options.finalUrl } : {}),
    renderMethod,
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
): readonly ProtocolElement[] {
  const state = preparedFrameMutations.get(mutation)
  if (!state) throw new StateError("Prepared Frame mutation is invalid")
  assertPreparedFrameMutationCurrent(session, mutation)
  preparedFrameMutations.delete(mutation)

  let nestedFrames: readonly ProtocolElement[] = Object.freeze([])
  session.mutate((tree) => {
    const morph =
      state.renderMethod === "morph"
        ? morphFrameRefreshChildren(tree, state.activeFrame, state.responseFrame)
        : undefined
    const changed = morph
      ? [...morph.changed]
      : [...replaceFrameChildrenPreservingPermanents(tree, state.activeFrame, state.responseFrame)]
    if (morph) nestedFrames = morph.nestedFrames
    if (state.finalUrl) tree.setAttribute(state.activeFrame, "src", state.finalUrl)
    if (state.documentUrl !== undefined && tree.document.url !== state.documentUrl) {
      tree.retargetDocumentUrl(state.documentUrl)
      changed.push(tree.document.key)
    }
    return changed
  })
  return nestedFrames
}

export function assertPreparedFrameMutationCurrent(
  session: DocumentSession,
  mutation: PreparedFrameMutation,
): void {
  const state = preparedFrameMutations.get(mutation)
  if (!state) throw new StateError("Prepared Frame mutation is invalid")
  if (
    session.tree !== state.tree ||
    session.treeGeneration !== state.treeGeneration ||
    session.revision !== state.revision ||
    session.tree.getElementById(mutation.frameId) !== state.activeFrame
  ) {
    throw new StateError("Prepared Frame mutation is stale", { frameId: mutation.frameId })
  }
}

/**
 * Dispatches the synchronous native before-render hook while the caller holds
 * exact Frame request ownership. The selected renderer must complete before
 * history and the package-owned Frame mutation may proceed.
 */
export function prepareFrameBeforeRender(
  lifecycle: FrameLifecycle | undefined,
  prepared: PreparedFrameResponse,
  url: string,
  renderMethod: FrameRenderMethod = "replace",
): FrameRenderer | undefined {
  if (!lifecycle) return undefined
  return lifecycle[FRAME_LIFECYCLE_BEFORE_RENDER_DISPATCH](
    createBeforeFrameRenderEvent(
      prepared.frameId,
      prepared.responseFrame,
      url,
      defaultFrameRenderer,
      renderMethod,
    ),
  )
}

/**
 * Runs the renderer selected by `prepareFrameBeforeRender` while the caller
 * holds exact Frame ownership. A custom renderer may only synchronously admit
 * the package-owned replacement by calling `renderDefault()` exactly once.
 */
export function renderPreparedFrameMutation(
  prepared: PreparedFrameResponse,
  renderer: FrameRenderer | undefined,
): void {
  if (!renderer) return

  const frameId = prepared.frameId
  let defaultRendered = false
  let rendering = true
  const context = Object.freeze({
    frameId,
    newFrame: prepared.responseFrame,
    renderDefault(): undefined {
      if (!rendering) {
        throw new StateError("Frame render context is no longer active", { frameId })
      }
      if (defaultRendered) {
        throw new StateError("Default Frame renderer may run only once", { frameId })
      }
      defaultRendered = true
      return undefined
    },
  })

  let result: unknown
  try {
    try {
      result = renderer(context)
    } finally {
      rendering = false
    }
  } catch {
    throw new StateError("Before-frame-render renderer failed", { frameId })
  }

  if (consumeThenableResult(result)) {
    throw new StateError("Before-frame-render renderers must be synchronous", { frameId })
  }
  if (result !== undefined) {
    throw new StateError("Before-frame-render renderer must return undefined", { frameId })
  }
  if (!defaultRendered) {
    throw new StateError("Before-frame-render renderer must call renderDefault exactly once", {
      frameId,
    })
  }
}

export function dispatchPreparedFrameResponseStreams(
  session: DocumentSession,
  prepared: PreparedFrameResponse,
  options: StreamActionDispatchOptions = {},
  control?: StreamDispatchControl,
): StreamDispatchReport {
  return dispatchEmbeddedTurboStreamElements(session, prepared.streams, options, control)
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
