import type { NavigationAdapter, VisibilityAdapter, VisitAction } from "../adapters"
import type { DocumentVisitController, DocumentVisitResult } from "./document-visit-controller"
import { FrameMissingError, TargetError } from "./errors"
import { FrameController } from "./frame-controller"
import { type FrameHistoryCoordinator, prepareFrameHistoryCommit } from "./frame-history"
import {
  type MountedFrameHistoryBinding,
  registerMountedFrameHistoryResolver,
  visitFrameWithHistory,
} from "./frame-history-internal"
import type { FrameLoadReport, FrameRequestLoader } from "./frame-loader"
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
  readonly node: ProtocolElement
  unregisterDisposal: () => void
}

function exactVisitAction(value: string | undefined): VisitAction | undefined {
  return value === "advance" || value === "replace" || value === "restore" ? value : undefined
}

export class FrameControllerRegistry implements FrameControllerCollection {
  private readonly controllers = new Map<string, FrameControllerRecord>()

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
  }

  get(frameId: string): FrameController {
    const frame = this.session.tree.getElementById(frameId)
    if (frame?.kind !== "frame") {
      throw new FrameMissingError(`Active frame ${JSON.stringify(frameId)} is missing`, { frameId })
    }

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
    let record!: FrameControllerRecord
    const frameHistory = this.options.frameHistory
    record = {
      controller,
      ...(frameHistory
        ? {
            history: Object.freeze({
              coordinator: frameHistory,
              isCurrent: () =>
                this.controllers.get(frameId) === record &&
                this.session.tree.getElementById(frameId) === frame,
              scope: controller,
            }),
          }
        : {}),
      node: frame,
      unregisterDisposal: () => undefined,
    }
    record.unregisterDisposal = this.session.registerDisposal(frame.key, () => {
      this.release(frameId, record, false)
    })
    this.controllers.set(frameId, record)
    return controller
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
    if (resolved.url.includes("#")) {
      throw new TargetError("Frame visit fragments require navigation support")
    }
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
      load = await visitFrameWithHistory(controller, resolved.url, plan)
    } else {
      load = await controller.visit(resolved.url)
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
    if (unregisterDisposal) record.unregisterDisposal()
    record.controller.disconnect()
  }
}
