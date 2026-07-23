import type { NavigationAdapter, VisibilityAdapter, VisitAction } from "../adapters"
import { registerDocumentMorphFrameReloader } from "./document-morph-frame-reload-internal"
import type { DocumentVisitController, DocumentVisitResult } from "./document-visit-controller"
import { FrameMissingError, TargetError } from "./errors"
import {
  registerMountedFrameAutofocusNotifier,
  stageFrameAutofocusReport,
} from "./frame-autofocus-internal"
import { FrameController } from "./frame-controller"
import { type FrameHistoryCoordinator, prepareFrameHistoryCommit } from "./frame-history"
import {
  type MountedFrameHistoryBinding,
  registerMountedFrameHistoryResolver,
  visitFrameWithHistory,
} from "./frame-history-internal"
import type { FrameLoadReport, FrameRequestLoader } from "./frame-loader"
import {
  consumeFrameMorphReloads,
  registerFrameMorphReloadController,
} from "./frame-morph-reload-internal"
import type { FrameResponseReport } from "./frames"
import {
  type ResolvedFrameTarget,
  type ResolveFrameTargetOptions,
  resolveFrameTarget,
} from "./frames"
import { resolveProtocolUrl } from "./protocol-request"
import type { DocumentSession } from "./session"
import { attributeValue, type ProtocolElement } from "./tree"

export interface FrameControllerCollection {
  delete(frameId: string, controller?: FrameController): void
  get(frameId: string): FrameController
  visit(url: string, options: FrameVisitOptions): Promise<FrameVisitResult>
}

/** A non-creating lookup for a currently mounted exact Frame node. */
export interface MountedFrameControllerLookup {
  findMounted(frame: ProtocolElement): FrameController | undefined
}

export interface FrameVisitOptions extends ResolveFrameTargetOptions {
  /** `null` explicitly masks destination-Frame action inheritance. */
  readonly action?: VisitAction | null
  readonly frame: string
}

export interface FrameControllerRegistryOptions {
  readonly frameHistory?: FrameHistoryCoordinator
}

export type FrameVisitResult =
  | Readonly<{
      frameId: string
      action?: Exclude<VisitAction, "restore">
      kind: "frame"
      load: FrameLoadReport | undefined
      target: Extract<ResolvedFrameTarget, { kind: "frame" }>
      url: string
    }>
  | Readonly<{
      action: VisitAction
      kind: "top"
      outcome?: DocumentVisitResult
      target: Extract<ResolvedFrameTarget, { kind: "top" }>
      url: string
    }>
  | Readonly<{
      kind: "external"
      target: ResolvedFrameTarget
      url: string
    }>

interface FrameControllerRecord {
  readonly controller: FrameController
  readonly history?: MountedFrameHistoryBinding
  readonly historyInvalidation?: AbortController
  readonly node: ProtocolElement
  unregisterDisposal: () => void
}

function exactVisitAction(value: string | undefined): VisitAction | undefined {
  return value === "advance" || value === "replace" || value === "restore" ? value : undefined
}

export class FrameControllerRegistry
  implements FrameControllerCollection, MountedFrameControllerLookup
{
  private readonly controllers = new Map<string, FrameControllerRecord>()
  private readonly unregisterDocumentMorphFrameReloader: () => void

  constructor(
    private readonly session: DocumentSession,
    private readonly loader: FrameRequestLoader,
    private readonly visibility?: VisibilityAdapter,
    private readonly navigation?: NavigationAdapter,
    private readonly topLevelVisits?: Pick<DocumentVisitController, "visit">,
    private readonly options: FrameControllerRegistryOptions = {},
  ) {
    registerMountedFrameHistoryResolver(this, (frameId, frame) => {
      const record = this.controllers.get(frameId)
      return record?.node === frame ? record.history : undefined
    })
    registerMountedFrameAutofocusNotifier(this, (report) => {
      const current = this.controllers.get(report.frameId)
      if (!current?.controller.state.connected) return false
      return stageFrameAutofocusReport(current.controller, report, this.session, current.node, true)
    })
    this.unregisterDocumentMorphFrameReloader = registerDocumentMorphFrameReloader(
      this.session,
      (frames) => {
        this.reloadDocumentMorphFrames(frames)
      },
    )
  }

  get(frameId: string): FrameController {
    const frame = this.session.tree.getElementById(frameId)
    if (frame?.kind !== "frame") {
      throw new FrameMissingError(`Active frame ${JSON.stringify(frameId)} is missing`, { frameId })
    }

    this.releaseStaleNodeOwnersAfterRender(frameId, frame)
    const current = this.controllers.get(frameId)
    if (current?.node === frame) return current.controller
    if (current) this.release(frameId, current, true)

    const controller = new FrameController(
      this.session,
      frameId,
      this.loader,
      this.visibility,
      frame,
      this.options.frameHistory,
    )
    registerFrameMorphReloadController(controller, (report) => {
      this.reloadNestedMorphFrames(controller, report)
    })
    let record!: FrameControllerRecord
    const frameHistory = this.options.frameHistory
    const historyInvalidation = frameHistory ? new AbortController() : undefined
    record = {
      controller,
      ...(frameHistory && historyInvalidation
        ? {
            history: Object.freeze({
              coordinator: frameHistory,
              invalidationSignal: historyInvalidation.signal,
              isCurrent: () =>
                this.controllers.get(frameId) === record &&
                this.session.tree.getElementById(frameId) === frame,
              scope: controller,
            }),
          }
        : {}),
      ...(historyInvalidation ? { historyInvalidation } : {}),
      node: frame,
      unregisterDisposal: () => undefined,
    }
    record.unregisterDisposal = this.session.registerDisposal(frame.key, () => {
      this.release(frameId, record, false)
    })
    this.controllers.set(frameId, record)
    return controller
  }

  findMounted(frame: ProtocolElement): FrameController | undefined {
    if (frame.kind !== "frame") return undefined
    const frameId = attributeValue(frame, "id")
    if (!frameId || this.session.tree.getElementById(frameId) !== frame) return undefined
    const current = this.controllers.get(frameId)
    return current?.node === frame && current.controller.state.connected
      ? current.controller
      : undefined
  }

  delete(frameId: string, controller?: FrameController): void {
    const current = this.controllers.get(frameId)
    if (!current || (controller && current.controller !== controller)) return
    this.release(frameId, current, true)
  }

  async visit(url: string, options: FrameVisitOptions): Promise<FrameVisitResult> {
    const documentUrl = this.session.tree.document.url
    if (!documentUrl) throw new TargetError("Frame visits require an active document URL")
    const resolved = resolveProtocolUrl(url, documentUrl)
    const requestLocation = new URL(resolved.url)
    const hasFragment = requestLocation.hash !== ""
    requestLocation.hash = ""
    const requestUrl = requestLocation.toString()
    const target = resolveFrameTarget(this.session.tree, options.frame, options)
    const targetFrame =
      target.kind === "frame" ? this.session.tree.getElementById(target.frameId) : undefined
    const inheritedAction =
      options.action === undefined &&
      targetFrame?.kind === "frame" &&
      resolved.urlOrigin === resolved.documentOrigin
        ? exactVisitAction(attributeValue(targetFrame, "data-turbo-action"))
        : undefined
    const action = options.action === null ? undefined : (options.action ?? inheritedAction)
    if (resolved.urlOrigin !== resolved.documentOrigin) {
      if (!this.navigation) throw new TargetError("External Frame visits require navigation")
      await this.navigation.openExternal(resolved.url)
      return Object.freeze({ kind: "external", target, url: resolved.url })
    }
    if (target.kind === "top") {
      if (hasFragment)
        throw new TargetError("Top-level Frame visit fragments require navigation support")
      const topAction = action ?? "advance"
      if (this.topLevelVisits) {
        const outcome = await this.topLevelVisits.visit(resolved.url, {
          action: topAction,
          ...(this.navigation ? { navigation: this.navigation } : {}),
        })
        return Object.freeze({ action: topAction, kind: "top", outcome, target, url: resolved.url })
      } else {
        if (!this.navigation) throw new TargetError("Top-level Frame visits require navigation")
        await this.navigation.visit(resolved.url, topAction)
      }
      return Object.freeze({ action: topAction, kind: "top", target, url: resolved.url })
    }

    const controller = this.get(target.frameId)
    let load: FrameLoadReport | undefined
    if (action === "restore") {
      throw new TargetError("Frame restore visits require whole-document traversal", {
        frameId: target.frameId,
      })
    }
    if (action) {
      const frameHistory = this.options.frameHistory
      if (!frameHistory) {
        throw new TargetError("Frame action visits require history coordination", {
          frameId: target.frameId,
        })
      }
      if (targetFrame?.kind !== "frame") {
        throw new FrameMissingError(`Active frame ${JSON.stringify(target.frameId)} is missing`, {
          frameId: target.frameId,
        })
      }
      const plan = prepareFrameHistoryCommit(
        frameHistory,
        controller,
        targetFrame,
        resolved.url,
        action,
      )
      load = await visitFrameWithHistory(controller, requestUrl, plan)
    } else {
      load = await controller.visit(requestUrl)
    }
    return Object.freeze({
      ...(action ? { action } : {}),
      frameId: target.frameId,
      kind: "frame",
      load,
      target,
      url: resolved.url,
    })
  }

  dispose(): void {
    this.unregisterDocumentMorphFrameReloader()
    for (const [frameId, record] of [...this.controllers]) {
      this.release(frameId, record, true)
    }
  }

  private release(
    frameId: string,
    record: FrameControllerRecord,
    unregisterDisposal: boolean,
  ): void {
    if (this.controllers.get(frameId) !== record) return
    this.controllers.delete(frameId)
    record.historyInvalidation?.abort()
    if (unregisterDisposal) record.unregisterDisposal()
    record.controller.disconnect()
  }

  private releaseStaleNodeOwnersAfterRender(frameId: string, frame: ProtocolElement): void {
    if (
      ![...this.controllers].some(
        ([ownedFrameId, record]) => ownedFrameId !== frameId && record.node === frame,
      )
    )
      return
    queueMicrotask(() => {
      const activeFrameId = attributeValue(frame, "id")
      for (const [ownedFrameId, record] of [...this.controllers]) {
        if (record.node === frame && ownedFrameId !== activeFrameId) {
          this.release(ownedFrameId, record, true)
        }
      }
    })
  }

  private reloadNestedMorphFrames(outer: FrameController, report: FrameResponseReport): void {
    const outerRecord = this.controllers.get(outer.frameId)
    if (!outerRecord || outerRecord.controller !== outer) return
    const frames = consumeFrameMorphReloads(report, this.session, outerRecord.node)
    for (const frame of frames) {
      if (!this.currentNestedMorphFrame(frame, outerRecord.node)) continue
      const controller = this.findMounted(frame)
      if (!controller || controller === outer) continue
      try {
        void controller.reload().catch(() => undefined)
      } catch {
        // A stale child must not turn an already-rendered outer Frame into a failed load.
      }
    }
  }

  private reloadDocumentMorphFrames(frames: readonly ProtocolElement[]): void {
    for (const frame of frames) {
      if (!this.currentDocumentMorphFrame(frame)) continue
      const controller = this.findMounted(frame)
      if (!controller) continue
      try {
        void controller.reload().catch(() => undefined)
      } catch {
        // A stale Frame must not turn an already-rendered document into a failed visit.
      }
    }
  }

  private currentDocumentMorphFrame(frame: ProtocolElement): boolean {
    if (
      frame.kind !== "frame" ||
      attributeValue(frame, "disabled") !== undefined ||
      !attributeValue(frame, "src")?.trim() ||
      attributeValue(frame, "refresh") !== "morph" ||
      attributeValue(frame, "data-turbo-permanent") !== undefined
    ) {
      return false
    }
    let current = frame.parent
    while (current && current.kind !== "document") {
      if (attributeValue(current, "data-turbo-permanent") !== undefined) return false
      if (
        current.kind === "frame" &&
        attributeValue(current, "src")?.trim() &&
        attributeValue(current, "refresh") === "morph"
      ) {
        return false
      }
      current = current.parent
    }
    return true
  }

  private currentNestedMorphFrame(frame: ProtocolElement, outer: ProtocolElement): boolean {
    if (
      frame.kind !== "frame" ||
      attributeValue(frame, "disabled") !== undefined ||
      !attributeValue(frame, "src")?.trim() ||
      attributeValue(frame, "refresh") !== "morph"
    ) {
      return false
    }
    if (attributeValue(frame, "data-turbo-permanent") !== undefined) return false
    let current = frame.parent
    while (current && current.kind !== "document") {
      if (attributeValue(current, "data-turbo-permanent") !== undefined) return false
      if (
        current.kind === "frame" &&
        attributeValue(current, "src")?.trim() &&
        attributeValue(current, "refresh") === "morph"
      ) {
        return current === outer
      }
      current = current.parent
    }
    return false
  }
}
