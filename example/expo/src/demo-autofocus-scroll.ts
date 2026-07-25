import type { AutofocusScrollAdapter } from "expo-turbo/adapters"
import {
  createElement,
  createContext,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
} from "react"
import type { LayoutChangeEvent } from "react-native"

import type { DemoMeasureInWindow, DemoVisibilityRect } from "./demo-visibility"

interface DemoAutofocusScrollRecord {
  readonly measure: DemoMeasureInWindow
  measureEpoch: number
  nativeHandle: number | null
  rect: DemoVisibilityRect | undefined
}

export interface DemoAutofocusScrollContainer {
  readonly getScrollY: () => number
  readonly isAvailable: () => boolean
  readonly measure: DemoMeasureInWindow
  readonly reveal?: (nativeHandle: number) => void
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
  private activeId: string | undefined
  private container: DemoAutofocusScrollContainerRecord | undefined
  private disposed = false
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
    const record: DemoAutofocusScrollRecord = {
      measure,
      measureEpoch: 0,
      nativeHandle: null,
      rect: undefined,
    }
    this.targets.set(id, record)
    this.measureTarget(id, record)
    return () => {
      if (this.targets.get(id) !== record) return
      this.targets.delete(id)
      if (this.activeId === id) this.activeId = undefined
      record.measureEpoch += 1
    }
  }

  cancel(id: string): void {
    if (this.activeId === id) this.activeId = undefined
  }

  setNativeHandle(id: string, nativeHandle: number | null): void {
    const target = this.targets.get(id)
    if (target) target.nativeHandle = nativeHandle
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
    this.activeId = id
    this.flushActive()
    this.revealActive()
  }

  revealActive(): void {
    const target = this.activeId ? this.targets.get(this.activeId) : undefined
    const nativeHandle = target?.nativeHandle
    if (nativeHandle !== null && nativeHandle !== undefined) {
      this.container?.container.reveal?.(nativeHandle)
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.activeId = undefined
    this.container = undefined
    this.targets.clear()
  }

  private flushActive(): void {
    const id = this.activeId
    if (!id) return
    const target = this.targets.get(id)
    const container = this.container
    if (!target || !container || !container.container.isAvailable()) {
      this.activeId = undefined
      return
    }
    if (!target.rect || !container.rect) return
    const currentY = container.container.getScrollY()
    if (!Number.isFinite(currentY)) {
      this.activeId = undefined
      return
    }
    const nextY = Math.max(0, currentY + nearestScrollDelta(target.rect, container.rect))
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
      this.flushActive()
    })
  }

  private measureTarget(id: string, record: DemoAutofocusScrollRecord): void {
    const measureEpoch = ++record.measureEpoch
    record.measure((x, y, width, height) => {
      if (this.targets.get(id) !== record || record.measureEpoch !== measureEpoch) return
      const rect = { height, width, x, y }
      record.rect = finiteRect(rect) ? Object.freeze(rect) : undefined
      this.flushActive()
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
): Readonly<{ onBlur(): void; onFocus(): void; onLayout(event: LayoutChangeEvent): void }> {
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
  const onBlur = useCallback(() => autofocusScroll?.cancel(nodeKey), [autofocusScroll, nodeKey])
  const onFocus = useCallback(
    () => autofocusScroll?.scrollTo(nodeKey),
    [autofocusScroll, nodeKey],
  )
  const onLayout = useCallback(
    (event: LayoutChangeEvent) => {
      autofocusScroll?.setNativeHandle(
        nodeKey,
        (event.nativeEvent as typeof event.nativeEvent & { readonly target?: number }).target ??
          null,
      )
      autofocusScroll?.remeasure(nodeKey)
    },
    [autofocusScroll, nodeKey],
  )
  return useMemo(() => Object.freeze({ onBlur, onFocus, onLayout }), [onBlur, onFocus, onLayout])
}
