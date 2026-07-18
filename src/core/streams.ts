import type {
  CustomStreamActionRegistry,
  CustomStreamActionResult,
  DefinedStreamAction,
} from "./custom-stream-actions"
import type { DocumentRefreshRequester } from "./document-refresh-controller"
import { ActionError, ExpoTurboError } from "./errors"
import { type ParseOptions, parseTurboStreamFragment } from "./parser"
import { querySelectorAll } from "./selectors"
import { type DocumentSession, SessionCommitError } from "./session"
import {
  attributeValue,
  type DocumentTree,
  isElement,
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

export type StreamActionStatus = "applied" | "error" | "noop"

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

function templatePayload(stream: ProtocolElement, action: string): readonly ProtocolNode[] {
  const firstElement = stream.children.find(isElement)
  if (!firstElement) return []
  if (firstElement.kind !== "template") {
    throw actionError("The first Turbo Stream child element must be template", action)
  }
  return firstElement.children
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
  const maybePromise = result as unknown as Readonly<{ then?: unknown }> | undefined
  if (typeof maybePromise?.then === "function") {
    throw new Error("Custom Stream action handlers must be synchronous")
  }
  return Object.freeze({ ...customResult(result, targets.length), matchedTargets: targets.length })
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
): boolean {
  const tree = session.tree
  if (!tree.contains(target)) return false

  if (action === "remove") {
    mutate(session, (activeTree) => activeTree.removeNode(target))
    return true
  }

  if (action === "replace") {
    assertIdsAvailable(tree, payload, [target], action)
    mutate(session, (activeTree) => activeTree.replaceNodeWithClones(target, payload))
    return true
  }

  if (action === "update") {
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

function dispatchAction(
  session: DocumentSession,
  stream: ProtocolElement,
  index: number,
  options: StreamActionDispatchOptions,
  control?: StreamDispatchControl,
): StreamActionReport {
  const action = attributeValue(stream, "action") ?? ""
  let matchedTargets = 0
  let appliedTargets = 0
  try {
    if (!action) throw actionError("Turbo Stream action must not be blank", action)
    if (action === "refresh") {
      if (!options.refresh) {
        throw actionError("Turbo Stream refresh requires a document refresh controller", action)
      }
      const baseUrl = session.tree.document.url
      if (!baseUrl)
        throw actionError("Turbo Stream refresh requires an active document URL", action)
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
      return Object.freeze({
        action,
        appliedTargets: 0,
        index,
        matchedTargets: 0,
        status: "applied",
      })
    }
    if (!BUILT_IN_ACTIONS.has(action)) {
      const customAction = options.customActions?.resolve(action)
      if (!customAction) {
        throw actionError(`Unknown Turbo Stream action ${JSON.stringify(action)}`, action)
      }
      const result = dispatchCustomAction(session, stream, customAction)
      return Object.freeze({
        action,
        appliedTargets: result.appliedTargets,
        index,
        matchedTargets: result.matchedTargets,
        status: result.status,
      })
    }
    if (
      (action === "replace" || action === "update") &&
      attributeValue(stream, "method") === "morph"
    ) {
      throw actionError("Native Turbo Stream morph method requires morph support", action)
    }
    const targets = resolveTargets(session.tree, stream, action)
    const payload = action === "remove" ? [] : templatePayload(stream, action)
    matchedTargets = targets.length
    if (targets.length > 1 && allIds(payload).length > 0) {
      throw actionError("Multi-target Turbo Stream payloads must not declare ids", action)
    }

    for (const target of targets) {
      if (control && !control.shouldContinue()) break
      if (!session.tree.contains(target)) continue
      if (applyToTarget(session, action, target, payload)) appliedTargets += 1
    }

    return Object.freeze({
      action,
      appliedTargets,
      index,
      matchedTargets,
      status: appliedTargets === 0 ? "noop" : "applied",
    })
  } catch (error) {
    if (error instanceof SessionCommitError) throw error
    const protocolError =
      error instanceof ExpoTurboError
        ? error
        : actionError(error instanceof Error ? error.message : "Turbo Stream action failed", action)
    return Object.freeze({
      action,
      appliedTargets,
      error: protocolError,
      index,
      matchedTargets,
      status: "error",
    })
  }
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

/** Internal staged-response entry point; intentionally omitted from the public core barrel. */
export function dispatchGuardedTurboStreamElements(
  session: DocumentSession,
  streams: readonly ProtocolElement[],
  options: StreamActionDispatchOptions = {},
  control?: StreamDispatchControl,
): StreamDispatchReport {
  const actions: StreamActionReport[] = []
  let interrupted = false
  for (const [index, stream] of streams.entries()) {
    if (control && !control.shouldContinue()) {
      interrupted = true
      break
    }
    const report = dispatchAction(session, stream, index, options, control)
    actions.push(report)
    if (report.status === "error") options.onActionError?.(report)
    if (
      control &&
      !control.shouldContinue() &&
      (report.appliedTargets < report.matchedTargets || index + 1 < streams.length)
    ) {
      interrupted = true
    }
  }
  return Object.freeze({ actions: Object.freeze(actions), interrupted })
}
