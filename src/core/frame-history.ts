import type { VisitAction } from "../adapters"
import type { DocumentHistory, DocumentHistoryEntry } from "./document-history"
import { currentDocumentNavigationEpoch } from "./document-navigation-epoch"
import type { DocumentSnapshotCache } from "./document-snapshot-cache"
import { StateError, TargetError } from "./errors"
import type { FrameTreeCommitCandidate } from "./frame-loader"
import { resolveProtocolUrl } from "./protocol-request"
import type { DocumentSession } from "./session"
import { attributeValue, type DocumentTree, type ProtocolElement } from "./tree"
import { classifyTopLevelLocation } from "./visitability"

export type FrameHistoryAction = Exclude<VisitAction, "restore">

export interface FrameHistoryCoordinatorOptions {
  readonly history: DocumentHistory
  readonly snapshotCache?: DocumentSnapshotCache
}

declare const FRAME_HISTORY_COMMIT_PLAN: unique symbol

interface FrameHistoryCommitPlan {
  readonly [FRAME_HISTORY_COMMIT_PLAN]: true
}

interface FrameHistoryCommitPlanState {
  readonly action: FrameHistoryAction
  readonly documentNavigationEpoch: number
  readonly frame: ProtocolElement
  readonly frameScope: object
  readonly history: DocumentHistory
  readonly requestedUrl: string
  readonly session: DocumentSession
  readonly snapshot?: DocumentTree
  readonly snapshotCache?: DocumentSnapshotCache
  readonly snapshotUrl: string
  status: "committed" | "ready"
}

interface FrameHistoryCoordinatorState {
  readonly history: DocumentHistory
  readonly session: DocumentSession
  readonly snapshotCache?: DocumentSnapshotCache
}

const frameHistoryCommitPlans = new WeakMap<FrameHistoryCommitPlan, FrameHistoryCommitPlanState>()
const frameHistoryCoordinators = new WeakMap<
  FrameHistoryCoordinator,
  FrameHistoryCoordinatorState
>()

export const FRAME_HISTORY_PLAN_OPTION = Symbol("frameHistoryPlanOption")

function canonicalDocumentUrl(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    return resolveProtocolUrl(value, value).url
  } catch {
    throw new StateError("Active Frame history requires a valid credential-free HTTP(S) URL")
  }
}

function planState(plan: FrameHistoryCommitPlan): FrameHistoryCommitPlanState {
  const state = frameHistoryCommitPlans.get(plan)
  if (state?.status !== "ready") {
    throw new StateError("Frame history commit plan is invalid")
  }
  return state
}

function validateCandidate(
  state: FrameHistoryCommitPlanState,
  session: DocumentSession,
  frame: ProtocolElement,
  candidate: FrameTreeCommitCandidate,
): void {
  if (
    state.session !== session ||
    state.frame !== frame ||
    candidate.frameId !== attributeValue(frame, "id") ||
    candidate.requestedUrl !== state.requestedUrl
  ) {
    throw new StateError("Frame history commit plan does not match the response")
  }
  if (currentDocumentNavigationEpoch(session) !== state.documentNavigationEpoch) {
    throw new StateError("Frame history commit plan was superseded by document navigation")
  }
}

function validateRequest(
  state: FrameHistoryCommitPlanState,
  session: DocumentSession,
  frame: ProtocolElement,
  requestedUrl: string,
): void {
  if (state.session !== session || state.frame !== frame || state.requestedUrl !== requestedUrl) {
    throw new StateError("Frame history commit plan does not match the request")
  }
}

function setFrameSource(
  state: FrameHistoryCommitPlanState,
  session: DocumentSession,
  frame: ProtocolElement,
  source: string,
): void {
  if (state.session !== session || state.frame !== frame) {
    throw new StateError("Frame history commit plan does not match the request")
  }
  if (attributeValue(frame, "src") !== source) session.setAttribute(frame.key, "src", source)
}

/** Coordinates promoted Frame history without owning document visit lifecycle or traversal. */
export class FrameHistoryCoordinator {
  constructor(session: DocumentSession, options: FrameHistoryCoordinatorOptions) {
    this.coordinatorBrand()
    if (!options || typeof options !== "object" || Array.isArray(options)) {
      throw new TargetError("Frame history coordinator options must be an object")
    }
    if (!options.history) {
      throw new TargetError("Frame history coordination requires a history ledger")
    }
    frameHistoryCoordinators.set(this, {
      history: options.history,
      session,
      ...(options.snapshotCache ? { snapshotCache: options.snapshotCache } : {}),
    })
  }

  private coordinatorBrand(): void {}
}

export function prepareFrameHistoryCommit(
  coordinator: FrameHistoryCoordinator,
  frameScope: object,
  frame: ProtocolElement,
  requestedUrl: string,
  action: FrameHistoryAction,
): FrameHistoryCommitPlan {
  const coordinatorState = frameHistoryCoordinators.get(coordinator)
  if (!coordinatorState) throw new StateError("Frame history coordinator is invalid")
  if (action !== "advance" && action !== "replace") {
    throw new TargetError("Frame history action is unsupported")
  }
  const { history, session, snapshotCache } = coordinatorState
  const disposition = classifyTopLevelLocation(session.tree, requestedUrl)
  if (disposition.classification !== "visitable") {
    throw new TargetError("Promoted Frame visits require a root-visitable destination")
  }
  const frameId = attributeValue(frame, "id")
  if (frame.kind !== "frame" || !frameId || session.tree.getElementById(frameId) !== frame) {
    throw new StateError("Frame history requires an exact active Frame", {
      ...(frameId ? { frameId } : {}),
    })
  }

  const base = history.current
  if (!base || canonicalDocumentUrl(session.tree.document.url) !== base.url) {
    throw new StateError("Document history must match the active document before Frame promotion")
  }
  const tree = session.tree
  const treeGeneration = session.treeGeneration
  const snapshot = snapshotCache ? tree.clone() : undefined
  if (
    session.tree !== tree ||
    session.treeGeneration !== treeGeneration ||
    session.tree.getElementById(frameId) !== frame ||
    canonicalDocumentUrl(session.tree.document.url) !== base.url ||
    history.current !== base
  ) {
    throw new StateError("Document history or the active Frame changed during promotion planning")
  }

  const plan = Object.freeze({}) as FrameHistoryCommitPlan
  frameHistoryCommitPlans.set(plan, {
    action,
    documentNavigationEpoch: currentDocumentNavigationEpoch(session),
    frame,
    frameScope,
    history,
    requestedUrl: disposition.url,
    session,
    ...(snapshot ? { snapshot } : {}),
    ...(snapshotCache ? { snapshotCache } : {}),
    snapshotUrl: base.url,
    status: "ready",
  })
  return plan
}

export function assertFrameHistoryCommitPlan(
  value: unknown,
): asserts value is FrameHistoryCommitPlan {
  if (!value || typeof value !== "object" || !frameHistoryCommitPlans.has(value as never)) {
    throw new StateError("Frame history commit plan is invalid")
  }
  planState(value as FrameHistoryCommitPlan)
}

export function beginFrameHistoryRequest(
  plan: FrameHistoryCommitPlan,
  session: DocumentSession,
  frame: ProtocolElement,
  requestedUrl: string,
): void {
  const state = planState(plan)
  validateRequest(state, session, frame, requestedUrl)
  setFrameSource(state, session, frame, requestedUrl)
}

export function updateFrameHistoryResponseSource(
  plan: FrameHistoryCommitPlan,
  session: DocumentSession,
  frame: ProtocolElement,
  finalUrl: string,
): void {
  const state = planState(plan)
  setFrameSource(state, session, frame, finalUrl)
}

export function frameHistoryPlanCurrent(
  plan: FrameHistoryCommitPlan,
  session: DocumentSession,
  frame: ProtocolElement,
): boolean {
  const state = planState(plan)
  if (state.session !== session || state.frame !== frame) {
    throw new StateError("Frame history commit plan does not match the request")
  }
  return currentDocumentNavigationEpoch(session) === state.documentNavigationEpoch
}

export function frameHistoryDocumentUrl(
  plan: FrameHistoryCommitPlan,
  session: DocumentSession,
  frame: ProtocolElement,
  candidate: FrameTreeCommitCandidate,
): string {
  const state = planState(plan)
  validateCandidate(state, session, frame, candidate)
  return candidate.url
}

export function commitFrameHistoryPlan(
  plan: FrameHistoryCommitPlan,
  session: DocumentSession,
  frame: ProtocolElement,
  candidate: FrameTreeCommitCandidate,
): DocumentHistoryEntry {
  const state = planState(plan)
  validateCandidate(state, session, frame, candidate)
  const frameId = candidate.frameId
  const current = state.history.current
  if (
    !current ||
    canonicalDocumentUrl(session.tree.document.url) !== current.url ||
    session.tree.getElementById(frameId) !== frame
  ) {
    throw new StateError("Frame history proposal is stale", { frameId })
  }

  const proposal =
    state.action === "replace"
      ? state.history.proposeFrameReplace(state.frameScope, candidate.url)
      : state.history.proposeFrameAdvance(state.frameScope, candidate.url)
  const tree = session.tree
  const treeGeneration = session.treeGeneration
  const revision = session.revision
  if (state.snapshot && state.snapshotCache) {
    state.snapshotCache.put(state.snapshotUrl, state.snapshot)
  }
  if (
    session.tree !== tree ||
    session.treeGeneration !== treeGeneration ||
    session.revision !== revision ||
    session.tree.getElementById(frameId) !== frame ||
    canonicalDocumentUrl(session.tree.document.url) !== current.url ||
    state.history.current !== current
  ) {
    throw new StateError("Frame history changed during snapshot capture", { frameId })
  }

  const entry = state.history.commitProposal(proposal)
  state.status = "committed"
  return entry
}

export type { FrameHistoryCommitPlan }
