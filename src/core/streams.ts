import { applicationAutofocusCandidatesFromNodes } from "./autofocus-candidates-internal"
import type {
  CustomStreamActionRegistry,
  CustomStreamActionResult,
  DefinedStreamAction,
} from "./custom-stream-actions"
import type { DocumentRefreshRequester } from "./document-refresh-controller"
import { ActionError, type ExpoTurboError } from "./errors"
import { isExpoTurboError } from "./expo-turbo-error-internal"
import { type ParseOptions, parseTurboStreamFragment } from "./parser"
import { querySelectorAll } from "./selectors"
import { type DocumentSession, SessionCommitError } from "./session"
import { isSessionCommitError, markSessionCommitError } from "./session-commit-error-internal"
import { stageStandaloneStreamAutofocus } from "./stream-autofocus-internal"
import {
  createBeforeStreamRenderEvent,
  createStreamActionEvent,
  STREAM_LIFECYCLE_ACTION_DISPATCH,
  STREAM_LIFECYCLE_BEFORE_DISPATCH,
  type StreamLifecycle,
  type StreamRenderContext,
  type StreamRenderer,
  type StreamRenderResult,
  streamLifecycleOption,
} from "./stream-lifecycle"
import { consumeThenableResult } from "./thenable-result"
import {
  attributeValue,
  type DocumentTree,
  isElement,
  morphStreamReplaceElement,
  morphStreamUpdateChildren,
  type ProtocolElement,
  type ProtocolNode,
  type ProtocolParentNode,
} from "./tree"

const BUILT_IN_ACTIONS = new Set([
  "after",
  "append",
  "before",
  "prepend",
  "refresh",
  "remove",
  "replace",
  "update",
])

const STRUCTURAL_STREAM_AUTOFOCUS_ACTIONS = new Set([
  "after",
  "append",
  "before",
  "prepend",
  "replace",
  "update",
])

export type StreamActionStatus = "applied" | "canceled" | "error" | "noop"

export interface StreamActionReport {
  readonly action: string
  readonly appliedTargets: number
  readonly error?: ExpoTurboError
  readonly index: number
  readonly matchedTargets: number
  readonly status: StreamActionStatus
}

export interface StreamActionDispatchOptions {
  readonly customActions?: CustomStreamActionRegistry<DefinedStreamAction>
  readonly onActionError?: (report: StreamActionReport) => void
  readonly refresh?: DocumentRefreshRequester
  readonly streamLifecycle?: StreamLifecycle
}

export interface StreamDispatchOptions extends ParseOptions, StreamActionDispatchOptions {}

export interface StreamDispatchReport {
  readonly actions: readonly StreamActionReport[]
  /** True when an ownership guard stopped work that had not begun. */
  readonly interrupted: boolean
}

/** Internal staged-response guard; false stops actions that have not begun. */
export interface StreamDispatchControl {
  shouldContinue(): boolean
}

function actionError(message: string, action: string, target?: string): ActionError {
  return new ActionError(message, {
    action,
    ...(target ? { target } : {}),
  })
}

function streamCommitError(message: string, action: string): SessionCommitError {
  return markSessionCommitError(new SessionCommitError([new ActionError(message, { action })]))
}

function templatePayload(stream: ProtocolElement, action: string): readonly ProtocolNode[] {
  const firstElement = stream.children.find(isElement)
  if (!firstElement) return []
  if (firstElement.kind !== "template") {
    throw actionError("The first Turbo Stream child element must be template", action)
  }
  return firstElement.children
}

interface StandaloneStreamAutofocusCandidate {
  readonly allowRetainedIdentity: boolean
  readonly key: string
}

function hasPermanentStreamPayload(nodes: readonly ProtocolNode[]): boolean {
  for (const node of nodes) {
    if (!isElement(node)) continue
    if (attributeValue(node, "data-turbo-permanent") !== undefined) return true
    if (hasPermanentStreamPayload(node.children)) return true
  }
  return false
}

function standaloneStreamAutofocusCandidate(
  stream: ProtocolElement,
  action: string,
): StandaloneStreamAutofocusCandidate | undefined {
  const morph =
    (action === "replace" || action === "update") && attributeValue(stream, "method") === "morph"
  if (
    !STRUCTURAL_STREAM_AUTOFOCUS_ACTIONS.has(action) ||
    attributeValue(stream, "targets") !== undefined
  ) {
    return undefined
  }
  try {
    const payload = templatePayload(stream, action)
    // Native standalone autofocus does not reproduce Turbo's permanent-node
    // preprocessing, so incoming permanent attributes cannot establish focus.
    if (hasPermanentStreamPayload(payload)) return undefined
    const key = applicationAutofocusCandidatesFromNodes(payload)[0]
    return key ? Object.freeze({ allowRetainedIdentity: morph, key }) : undefined
  } catch {
    return undefined
  }
}

function assertNoPermanentMorphEnvelope(stream: ProtocolElement, action: string): void {
  const template = stream.children.find(isElement)
  if (
    attributeValue(stream, "data-turbo-permanent") !== undefined ||
    (template?.kind === "template" &&
      attributeValue(template, "data-turbo-permanent") !== undefined)
  ) {
    throw actionError(
      "Native Stream morph does not allow data-turbo-permanent on protocol envelopes",
      action,
    )
  }
}

function customParams(stream: ProtocolElement): Readonly<Record<string, string>> {
  return Object.freeze(
    Object.fromEntries(
      stream.attributes
        .filter((attribute) => attribute.name.startsWith("data-"))
        .map((attribute) => [attribute.name.slice(5), attribute.value]),
    ),
  )
}

function customResult(
  result: CustomStreamActionResult | undefined,
  matchedTargets: number,
): Readonly<{ appliedTargets: number; status: "applied" | "noop" }> {
  if (!result) return Object.freeze({ appliedTargets: matchedTargets, status: "applied" })
  if (result.status !== "applied" && result.status !== "noop") {
    throw new Error("Custom Stream action returned an invalid status")
  }
  const appliedTargets = result.appliedTargets ?? (result.status === "noop" ? 0 : matchedTargets)
  if (!Number.isInteger(appliedTargets) || appliedTargets < 0 || appliedTargets > matchedTargets) {
    throw new Error("Custom Stream action returned an invalid applied-target count")
  }
  if (result.status === "noop" && appliedTargets !== 0) {
    throw new Error("A no-op custom Stream action cannot report applied targets")
  }
  return Object.freeze({ appliedTargets, status: result.status })
}

function dispatchCustomAction(
  session: DocumentSession,
  stream: ProtocolElement,
  definition: DefinedStreamAction,
): Readonly<{ appliedTargets: number; matchedTargets: number; status: "applied" | "noop" }> {
  const action = definition.action
  const hasTarget =
    attributeValue(stream, "target") !== undefined ||
    attributeValue(stream, "targets") !== undefined
  const targets = hasTarget ? resolveTargets(session.tree, stream, action) : []
  const revision = session.revision
  try {
    const params = definition.decodeParams(customParams(stream))
    const result = definition.handler(
      Object.freeze({
        action,
        params,
        session,
        stream,
        targets: Object.freeze([...targets]),
        template: Object.freeze([...templatePayload(stream, action)]),
      }),
    )
    if (consumeThenableResult(result)) {
      if (session.revision !== revision) {
        throw streamCommitError("Asynchronous custom Stream action mutated the session", action)
      }
      throw actionError("Custom Stream action handlers must be synchronous", action)
    }
    return Object.freeze({
      ...customResult(result, targets.length),
      matchedTargets: targets.length,
    })
  } catch (error) {
    if (isSessionCommitError(error)) throw error
    if (session.revision !== revision) {
      throw streamCommitError("Custom Stream action failed after mutating the session", action)
    }
    throw actionError("Custom Stream action failed", action)
  }
}

function resolveTargets(
  tree: DocumentTree,
  stream: ProtocolElement,
  action: string,
): readonly ProtocolElement[] {
  const target = attributeValue(stream, "target")
  if (target !== undefined) {
    if (!target.trim()) throw actionError("Turbo Stream target must not be blank", action)
    const element = tree.getElementById(target)
    return element ? [element] : []
  }

  const targets = attributeValue(stream, "targets")
  if (targets !== undefined) {
    if (!targets.trim()) throw actionError("Turbo Stream targets must not be blank", action)
    return querySelectorAll(tree, targets)
  }

  throw actionError(
    `Turbo Stream action ${JSON.stringify(action)} requires target or targets`,
    action,
  )
}

function topLevelIds(nodes: readonly ProtocolNode[]): readonly string[] {
  return nodes.flatMap((node) => {
    if (!isElement(node)) return []
    const id = attributeValue(node, "id")
    return id ? [id] : []
  })
}

function allIds(nodes: readonly ProtocolNode[]): readonly string[] {
  const ids: string[] = []
  const visit = (node: ProtocolNode) => {
    if (!isElement(node)) return
    const id = attributeValue(node, "id")
    if (id) ids.push(id)
    for (const child of node.children) visit(child)
  }
  for (const node of nodes) visit(node)
  return ids
}

function isWithin(node: ProtocolNode, root: ProtocolNode): boolean {
  let current: ProtocolNode | null = node
  while (current) {
    if (current === root) return true
    current = current.parent
  }
  return false
}

function assertIdsAvailable(
  tree: DocumentTree,
  payload: readonly ProtocolNode[],
  removals: readonly ProtocolNode[],
  action: string,
): void {
  const seen = new Set<string>()
  for (const id of allIds(payload)) {
    if (seen.has(id)) {
      throw actionError(
        `Turbo Stream payload id ${JSON.stringify(id)} is declared more than once`,
        action,
        id,
      )
    }
    seen.add(id)
    const existing = tree.getElementById(id)
    if (!existing || removals.some((root) => isWithin(existing, root))) continue
    throw actionError(`Turbo Stream payload id ${JSON.stringify(id)} already exists`, action, id)
  }
}

function directCollisions(
  parent: ProtocolParentNode,
  payload: readonly ProtocolNode[],
): readonly ProtocolNode[] {
  const ids = new Set(topLevelIds(payload))
  if (ids.size === 0) return []
  return parent.children.filter(
    (child) => isElement(child) && ids.has(attributeValue(child, "id") ?? ""),
  )
}

function mutate(
  session: DocumentSession,
  operation: (tree: DocumentTree) => readonly string[],
): void {
  session.mutate(operation)
}

function applyToTarget(
  session: DocumentSession,
  action: string,
  target: ProtocolElement,
  payload: readonly ProtocolNode[],
  morph = false,
): boolean {
  const tree = session.tree
  if (!tree.contains(target)) return false

  if (action === "remove") {
    mutate(session, (activeTree) => activeTree.removeNode(target))
    return true
  }

  if (action === "replace") {
    if (morph) {
      mutate(session, (activeTree) => morphStreamReplaceElement(activeTree, target, payload))
      return true
    }
    assertIdsAvailable(tree, payload, [target], action)
    mutate(session, (activeTree) => activeTree.replaceNodeWithClones(target, payload))
    return true
  }

  if (action === "update") {
    if (morph) {
      mutate(session, (activeTree) => morphStreamUpdateChildren(activeTree, target, payload))
      return true
    }
    assertIdsAvailable(tree, payload, target.children, action)
    mutate(session, (activeTree) => activeTree.replaceChildrenWithClones(target, payload))
    return true
  }

  if (payload.length === 0) return false

  if (action === "append" || action === "prepend") {
    const collisions = directCollisions(target, payload)
    assertIdsAvailable(tree, payload, collisions, action)
    mutate(session, (activeTree) => {
      const changed: string[] = []
      for (const collision of collisions) changed.push(...activeTree.removeNode(collision))
      const index = action === "append" ? target.children.length : 0
      changed.push(...activeTree.insertClones(target, index, payload))
      return changed
    })
    return true
  }

  const parent = target.parent
  if (!parent) throw actionError("Relative Turbo Stream target is detached", action)
  const collisions = directCollisions(parent, payload)
  assertIdsAvailable(tree, payload, collisions, action)
  mutate(session, (activeTree) => {
    const changed: string[] = []
    for (const collision of collisions) changed.push(...activeTree.removeNode(collision))
    if (!activeTree.contains(target)) return changed
    const targetIndex = parent.children.indexOf(target)
    if (targetIndex === -1) throw actionError("Relative Turbo Stream target is detached", action)
    const index = action === "before" ? targetIndex : targetIndex + 1
    changed.push(...activeTree.insertClones(parent, index, payload))
    return changed
  })
  return true
}

interface StreamActionProgress {
  appliedTargets: number
  autofocusCandidates: ProtocolNode[]
  matchedTargets: number
  ownershipInterrupted: boolean
}

interface StreamActionDispatchResult {
  readonly autofocusCandidates: readonly ProtocolNode[]
  readonly ownershipInterrupted: boolean
  readonly report: StreamActionReport
}

type StreamAutofocusMode = "embedded" | "standalone"

const STREAM_RENDER_INTERRUPTED = Symbol("expo-turbo.stream-render-interrupted")

function renderAction(
  session: DocumentSession,
  stream: ProtocolElement,
  action: string,
  options: StreamActionDispatchOptions,
  progress: StreamActionProgress,
  control?: StreamDispatchControl,
): StreamRenderResult {
  if (!action) throw actionError("Turbo Stream action must not be blank", action)
  if (action === "refresh") {
    if (!options.refresh) {
      throw actionError("Turbo Stream refresh requires a document refresh controller", action)
    }
    const baseUrl = session.tree.document.url
    if (!baseUrl) throw actionError("Turbo Stream refresh requires an active document URL", action)
    const method = attributeValue(stream, "method")
    const requestId = attributeValue(stream, "request-id")
    const scroll = attributeValue(stream, "scroll")
    options.refresh.request(
      Object.freeze({
        baseUrl,
        ...(method !== undefined ? { method } : {}),
        ...(requestId !== undefined ? { requestId } : {}),
        ...(scroll !== undefined ? { scroll } : {}),
      }),
    )
    return Object.freeze({ appliedTargets: 0, matchedTargets: 0, status: "applied" })
  }
  if (!BUILT_IN_ACTIONS.has(action)) {
    const customAction = options.customActions?.resolve(action)
    if (!customAction) {
      throw actionError(`Unknown Turbo Stream action ${JSON.stringify(action)}`, action)
    }
    const result = dispatchCustomAction(session, stream, customAction)
    progress.appliedTargets = result.appliedTargets
    progress.matchedTargets = result.matchedTargets
    return result
  }
  const morph = attributeValue(stream, "method") === "morph"
  if (
    (action === "replace" || action === "update") &&
    morph &&
    attributeValue(stream, "target") === undefined
  ) {
    throw actionError("Native Turbo Stream morph requires an exact target", action)
  }
  if ((action === "replace" || action === "update") && morph) {
    assertNoPermanentMorphEnvelope(stream, action)
  }
  const targets = resolveTargets(session.tree, stream, action)
  const payload = action === "remove" ? [] : templatePayload(stream, action)
  const autofocusCandidate = standaloneStreamAutofocusCandidate(stream, action)
  const autofocusCandidates = autofocusCandidate ? [autofocusCandidate.key] : []
  progress.matchedTargets = targets.length
  if (targets.length > 1 && allIds(payload).length > 0) {
    throw actionError("Multi-target Turbo Stream payloads must not declare ids", action)
  }

  for (const target of targets) {
    if (control && !control.shouldContinue()) {
      progress.ownershipInterrupted = true
      break
    }
    if (!session.tree.contains(target)) continue
    if (applyToTarget(session, action, target, payload, morph)) {
      progress.appliedTargets += 1
      for (const candidate of autofocusCandidates) {
        const active = session.tree.getNodeByKey(candidate)
        if (active) progress.autofocusCandidates.push(active)
      }
    }
  }

  return Object.freeze({
    appliedTargets: progress.appliedTargets,
    matchedTargets: progress.matchedTargets,
    status: progress.appliedTargets === 0 ? "noop" : "applied",
  })
}

function dispatchAction(
  session: DocumentSession,
  stream: ProtocolElement,
  index: number,
  options: StreamActionDispatchOptions,
  lifecycle: StreamLifecycle | undefined,
  control?: StreamDispatchControl,
): StreamActionDispatchResult {
  const action = attributeValue(stream, "action") ?? ""
  const progress: StreamActionProgress = {
    appliedTargets: 0,
    autofocusCandidates: [],
    matchedTargets: 0,
    ownershipInterrupted: false,
  }
  let ownershipInterrupted = false
  let report: StreamActionReport
  try {
    if (control && !control.shouldContinue()) {
      ownershipInterrupted = true
      throw STREAM_RENDER_INTERRUPTED
    }
    let result: StreamRenderResult
    if (!lifecycle) {
      result = renderAction(session, stream, action, options, progress, control)
    } else {
      let defaultResult: StreamRenderResult | undefined
      let defaultRendered = false
      let defaultFailure: unknown
      let fatalDefaultError: unknown
      let renderInterrupted = false
      let rendering = true
      const context = Object.freeze({
        action,
        index,
        newStream: stream,
        renderDefault(): StreamRenderResult {
          if (!rendering) {
            throw actionError("The Stream render context is no longer active", action)
          }
          if (defaultRendered) {
            throw actionError("The default Stream renderer may run only once", action)
          }
          if (control && !control.shouldContinue()) {
            ownershipInterrupted = true
            renderInterrupted = true
            throw STREAM_RENDER_INTERRUPTED
          }
          defaultRendered = true
          try {
            defaultResult = renderAction(session, stream, action, options, progress, control)
            return defaultResult
          } catch (error) {
            defaultFailure = error
            if (isSessionCommitError(error)) fatalDefaultError = error
            throw error
          }
        },
        session,
      }) satisfies StreamRenderContext
      const defaultRenderer: StreamRenderer = (activeContext) => {
        if (activeContext !== context) {
          throw actionError("Stream renderer received an invalid context", action)
        }
        return activeContext.renderDefault()
      }
      const event = createBeforeStreamRenderEvent(action, index, stream, defaultRenderer)
      const beforeRevision = session.revision
      try {
        lifecycle[STREAM_LIFECYCLE_BEFORE_DISPATCH](event)
      } catch (error) {
        if (isSessionCommitError(error)) throw error
        if (session.revision !== beforeRevision) {
          throw streamCommitError("Before-stream-render failed after mutating the session", action)
        }
        throw error
      }
      if (control && !control.shouldContinue()) {
        ownershipInterrupted = true
        throw STREAM_RENDER_INTERRUPTED
      }
      if (event.defaultPrevented) {
        throw STREAM_RENDER_INTERRUPTED
      }
      const renderer = event.detail.render
      const rendererRevision = session.revision
      let candidate: unknown
      try {
        try {
          candidate = renderer(context)
        } finally {
          rendering = false
        }
      } catch (error) {
        if (fatalDefaultError) throw fatalDefaultError
        if (renderInterrupted) throw STREAM_RENDER_INTERRUPTED
        if (renderer === defaultRenderer && error === defaultFailure) throw error
        throw actionError("Stream renderer failed", action)
      }
      if (fatalDefaultError) throw fatalDefaultError
      if (renderInterrupted) throw STREAM_RENDER_INTERRUPTED
      if (consumeThenableResult(candidate)) {
        if (session.revision !== rendererRevision) {
          throw streamCommitError("Asynchronous Stream renderer mutated the session", action)
        }
        throw actionError("Stream renderers must be synchronous", action)
      }
      if (defaultRendered && candidate !== defaultResult) {
        throw actionError("A wrapped Stream renderer must return the default result", action)
      }
      result = admitRenderResult(candidate, action)
    }
    report = actionReport(action, index, result)
  } catch (error) {
    if (isSessionCommitError(error)) throw error
    if (error === STREAM_RENDER_INTERRUPTED) {
      report = Object.freeze({
        action,
        appliedTargets: progress.appliedTargets,
        index,
        matchedTargets: progress.matchedTargets,
        status: "canceled",
      })
    } else {
      const protocolError = isExpoTurboError(error)
        ? (error as ExpoTurboError)
        : actionError("Turbo Stream action failed", action)
      report = Object.freeze({
        action,
        appliedTargets: progress.appliedTargets,
        error: protocolError,
        index,
        matchedTargets: progress.matchedTargets,
        status: "error",
      })
    }
  }
  lifecycle?.[STREAM_LIFECYCLE_ACTION_DISPATCH](createStreamActionEvent(stream, report))
  return Object.freeze({
    autofocusCandidates: Object.freeze([...progress.autofocusCandidates]),
    ownershipInterrupted: ownershipInterrupted || progress.ownershipInterrupted,
    report,
  })
}

function actionReport(
  action: string,
  index: number,
  result: StreamRenderResult,
): StreamActionReport {
  return Object.freeze({ action, index, ...result })
}

function admitRenderResult(candidate: unknown, action: string): StreamRenderResult {
  let appliedTargets: unknown
  let matchedTargets: unknown
  let status: unknown
  try {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new TypeError("invalid result")
    }
    appliedTargets = (candidate as StreamRenderResult).appliedTargets
    matchedTargets = (candidate as StreamRenderResult).matchedTargets
    status = (candidate as StreamRenderResult).status
  } catch (error) {
    if (isSessionCommitError(error)) throw error
    throw actionError("Stream renderer returned an invalid result", action)
  }
  if (
    !Number.isInteger(appliedTargets) ||
    (appliedTargets as number) < 0 ||
    !Number.isInteger(matchedTargets) ||
    (matchedTargets as number) < 0 ||
    (appliedTargets as number) > (matchedTargets as number) ||
    (status !== "applied" && status !== "noop") ||
    (status === "noop" && appliedTargets !== 0)
  ) {
    throw actionError("Stream renderer returned an invalid result", action)
  }
  return Object.freeze({
    appliedTargets: appliedTargets as number,
    matchedTargets: matchedTargets as number,
    status,
  })
}

export function dispatchTurboStreamFragment(
  session: DocumentSession,
  xml: string,
  options: StreamDispatchOptions = {},
): StreamDispatchReport {
  const fragment = parseTurboStreamFragment(xml, options)
  const streams = fragment.document.children.filter(
    (node): node is ProtocolElement => isElement(node) && node.kind === "stream",
  )
  return dispatchTurboStreamElements(session, streams, options)
}

export function dispatchTurboStreamElements(
  session: DocumentSession,
  streams: readonly ProtocolElement[],
  options: StreamActionDispatchOptions = {},
): StreamDispatchReport {
  return dispatchGuardedTurboStreamElements(session, streams, options)
}

/** Internal response path for Streams embedded in a document or Frame payload. */
export function dispatchEmbeddedTurboStreamElements(
  session: DocumentSession,
  streams: readonly ProtocolElement[],
  options: StreamActionDispatchOptions = {},
  control?: StreamDispatchControl,
): StreamDispatchReport {
  return dispatchGuardedTurboStreamElements(session, streams, options, control, "embedded")
}

/** Internal staged-response entry point; intentionally omitted from the public core barrel. */
export function dispatchGuardedTurboStreamElements(
  session: DocumentSession,
  streams: readonly ProtocolElement[],
  options: StreamActionDispatchOptions = {},
  control?: StreamDispatchControl,
  autofocusMode: StreamAutofocusMode = "standalone",
): StreamDispatchReport {
  const revision = session.revision
  const lifecycle = streamLifecycleOption(options, "Turbo Stream dispatcher")
  const actions: StreamActionReport[] = []
  let autofocusCandidate: ProtocolNode | undefined
  let autofocusCandidateClaimed = false
  let interrupted = false
  for (const [index, stream] of streams.entries()) {
    if (control && !control.shouldContinue()) {
      interrupted = true
      break
    }
    const action = attributeValue(stream, "action") ?? ""
    const candidate =
      !autofocusCandidateClaimed && autofocusMode === "standalone"
        ? standaloneStreamAutofocusCandidate(stream, action)
        : undefined
    const candidateBefore = candidate ? session.tree.getNodeByKey(candidate.key) : undefined
    if (candidate) autofocusCandidateClaimed = true
    const dispatched = dispatchAction(session, stream, index, options, lifecycle, control)
    const report = dispatched.report
    actions.push(report)
    if (candidate && report.status === "applied") {
      const activeCandidate = session.tree.getNodeByKey(candidate.key)
      if (
        activeCandidate &&
        (candidate.allowRetainedIdentity || activeCandidate !== candidateBefore) &&
        dispatched.autofocusCandidates.includes(activeCandidate)
      ) {
        autofocusCandidate = activeCandidate
      }
    }
    if (report.status === "error") options.onActionError?.(report)
    if (
      control &&
      !control.shouldContinue() &&
      (dispatched.ownershipInterrupted || index + 1 < streams.length)
    ) {
      interrupted = true
    }
  }
  if (
    autofocusMode === "standalone" &&
    session.revision !== revision &&
    !interrupted &&
    (!control || control.shouldContinue())
  ) {
    stageStandaloneStreamAutofocus(session, autofocusCandidate ? [autofocusCandidate] : [])
  }
  return Object.freeze({ actions: Object.freeze(actions), interrupted })
}
