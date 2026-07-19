import { StateError } from "./errors"
import type { FrameController } from "./frame-controller"
import type { FrameControllerRegistry } from "./frame-controller-registry"
import { activeFrameAutofocusCandidates } from "./frame-response-application"
import type { FrameResponseReport } from "./frames"
import type { DocumentSession } from "./session"
import { attributeValue, type ProtocolElement, type ProtocolNode } from "./tree"

interface FrameAutofocusControllerBinding {
  consume(revision: number): FrameResponseReport | undefined
  stage(report: FrameResponseReport, candidates: readonly string[], publish: boolean): void
}

interface FrameAutofocusReportBinding {
  readonly candidateNodes: readonly ProtocolNode[]
  readonly candidates: readonly string[]
  readonly frame: ProtocolElement
  readonly session: DocumentSession
}

type MountedFrameAutofocusNotifier = (report: FrameResponseReport) => boolean

const controllerBindings = new WeakMap<FrameController, FrameAutofocusControllerBinding>()
const reportBindings = new WeakMap<FrameResponseReport, FrameAutofocusReportBinding>()
const registryNotifiers = new WeakMap<FrameControllerRegistry, MountedFrameAutofocusNotifier>()

function reportIsCurrent(
  report: FrameResponseReport,
  session: DocumentSession,
  frame: ProtocolElement,
): boolean {
  const binding = reportBindings.get(report)
  const candidates = binding ? activeFrameAutofocusCandidates(session, frame) : []
  return Boolean(
    binding &&
      binding.session === session &&
      binding.frame === frame &&
      report.frameId === attributeValue(frame, "id") &&
      session.tree.getElementById(report.frameId) === frame &&
      candidates.length === binding.candidates.length &&
      candidates.every(
        (candidate, index) =>
          candidate === binding.candidates[index] &&
          session.tree.getNodeByKey(candidate) === binding.candidateNodes[index],
      ),
  )
}

export function registerFrameAutofocusController(
  controller: FrameController,
  binding: FrameAutofocusControllerBinding,
): void {
  controllerBindings.set(controller, binding)
}

export function consumeFrameAutofocus(
  controller: FrameController,
  revision: number,
): readonly string[] | undefined {
  const binding = controllerBindings.get(controller)
  if (!binding) throw new StateError("Frame autofocus controller is invalid")
  const report = binding.consume(revision)
  const reportBinding = report ? reportBindings.get(report) : undefined
  return report &&
    reportBinding &&
    reportIsCurrent(report, reportBinding.session, reportBinding.frame)
    ? reportBinding.candidates
    : undefined
}

export function recordFrameAutofocusReport<T extends FrameResponseReport>(
  report: T,
  session: DocumentSession,
  frame: ProtocolElement,
  candidates: readonly string[],
): T {
  const frozenCandidates = Object.freeze([...candidates])
  const candidateNodes = frozenCandidates.map((candidate) => session.tree.getNodeByKey(candidate))
  if (candidateNodes.some((candidate) => candidate === undefined)) {
    throw new StateError("Frame autofocus candidate binding failed", { frameId: report.frameId })
  }
  reportBindings.set(report, {
    candidateNodes: Object.freeze(candidateNodes as ProtocolNode[]),
    candidates: frozenCandidates,
    frame,
    session,
  })
  return report
}

export function stageFrameAutofocusReport(
  controller: FrameController,
  report: FrameResponseReport,
  session: DocumentSession,
  frame: ProtocolElement,
  publish = false,
): boolean {
  const binding = controllerBindings.get(controller)
  const reportBinding = reportBindings.get(report)
  if (!binding || !reportBinding || !reportIsCurrent(report, session, frame)) return false
  binding.stage(report, reportBinding.candidates, publish)
  return true
}

export function registerMountedFrameAutofocusNotifier(
  registry: FrameControllerRegistry,
  notifier: MountedFrameAutofocusNotifier,
): void {
  registryNotifiers.set(registry, notifier)
}

export function notifyMountedFrameAutofocus(
  registry: FrameControllerRegistry,
  report: FrameResponseReport,
): boolean {
  return registryNotifiers.get(registry)?.(report) ?? false
}
