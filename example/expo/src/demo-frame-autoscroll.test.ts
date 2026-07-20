import { describe, expect, test } from "bun:test"

import type { DemoMeasureInWindow, DemoVisibilityRect } from "./demo-visibility"
import { DemoFrameAutoscrollRegistry } from "./demo-frame-autoscroll"

function measurement() {
  let listener: ((x: number, y: number, width: number, height: number) => void) | undefined
  let calls = 0
  return {
    emit(rect: DemoVisibilityRect): void {
      listener?.(rect.x, rect.y, rect.width, rect.height)
    },
    get calls(): number {
      return calls
    },
    measure: ((next) => {
      calls += 1
      listener = next
    }) satisfies DemoMeasureInWindow,
  }
}

function harness(options: Readonly<{ available?: boolean; frame?: DemoVisibilityRect }> = {}) {
  const registry = new DemoFrameAutoscrollRegistry()
  const frame = measurement()
  const viewport = measurement()
  let available = options.available ?? true
  let scrollY = 25
  const scrolls: Readonly<{ animated: boolean; y: number }>[] = []
  const unregisterContainer = registry.registerContainer({
    getScrollY: () => scrollY,
    isAvailable: () => available,
    measure: viewport.measure,
    scrollTo: (options) => scrolls.push(options),
  })
  const unregisterFrame = registry.register("frame", frame.measure)
  viewport.emit({ height: 300, width: 320, x: 0, y: 100 })
  frame.emit(options.frame ?? { height: 100, width: 320, x: 0, y: 250 })

  return {
    frame,
    registry,
    scrolls,
    setAvailable(next: boolean): void {
      available = next
    },
    setScrollY(next: number): void {
      scrollY = next
    },
    unregisterContainer,
    unregisterFrame,
    viewport,
  }
}

describe("demo Frame autoscroll", () => {
  test("uses cached root and Frame geometry for start, center, and end alignment", () => {
    for (const [block, y] of [
      ["start", 175],
      ["center", 75],
      ["end", 0],
    ] as const) {
      const current = harness()
      const frameMeasurements = current.frame.calls
      const viewportMeasurements = current.viewport.calls

      current.registry.scrollTo({ behavior: "auto", block, frameId: "frame" })

      expect(current.scrolls).toEqual([{ animated: false, y }])
      expect(current.frame.calls).toBe(frameMeasurements)
      expect(current.viewport.calls).toBe(viewportMeasurements)
      current.registry.dispose()
    }
  })

  test("uses smooth behavior and nearest alignment without an unnecessary scroll", () => {
    const current = harness({ frame: { height: 100, width: 320, x: 0, y: 150 } })

    current.registry.scrollTo({ behavior: "smooth", block: "nearest", frameId: "frame" })
    expect(current.scrolls).toEqual([])

    current.registry.remeasure("frame")
    current.frame.emit({ height: 50, width: 320, x: 0, y: 450 })
    current.registry.scrollTo({ behavior: "smooth", block: "nearest", frameId: "frame" })

    expect(current.scrolls).toEqual([{ animated: true, y: 125 }])
  })

  test("requires current measured identities and an available root ScrollView", () => {
    const current = harness({ available: false })

    expect(current.registry.canScroll("frame")).toBe(false)
    current.registry.scrollTo({ behavior: "auto", block: "start", frameId: "frame" })
    expect(current.scrolls).toEqual([])

    current.setAvailable(true)
    expect(current.registry.canScroll("frame")).toBe(true)
    const replacement = measurement()
    const unregisterReplacement = current.registry.register("frame", replacement.measure)
    current.frame.emit({ height: 100, width: 320, x: 0, y: 250 })
    expect(current.registry.canScroll("frame")).toBe(false)
    replacement.emit({ height: 100, width: 320, x: 0, y: 250 })
    expect(current.registry.canScroll("frame")).toBe(true)

    current.unregisterFrame()
    expect(current.registry.canScroll("frame")).toBe(true)
    unregisterReplacement()
    expect(current.registry.canScroll("frame")).toBe(false)
  })

  test("releases cached native registrations on disposal", () => {
    const current = harness()

    current.registry.dispose()
    current.registry.dispose()
    current.setScrollY(500)
    current.registry.remeasure()
    current.registry.scrollTo({ behavior: "auto", block: "start", frameId: "frame" })

    expect(current.registry.canScroll("frame")).toBe(false)
    expect(current.scrolls).toEqual([])
    expect(() => current.registry.register("late", () => {})).toThrow(/disposed/)
    expect(() => current.registry.registerContainer({} as never)).toThrow(/disposed/)
  })
})
