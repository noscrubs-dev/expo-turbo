import { describe, expect, test } from "bun:test"

import type { DemoMeasureInWindow, DemoVisibilityRect } from "./demo-visibility"
import { DemoAutofocusScrollRegistry } from "./demo-autofocus-scroll"

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

function harness(options: Readonly<{ available?: boolean; target?: DemoVisibilityRect }> = {}) {
  const registry = new DemoAutofocusScrollRegistry()
  const target = measurement()
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
  const unregisterTarget = registry.register("id:field", target.measure)
  viewport.emit({ height: 300, width: 320, x: 0, y: 100 })
  target.emit(options.target ?? { height: 44, width: 320, x: 0, y: 450 })

  return {
    registry,
    scrolls,
    setAvailable(next: boolean): void {
      available = next
    },
    setScrollY(next: number): void {
      scrollY = next
    },
    target,
    unregisterContainer,
    unregisterTarget,
    viewport,
  }
}

describe("demo autofocus scrolling", () => {
  test("brings a registered target into the nearest root viewport edge", () => {
    const current = harness()
    const targetMeasurements = current.target.calls
    const viewportMeasurements = current.viewport.calls

    expect(current.registry.canScroll("id:field")).toBe(true)
    current.registry.scrollTo("id:field")

    expect(current.scrolls).toEqual([{ animated: false, y: 119 }])
    expect(current.target.calls).toBe(targetMeasurements)
    expect(current.viewport.calls).toBe(viewportMeasurements)
  })

  test("does not scroll an already visible target or an unavailable root", () => {
    const visible = harness({ target: { height: 44, width: 320, x: 0, y: 180 } })
    visible.registry.scrollTo("id:field")
    expect(visible.scrolls).toEqual([])

    const unavailable = harness({ available: false })
    expect(unavailable.registry.canScroll("id:field")).toBe(false)
    unavailable.registry.scrollTo("id:field")
    expect(unavailable.scrolls).toEqual([])
    unavailable.setAvailable(true)
    expect(unavailable.registry.canScroll("id:field")).toBe(true)
  })

  test("retains one early request until current root and target geometry arrives", () => {
    const registry = new DemoAutofocusScrollRegistry()
    const target = measurement()
    const viewport = measurement()
    const scrolls: Readonly<{ animated: boolean; y: number }>[] = []
    registry.registerContainer({
      getScrollY: () => 25,
      isAvailable: () => true,
      measure: viewport.measure,
      scrollTo: (options) => scrolls.push(options),
    })
    registry.register("id:field", target.measure)

    expect(registry.canScroll("id:field")).toBe(true)
    registry.scrollTo("id:field")
    expect(scrolls).toEqual([])

    target.emit({ height: 44, width: 320, x: 0, y: 450 })
    expect(scrolls).toEqual([])
    viewport.emit({ height: 300, width: 320, x: 0, y: 100 })

    expect(scrolls).toEqual([{ animated: false, y: 119 }])
  })

  test("keeps stale target measurements and unregisters identity-safe", () => {
    const current = harness()
    const replacement = measurement()
    const unregisterReplacement = current.registry.register("id:field", replacement.measure)

    current.target.emit({ height: 44, width: 320, x: 0, y: 450 })
    expect(current.registry.canScroll("id:field")).toBe(true)
    current.registry.scrollTo("id:field")
    expect(current.scrolls).toEqual([])
    replacement.emit({ height: 44, width: 320, x: 0, y: 450 })
    expect(current.scrolls).toEqual([{ animated: false, y: 119 }])

    current.unregisterTarget()
    expect(current.registry.canScroll("id:field")).toBe(true)
    unregisterReplacement()
    expect(current.registry.canScroll("id:field")).toBe(false)
  })

  test("releases native registrations on disposal", () => {
    const current = harness()

    current.registry.dispose()
    current.registry.dispose()
    current.setScrollY(500)
    current.registry.remeasure()
    current.registry.scrollTo("id:field")

    expect(current.registry.canScroll("id:field")).toBe(false)
    expect(current.scrolls).toEqual([])
    expect(() => current.registry.register("id:late", () => {})).toThrow(/disposed/)
    expect(() => current.registry.registerContainer({} as never)).toThrow(/disposed/)
  })
})
