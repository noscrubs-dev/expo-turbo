import type { NavigationAdapter, VisibilityAdapter, VisitAction } from "../adapters"
import { TargetError } from "./errors"
import { FrameController } from "./frame-controller"
import type { FrameLoadReport, FrameRequestLoader } from "./frame-loader"
import {
  type ResolvedFrameTarget,
  type ResolveFrameTargetOptions,
  resolveFrameTarget,
} from "./frames"
import type { DocumentSession } from "./session"

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

export class FrameControllerRegistry implements FrameControllerCollection {
  private readonly controllers = new Map<string, FrameController>()

  constructor(
    private readonly session: DocumentSession,
    private readonly loader: FrameRequestLoader,
    private readonly visibility?: VisibilityAdapter,
    private readonly navigation?: NavigationAdapter,
  ) {}

  get(frameId: string): FrameController {
    let controller = this.controllers.get(frameId)
    if (!controller) {
      controller = new FrameController(this.session, frameId, this.loader, this.visibility)
      this.controllers.set(frameId, controller)
    }
    return controller
  }

  delete(frameId: string, controller?: FrameController): void {
    const current = this.controllers.get(frameId)
    if (!current || (controller && current !== controller)) return
    current.disconnect()
    this.controllers.delete(frameId)
  }

  async visit(url: string, options: FrameVisitOptions): Promise<FrameVisitResult> {
    const documentUrl = this.session.tree.document.url
    if (!documentUrl) throw new TargetError("Frame visits require an active document URL")
    const document = new URL(documentUrl)
    const resolved = new URL(url, document)
    const resolvedUrl = resolved.toString()
    const target = resolveFrameTarget(this.session.tree, options.frame, options)

    if (resolved.origin !== document.origin) {
      if (!this.navigation) throw new TargetError("External Frame visits require navigation")
      this.navigation.openExternal(resolvedUrl)
      return Object.freeze({ kind: "external", target, url: resolvedUrl })
    }
    if (target.kind === "top") {
      if (!this.navigation) throw new TargetError("Top-level Frame visits require navigation")
      const action = options.action ?? "advance"
      this.navigation.visit(resolvedUrl, action)
      return Object.freeze({ action, kind: "top", target, url: resolvedUrl })
    }

    const load = await this.get(target.frameId).visit(resolvedUrl)
    return Object.freeze({
      frameId: target.frameId,
      kind: "frame",
      load,
      target,
      url: resolvedUrl,
    })
  }

  dispose(): void {
    for (const controller of this.controllers.values()) controller.disconnect()
    this.controllers.clear()
  }
}
