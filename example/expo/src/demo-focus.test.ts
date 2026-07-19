import { describe, expect, test } from "bun:test";

import { type DemoFocusHandle, DemoFocusRegistry } from "./demo-focus";

describe("demo focus registry", () => {
  test("maps logical node keys to exact native focus handles", () => {
    const registry = new DemoFocusRegistry();
    const calls: string[] = [];
    const unregister = registry.register("id:first-name", {
      blur: () => calls.push("blur"),
      focus: () => calls.push("focus"),
    });

    expect(registry.canFocus("id:first-name")).toBe(true);
    expect(registry.canFocus("id:missing")).toBe(false);
    registry.focus("id:first-name");
    expect(calls).toEqual(["focus"]);
    expect(registry.getFocusedId()).toBe("id:first-name");

    registry.blur("id:first-name");
    expect(calls).toEqual(["focus", "blur"]);
    expect(registry.getFocusedId()).toBeUndefined();

    unregister();
    unregister();
    expect(registry.canFocus("id:first-name")).toBe(false);
    expect(() => registry.focus("id:first-name")).toThrow(/No active demo focus handle/);
  });

  test("keeps unregister identity-safe and clears focused state on cleanup", () => {
    const registry = new DemoFocusRegistry();
    const first = registry.register("id:field", { blur() {}, focus() {} });
    registry.focus("id:field");
    first();
    expect(registry.getFocusedId()).toBeUndefined();

    const replacement = registry.register("id:field", { blur() {}, focus() {} });
    first();
    registry.focus("id:field");
    expect(registry.getFocusedId()).toBe("id:field");
    replacement();
  });

  test("restores focus bookkeeping only for an immediate exact effect replay", async () => {
    const registry = new DemoFocusRegistry();
    const handle = { blur() {}, focus() {} };
    const eventToken = {};
    let unregister = registry.register("id:field", handle, eventToken);
    registry.focus("id:field");

    unregister();
    expect(registry.getFocusedId()).toBeUndefined();
    unregister = registry.register("id:field", handle, eventToken);
    expect(registry.getFocusedId()).toBe("id:field");

    unregister();
    await Promise.resolve();
    registry.register("id:field", handle, eventToken);
    expect(registry.getFocusedId()).toBeUndefined();

    const competing = { blur() {}, focus() {} };
    registry.register("id:competing", competing);
    registry.focus("id:field");
    unregister = registry.register("id:replay", handle, eventToken);
    registry.focus("id:replay");
    unregister();
    registry.focus("id:competing");
    registry.register("id:replay", handle, eventToken);
    expect(registry.getFocusedId()).toBe("id:competing");
  });

  test("tracks user-driven focus and ignores reentrant stale handles", () => {
    const registry = new DemoFocusRegistry();
    const userHandle = { blur() {}, focus() {} };
    const first = registry.register("id:user-field", userHandle);
    registry.handleFocus("id:user-field", userHandle);
    expect(registry.getFocusedId()).toBe("id:user-field");
    registry.handleBlur("id:user-field", userHandle);
    expect(registry.getFocusedId()).toBeUndefined();
    first();

    let unregister: () => void = () => undefined;
    unregister = registry.register("id:reentrant", {
      blur() {},
      focus() {
        unregister();
      },
    });
    registry.focus("id:reentrant");
    expect(registry.getFocusedId()).toBeUndefined();

    let replace: () => void = () => undefined;
    replace = registry.register("id:replacement", {
      blur() {},
      focus() {
        replace();
        registry.register("id:replacement", { blur() {}, focus() {} });
      },
    });
    registry.focus("id:replacement");
    expect(registry.getFocusedId()).toBeUndefined();
    registry.focus("id:replacement");
    expect(registry.getFocusedId()).toBe("id:replacement");
  });

  test("ignores stale native events and preserves reentrant refocus during blur", () => {
    const registry = new DemoFocusRegistry();
    const stale = { blur() {}, focus() {} };
    const unregisterStale = registry.register("id:field", stale);
    unregisterStale();

    const replacement = { blur() {}, focus() {} };
    registry.register("id:field", replacement);
    registry.handleFocus("id:field", stale);
    expect(registry.getFocusedId()).toBeUndefined();
    registry.handleFocus("id:field", replacement);
    registry.handleBlur("id:field", stale);
    expect(registry.getFocusedId()).toBe("id:field");

    let refocusing: DemoFocusHandle;
    refocusing = {
      blur() {
        registry.handleFocus("id:refocus", refocusing);
      },
      focus() {},
    };
    registry.register("id:refocus", refocusing);
    registry.focus("id:refocus");
    registry.blur("id:refocus");
    expect(registry.getFocusedId()).toBe("id:refocus");

    const blurReplacement = { blur() {}, focus() {} };
    let unregisterBlurSource: () => void = () => undefined;
    const blurSource: DemoFocusHandle = {
      blur() {
        unregisterBlurSource();
        registry.register("id:replace-on-blur", blurReplacement);
        registry.handleFocus("id:replace-on-blur", blurReplacement);
      },
      focus() {},
    };
    unregisterBlurSource = registry.register("id:replace-on-blur", blurSource);
    registry.focus("id:replace-on-blur");
    registry.blur("id:replace-on-blur");
    expect(registry.getFocusedId()).toBe("id:replace-on-blur");
  });

  test("rejects duplicate or malformed registrations and all work after disposal", () => {
    const registry = new DemoFocusRegistry();
    registry.register("id:field", { blur() {}, focus() {} });
    expect(() => registry.register("id:field", { blur() {}, focus() {} })).toThrow(
      /already registered/,
    );
    expect(() => registry.register("", { blur() {}, focus() {} })).toThrow(
      /require an ID and focusable handle/,
    );

    registry.dispose();
    registry.dispose();
    expect(registry.getFocusedId()).toBeUndefined();
    expect(() => registry.canFocus("id:field")).toThrow(/disposed/);
    expect(() => registry.focus("id:field")).toThrow(/disposed/);
    expect(() => registry.register("id:late", { blur() {}, focus() {} })).toThrow(/disposed/);
  });
});
