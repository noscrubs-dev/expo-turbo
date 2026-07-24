import type { FrameAutoscrollBehavior, ScrollAlignment } from "../adapters/index.js"
import { applicationAutofocusCandidates } from "./autofocus-candidates-internal.js"
import { FrameMissingError, StateError, TargetError } from "./errors.js"
import {
  type BeforeFrameRenderEvent,
  createBeforeFrameRenderEvent,
  FRAME_LIFECYCLE_BEFORE_RENDER_DISPATCH,
  type FrameLifecycle,
  type FrameRenderer,
  type FrameRenderMethod,
  waitUntilBeforeFrameRenderResumed,
} from "./frame-lifecycle.js"
import { type ParseLimits, parseExpoTurboDocument } from "./parser.js"
import type { DocumentSession } from "./session.js"
import {
  dispatchEmbeddedTurboStreamElements,
  type StreamActionDispatchOptions,
  type StreamDispatchControl,
  type StreamDispatchReport,
} from "./streams.js"
import { consumeThenableResult } from "./thenable-result.js"
import {
  attributeValue,
  type DocumentTree,
  isElement,
  morphFrameRefreshChildren,
  type ProtocolElement,
  type ProtocolNode,
  replaceFrameChildrenPreservingPermanents,
} from "./tree.js"

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

export interface PreparedFrameBeforeRender {
  readonly event: BeforeFrameRenderEvent
  readonly renderer: FrameRenderer
}

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
    if (morph) nestedFrames = morph.reloadFrames
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

export function discardPreparedFrameMutation(mutation: PreparedFrameMutation): void {
  preparedFrameMutations.delete(mutation)
}

/**
 * Dispatches the native before-render hook while the caller holds exact Frame
 * request ownership. The caller may release its commit transaction while a
 * listener-requested pause is pending, but must retain the request lease and
 * reacquire commit ownership before using the selected renderer.
 */
export function prepareFrameBeforeRender(
  lifecycle: FrameLifecycle | undefined,
  prepared: PreparedFrameResponse,
  url: string,
  renderMethod: FrameRenderMethod = "replace",
): PreparedFrameBeforeRender | undefined {
  if (!lifecycle) return undefined
  const event = createBeforeFrameRenderEvent(
    prepared.frameId,
    prepared.responseFrame,
    url,
    defaultFrameRenderer,
    renderMethod,
  )
  const renderer = lifecycle[FRAME_LIFECYCLE_BEFORE_RENDER_DISPATCH](event)
  return Object.freeze({ event, renderer })
}

export function waitForPreparedFrameBeforeRender(
  prepared: PreparedFrameBeforeRender | undefined,
  signal?: AbortSignal,
): Promise<boolean> {
  return prepared
    ? waitUntilBeforeFrameRenderResumed(prepared.event, signal)
    : Promise.resolve(!signal?.aborted)
}

/**
 * Runs the renderer selected by `prepareFrameBeforeRender` while the caller
 * holds exact Frame ownership. A custom renderer synchronously selects either
 * the prepared default or the package-owned bounded morph exactly once.
 */
export function renderPreparedFrameMutation(
  prepared: PreparedFrameResponse,
  beforeRender: PreparedFrameBeforeRender | undefined,
  defaultRenderMethod: FrameRenderMethod = "replace",
): FrameRenderMethod {
  if (!beforeRender) return defaultRenderMethod
  const { renderer } = beforeRender

  const frameId = prepared.frameId
  let selectedRenderMethod: FrameRenderMethod | undefined
  let rendering = true
  const select = (renderMethod: FrameRenderMethod): undefined => {
    if (!rendering) {
      throw new StateError("Frame render context is no longer active", { frameId })
    }
    if (selectedRenderMethod) {
      throw new StateError("Frame renderer may select a method only once", { frameId })
    }
    selectedRenderMethod = renderMethod
    return undefined
  }
  const context = Object.freeze({
    frameId,
    newFrame: prepared.responseFrame,
    renderDefault: () => select(defaultRenderMethod),
    renderMorph: () => select("morph"),
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
  if (!selectedRenderMethod) {
    throw new StateError("Before-frame-render renderer must select a render method exactly once", {
      frameId,
    })
  }
  return selectedRenderMethod
}

export async function dispatchPreparedFrameResponseStreams(
  session: DocumentSession,
  prepared: PreparedFrameResponse,
  options: StreamActionDispatchOptions = {},
  control?: StreamDispatchControl,
): Promise<StreamDispatchReport> {
  return await dispatchEmbeddedTurboStreamElements(session, prepared.streams, options, control)
}

export async function commitPreparedFrameResponse(
  session: DocumentSession,
  activeFrame: ProtocolElement,
  prepared: PreparedFrameResponse,
  options: CommitPreparedFrameResponseOptions = {},
  control?: StreamDispatchControl,
): Promise<CommittedFrameResponse> {
  const mutation = prepareFrameMutation(session, activeFrame, prepared, options)
  commitPreparedFrameMutation(session, mutation)
  const streams = await dispatchPreparedFrameResponseStreams(session, prepared, options, control)
  return Object.freeze({
    ...(options.documentUrl !== undefined ? { documentUrl: options.documentUrl } : {}),
    ...(options.finalUrl ? { finalUrl: options.finalUrl } : {}),
    frameId: prepared.frameId,
    streams,
  })
}
