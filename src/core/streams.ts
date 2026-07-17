import { ActionError, ExpoTurboError } from "./errors"
import { type ParseOptions, parseTurboStreamFragment } from "./parser"
import { querySelectorAll } from "./selectors"
import type { DocumentSession } from "./session"
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

export interface StreamDispatchOptions extends ParseOptions {
  readonly onActionError?: (report: StreamActionReport) => void
}

export interface StreamDispatchReport {
  readonly actions: readonly StreamActionReport[]
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
  for (const id of allIds(payload)) {
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
): StreamActionReport {
  const action = attributeValue(stream, "action") ?? ""
  let matchedTargets = 0
  let appliedTargets = 0
  try {
    if (!action) throw actionError("Turbo Stream action must not be blank", action)
    if (!BUILT_IN_ACTIONS.has(action)) {
      throw actionError(`Unknown Turbo Stream action ${JSON.stringify(action)}`, action)
    }
    const targets = resolveTargets(session.tree, stream, action)
    const payload = action === "remove" ? [] : templatePayload(stream, action)
    matchedTargets = targets.length
    if (targets.length > 1 && allIds(payload).length > 0) {
      throw actionError("Multi-target Turbo Stream payloads must not declare ids", action)
    }

    for (const target of targets) {
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
  const actions = streams.map((stream, index) => dispatchAction(session, stream, index))
  for (const report of actions) {
    if (report.status === "error") options.onActionError?.(report)
  }
  return Object.freeze({ actions: Object.freeze(actions) })
}
