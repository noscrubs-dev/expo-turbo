import { FrameController } from "./frame-controller"
import type { FrameRequestLoader } from "./frame-loader"
import type { DocumentSession } from "./session"

export interface FrameControllerCollection {
  delete(frameId: string, controller?: FrameController): void
  get(frameId: string): FrameController
}

export class FrameControllerRegistry implements FrameControllerCollection {
  private readonly controllers = new Map<string, FrameController>()

  constructor(
    private readonly session: DocumentSession,
    private readonly loader: FrameRequestLoader,
  ) {}

  get(frameId: string): FrameController {
    let controller = this.controllers.get(frameId)
    if (!controller) {
      controller = new FrameController(this.session, frameId, this.loader)
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

  dispose(): void {
    for (const controller of this.controllers.values()) controller.disconnect()
    this.controllers.clear()
  }
}
