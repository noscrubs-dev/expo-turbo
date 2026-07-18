import { describe, expect, test } from "bun:test";
import type { TurboRequest, TurboResponse } from "expo-turbo/adapters";
import {
  DocumentSession,
  EXPO_TURBO_MIME_TYPE,
  FrameController,
  FrameRequestLoader,
  parseExpoTurboDocument,
} from "expo-turbo/core";

import { DemoVisibilityRegistry } from "./demo-visibility";

describe("demo Frame visibility", () => {
  test("defaults unknown and unmeasured Frames to hidden", () => {
    const visibility = new DemoVisibilityRegistry();
    expect(visibility.isVisible("lazy-frame")).toBe(false);

    visibility.register("lazy-frame", () => {});
    visibility.setViewport({ height: 100, width: 100, x: 0, y: 0 });

    expect(visibility.isVisible("lazy-frame")).toBe(false);
  });

  test("uses positive viewport intersection and excludes touching edges", () => {
    const visibility = new DemoVisibilityRegistry();
    visibility.setViewport({ height: 100, width: 100, x: 10, y: 20 });
    let rect = { height: 10, width: 10, x: 109, y: 119 };
    visibility.register("lazy-frame", (listener) =>
      listener(rect.x, rect.y, rect.width, rect.height),
    );

    expect(visibility.isVisible("lazy-frame")).toBe(true);

    rect = { ...rect, x: 110 };
    visibility.remeasure("lazy-frame");
    expect(visibility.isVisible("lazy-frame")).toBe(false);

    rect = { ...rect, x: 20, y: 120 };
    visibility.remeasure("lazy-frame");
    expect(visibility.isVisible("lazy-frame")).toBe(false);

    rect = { ...rect, height: 1, y: 119 };
    visibility.remeasure("lazy-frame");
    expect(visibility.isVisible("lazy-frame")).toBe(true);
  });

  test("publishes only boolean transitions across scroll remeasurement", () => {
    const visibility = new DemoVisibilityRegistry();
    const transitions: boolean[] = [];
    let y = 140;
    visibility.setViewport({ height: 100, width: 100, x: 0, y: 0 });
    visibility.subscribe("lazy-frame", (visible) => transitions.push(visible));
    visibility.register("lazy-frame", (listener) => listener(0, y, 50, 20));

    visibility.remeasure();
    y = 90;
    visibility.remeasure();
    visibility.remeasure();
    y = -20;
    visibility.remeasure();

    expect(transitions).toEqual([true, false]);
  });

  test("ignores stale asynchronous measurements", () => {
    const visibility = new DemoVisibilityRegistry();
    const measurements: ((x: number, y: number, width: number, height: number) => void)[] = [];
    visibility.setViewport({ height: 100, width: 100, x: 0, y: 0 });
    visibility.register("lazy-frame", (listener) => measurements.push(listener));
    visibility.remeasure("lazy-frame");

    measurements[1]?.(0, 0, 20, 20);
    measurements[0]?.(0, 200, 20, 20);

    expect(visibility.isVisible("lazy-frame")).toBe(true);
  });

  test("ignores stale asynchronous viewport measurements", () => {
    const visibility = new DemoVisibilityRegistry();
    const measurements: ((x: number, y: number, width: number, height: number) => void)[] = [];
    visibility.measureViewport((listener) => measurements.push(listener));
    visibility.measureViewport((listener) => measurements.push(listener));
    visibility.register("lazy-frame", (listener) => listener(0, 90, 20, 20));

    measurements[1]?.(0, 0, 100, 100);
    measurements[0]?.(0, 0, 50, 50);

    expect(visibility.isVisible("lazy-frame")).toBe(true);
  });

  test("keeps a lazy Frame idle offscreen and loads it once after appearance", async () => {
    const visibility = new DemoVisibilityRegistry();
    const requests: TurboRequest[] = [];
    let settle: ((response: TurboResponse) => void) | undefined;
    let y = 140;
    visibility.setViewport({ height: 100, width: 100, x: 0, y: 0 });
    visibility.register("lazy-frame", (listener) => listener(0, y, 50, 20));
    const session = new DocumentSession(
      parseExpoTurboDocument(
        '<Gallery><turbo-frame id="lazy-frame" loading="lazy" src="/frame"><Loading /></turbo-frame></Gallery>',
        { url: "https://example.test/demo" },
      ),
    );
    const loader = new FrameRequestLoader(
      session,
      {
        fetch: (request) => {
          requests.push(request);
          return new Promise<TurboResponse>((resolve) => {
            settle = resolve;
          });
        },
      },
      { next: () => "lazy-request" },
    );
    const controller = new FrameController(session, "lazy-frame", loader, visibility);

    expect(await controller.connect()).toBeUndefined();
    expect(requests).toHaveLength(0);

    y = 90;
    visibility.remeasure();
    const loaded = controller.loaded;
    expect(requests).toHaveLength(1);
    settle?.({
      headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
      redirected: false,
      status: 200,
      text: async () => '<Gallery><turbo-frame id="lazy-frame"><Loaded /></turbo-frame></Gallery>',
      url: "https://example.test/frame",
    });
    expect(await loaded).toMatchObject({ status: "completed" });

    visibility.remeasure();
    expect(requests).toHaveLength(1);
  });

  test("unregisters identity-safely and releases subscriber state", () => {
    const visibility = new DemoVisibilityRegistry();
    const transitions: boolean[] = [];
    visibility.setViewport({ height: 100, width: 100, x: 0, y: 0 });
    const unsubscribe = visibility.subscribe("lazy-frame", (visible) =>
      transitions.push(visible),
    );
    const unregisterOld = visibility.register("lazy-frame", (listener) =>
      listener(0, 0, 20, 20),
    );
    const unregisterCurrent = visibility.register("lazy-frame", (listener) =>
      listener(0, 0, 20, 20),
    );

    unregisterOld();
    expect(visibility.isVisible("lazy-frame")).toBe(true);
    unregisterCurrent();
    expect(visibility.isVisible("lazy-frame")).toBe(false);
    unsubscribe();
    visibility.register("lazy-frame", (listener) => listener(0, 0, 20, 20));

    expect(transitions).toEqual([true, false, true, false]);
  });

  test("rejects malformed registrations and viewports", () => {
    const visibility = new DemoVisibilityRegistry();

    expect(() => visibility.register("", () => {})).toThrow(TypeError);
    expect(() => visibility.subscribe("", () => {})).toThrow(TypeError);
    expect(() => visibility.measureViewport(undefined as never)).toThrow(TypeError);
    expect(() =>
      visibility.setViewport({ height: Number.NaN, width: 1, x: 0, y: 0 }),
    ).toThrow(TypeError);
    expect(() => visibility.setViewport({ height: -1, width: 1, x: 0, y: 0 })).toThrow(
      TypeError,
    );
  });
});
