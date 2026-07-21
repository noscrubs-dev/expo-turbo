import type { FrameController } from "./frame-controller"
import type { FrameResponseReport } from "./frames"
import type { DocumentSession } from "./session"
import { attributeValue, type ProtocolElement } from "./tree"

interface FrameMorphReloadReportBinding {
  readonly frame: ProtocolElement
  readonly nestedFrames: readonly ProtocolElement[]
  readonly session: DocumentSession
}

type FrameMorphReloadContinuation = (report: FrameResponseReport) => void

const controllerContinuations = new WeakMap<FrameController, FrameMorphReloadContinuation>()
const reportBindings = new WeakMap<FrameResponseReport, FrameMorphReloadReportBinding>()

export function registerFrameMorphReloadController(
  controller: FrameController,
  continuation: FrameMorphReloadContinuation,
): void {
  controllerContinuations.set(controller, continuation)
}

export function notifyFrameMorphReload(
  controller: FrameController,
  report: FrameResponseReport,
): void {
  controllerContinuations.get(controller)?.(report)
}

export function recordFrameMorphReloadReport<T extends FrameResponseReport>(
  report: T,
  session: DocumentSession,
  frame: ProtocolElement,
  nestedFrames: readonly ProtocolElement[],
): T {
  if (nestedFrames.length === 0) return report
  reportBindings.set(report, {
    frame,
    nestedFrames: Object.freeze([...nestedFrames]),
    session,
  })
  return report
}

export function consumeFrameMorphReloads(
  report: FrameResponseReport,
  session: DocumentSession,
  frame: ProtocolElement,
): readonly ProtocolElement[] {
  const binding = reportBindings.get(report)
  reportBindings.delete(report)
  if (
    !binding ||
    binding.session !== session ||
    binding.frame !== frame ||
    report.frameId !== attributeValue(frame, "id") ||
    session.tree.getElementById(report.frameId) !== frame
  ) {
    return Object.freeze([])
  }
  return binding.nestedFrames
}
