import { describe, expect, test } from "bun:test";

import { DemoDocumentRefreshScrollRegistry } from "./demo-document-refresh-scroll";

describe("DemoDocumentRefreshScrollRegistry", () => {
  test("resets and restores its registered root container while it remains available", () => {
    const registry = new DemoDocumentRefreshScrollRegistry();
    const calls: string[] = [];
    let available = true;
    const unregister = registry.registerContainer({
      isAvailable: () => available,
      scrollTo: ({ x, y }) => {
        calls.push(`restore:${x},${y}`);
      },
      scrollToTop: () => {
        calls.push("top");
      },
    });

    expect(registry.canReset()).toBe(true);
    expect(registry.canRestore()).toBe(true);
    registry.reset();
    registry.restore({ x: 4, y: 7 });
    expect(calls).toEqual(["top", "restore:4,7"]);

    available = false;
    expect(registry.canReset()).toBe(false);
    expect(registry.canRestore()).toBe(false);
    registry.reset();
    registry.restore({ x: 8, y: 9 });
    expect(calls).toEqual(["top", "restore:4,7"]);

    unregister();
    available = true;
    expect(registry.canReset()).toBe(false);
    expect(registry.canRestore()).toBe(false);
    registry.dispose();
  });

  test("rejects invalid containers and becomes inert after disposal", () => {
    const registry = new DemoDocumentRefreshScrollRegistry();

    expect(() => registry.registerContainer({} as never)).toThrow(TypeError);
    registry.dispose();
    expect(registry.canReset()).toBe(false);
    expect(() => registry.registerContainer({} as never)).toThrow("disposed");
  });
});
