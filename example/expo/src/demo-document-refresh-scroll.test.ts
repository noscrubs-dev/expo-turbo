import { describe, expect, test } from "bun:test";

import { DemoDocumentRefreshScrollRegistry } from "./demo-document-refresh-scroll";

describe("DemoDocumentRefreshScrollRegistry", () => {
  test("resets its registered root container once while it remains available", () => {
    const registry = new DemoDocumentRefreshScrollRegistry();
    const calls: string[] = [];
    let available = true;
    const unregister = registry.registerContainer({
      isAvailable: () => available,
      scrollToTop: () => {
        calls.push("top");
      },
    });

    expect(registry.canReset()).toBe(true);
    registry.reset();
    expect(calls).toEqual(["top"]);

    available = false;
    expect(registry.canReset()).toBe(false);
    registry.reset();
    expect(calls).toEqual(["top"]);

    unregister();
    available = true;
    expect(registry.canReset()).toBe(false);
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
