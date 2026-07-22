import { describe, expect, test } from "bun:test";

import { DemoDocumentAnchorScrollRegistry } from "./demo-document-anchor-scroll";

describe("DemoDocumentAnchorScrollRegistry", () => {
  test("maps a registered top-level target into the owning root ScrollView", () => {
    const registry = new DemoDocumentAnchorScrollRegistry();
    const calls: Readonly<{ x: number; y: number }>[] = [];
    let available = true;
    const unregisterContainer = registry.registerContainer({
      isAvailable: () => available,
      scrollTo: (position) => {
        calls.push(position);
      },
    });
    const unregisterTarget = registry.registerTarget("section", { getOffset: () => 320 });
    registry.setDocumentOffset(48);
    registry.setDocumentContentOffset(62);

    expect(registry.scrollTo("section", "start")).toBeUndefined();
    expect(calls).toEqual([{ x: 0, y: 430 }]);

    available = false;
    registry.scrollTo("section", "start");
    expect(calls).toEqual([{ x: 0, y: 430 }]);

    unregisterTarget();
    available = true;
    registry.scrollTo("section", "start");
    expect(calls).toEqual([{ x: 0, y: 430 }]);

    unregisterContainer();
    registry.dispose();
  });

  test("rejects incomplete registrations and clears target ownership on disposal", () => {
    const registry = new DemoDocumentAnchorScrollRegistry();

    expect(() => registry.registerContainer({} as never)).toThrow(TypeError);
    expect(() =>
      registry.registerNestedContainer(" nested", {
        isAvailable: () => true,
        scrollTo: () => undefined,
      }),
    ).toThrow(TypeError);
    expect(() => registry.registerTarget("", { getOffset: () => 0 })).toThrow(TypeError);
    expect(() => registry.registerTarget("section", { getOffset: () => 0 }, " nested")).toThrow(
      TypeError,
    );
    expect(() => registry.setDocumentOffset(-1)).toThrow(TypeError);
    expect(() => registry.setDocumentContentOffset(-1)).toThrow(TypeError);
    registry.dispose();
    expect(registry.scrollTo("section", "start")).toBeUndefined();
    expect(() => registry.setDocumentOffset(undefined)).not.toThrow();
    expect(() => registry.setDocumentContentOffset(undefined)).not.toThrow();
    expect(() => registry.registerTarget("section", { getOffset: () => 0 })).toThrow("disposed");
    expect(() =>
      registry.registerNestedContainer("nested", {
        isAvailable: () => true,
        scrollTo: () => undefined,
      }),
    ).toThrow("disposed");
  });

  test("holds one Expo Go link target until native layout makes it scrollable", () => {
    const registry = new DemoDocumentAnchorScrollRegistry();
    const calls: Readonly<{ x: number; y: number }>[] = [];
    let targetOffset: number | undefined;

    registry.requestDeferredAnchor("section");
    registry.registerContainer({
      isAvailable: () => true,
      scrollTo: (position) => {
        calls.push(position);
      },
    });
    registry.setDocumentOffset(48);
    registry.setDocumentContentOffset(62);
    registry.registerTarget("section", { getOffset: () => targetOffset });

    expect(calls).toEqual([]);
    targetOffset = 320;
    registry.notifyDeferredAnchorLayout();

    expect(calls).toEqual([{ x: 0, y: 430 }]);
    registry.confirmDeferredAnchorContentSize();
    expect(calls).toEqual([
      { x: 0, y: 430 },
      { x: 0, y: 430 },
    ]);
    registry.setDocumentContentOffset(64);
    expect(calls).toEqual([
      { x: 0, y: 430 },
      { x: 0, y: 430 },
    ]);
  });

  test("routes an owned target to its declared nested ScrollView", () => {
    const registry = new DemoDocumentAnchorScrollRegistry();
    const rootCalls: Readonly<{ x: number; y: number }>[] = [];
    const nestedCalls: Readonly<{ x: number; y: number }>[] = [];
    registry.registerContainer({
      isAvailable: () => true,
      scrollTo: (position) => rootCalls.push(position),
    });
    registry.setDocumentOffset(48);
    registry.setDocumentContentOffset(62);
    registry.registerNestedContainer("nested", {
      isAvailable: () => true,
      scrollTo: (position) => nestedCalls.push(position),
    });
    registry.registerTarget("section", { getOffset: () => 320 }, "nested");

    registry.scrollTo("section", "start");

    expect(rootCalls).toEqual([]);
    expect(nestedCalls).toEqual([{ x: 0, y: 320 }]);
  });

  test("holds a deferred nested target until its root reveal owner is registered", () => {
    const registry = new DemoDocumentAnchorScrollRegistry();
    const reveals: number[] = [];
    const nestedCalls: Readonly<{ x: number; y: number }>[] = [];
    registry.requestDeferredAnchor("section");
    registry.registerNestedContainer("nested", {
      isAvailable: () => true,
      measure: (listener) => listener(0, 600, 320, 160),
      scrollTo: (position) => nestedCalls.push(position),
    });
    registry.registerTarget("section", { getOffset: () => 320 }, "nested");

    expect(reveals).toEqual([]);
    expect(nestedCalls).toEqual([]);

    registry.registerContainer({
      isAvailable: () => true,
      reveal: (container) => container.measure?.((_x, y) => reveals.push(y)),
      scrollTo: () => undefined,
    });

    expect(reveals).toEqual([600]);
    expect(nestedCalls).toEqual([{ x: 0, y: 320 }]);
  });
});
