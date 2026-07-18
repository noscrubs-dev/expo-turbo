import { StateError } from "./errors"
import type { FrameController } from "./frame-controller"
import type { FrameHistoryCommitPlan } from "./frame-history"
import type { FrameLoadReport, FrameRequestLoader } from "./frame-loader"

type FrameHistoryVisit = (
  source: string,
  plan: FrameHistoryCommitPlan,
) => Promise<FrameLoadReport | undefined>

type FrameCommitProtection = (frameId: string, owner: object) => boolean

const frameHistoryVisits = new WeakMap<FrameController, FrameHistoryVisit>()
const frameCommitProtections = new WeakMap<FrameRequestLoader, FrameCommitProtection>()

export function registerFrameHistoryVisit(
  controller: FrameController,
  visit: FrameHistoryVisit,
): void {
  frameHistoryVisits.set(controller, visit)
}

export function visitFrameWithHistory(
  controller: FrameController,
  source: string,
  plan: FrameHistoryCommitPlan,
): Promise<FrameLoadReport | undefined> {
  const visit = frameHistoryVisits.get(controller)
  if (!visit) throw new StateError("Frame history controller is invalid")
  return visit(source, plan)
}

export function registerFrameCommitProtection(
  loader: FrameRequestLoader,
  protection: FrameCommitProtection,
): void {
  frameCommitProtections.set(loader, protection)
}

export function isFrameCommitProtected(
  loader: FrameRequestLoader,
  frameId: string,
  owner: object,
): boolean {
  const protection = frameCommitProtections.get(loader)
  if (!protection) throw new StateError("Frame request loader is invalid")
  return protection(frameId, owner)
}
