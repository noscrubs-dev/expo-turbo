import { StateError } from "./errors.js"
import type { FrameController } from "./frame-controller.js"
import type { FrameControllerRegistry } from "./frame-controller-registry.js"
import {
  activeFrameAutofocusCandidates,
  type FrameAutoscrollIntent,
} from "./frame-response-application.js"
import type { FrameResponseReport } from "./frames.js"
import type { DocumentSession } from "./session.js"
import { attributeValue, type ProtocolElement, type ProtocolNode } from "./tree.js"

export interface FrameRenderEffects {
  readonly autofocus?: readonly string[]
  readonly autoscroll?: FrameAutoscrollIntent
}

interface FrameEffectReports {
  readonly autofocus?: FrameResponseReport
  readonly autoscroll?: FrameResponseReport
}

interface FrameAutofocusControllerBinding {
  consume(revision: number): FrameEffectReports
  stage(report: FrameResponseReport, effects: FrameRenderEffects, publish: boolean): boolean
}

interface FrameAutofocusReportBinding {
  readonly autoscroll?: FrameAutoscrollIntent
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
): FrameAutofocusReportBinding | undefined {
  const binding = reportBindings.get(report)
  return binding &&
    binding.session === session &&
    binding.frame === frame &&
    report.frameId === attributeValue(frame, "id") &&
    session.tree.getElementById(report.frameId) === frame
    ? binding
    : undefined
}

function autofocusIsCurrent(binding: FrameAutofocusReportBinding): boolean {
  const candidates = activeFrameAutofocusCandidates(binding.session, binding.frame)
  return (
    candidates.length === binding.candidates.length &&
    candidates.every(
      (candidate, index) =>
        candidate === binding.candidates[index] &&
        binding.session.tree.getNodeByKey(candidate) === binding.candidateNodes[index],
    )
  )
}

function effectsFor(
  report: FrameResponseReport,
  session: DocumentSession,
  frame: ProtocolElement,
): FrameRenderEffects | undefined {
  const binding = reportIsCurrent(report, session, frame)
  if (!binding) return undefined
  const autofocus =
    binding.candidates.length > 0 && autofocusIsCurrent(binding) ? binding.candidates : undefined
  const autoscroll = binding.autoscroll
  return Object.freeze({
    ...(autofocus ? { autofocus } : {}),
    ...(autoscroll ? { autoscroll } : {}),
  })
}

export function registerFrameAutofocusController(
  controller: FrameController,
  binding: FrameAutofocusControllerBinding,
): void {
  controllerBindings.set(controller, binding)
}

export function consumeFrameRenderEffects(
  controller: FrameController,
  revision: number,
): FrameRenderEffects | undefined {
  const binding = controllerBindings.get(controller)
  if (!binding) throw new StateError("Frame autofocus controller is invalid")
  const reports = binding.consume(revision)
  const autofocusBinding = reports.autofocus ? reportBindings.get(reports.autofocus) : undefined
  const autoscrollBinding = reports.autoscroll ? reportBindings.get(reports.autoscroll) : undefined
  const autofocus =
    reports.autofocus &&
    autofocusBinding &&
    reportIsCurrent(reports.autofocus, autofocusBinding.session, autofocusBinding.frame) &&
    autofocusBinding.candidates.length > 0 &&
    autofocusIsCurrent(autofocusBinding)
      ? autofocusBinding.candidates
      : undefined
  const autoscroll =
    reports.autoscroll &&
    autoscrollBinding &&
    reportIsCurrent(reports.autoscroll, autoscrollBinding.session, autoscrollBinding.frame)
      ? autoscrollBinding.autoscroll
      : undefined
  if (!autofocus && !autoscroll) return undefined
  return Object.freeze({
    ...(autofocus ? { autofocus } : {}),
    ...(autoscroll ? { autoscroll } : {}),
  })
}

export function consumeFrameAutofocus(
  controller: FrameController,
  revision: number,
): readonly string[] | undefined {
  return consumeFrameRenderEffects(controller, revision)?.autofocus
}

export function recordFrameAutofocusReport<T extends FrameResponseReport>(
  report: T,
  session: DocumentSession,
  frame: ProtocolElement,
  candidates: readonly string[],
  autoscroll?: FrameAutoscrollIntent,
): T {
  if (autoscroll && autoscroll.frameId !== report.frameId) {
    throw new StateError("Frame autoscroll binding failed", { frameId: report.frameId })
  }
  const frozenCandidates = Object.freeze([...candidates])
  const candidateNodes = frozenCandidates.map((candidate) => session.tree.getNodeByKey(candidate))
  if (candidateNodes.some((candidate) => candidate === undefined)) {
    throw new StateError("Frame autofocus candidate binding failed", { frameId: report.frameId })
  }
  reportBindings.set(report, {
    ...(autoscroll ? { autoscroll } : {}),
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
  const effects = effectsFor(report, session, frame)
  if (!binding || !effects) return false
  return binding.stage(report, effects, publish)
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
