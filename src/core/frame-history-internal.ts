import { StateError } from "./errors"
import type { FrameController } from "./frame-controller"
import type { FrameControllerRegistry } from "./frame-controller-registry"
import type { FrameHistoryCommitPlan, FrameHistoryCoordinator } from "./frame-history"
import type { FrameLoadReport, FrameRequestLoader } from "./frame-loader"
import type { ProtocolElement } from "./tree"

type FrameHistoryVisit = (
  source: string,
  plan: FrameHistoryCommitPlan,
) => Promise<FrameLoadReport | undefined>

type FrameCommitProtection = (frameId: string, owner: object) => boolean

export interface MountedFrameHistoryBinding {
  readonly coordinator: FrameHistoryCoordinator
  readonly invalidationSignal: AbortSignal
  readonly scope: object
  isCurrent(): boolean
}

type MountedFrameHistoryResolver = (
  frameId: string,
  frame: ProtocolElement,
) => MountedFrameHistoryBinding | undefined

const frameHistoryVisits = new WeakMap<FrameController, FrameHistoryVisit>()
const frameCommitProtections = new WeakMap<FrameRequestLoader, FrameCommitProtection>()
const mountedFrameHistoryResolvers = new WeakMap<
  FrameControllerRegistry,
  MountedFrameHistoryResolver
>()

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

export function registerMountedFrameHistoryResolver(
  registry: FrameControllerRegistry,
  resolver: MountedFrameHistoryResolver,
): void {
  mountedFrameHistoryResolvers.set(registry, resolver)
}

export function resolveMountedFrameHistory(
  registry: FrameControllerRegistry,
  frameId: string,
  frame: ProtocolElement,
): MountedFrameHistoryBinding | undefined {
  return mountedFrameHistoryResolvers.get(registry)?.(frameId, frame)
}
