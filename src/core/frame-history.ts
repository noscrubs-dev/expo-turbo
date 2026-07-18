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
declare const FRAME_FORM_HISTORY_PLAN: unique symbol

interface FrameHistoryCommitPlan {
  readonly [FRAME_HISTORY_COMMIT_PLAN]: true
}

interface FrameFormHistoryPlan {
  readonly [FRAME_FORM_HISTORY_PLAN]: true
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

interface FrameFormHistoryPlanState {
  readonly action: FrameHistoryAction
  readonly documentNavigationEpoch: number
  readonly frame: ProtocolElement
  readonly frameScope: object
  readonly history: DocumentHistory
  readonly isMounted: () => boolean
  readonly requestedUrl: string
  readonly session: DocumentSession
  snapshot?: DocumentTree
  readonly snapshotCache?: DocumentSnapshotCache
  snapshotUrl?: string
  responseUrl?: string
  status: "admitted" | "committed" | "ready" | "staged"
}

const frameHistoryCommitPlans = new WeakMap<FrameHistoryCommitPlan, FrameHistoryCommitPlanState>()
const frameFormHistoryPlans = new WeakMap<FrameFormHistoryPlan, FrameFormHistoryPlanState>()
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

function formPlanState(
  plan: FrameFormHistoryPlan,
  allowed: readonly FrameFormHistoryPlanState["status"][] = ["admitted", "ready", "staged"],
): FrameFormHistoryPlanState {
  const state = frameFormHistoryPlans.get(plan)
  if (!state || !allowed.includes(state.status)) {
    throw new StateError("Frame form history plan is invalid")
  }
  return state
}

function validateFormPlanIdentity(
  state: FrameFormHistoryPlanState,
  session: DocumentSession,
  frame: ProtocolElement,
  requestedUrl: string,
): void {
  if (state.session !== session || state.frame !== frame || state.requestedUrl !== requestedUrl) {
    throw new StateError("Frame form history plan does not match the request")
  }
}

function formPlanCurrent(state: FrameFormHistoryPlanState): boolean {
  const frameId = attributeValue(state.frame, "id")
  const current = state.history.current
  return Boolean(
    frameId &&
      currentDocumentNavigationEpoch(state.session) === state.documentNavigationEpoch &&
      state.session.tree.getElementById(frameId) === state.frame &&
      state.isMounted() &&
      current &&
      canonicalDocumentUrl(state.session.tree.document.url) === current.url,
  )
}

function formResponseUrl(state: FrameFormHistoryPlanState, finalUrl: string): string {
  const disposition = classifyTopLevelLocation(state.session.tree, finalUrl)
  if (disposition.classification !== "visitable" || disposition.url.includes("#")) {
    throw new TargetError("Promoted Frame form responses require a root-visitable destination")
  }
  return disposition.url
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

export function prepareFrameFormHistoryCommit(
  coordinator: FrameHistoryCoordinator,
  frameScope: object,
  isMounted: () => boolean,
  frame: ProtocolElement,
  requestedUrl: string,
  action: FrameHistoryAction,
): FrameFormHistoryPlan {
  const coordinatorState = frameHistoryCoordinators.get(coordinator)
  if (!coordinatorState) throw new StateError("Frame history coordinator is invalid")
  if (action !== "advance" && action !== "replace") {
    throw new TargetError("Frame form history action is unsupported")
  }
  if (typeof isMounted !== "function" || !isMounted()) {
    throw new StateError("Frame form history requires an exact mounted Frame controller")
  }
  const { history, session, snapshotCache } = coordinatorState
  const disposition = classifyTopLevelLocation(session.tree, requestedUrl)
  if (disposition.classification !== "visitable" || disposition.url.includes("#")) {
    throw new TargetError("Promoted Frame forms require a root-visitable destination")
  }
  const frameId = attributeValue(frame, "id")
  if (frame.kind !== "frame" || !frameId || session.tree.getElementById(frameId) !== frame) {
    throw new StateError("Frame form history requires an exact active Frame", {
      ...(frameId ? { frameId } : {}),
    })
  }
  const current = history.current
  if (!current || canonicalDocumentUrl(session.tree.document.url) !== current.url) {
    throw new StateError(
      "Document history must match the active document before Frame form promotion",
    )
  }

  const plan = Object.freeze({}) as FrameFormHistoryPlan
  frameFormHistoryPlans.set(plan, {
    action,
    documentNavigationEpoch: currentDocumentNavigationEpoch(session),
    frame,
    frameScope,
    history,
    isMounted,
    requestedUrl: disposition.url,
    session,
    ...(snapshotCache ? { snapshotCache } : {}),
    status: "ready",
  })
  return plan
}

export function frameFormHistoryPlanCurrent(
  plan: FrameFormHistoryPlan,
  session: DocumentSession,
  frame: ProtocolElement,
  requestedUrl: string,
): boolean {
  const state = formPlanState(plan, ["admitted", "committed", "ready", "staged"])
  validateFormPlanIdentity(state, session, frame, requestedUrl)
  return formPlanCurrent(state)
}

export function assertFrameFormHistoryPlanCurrent(
  plan: FrameFormHistoryPlan,
  session: DocumentSession,
  frame: ProtocolElement,
  requestedUrl: string,
): void {
  const state = formPlanState(plan, ["admitted", "committed", "ready", "staged"])
  validateFormPlanIdentity(state, session, frame, requestedUrl)
  if (!formPlanCurrent(state)) {
    throw new StateError("Document history or the mounted Frame changed during form submission")
  }
}

export function invalidateFrameFormHistoryCache(plan: FrameFormHistoryPlan): void {
  formPlanState(plan, ["admitted", "ready", "staged"]).snapshotCache?.clear()
}

export function stageFrameFormHistoryResponse(
  plan: FrameFormHistoryPlan,
  session: DocumentSession,
  frame: ProtocolElement,
  requestedUrl: string,
  finalUrl: string,
  options: Readonly<{ invalidateCache: boolean; publishSource: boolean }>,
): void {
  const state = formPlanState(plan, ["ready"])
  validateFormPlanIdentity(state, session, frame, requestedUrl)
  if (!formPlanCurrent(state)) {
    throw new StateError("Frame form history response was superseded")
  }

  let responseUrl: string
  try {
    responseUrl = formResponseUrl(state, finalUrl)
  } catch (error) {
    if (options.invalidateCache) state.snapshotCache?.clear()
    throw error
  }
  const current = state.history.current
  if (!current) {
    if (options.invalidateCache) state.snapshotCache?.clear()
    throw new StateError("Document history is not initialized")
  }
  const tree = session.tree
  const treeGeneration = session.treeGeneration
  let snapshot: DocumentTree | undefined
  try {
    snapshot = state.snapshotCache ? tree.clone() : undefined
    if (
      session.tree !== tree ||
      session.treeGeneration !== treeGeneration ||
      !formPlanCurrent(state) ||
      state.history.current !== current
    ) {
      throw new StateError("Document history or the mounted Frame changed during snapshot capture")
    }
  } finally {
    if (options.invalidateCache) state.snapshotCache?.clear()
  }
  if (!formPlanCurrent(state) || state.history.current !== current) {
    throw new StateError("Document history or the mounted Frame changed during cache invalidation")
  }
  if (options.publishSource && attributeValue(frame, "src") !== responseUrl) {
    session.setAttribute(frame.key, "src", responseUrl)
  }
  if (snapshot) state.snapshot = snapshot
  state.snapshotUrl = current.url
  state.responseUrl = responseUrl
  state.status = options.publishSource ? "admitted" : "staged"
}

export function admitFrameFormHistoryResponse(
  plan: FrameFormHistoryPlan,
  session: DocumentSession,
  frame: ProtocolElement,
  requestedUrl: string,
  finalUrl: string,
): void {
  const state = formPlanState(plan, ["admitted", "staged"])
  validateFormPlanIdentity(state, session, frame, requestedUrl)
  if (!formPlanCurrent(state)) throw new StateError("Frame form history response was superseded")
  const responseUrl = formResponseUrl(state, finalUrl)
  if (state.responseUrl !== responseUrl) {
    throw new StateError("Frame form history response URL changed after admission")
  }
  if (state.status === "staged" && attributeValue(frame, "src") !== responseUrl) {
    session.setAttribute(frame.key, "src", responseUrl)
  }
  state.status = "admitted"
}

export function commitFrameFormHistoryPlan(
  plan: FrameFormHistoryPlan,
  session: DocumentSession,
  frame: ProtocolElement,
  requestedUrl: string,
  finalUrl: string,
  expectedRevision: number,
): DocumentHistoryEntry {
  const state = formPlanState(plan, ["admitted"])
  validateFormPlanIdentity(state, session, frame, requestedUrl)
  if (!formPlanCurrent(state) || session.revision !== expectedRevision) {
    throw new StateError("Frame form history proposal is stale")
  }
  const responseUrl = formResponseUrl(state, finalUrl)
  if (state.responseUrl !== responseUrl || attributeValue(frame, "src") !== responseUrl) {
    throw new StateError("Frame form history response was not admitted")
  }

  const current = state.history.current
  if (!current) throw new StateError("Document history is not initialized")
  const proposal =
    state.action === "replace"
      ? state.history.proposeFrameReplace(state.frameScope, responseUrl)
      : state.history.proposeFrameAdvance(state.frameScope, responseUrl)
  const tree = session.tree
  const treeGeneration = session.treeGeneration
  if (!formPlanCurrent(state) || state.history.current !== current) {
    throw new StateError("Frame form history changed during proposal creation")
  }
  if (state.snapshot && state.snapshotCache && state.snapshotUrl) {
    state.snapshotCache.put(state.snapshotUrl, state.snapshot)
  }
  if (
    session.tree !== tree ||
    session.treeGeneration !== treeGeneration ||
    session.revision !== expectedRevision ||
    !formPlanCurrent(state) ||
    state.history.current !== current
  ) {
    throw new StateError("Frame form history changed during snapshot storage")
  }

  const entry = state.history.commitProposal(proposal)
  state.status = "committed"
  return entry
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

export type { FrameFormHistoryPlan, FrameHistoryCommitPlan }
