import type { FrameAutoscrollAdapter, FrameAutoscrollRequest } from "expo-turbo/adapters"

import type { DemoMeasureInWindow, DemoVisibilityRect } from "./demo-visibility"

interface DemoFrameRecord {
  readonly measure: DemoMeasureInWindow
  measureEpoch: number
  rect: DemoVisibilityRect | undefined
}

export interface DemoFrameAutoscrollContainer {
  readonly getScrollY: () => number
  readonly isAvailable: () => boolean
  readonly measure: DemoMeasureInWindow
  readonly scrollTo: (options: Readonly<{ animated: boolean; y: number }>) => void
}

interface DemoContainerRecord {
  readonly container: DemoFrameAutoscrollContainer
  measureEpoch: number
  rect: DemoVisibilityRect | undefined
}

function finiteRect(rect: DemoVisibilityRect): boolean {
  return (
    Number.isFinite(rect.x) &&
    Number.isFinite(rect.y) &&
    Number.isFinite(rect.width) &&
    Number.isFinite(rect.height) &&
    rect.width >= 0 &&
    rect.height >= 0
  )
}

function scrollDelta(
  frame: DemoVisibilityRect,
  viewport: DemoVisibilityRect,
  block: FrameAutoscrollRequest["block"],
): number {
  const frameEnd = frame.y + frame.height
  const viewportEnd = viewport.y + viewport.height
  if (block === "start") return frame.y - viewport.y
  if (block === "center") return frame.y - viewport.y - (viewport.height - frame.height) / 2
  if (block === "end") return frameEnd - viewportEnd
  if (frame.y < viewport.y) return frame.y - viewport.y
  return frameEnd > viewportEnd ? frameEnd - viewportEnd : 0
}

/** Example-owned Frame-boundary scrolling inside its one root ScrollView. */
export class DemoFrameAutoscrollRegistry implements FrameAutoscrollAdapter {
  private container: DemoContainerRecord | undefined
  private disposed = false
  private readonly frames = new Map<string, DemoFrameRecord>()

  canScroll(frameId: string): boolean {
    if (this.disposed) return false
    const frame = this.frames.get(frameId)
    const container = this.container
    return Boolean(
      frame?.rect &&
        container?.rect &&
        finiteRect(frame.rect) &&
        finiteRect(container.rect) &&
        container.container.isAvailable(),
    )
  }

  register(frameId: string, measure: DemoMeasureInWindow): () => void {
    this.assertActive()
    if (typeof frameId !== "string" || frameId === "") {
      throw new TypeError("Demo Frame autoscroll registration requires a nonempty Frame id")
    }
    if (typeof measure !== "function") {
      throw new TypeError("Demo Frame autoscroll registration requires a measurement callback")
    }
    const record: DemoFrameRecord = { measure, measureEpoch: 0, rect: undefined }
    this.frames.set(frameId, record)
    this.measureFrame(frameId, record)
    return () => {
      if (this.frames.get(frameId) !== record) return
      this.frames.delete(frameId)
      record.measureEpoch += 1
    }
  }

  registerContainer(container: DemoFrameAutoscrollContainer): () => void {
    this.assertActive()
    if (!container || typeof container !== "object" || Array.isArray(container)) {
      throw new TypeError("Demo Frame autoscroll requires a root ScrollView container")
    }
    if (
      typeof container.getScrollY !== "function" ||
      typeof container.isAvailable !== "function" ||
      typeof container.measure !== "function" ||
      typeof container.scrollTo !== "function"
    ) {
      throw new TypeError("Demo Frame autoscroll container is incomplete")
    }
    const record: DemoContainerRecord = { container, measureEpoch: 0, rect: undefined }
    this.container = record
    this.measureContainer(record)
    return () => {
      if (this.container !== record) return
      this.container = undefined
      record.measureEpoch += 1
    }
  }

  remeasure(frameId?: string): void {
    if (this.disposed) return
    if (frameId !== undefined) {
      const frame = this.frames.get(frameId)
      if (frame) this.measureFrame(frameId, frame)
      return
    }
    this.measureContainer(this.container)
    for (const [id, frame] of this.frames) this.measureFrame(id, frame)
  }

  scrollTo(request: FrameAutoscrollRequest): void {
    if (this.disposed) return
    const frame = this.frames.get(request.frameId)
    const container = this.container
    if (!frame?.rect || !container?.rect || !container.container.isAvailable()) return
    const currentY = container.container.getScrollY()
    if (!Number.isFinite(currentY)) return
    const nextY = Math.max(0, currentY + scrollDelta(frame.rect, container.rect, request.block))
    if (Math.abs(nextY - currentY) < 0.5) return
    container.container.scrollTo({ animated: request.behavior === "smooth", y: nextY })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.container = undefined
    this.frames.clear()
  }

  private assertActive(): void {
    if (this.disposed) throw new Error("Demo Frame autoscroll registry has been disposed")
  }

  private measureContainer(record: DemoContainerRecord | undefined): void {
    if (!record) return
    const measureEpoch = ++record.measureEpoch
    record.container.measure((x, y, width, height) => {
      if (this.container !== record || record.measureEpoch !== measureEpoch) return
      const rect = { height, width, x, y }
      record.rect = finiteRect(rect) ? Object.freeze(rect) : undefined
    })
  }

  private measureFrame(frameId: string, record: DemoFrameRecord): void {
    const measureEpoch = ++record.measureEpoch
    record.measure((x, y, width, height) => {
      if (this.frames.get(frameId) !== record || record.measureEpoch !== measureEpoch) return
      const rect = { height, width, x, y }
      record.rect = finiteRect(rect) ? Object.freeze(rect) : undefined
    })
  }
}
