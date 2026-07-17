import type { NavigationAdapter, VisibilityAdapter, VisitAction } from "../adapters"
import { FrameMissingError, TargetError } from "./errors"
import { FrameController } from "./frame-controller"
import type { FrameLoadReport, FrameRequestLoader } from "./frame-loader"
import {
  type ResolvedFrameTarget,
  type ResolveFrameTargetOptions,
  resolveFrameTarget,
} from "./frames"
import { resolveProtocolUrl } from "./protocol-request"
import type { DocumentSession } from "./session"
import type { ProtocolElement } from "./tree"

export interface FrameControllerCollection {
  delete(frameId: string, controller?: FrameController): void
  get(frameId: string): FrameController
}

export interface FrameVisitOptions extends ResolveFrameTargetOptions {
  readonly action?: VisitAction
  readonly frame: string
}

export type FrameVisitResult =
  | Readonly<{
      frameId: string
      kind: "frame"
      load: FrameLoadReport | undefined
      target: Extract<ResolvedFrameTarget, { kind: "frame" }>
      url: string
    }>
  | Readonly<{
      action: VisitAction
      kind: "top"
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
  readonly node: ProtocolElement
  unregisterDisposal: () => void
}

export class FrameControllerRegistry implements FrameControllerCollection {
  private readonly controllers = new Map<string, FrameControllerRecord>()

  constructor(
    private readonly session: DocumentSession,
    private readonly loader: FrameRequestLoader,
    private readonly visibility?: VisibilityAdapter,
    private readonly navigation?: NavigationAdapter,
  ) {}

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
    )
    const record: FrameControllerRecord = {
      controller,
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

    if (resolved.urlOrigin !== resolved.documentOrigin) {
      if (!this.navigation) throw new TargetError("External Frame visits require navigation")
      this.navigation.openExternal(resolved.url)
      return Object.freeze({ kind: "external", target, url: resolved.url })
    }
    if (target.kind === "top") {
      if (!this.navigation) throw new TargetError("Top-level Frame visits require navigation")
      const action = options.action ?? "advance"
      this.navigation.visit(resolved.url, action)
      return Object.freeze({ action, kind: "top", target, url: resolved.url })
    }

    const load = await this.get(target.frameId).visit(resolved.url)
    return Object.freeze({
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
