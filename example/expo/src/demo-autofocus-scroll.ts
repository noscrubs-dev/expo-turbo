import type { AutofocusScrollAdapter } from "expo-turbo/adapters"
import {
  createElement,
  createContext,
  type ReactNode,
  type RefObject,
  useContext,
  useLayoutEffect,
  useMemo,
} from "react"

import type { DemoMeasureInWindow, DemoVisibilityRect } from "./demo-visibility"

interface DemoAutofocusScrollRecord {
  readonly measure: DemoMeasureInWindow
  measureEpoch: number
  rect: DemoVisibilityRect | undefined
}

export interface DemoAutofocusScrollContainer {
  readonly getScrollY: () => number
  readonly isAvailable: () => boolean
  readonly measure: DemoMeasureInWindow
  readonly scrollTo: (options: Readonly<{ animated: boolean; y: number }>) => void
}

interface DemoAutofocusScrollContainerRecord {
  readonly container: DemoAutofocusScrollContainer
  measureEpoch: number
  rect: DemoVisibilityRect | undefined
}

interface DemoAutofocusScrollMeasureTarget {
  measureInWindow(listener: (x: number, y: number, width: number, height: number) => void): void
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

function nearestScrollDelta(target: DemoVisibilityRect, viewport: DemoVisibilityRect): number {
  const targetEnd = target.y + target.height
  const viewportEnd = viewport.y + viewport.height
  if (target.y < viewport.y) return target.y - viewport.y
  return targetEnd > viewportEnd ? targetEnd - viewportEnd : 0
}

/** Example-owned root ScrollView implementation for registered autofocus controls. */
export class DemoAutofocusScrollRegistry implements AutofocusScrollAdapter {
  private container: DemoAutofocusScrollContainerRecord | undefined
  private disposed = false
  private pendingId: string | undefined
  private readonly targets = new Map<string, DemoAutofocusScrollRecord>()

  canScroll(id: string): boolean {
    if (this.disposed) return false
    const container = this.container
    return Boolean(this.targets.has(id) && container?.container.isAvailable())
  }

  register(id: string, measure: DemoMeasureInWindow): () => void {
    this.assertActive()
    if (typeof id !== "string" || id === "") {
      throw new TypeError("Demo autofocus scrolling requires a nonempty node key")
    }
    if (typeof measure !== "function") {
      throw new TypeError("Demo autofocus scrolling requires a measurement callback")
    }
    const record: DemoAutofocusScrollRecord = { measure, measureEpoch: 0, rect: undefined }
    this.targets.set(id, record)
    this.measureTarget(id, record)
    return () => {
      if (this.targets.get(id) !== record) return
      this.targets.delete(id)
      if (this.pendingId === id) this.pendingId = undefined
      record.measureEpoch += 1
    }
  }

  registerContainer(container: DemoAutofocusScrollContainer): () => void {
    this.assertActive()
    if (!container || typeof container !== "object" || Array.isArray(container)) {
      throw new TypeError("Demo autofocus scrolling requires a root ScrollView container")
    }
    if (
      typeof container.getScrollY !== "function" ||
      typeof container.isAvailable !== "function" ||
      typeof container.measure !== "function" ||
      typeof container.scrollTo !== "function"
    ) {
      throw new TypeError("Demo autofocus scroll container is incomplete")
    }
    const record: DemoAutofocusScrollContainerRecord = {
      container,
      measureEpoch: 0,
      rect: undefined,
    }
    this.container = record
    this.measureContainer(record)
    return () => {
      if (this.container !== record) return
      this.container = undefined
      record.measureEpoch += 1
    }
  }

  remeasure(id?: string): void {
    if (this.disposed) return
    if (id !== undefined) {
      const target = this.targets.get(id)
      if (target) this.measureTarget(id, target)
      return
    }
    this.measureContainer(this.container)
    for (const [targetId, target] of this.targets) this.measureTarget(targetId, target)
  }

  scrollTo(id: string): void {
    if (this.disposed) return
    if (!this.targets.has(id) || !this.container?.container.isAvailable()) return
    this.pendingId = id
    this.flushPending()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.container = undefined
    this.pendingId = undefined
    this.targets.clear()
  }

  private flushPending(): void {
    const id = this.pendingId
    if (!id) return
    const target = this.targets.get(id)
    const container = this.container
    if (!target || !container || !container.container.isAvailable()) {
      this.pendingId = undefined
      return
    }
    if (!target.rect || !container.rect) return
    const currentY = container.container.getScrollY()
    if (!Number.isFinite(currentY)) {
      this.pendingId = undefined
      return
    }
    const nextY = Math.max(0, currentY + nearestScrollDelta(target.rect, container.rect))
    this.pendingId = undefined
    if (Math.abs(nextY - currentY) < 0.5) return
    container.container.scrollTo({ animated: false, y: nextY })
  }

  private assertActive(): void {
    if (this.disposed) throw new Error("Demo autofocus scroll registry has been disposed")
  }

  private measureContainer(record: DemoAutofocusScrollContainerRecord | undefined): void {
    if (!record) return
    const measureEpoch = ++record.measureEpoch
    record.container.measure((x, y, width, height) => {
      if (this.container !== record || record.measureEpoch !== measureEpoch) return
      const rect = { height, width, x, y }
      record.rect = finiteRect(rect) ? Object.freeze(rect) : undefined
      this.flushPending()
    })
  }

  private measureTarget(id: string, record: DemoAutofocusScrollRecord): void {
    const measureEpoch = ++record.measureEpoch
    record.measure((x, y, width, height) => {
      if (this.targets.get(id) !== record || record.measureEpoch !== measureEpoch) return
      const rect = { height, width, x, y }
      record.rect = finiteRect(rect) ? Object.freeze(rect) : undefined
      this.flushPending()
    })
  }
}

const DemoAutofocusScrollContext = createContext<DemoAutofocusScrollRegistry | undefined>(undefined)

export function DemoAutofocusScrollProvider({
  children,
  autofocusScroll,
}: Readonly<{ children: ReactNode; autofocusScroll: DemoAutofocusScrollRegistry }>) {
  return createElement(DemoAutofocusScrollContext.Provider, { value: autofocusScroll }, children)
}

export function useDemoAutofocusScrollTarget(
  nodeKey: string,
  ref: RefObject<DemoAutofocusScrollMeasureTarget | null>,
): Readonly<{ onLayout(): void }> {
  const autofocusScroll = useContext(DemoAutofocusScrollContext)
  useLayoutEffect(
    () => {
      if (!autofocusScroll) return
      return autofocusScroll.register(nodeKey, (listener) => {
        ref.current?.measureInWindow?.(listener)
      })
    },
    [autofocusScroll, nodeKey, ref],
  )
  return useMemo(
    () =>
      Object.freeze({
        onLayout: () => autofocusScroll?.remeasure(nodeKey),
      }),
    [autofocusScroll, nodeKey],
  )
}
