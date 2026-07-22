/// <reference types="bun" />

import { describe, expect, mock, test } from "bun:test";
import type { ClockAdapter, FetchAdapter, TurboRequest, TurboResponse } from "expo-turbo/adapters";
import {
  dispatchTurboStreamFragment,
  EXPO_TURBO_MIME_TYPE,
  isElement,
  StateError,
} from "expo-turbo/core";
import { createElement, Fragment, forwardRef, StrictMode, useImperativeHandle, useRef } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import type {
  DemoRouterNavigation,
  DemoRouterRoute,
  DemoRouterState,
} from "./demo-router-history";

interface NativeScrollCall {
  readonly containerId: number;
  readonly options: Readonly<{ animated: boolean; x: number; y: number }>;
}

interface NativeScrollViewHandle {
  readonly getNativeScrollRef: () => Readonly<{
    measureInWindow: (
      listener: (x: number, y: number, width: number, height: number) => void,
    ) => void;
  }>;
  readonly scrollTo: (options: Readonly<{ animated?: boolean; x?: number; y?: number }>) => void;
}

const nativeScrollCalls: NativeScrollCall[] = [];
const nativeRootScrollContainerIds: number[] = [];
let nextNativeScrollContainerId = 0;

const NativeScrollView = forwardRef<NativeScrollViewHandle, Readonly<Record<string, unknown>>>(
  (props, ref) => {
    const containerId = useRef(0);
    if (containerId.current === 0) {
      containerId.current = ++nextNativeScrollContainerId;
      if (props.contentInsetAdjustmentBehavior === "automatic") {
        nativeRootScrollContainerIds.push(containerId.current);
      }
    }
    useImperativeHandle(ref, () => ({
      getNativeScrollRef: () => ({
        measureInWindow(listener) {
          listener(0, 0, 390, 844);
        },
      }),
      scrollTo(options) {
        nativeScrollCalls.push({
          containerId: containerId.current,
          options: {
            animated: options.animated ?? false,
            x: options.x ?? 0,
            y: options.y ?? 0,
          },
        });
      },
    }));
    return createElement("scroll-view", props);
  },
);
NativeScrollView.displayName = "NativeScrollView";

mock.module("react-native", () => ({
  AccessibilityInfo: { announceForAccessibility: () => undefined },
  Alert: { alert: () => undefined },
  AppState: { addEventListener: () => ({ remove: () => undefined }), currentState: "active" },
  FlatList: (props: Readonly<Record<string, unknown>>) => createElement("flat-list", props),
  Linking: { openURL: async () => undefined },
  Platform: { OS: "web" },
  Pressable: (props: Readonly<Record<string, unknown>>) =>
    createElement("pressable", props),
  ScrollView: NativeScrollView,
  Text: (props: Readonly<Record<string, unknown>>) => createElement("native-text", props),
  TextInput: (props: Readonly<Record<string, unknown>>) =>
    createElement("text-input", props),
  useWindowDimensions: () => ({ height: 844, width: 390 }),
  View: (props: Readonly<Record<string, unknown>>) => createElement("view", props),
}));

mock.module("expo-router", () => ({
  Stack: { Screen: () => null },
  useIsFocused: () => true,
  useNavigation: () => undefined,
  useNavigationContainerRef: () => ({
    addListener: () => () => undefined,
    isReady: () => true,
  }),
  useRoute: () => ({ key: "demo-route-1" }),
}));

const {
  DEMO_ROUTER_ROUTE_NAME,
  decodeDemoRouterHistoryEntry,
  encodeDemoRouterHistoryEntry,
} = await import("./demo-router-history");
const { DEMO_ROUTER_PATH_PARAM, encodeDemoRouterDocumentPath } = await import(
  "./demo-router-path"
);
const { DemoRouterRouteOwner } = await import("./demo-router-route-owner");
const { createDemoRuntime, DemoRuntimeProvider, useDemoRuntime } = await import(
  "./demo-runtime"
);
const { createDemoFixtureFetchAdapter } = await import("./demo-document-controller");
const { DEMO_REGISTRY } = await import("./demo-registry");
const { DemoCompatibilityGallery } = await import("./demo-route-screen");
const { ExpoTurboRoot } = await import("expo-turbo/react");

const globalWithAct = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean;
};
globalWithAct.IS_REACT_ACT_ENVIRONMENT = true;

const COLD_START_DOCUMENT = `<Gallery data-turbo-root="/demo">
  <DemoCard id="cold-start-document" title="Cold start restored">
    <DemoText>The managed Router entry loaded before history adoption.</DemoText>
  </DemoCard>
</Gallery>`;

function response(
  request: TurboRequest,
  options: Readonly<{
    contentType?: string;
    redirected?: boolean;
    status?: number;
    url?: string;
    xml?: string;
  }> = {},
): TurboResponse {
  return {
    headers: { "Content-Type": options.contentType ?? EXPO_TURBO_MIME_TYPE },
    redirected: options.redirected ?? false,
    status: options.status ?? 200,
    text: async () => options.xml ?? COLD_START_DOCUMENT,
    url: options.url ?? request.url,
  };
}

interface PendingFetch {
  readonly reject: (error: unknown) => void;
  readonly request: TurboRequest;
  readonly resolve: (response: TurboResponse) => void;
}

class ControlledFetch implements FetchAdapter {
  readonly pending: PendingFetch[] = [];

  fetch(request: TurboRequest): Promise<TurboResponse> {
    return new Promise((resolve, reject) => {
      this.pending.push({ reject, request, resolve });
    });
  }
}

const nextTurn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const INITIAL_ROUTE_KEY = "demo-route-1";
const GALLERY_URL = "https://example.test/demo";
const LINKED_URL = "https://example.test/demo/linked";
const LINKED_QUERY_URL = "https://example.test/demo/linked?source=deep-link&tag=a&tag=b";
const LINKED_REPLACEMENT_QUERY_URL = "https://example.test/demo/linked?source=changed";
const GALLERY_QUERY_LINKED_URL =
  "https://example.test/demo/linked?source=gallery&tag=a&tag=b&empty=";
const PREVIEW_URL = "https://example.test/demo/linked?preview=automatic";
const REFRESH_SCENARIO_URL = "https://example.test/demo/linked?refresh=scroll";
const HISTORY_SCROLL_URL = "https://example.test/demo/linked?history=scroll";
const AUTOFOCUS_SCROLL_URL = "https://example.test/demo/linked?autofocus=scroll";
const GENERIC_ROUTE_URL =
  "https://example.test/demo/routes/ios-proof/details?source=gallery&tag=a&tag=b&empty=";

interface FixtureTimer {
  readonly callback: () => void;
  cleared: boolean;
  readonly delayMs: number;
}

function createFixtureClock(): readonly [ClockAdapter, FixtureTimer[]] {
  const timers: FixtureTimer[] = [];
  return [
    {
      clearTimeout(handle) {
        const timer = timers.find((candidate) => candidate === handle);
        if (timer) timer.cleared = true;
      },
      now: () => 0,
      setTimeout(callback, delayMs): unknown {
        const timer: FixtureTimer = { callback, cleared: false, delayMs };
        timers.push(timer);
        return timer;
      },
    },
    timers,
  ];
}

function routeParams(
  url: string,
  params: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    [DEMO_ROUTER_PATH_PARAM]: encodeDemoRouterDocumentPath(url),
    ...params,
  });
}

class TestNavigation implements DemoRouterNavigation {
  private key = 1;
  private readonly listeners = new Set<() => void>();
  pushCalls = 0;
  resetCalls = 0;
  setParamsCalls = 0;
  state: DemoRouterState;

  constructor(params?: Readonly<Record<string, unknown>>) {
    this.state = Object.freeze({
      stale: false,
      type: "stack",
      key: "stack-1",
      index: 0,
      routeNames: Object.freeze([DEMO_ROUTER_ROUTE_NAME]),
      preloadedRoutes: Object.freeze([]),
      routes: Object.freeze([
        Object.freeze({
          key: INITIAL_ROUTE_KEY,
          name: DEMO_ROUTER_ROUTE_NAME,
          path: "/demo",
          params: routeParams(GALLERY_URL, params),
        }),
      ]),
    });
  }

  get listenerCount(): number {
    return this.listeners.size;
  }

  addListener(event: "state", listener: () => void): () => void {
    expect(event).toBe("state");
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  canGoBack(): boolean {
    return this.state.index > 0;
  }

  getState(): DemoRouterState {
    return this.state;
  }

  goBack(): void {
    if (!this.canGoBack()) throw new Error("cannot go back");
    this.state = Object.freeze({ ...this.state, index: this.state.index - 1 });
    this.emit();
  }

  push(name: string, params: Readonly<Record<string, unknown>>): void {
    this.pushCalls += 1;
    const routes = [
      ...this.state.routes.slice(0, this.state.index + 1),
      Object.freeze({ key: `${name}-${++this.key}`, name, path: undefined, params }),
    ];
    this.state = Object.freeze({
      ...this.state,
      index: routes.length - 1,
      preloadedRoutes: Object.freeze(
        this.state.preloadedRoutes.filter((route) => route.key !== routes.at(-1)?.key),
      ),
      routes: Object.freeze(routes),
    });
    this.emit();
  }

  reset(state: DemoRouterState): void {
    this.resetCalls += 1;
    this.state = state;
    this.emit();
  }

  replaceFocusedParams(params: Readonly<Record<string, unknown>>): void {
    const route = this.state.routes[this.state.index] as DemoRouterRoute;
    const routes = [...this.state.routes];
    routes[this.state.index] = Object.freeze({ ...route, params: Object.freeze({ ...params }) });
    this.state = Object.freeze({ ...this.state, routes: Object.freeze(routes) });
    this.emit();
  }

  setParams(params: Readonly<Record<string, unknown>>): void {
    this.setParamsCalls += 1;
    const route = this.state.routes[this.state.index] as DemoRouterRoute;
    const routes = [...this.state.routes];
    routes[this.state.index] = Object.freeze({
      ...route,
      params: Object.freeze({ ...(route.params ?? {}), ...params }),
    });
    this.state = Object.freeze({ ...this.state, routes: Object.freeze(routes) });
    this.emit();
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

type DemoRuntimeInstance = ReturnType<typeof createDemoRuntime>;

function routeTree(
  runtime: DemoRuntimeInstance,
  navigation: TestNavigation,
  focused = true,
) {
  return createElement(
    DemoRuntimeProvider,
    { runtime },
    createElement(
      DemoRouterRouteOwner,
      { focused, navigation, routeKey: INITIAL_ROUTE_KEY, runtime },
      createElement("active-route"),
    ),
  );
}

describe("demo app runtime ownership", () => {
  test("shares one Stream lifecycle through direct gallery dispatch", () => {
    const runtime = createDemoRuntime();
    const events: string[] = [];
    const unsubscribeBefore = runtime.streamLifecycle.subscribe(
      "before-stream-render",
      (event) => {
        events.push(`before:${event.detail.action}`);
        return undefined;
      },
    );
    const unsubscribeAction = runtime.streamLifecycle.subscribe("stream-action", (event) => {
      events.push(`action:${event.detail.report.status}`);
      return undefined;
    });

    try {
      const report = dispatchTurboStreamFragment(
        runtime.session,
        '<turbo-stream action="update" target="static-renderer"><template><DemoText>Lifecycle update.</DemoText></template></turbo-stream>',
        { streamLifecycle: runtime.streamLifecycle },
      );

      expect(report.actions.map((action) => action.status)).toEqual(["applied"]);
      expect(events).toEqual(["before:update", "action:applied"]);
    } finally {
      unsubscribeBefore();
      unsubscribeAction();
      runtime.dispose();
    }
  });

  test("keeps virtualized Frame responses inside the declared style vocabulary", async () => {
    const runtime = createDemoRuntime();

    try {
      const controller = runtime.frames.get("flatlist-lazy-frame-one");
      await controller.setLoading("eager");
      await controller.connect();
      await controller.loaded;
      const frame = runtime.session.tree.getElementById("flatlist-lazy-frame-one");
      const card = frame?.children.find(
        (node) => isElement(node) && node.tagName === "DemoCard",
      );
      if (!card || !isElement(card)) throw new Error("Virtualized Frame card did not load");

      expect(DEMO_REGISTRY.decode(card).props).toMatchObject({
        styleTokens: ["space:compact"],
        tone: "positive",
      });
    } finally {
      runtime.dispose();
    }
  });

  test("shares one submit lifecycle through the rendered native form", async () => {
    const runtime = createDemoRuntime();
    const events: string[] = [];
    let resolveEnd: () => void = () => undefined;
    const ended = new Promise<void>((resolve) => {
      resolveEnd = resolve;
    });
    const unsubscribeStart = runtime.submissionLifecycle.subscribe("submit-start", (event) => {
      events.push(`${event.type}:${event.detail.formSubmission.requestId}`);
    });
    const unsubscribeEnd = runtime.submissionLifecycle.subscribe("submit-end", (event) => {
      const outcome =
        "fetchResponse" in event.detail
          ? "response"
          : "error" in event.detail
            ? "error"
            : "canceled";
      events.push(`${event.type}:${outcome}`);
      resolveEnd();
    });
    const originalConfirm = globalThis.confirm;
    globalThis.confirm = () => true;
    let renderer: ReactTestRenderer | undefined;

    try {
      await act(async () => {
        renderer = create(
          createElement(
            DemoRuntimeProvider,
            { runtime },
            createElement(ExpoTurboRoot),
          ),
          {
            createNodeMock(element) {
              if (element.type === "text-input") return { blur() {}, focus() {} };
              if (element.type === "view") {
                return {
                  measureInWindow(
                    listener: (x: number, y: number, width: number, height: number) => void,
                  ) {
                    listener(0, 0, 320, 40);
                  },
                };
              }
              return {};
            },
          },
        );
        await Promise.resolve();
      });
      if (!renderer) throw new Error("renderer was not created");
      const submitter = renderer.root
        .findAll((node) => String(node.type) === "pressable")
        .find((pressable) =>
          pressable.findAll(
            (node) =>
              String(node.type) === "native-text" &&
              node.children.includes("Confirm and submit immutable request"),
          ).length > 0,
        );
      if (!submitter) throw new Error("native form submitter was not rendered");

      await act(async () => {
        submitter.props.onPress();
        await ended;
      });

      expect(events).toEqual(["submit-start:demo-form-id%3Acollect-form-1", "submit-end:response"]);
      expect(runtime.forms.controlsFor("id:native-form").submissionState.busy).toBeFalse();
    } finally {
      unsubscribeStart();
      unsubscribeEnd();
      globalThis.confirm = originalConfirm;
      await act(async () => {
        renderer?.unmount();
        await Promise.resolve();
      });
    }
  });

  test("focuses real initial-document and replacement-Frame inputs once in order", async () => {
    const runtime = createDemoRuntime();
    const nativeFocuses: string[] = [];
    let renderer: ReactTestRenderer | undefined;

    await act(async () => {
      renderer = create(
        createElement(
          StrictMode,
          null,
          createElement(
            DemoRuntimeProvider,
            { runtime },
            createElement(ExpoTurboRoot),
          ),
        ),
        {
          createNodeMock(element) {
            if (element.type === "text-input") {
              const props = element.props as Readonly<Record<string, unknown>>;
              return {
                blur() {},
                focus() {
                  nativeFocuses.push(String(props.accessibilityLabel));
                },
              };
            }
            if (element.type === "view") {
              return {
                measureInWindow(
                  listener: (x: number, y: number, width: number, height: number) => void,
                ) {
                  listener(0, 0, 320, 40);
                },
              };
            }
            return {};
          },
        },
      );
      await Promise.resolve();
    });
    if (!renderer) throw new Error("renderer was not created");
    expect(nativeFocuses).toEqual(["First name"]);
    expect(runtime.focus.getFocusedId()).toBe("id:first-name");

    const frameLink = renderer.root
      .findAll((node) => String(node.type) === "pressable")
      .find((pressable) =>
        pressable.findAll(
          (node) =>
            String(node.type) === "native-text" &&
            node.children.includes(
              "Load this Frame through the shared Frame visit controller.",
            ),
        ).length > 0,
    );
    if (!frameLink) throw new Error("Frame fixture link was not rendered");
    const frameController = runtime.frames.get("link-frame");

    await act(async () => {
      frameLink.props.onPress();
      await frameController.loaded;
      await Promise.resolve();
    });

    expect(nativeFocuses).toEqual(["First name", "Autofocused Frame field"]);
    expect(runtime.focus.getFocusedId()).toBe("id:frame-autofocus-name");

    await act(async () => {
      renderer?.unmount();
      await Promise.resolve();
    });
  });

  test("visits the gallery query fixture through the exact Router history URL", async () => {
    const runtime = createDemoRuntime();
    const navigation = new TestNavigation();
    let renderer: ReactTestRenderer | undefined;

    await act(async () => {
      renderer = create(
        createElement(
          DemoRuntimeProvider,
          { runtime },
          createElement(
            DemoRouterRouteOwner,
            { focused: true, navigation, routeKey: INITIAL_ROUTE_KEY, runtime },
            createElement(ExpoTurboRoot),
          ),
        ),
        {
          createNodeMock(element) {
            if (element.type === "text-input") return { blur() {}, focus() {} };
            if (element.type === "view") {
              return {
                measureInWindow(
                  listener: (x: number, y: number, width: number, height: number) => void,
                ) {
                  listener(0, 0, 320, 40);
                },
              };
            }
            return {};
          },
        },
      );
      await nextTurn();
    });
    if (!renderer) throw new Error("gallery query fixture did not render");
    const queryLink = renderer.root
      .findAll((node) => String(node.type) === "pressable")
      .find((pressable) =>
        pressable.findAll(
          (node) =>
            String(node.type) === "native-text" &&
            node.children.includes(
              "Open a query-bearing same-origin document and retain repeated and empty values through native history.",
            ),
        ).length > 0,
      );
    if (!queryLink) throw new Error("gallery query fixture link was not rendered");

    await act(async () => {
      queryLink.props.onPress();
      await nextTurn();
    });

    expect(runtime.session.tree.document.url).toBe(GALLERY_QUERY_LINKED_URL);
    expect(runtime.session.tree.getElementById("linked-document")).toBeDefined();
    expect(runtime.documentRuntime.history.current?.url).toBe(GALLERY_QUERY_LINKED_URL);
    expect(navigation.state.routes).toHaveLength(2);
    expect(navigation.state.routes[1]?.params?.[DEMO_ROUTER_PATH_PARAM]).toEqual([
      "demo",
      "linked",
    ]);
    expect(decodeDemoRouterHistoryEntry(navigation.state.routes[1]?.params)?.url).toBe(
      GALLERY_QUERY_LINKED_URL,
    );

    await act(async () => {
      renderer?.unmount();
      await Promise.resolve();
    });
  });

  test("visits the gallery generic nested route through the exact Router history URL", async () => {
    const runtime = createDemoRuntime();
    const navigation = new TestNavigation();
    let renderer: ReactTestRenderer | undefined;

    await act(async () => {
      renderer = create(
        createElement(
          DemoRuntimeProvider,
          { runtime },
          createElement(
            DemoRouterRouteOwner,
            { focused: true, navigation, routeKey: INITIAL_ROUTE_KEY, runtime },
            createElement(ExpoTurboRoot),
          ),
        ),
        {
          createNodeMock(element) {
            if (element.type === "text-input") return { blur() {}, focus() {} };
            if (element.type === "view") {
              return {
                measureInWindow(
                  listener: (x: number, y: number, width: number, height: number) => void,
                ) {
                  listener(0, 0, 320, 40);
                },
              };
            }
            return {};
          },
        },
      );
      await nextTurn();
    });
    if (!renderer) throw new Error("gallery generic route fixture did not render");
    const genericRouteLink = renderer.root
      .findAll((node) => String(node.type) === "pressable")
      .find((pressable) =>
        pressable.findAll(
          (node) =>
            String(node.type) === "native-text" &&
            node.children.includes(
              "Open a nested generic Router path and retain its ordered query metadata through native history.",
            ),
        ).length > 0,
      );
    if (!genericRouteLink) throw new Error("gallery generic route link was not rendered");

    await act(async () => {
      genericRouteLink.props.onPress();
      await nextTurn();
    });

    expect(runtime.session.tree.document.url).toBe(GENERIC_ROUTE_URL);
    expect(runtime.session.tree.getElementById("generic-route-document")).toBeDefined();
    expect(runtime.documentRuntime.history.current?.url).toBe(GENERIC_ROUTE_URL);
    expect(navigation.state.routes).toHaveLength(2);
    expect(navigation.state.routes[1]?.params?.[DEMO_ROUTER_PATH_PARAM]).toEqual([
      "demo",
      "routes",
      "ios-proof",
      "details",
    ]);
    expect(decodeDemoRouterHistoryEntry(navigation.state.routes[1]?.params)?.url).toBe(
      GENERIC_ROUTE_URL,
    );

    await act(async () => {
      renderer?.unmount();
      await Promise.resolve();
    });
  });

  test("scrolls the gallery root to the focused measured document field", async () => {
    const runtime = createDemoRuntime();
    const navigation = new TestNavigation();
    const scrolls: Readonly<{ animated: boolean; y: number }>[] = [];
    const unregisterContainer = runtime.autofocusScroll.registerContainer({
      getScrollY: () => 0,
      isAvailable: () => true,
      measure(listener) {
        listener(0, 0, 390, 844);
      },
      scrollTo(options) {
        scrolls.push(options);
      },
    });
    let renderer: ReactTestRenderer | undefined;

    await act(async () => {
      renderer = create(
        createElement(
          DemoRuntimeProvider,
          { runtime },
          createElement(
            DemoRouterRouteOwner,
            { focused: true, navigation, routeKey: INITIAL_ROUTE_KEY, runtime },
            createElement(ExpoTurboRoot),
          ),
        ),
        {
          createNodeMock(element) {
            if (element.type === "text-input") {
              const props = element.props as Readonly<Record<string, unknown>>;
              const target = props.accessibilityLabel === "Root autofocus scroll target";
              return {
                blur() {},
                focus() {},
                measureInWindow(
                  listener: (x: number, y: number, width: number, height: number) => void,
                ) {
                  listener(0, target ? 1_200 : 200, 320, 44);
                },
              };
            }
            if (element.type === "view") {
              return {
                measureInWindow(
                  listener: (x: number, y: number, width: number, height: number) => void,
                ) {
                  listener(0, 0, 320, 40);
                },
              };
            }
            return {};
          },
        },
      );
      await nextTurn();
    });
    if (!renderer) throw new Error("gallery autofocus-scroll fixture did not render");
    const proofLink = renderer.root
      .findAll((node) => String(node.type) === "pressable")
      .find((pressable) =>
        pressable.findAll(
          (node) =>
            String(node.type) === "native-text" &&
            node.children.includes(
              "Open the root autofocus-scroll proof and focus the measured native field below the viewport.",
            ),
        ).length > 0,
      );
    if (!proofLink) throw new Error("gallery autofocus-scroll proof link was not rendered");

    await act(async () => {
      proofLink.props.onPress();
      await nextTurn();
      await nextTurn();
    });

    expect(runtime.session.tree.document.url).toBe(AUTOFOCUS_SCROLL_URL);
    expect(runtime.session.tree.getElementById("root-autofocus-scroll-target")).toBeDefined();
    expect(runtime.focus.getFocusedId()).toBe("id:root-autofocus-scroll-target");
    expect(scrolls).toEqual([{ animated: false, y: 400 }]);

    await act(async () => {
      renderer?.unmount();
      await Promise.resolve();
    });
    unregisterContainer();
  });

  test("activates the gallery's registered same-document anchor without fetching or writing history", async () => {
    const fixtureFetch = createDemoFixtureFetchAdapter();
    const requests: TurboRequest[] = [];
    const runtime = createDemoRuntime({
      documentFetch: {
        fetch(request) {
          requests.push(request);
          return fixtureFetch.fetch(request);
        },
      },
    });
    const navigation = new TestNavigation();
    const scrolls: Readonly<{ x: number; y: number }>[] = [];
    const unregisterScroll = runtime.documentAnchorScroll.registerContainer({
      isAvailable: () => true,
      scrollTo(position) {
        scrolls.push(position);
      },
    });
    runtime.documentAnchorScroll.setDocumentOffset(40);
    let renderer: ReactTestRenderer | undefined;

    await act(async () => {
      renderer = create(
        createElement(
          DemoRuntimeProvider,
          { runtime },
          createElement(
            DemoRouterRouteOwner,
            { focused: true, navigation, routeKey: INITIAL_ROUTE_KEY, runtime },
            createElement(ExpoTurboRoot),
          ),
        ),
        {
          createNodeMock(element) {
            if (element.type === "text-input") return { blur() {}, focus() {} };
            if (element.type === "view") {
              return {
                measureInWindow(
                  listener: (x: number, y: number, width: number, height: number) => void,
                ) {
                  listener(0, 0, 320, 40);
                },
              };
            }
            return {};
          },
        },
      );
      await nextTurn();
      await nextTurn();
    });
    if (!renderer) throw new Error("gallery anchor fixture did not render");
    const content = renderer.root.findByProps({ testID: "demo-document-anchor-content" });
    const target = renderer.root.findByProps({ testID: "demo-anchor-target-native-anchor-target" });
    act(() => {
      content.props.onLayout({ nativeEvent: { layout: { y: 64 } } });
      target.props.onLayout({ nativeEvent: { layout: { y: 480 } } });
    });
    const requestsBeforeAnchor = requests.length;
    const anchorLink = renderer.root
      .findAll((node) => String(node.type) === "pressable")
      .find((pressable) =>
        pressable.findAll(
          (node) =>
            String(node.type) === "native-text" &&
            node.children.includes(
              "Jump to the registered native anchor target without a request or Router history write.",
            ),
        ).length > 0,
      );
    if (!anchorLink) throw new Error("gallery anchor link was not rendered");

    await act(async () => {
      anchorLink.props.onPress();
      await nextTurn();
    });

    expect(scrolls).toEqual([{ x: 0, y: 584 }]);
    expect(requests).toHaveLength(requestsBeforeAnchor);
    expect(runtime.session.tree.document.url).toBe(GALLERY_URL);
    expect(runtime.documentRuntime.history.current?.url).toBe(GALLERY_URL);
    expect(navigation.state.routes).toHaveLength(1);

    await act(async () => {
      renderer?.unmount();
      await Promise.resolve();
    });
    unregisterScroll();
  });

  test("restores the gallery root scroll after a cached native history traversal", async () => {
    nativeScrollCalls.length = 0;
    nativeRootScrollContainerIds.length = 0;
    nextNativeScrollContainerId = 0;
    const fixtureFetch = createDemoFixtureFetchAdapter();
    const requests: TurboRequest[] = [];
    const runtime = createDemoRuntime({
      documentFetch: {
        fetch(request) {
          requests.push(request);
          return fixtureFetch.fetch(request);
        },
      },
    });
    const navigation = new TestNavigation();
    let renderer: ReactTestRenderer | undefined;
    const routeTree = (
      initialFocused: boolean,
      linkedFocused: boolean,
      linkedRouteKey?: string,
    ) =>
      createElement(
        DemoRuntimeProvider,
        { runtime },
        createElement(
          Fragment,
          null,
          createElement(
            DemoRouterRouteOwner,
            { focused: initialFocused, navigation, routeKey: INITIAL_ROUTE_KEY, runtime },
            createElement(DemoCompatibilityGallery),
          ),
          linkedRouteKey
            ? createElement(
                DemoRouterRouteOwner,
                { focused: linkedFocused, navigation, routeKey: linkedRouteKey, runtime },
                createElement(DemoCompatibilityGallery),
              )
            : null,
        ),
      );

    try {
      await act(async () => {
        renderer = create(
          routeTree(true, false),
          {
            createNodeMock(element) {
              if (element.type === "text-input") return { blur() {}, focus() {} };
              if (element.type === "view") {
                return {
                  measureInWindow(
                    listener: (x: number, y: number, width: number, height: number) => void,
                  ) {
                    listener(0, 0, 320, 40);
                  },
                };
              }
              return {};
            },
          },
        );
        await nextTurn();
        await nextTurn();
      });
      if (!renderer) throw new Error("history-scroll gallery did not render");

      const galleryScroll = renderer.root
        .findAll(
          (node) =>
            String(node.type) === "scroll-view" &&
            node.props.contentInsetAdjustmentBehavior === "automatic",
        )
        .at(0);
      if (!galleryScroll) throw new Error("gallery root ScrollView was not rendered");
      const initialScrollContainerId = nativeRootScrollContainerIds.at(-1);
      if (!initialScrollContainerId) throw new Error("initial gallery ScrollView did not mount");
      const initialEntry = runtime.documentRuntime.history.current;
      if (!initialEntry) throw new Error("gallery history did not initialize");

      act(() => {
        galleryScroll.props.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 384 } } });
      });
      expect(
        runtime.documentRuntime.history.getRestorationData(initialEntry.restorationIdentifier),
      ).toEqual({ scrollPosition: { x: 0, y: 384 } });

      const historyLink = renderer.root
        .findAll((node) => String(node.type) === "pressable")
        .find((pressable) =>
          pressable.findAll(
            (node) =>
              String(node.type) === "native-text" &&
              node.children.includes("Open the native history scroll restoration proof."),
          ).length > 0,
        );
      if (!historyLink) throw new Error("history-scroll fixture link was not rendered");

      await act(async () => {
        historyLink.props.onPress();
        await nextTurn();
        await nextTurn();
      });
      expect(runtime.session.tree.document.url).toBe(HISTORY_SCROLL_URL);
      expect(runtime.session.tree.getElementById("history-scroll-linked-document")).toBeDefined();
      expect(navigation.state.index).toBe(1);
      const linkedRouteKey = navigation.state.routes.at(1)?.key;
      if (!linkedRouteKey) throw new Error("history-scroll linked route was not pushed");

      await act(async () => {
        renderer?.update(routeTree(false, true, linkedRouteKey));
        await nextTurn();
        await nextTurn();
      });
      const linkedScrollContainerId = nativeRootScrollContainerIds.at(-1);
      if (!linkedScrollContainerId) throw new Error("linked gallery ScrollView did not mount");
      expect(linkedScrollContainerId).not.toBe(initialScrollContainerId);
      const fetchesBeforeBack = requests.length;

      await act(async () => {
        navigation.goBack();
        await nextTurn();
        await nextTurn();
      });
      expect(runtime.session.tree.document.url).toBe(HISTORY_SCROLL_URL);
      expect(nativeScrollCalls).toEqual([]);

      await act(async () => {
        renderer?.update(routeTree(true, false, linkedRouteKey));
        await nextTurn();
        await nextTurn();
      });

      expect(runtime.session.tree.document.url).toBe(GALLERY_URL);
      expect(runtime.session.tree.getElementById("history-scroll-marker")).toBeDefined();
      expect(runtime.documentRuntime.history.current).toEqual(initialEntry);
      expect(requests).toHaveLength(fetchesBeforeBack);
      const restoredScrollContainerId = nativeRootScrollContainerIds.at(-1);
      if (!restoredScrollContainerId) {
        throw new Error("restored gallery ScrollView did not mount");
      }
      expect(restoredScrollContainerId).not.toBe(initialScrollContainerId);
      expect(restoredScrollContainerId).not.toBe(linkedScrollContainerId);
      expect(nativeScrollCalls).toEqual([
        {
          containerId: restoredScrollContainerId,
          options: { animated: false, x: 0, y: 384 },
        },
      ]);
    } finally {
      await act(async () => {
        renderer?.unmount();
        await Promise.resolve();
      });
    }
  });

  test("uses the gallery's automatic preload as a visible preview before canonical revalidation", async () => {
    const [clock, timers] = createFixtureClock();
    const fixtureFetch = createDemoFixtureFetchAdapter(clock);
    const requests: TurboRequest[] = [];
    const fetch: FetchAdapter = {
      fetch(request) {
        requests.push(request);
        return fixtureFetch.fetch(request);
      },
    };
    const runtime = createDemoRuntime({ documentFetch: fetch });
    const navigation = new TestNavigation();
    let renderer: ReactTestRenderer | undefined;

    await act(async () => {
      renderer = create(
        createElement(
          DemoRuntimeProvider,
          { runtime },
          createElement(
            DemoRouterRouteOwner,
            { focused: true, navigation, routeKey: INITIAL_ROUTE_KEY, runtime },
            createElement(ExpoTurboRoot),
          ),
        ),
        {
          createNodeMock(element) {
            if (element.type === "text-input") return { blur() {}, focus() {} };
            if (element.type === "view") {
              return {
                measureInWindow(
                  listener: (x: number, y: number, width: number, height: number) => void,
                ) {
                  listener(0, 0, 320, 40);
                },
              };
            }
            return {};
          },
        },
      );
      await nextTurn();
      await nextTurn();
    });
    if (!renderer) throw new Error("gallery cached-preview fixture did not render");
    const preload = requests[0];
    if (!preload) throw new Error("automatic cached-preview preload did not start");
    expect(preload.url).toBe(PREVIEW_URL);
    expect(preload.headers["X-Sec-Purpose"]).toBe("prefetch");
    expect(runtime.documentRuntime.snapshotCache.has(PREVIEW_URL)).toBe(true);

    const previewLink = renderer.root
      .findAll((node) => String(node.type) === "pressable")
      .find(
        (pressable) =>
          pressable.findAll(
            (node) =>
              String(node.type) === "native-text" &&
              node.children.includes(
                "Open a cached document preview, then replace it with the canonical response.",
              ),
          ).length > 0,
      );
    if (!previewLink) throw new Error("gallery cached-preview link was not rendered");

    await act(async () => {
      previewLink.props.onPress();
      await nextTurn();
    });

    const canonical = requests[1];
    if (!canonical) throw new Error("cached preview canonical revalidation did not start");
    expect(canonical.url).toBe(PREVIEW_URL);
    expect(canonical.headers["X-Sec-Purpose"]).toBeUndefined();
    const timer = timers[0];
    if (!timer) throw new Error("cached preview canonical revalidation did not delay");
    expect(timer.delayMs).toBe(4_000);
    expect(
      renderer.root.findAll(
        (node) =>
          node.props.accessibilityLabel === "Document visit: started, showing cached preview",
      ),
    ).not.toHaveLength(0);
    expect(runtime.session.treeState.preview).toBe(true);
    expect(runtime.session.tree.getElementById("cached-preview-document")).toBeDefined();
    expect(runtime.documentRuntime.controller.state.previewVisible).toBe(true);
    expect(navigation.state.routes[1]?.params?.[DEMO_ROUTER_PATH_PARAM]).toEqual([
      "demo",
      "linked",
    ]);

    await act(async () => {
      timer.callback();
      await nextTurn();
      await nextTurn();
    });

    expect(runtime.session.treeState.preview).toBe(false);
    expect(runtime.session.tree.getElementById("canonical-preview-document")).toBeDefined();
    expect(runtime.documentRuntime.controller.state.previewVisible).toBe(false);
    expect(runtime.documentRuntime.history.current?.url).toBe(PREVIEW_URL);

    await act(async () => {
      renderer?.unmount();
      await Promise.resolve();
    });
  });

  test("cancels the delayed preview fixture timer when canonical revalidation aborts", async () => {
    const [clock, timers] = createFixtureClock();
    const adapter = createDemoFixtureFetchAdapter(clock);
    const controller = new AbortController();
    let resolved = false;
    const pending = adapter.fetch({
      headers: {},
      method: "GET",
      signal: controller.signal,
      url: PREVIEW_URL,
    });
    void pending.then(
      () => {
        resolved = true;
      },
      () => undefined,
    );
    const timer = timers[0];
    if (!timer) throw new Error("canonical preview timer did not start");

    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(timer.cleared).toBe(true);
    timer.callback();
    await Promise.resolve();
    expect(resolved).toBe(false);
  });

  test("commits the gallery Refresh Stream scenario and resets its owning root ScrollView", async () => {
    const [clock, timers] = createFixtureClock();
    const runtime = createDemoRuntime({
      clock,
      documentFetch: createDemoFixtureFetchAdapter(clock),
    });
    const navigation = new TestNavigation();
    let renderer: ReactTestRenderer | undefined;
    const scrollCalls: string[] = [];
    const unregisterScroll = runtime.documentRefreshScroll.registerContainer({
      isAvailable: () => true,
      scrollTo: () => undefined,
      scrollToTop: () => {
        scrollCalls.push("top");
      },
    });

    await act(async () => {
      renderer = create(
        createElement(
          DemoRuntimeProvider,
          { runtime },
          createElement(
            DemoRouterRouteOwner,
            { focused: true, navigation, routeKey: INITIAL_ROUTE_KEY, runtime },
            createElement(ExpoTurboRoot),
          ),
        ),
        {
          createNodeMock(element) {
            if (element.type === "text-input") return { blur() {}, focus() {} };
            if (element.type === "view") {
              return {
                measureInWindow(
                  listener: (x: number, y: number, width: number, height: number) => void,
                ) {
                  listener(0, 0, 320, 40);
                },
              };
            }
            return {};
          },
        },
      );
      await nextTurn();
      await nextTurn();
    });
    if (!renderer) throw new Error("gallery Refresh Stream scenario did not render");

    await act(async () => {
      await runtime.documentRuntime.controller.visit(REFRESH_SCENARIO_URL);
      await nextTurn();
      await nextTurn();
    });

    expect(runtime.session.tree.document.url).toBe(REFRESH_SCENARIO_URL);
    expect(runtime.session.tree.getElementById("refresh-ready-document")).toBeDefined();
    const scenarioRouteKey = navigation.state.routes[navigation.state.index]?.key;
    if (!scenarioRouteKey) throw new Error("Refresh Stream scenario route did not become focused");

    await act(async () => {
      renderer?.update(
        createElement(
          DemoRuntimeProvider,
          { runtime },
          createElement(
            DemoRouterRouteOwner,
            { focused: true, navigation, routeKey: scenarioRouteKey, runtime },
            createElement(ExpoTurboRoot),
          ),
        ),
      );
      await nextTurn();
      await nextTurn();
    });

    act(() => {
      dispatchTurboStreamFragment(
        runtime.session,
        '<turbo-stream action="refresh" method="replace" target="ignored"><template><DemoText>Ignored refresh payload.</DemoText></template></turbo-stream>',
        { refresh: runtime.refresh, streamLifecycle: runtime.streamLifecycle },
      );
    });
    const refreshTimer = timers.find((timer) => timer.delayMs === 150 && !timer.cleared);
    if (!refreshTimer) throw new Error("Refresh Stream debounce timer did not start");

    await act(async () => {
      refreshTimer.callback();
      await nextTurn();
      await nextTurn();
      await nextTurn();
    });

    expect(runtime.session.tree.getElementById("refresh-completed-document")).toBeDefined();
    expect(scrollCalls).toEqual(["top"]);

    await act(async () => {
      await runtime.documentRuntime.controller.visit(REFRESH_SCENARIO_URL);
      await nextTurn();
    });

    expect(runtime.session.tree.getElementById("refresh-ready-document")).toBeDefined();

    await act(async () => {
      renderer?.unmount();
      await Promise.resolve();
    });
    unregisterScroll();
  });

  test("direct disposal releases every runtime-owned state surface", () => {
    const runtime = createDemoRuntime();

    runtime.dispose();
    runtime.dispose();

    expect(runtime.forms.isDisposed).toBeTrue();
    expect(() => runtime.focus.focus("id:first-name")).toThrow(/disposed/);
    expect(() => runtime.visibility.register("late-frame", () => {})).toThrow(/disposed/);
    expect(runtime.actionRuntime.state.isDisposed).toBeTrue();
  });

  test("keeps one runtime through StrictMode replay and route-child replacement", async () => {
    const runtime = createDemoRuntime();
    const observed = new Set<unknown>();
    let renderer: ReactTestRenderer | undefined;

    function Probe() {
      observed.add(useDemoRuntime());
      return createElement("runtime-probe");
    }

    await act(async () => {
      renderer = create(
        createElement(
          StrictMode,
          null,
          createElement(
            DemoRuntimeProvider,
            { runtime },
            createElement(Probe, { key: "route-1" }),
          ),
        ),
      );
      await Promise.resolve();
    });

    expect(observed).toEqual(new Set([runtime]));
    expect(runtime.forms.isDisposed).toBeFalse();
    expect(runtime.actionRuntime.state.isDisposed).toBeFalse();

    await act(async () => {
      renderer?.update(
        createElement(
          StrictMode,
          null,
          createElement(
            DemoRuntimeProvider,
            { runtime },
            createElement(Probe, { key: "route-2" }),
          ),
        ),
      );
      await Promise.resolve();
    });

    expect(observed).toEqual(new Set([runtime]));
    expect(runtime.forms.isDisposed).toBeFalse();
    expect(runtime.actionRuntime.state.isDisposed).toBeFalse();

    await act(async () => {
      renderer?.unmount();
      await Promise.resolve();
    });
    expect(runtime.forms.isDisposed).toBeTrue();
    expect(() => runtime.focus.focus("id:first-name")).toThrow(/disposed/);
    expect(runtime.actionRuntime.state.isDisposed).toBeTrue();
  });

  test("attaches and renders only the focused route projection", async () => {
    const runtime = createDemoRuntime();
    const navigation = new TestNavigation();
    let renderer: ReactTestRenderer | undefined;
    const activeRoutes = () =>
      renderer?.root.findAll((node) => String(node.type) === "active-route") ?? [];

    const routeOwner = (focused: boolean, routeKey: string, label: string) =>
      createElement(
        DemoRouterRouteOwner,
        { focused, navigation, routeKey, runtime },
        createElement("active-route", { label }),
      );

    await act(async () => {
      renderer = create(
        createElement(
          DemoRuntimeProvider,
          { runtime },
          routeOwner(false, INITIAL_ROUTE_KEY, "first"),
        ),
      );
      await Promise.resolve();
    });
    expect(renderer?.toJSON()).toBeNull();
    expect(navigation.listenerCount).toBe(0);
    expect(runtime.documentRuntime.history.current).toBeUndefined();

    await act(async () => {
      renderer?.update(
        createElement(
          DemoRuntimeProvider,
          { runtime },
          routeOwner(true, INITIAL_ROUTE_KEY, "first"),
        ),
      );
      await Promise.resolve();
    });
    expect(navigation.listenerCount).toBe(1);
    expect(runtime.documentRuntime.history.current?.url).toBe(GALLERY_URL);
    expect(activeRoutes()).toHaveLength(1);
    expect(activeRoutes()[0]?.props.label).toBe("first");

    act(() => runtime.navigation.reportError(new StateError("temporary traversal failure")));
    expect(activeRoutes()).toHaveLength(0);
    act(() => runtime.navigation.clearError());
    expect(activeRoutes()).toHaveLength(1);

    const proposal = runtime.documentRuntime.history.proposeAdvance(
      LINKED_URL,
    );
    runtime.documentRuntime.history.commitProposal(proposal);
    expect(navigation.state.routes).toHaveLength(2);

    await act(async () => {
      renderer?.update(
        createElement(
          DemoRuntimeProvider,
          { runtime },
          createElement(
            Fragment,
            null,
            routeOwner(false, INITIAL_ROUTE_KEY, "first"),
            routeOwner(true, `${DEMO_ROUTER_ROUTE_NAME}-2`, "second"),
          ),
        ),
      );
      await Promise.resolve();
    });
    expect(navigation.listenerCount).toBe(1);
    expect(activeRoutes()).toHaveLength(1);
    expect(activeRoutes()[0]?.props.label).toBe("second");
    expect(useDemoRuntime).toBeFunction();

    await act(async () => {
      renderer?.unmount();
      await Promise.resolve();
    });
    expect(navigation.listenerCount).toBe(0);
    expect(runtime.forms.isDisposed).toBeTrue();
    expect(runtime.actionRuntime.state.isDisposed).toBeTrue();
  });

  test("does not reuse an adopted restoration identifier after demo restart", async () => {
    let fetches = 0;
    const runtime = createDemoRuntime({
      documentFetch: {
        async fetch() {
          fetches += 1;
          throw new Error("matching managed entries must not fetch");
        },
      },
    });
    const navigation = new TestNavigation(
      encodeDemoRouterHistoryEntry({
        restorationIdentifier: "demo-history-1",
        restorationIndex: 0,
        url: GALLERY_URL,
      }),
    );
    let renderer: ReactTestRenderer | undefined;

    await act(async () => {
      renderer = create(routeTree(runtime, navigation));
      await Promise.resolve();
    });

    expect(runtime.documentRuntime.history.current?.restorationIdentifier).toBe(
      "demo-history-1",
    );
    expect(fetches).toBe(0);
    expect(navigation.pushCalls).toBe(0);
    expect(navigation.resetCalls).toBe(0);
    expect(navigation.setParamsCalls).toBe(0);
    const proposal = runtime.documentRuntime.history.proposeAdvance(
      LINKED_URL,
    );
    expect(proposal.entry.restorationIdentifier).not.toBe("demo-history-1");
    expect(runtime.documentRuntime.history.commitProposal(proposal)).toBe(proposal.entry);

    await act(async () => {
      renderer?.unmount();
      await Promise.resolve();
    });
  });

  test("bootstraps a managed different-document route before adopting it without a Router write", async () => {
    const fetch = new ControlledFetch();
    const runtime = createDemoRuntime({ documentFetch: fetch });
    const entry = {
      restorationIdentifier: "persisted-linked",
      restorationIndex: 4,
      url: LINKED_URL,
    } as const;
    const navigation = new TestNavigation(
      routeParams(entry.url, encodeDemoRouterHistoryEntry(entry)),
    );
    const initialState = navigation.state;
    const initialTree = runtime.session.tree;
    let renderer: ReactTestRenderer | undefined;

    await act(async () => {
      renderer = create(routeTree(runtime, navigation));
      await Promise.resolve();
    });

    expect(renderer?.toJSON()).toBeNull();
    expect(runtime.documentRuntime.history.current).toBeUndefined();
    expect(runtime.session.tree).toBe(initialTree);
    expect(fetch.pending).toHaveLength(1);
    expect(fetch.pending[0]?.request.method).toBe("GET");
    expect(fetch.pending[0]?.request.url).toBe(entry.url);
    expect(navigation.state).toBe(initialState);

    await act(async () => {
      const pending = fetch.pending[0];
      if (!pending) throw new Error("missing cold-start request");
      pending.resolve(response(pending.request));
      await nextTurn();
    });

    expect(runtime.session.tree.document.url).toBe(entry.url);
    expect(runtime.session.tree.getElementById("cold-start-document")).toBeDefined();
    expect(runtime.documentRuntime.history.current).toEqual(entry);
    expect(renderer?.root.findAll((node) => String(node.type) === "active-route")).toHaveLength(1);
    expect(navigation.state).toBe(initialState);
    expect(navigation.pushCalls).toBe(0);
    expect(navigation.resetCalls).toBe(0);
    expect(navigation.setParamsCalls).toBe(0);

    await act(async () => {
      renderer?.unmount();
      await Promise.resolve();
    });
  });

  test("bootstraps a managed query-bearing route from its exact Router payload", async () => {
    const fetch = new ControlledFetch();
    const runtime = createDemoRuntime({ documentFetch: fetch });
    const entry = {
      restorationIdentifier: "persisted-linked-query",
      restorationIndex: 5,
      url: LINKED_QUERY_URL,
    } as const;
    const navigation = new TestNavigation(
      routeParams(entry.url, encodeDemoRouterHistoryEntry(entry)),
    );
    const initialState = navigation.state;
    let renderer: ReactTestRenderer | undefined;

    await act(async () => {
      renderer = create(routeTree(runtime, navigation));
      await Promise.resolve();
    });

    expect(fetch.pending[0]?.request.url).toBe(entry.url);
    expect(navigation.state).toBe(initialState);

    await act(async () => {
      const pending = fetch.pending[0];
      if (!pending) throw new Error("missing query cold-start request");
      pending.resolve(response(pending.request));
      await nextTurn();
    });

    expect(runtime.session.tree.document.url).toBe(entry.url);
    expect(runtime.documentRuntime.history.current).toEqual(entry);
    expect(navigation.state).toBe(initialState);
    expect(navigation.setParamsCalls).toBe(0);

    await act(async () => {
      renderer?.unmount();
      await Promise.resolve();
    });
  });

  test("bootstraps an unmanaged canonical deep link and repairs it in the tree commit", async () => {
    const fetch = new ControlledFetch();
    const runtime = createDemoRuntime({ documentFetch: fetch });
    const navigation = new TestNavigation(routeParams(LINKED_URL));
    const initialState = navigation.state;
    const initialTree = runtime.session.tree;
    let renderer: ReactTestRenderer | undefined;

    await act(async () => {
      renderer = create(routeTree(runtime, navigation));
      await Promise.resolve();
    });

    expect(renderer?.toJSON()).toBeNull();
    expect(runtime.documentRuntime.history.current).toBeUndefined();
    expect(runtime.session.tree).toBe(initialTree);
    expect(fetch.pending[0]?.request.url).toBe(LINKED_URL);
    expect(navigation.state).toBe(initialState);

    await act(async () => {
      const pending = fetch.pending[0];
      if (!pending) throw new Error("missing unmanaged cold-start request");
      pending.resolve(response(pending.request));
      await nextTurn();
    });

    expect(runtime.session.tree.document.url).toBe(LINKED_URL);
    expect(runtime.documentRuntime.history.current?.url).toBe(LINKED_URL);
    expect(runtime.documentRuntime.history.current?.restorationIndex).toBe(0);
    expect(navigation.state).not.toBe(initialState);
    expect(navigation.setParamsCalls).toBe(1);
    expect(navigation.pushCalls).toBe(0);
    expect(navigation.resetCalls).toBe(0);
    expect(decodeDemoRouterHistoryEntry(navigation.state.routes[0]?.params)).toEqual(
      runtime.documentRuntime.history.current,
    );
    expect(renderer?.root.findAll((node) => String(node.type) === "active-route")).toHaveLength(1);

    await act(async () => {
      renderer?.unmount();
      await Promise.resolve();
    });
  });

  test("adopts exact authoritative XML error documents during a managed cold start", async () => {
    for (const status of [422, 500]) {
      const requests: TurboRequest[] = [];
      const runtime = createDemoRuntime({
        documentFetch: {
          async fetch(request) {
            requests.push(request);
            return response(request, { status });
          },
        },
      });
      const entry = {
        restorationIdentifier: `error-${status}`,
        restorationIndex: status,
        url: LINKED_URL,
      } as const;
      const navigation = new TestNavigation(
        routeParams(entry.url, encodeDemoRouterHistoryEntry(entry)),
      );
      const initialState = navigation.state;
      let renderer: ReactTestRenderer | undefined;

      await act(async () => {
        renderer = create(routeTree(runtime, navigation));
        await nextTurn();
      });

      expect(requests).toHaveLength(1);
      expect(runtime.session.tree.document.url).toBe(entry.url);
      expect(runtime.documentRuntime.history.current).toEqual(entry);
      expect(renderer?.root.findAll((node) => String(node.type) === "active-route")).toHaveLength(1);
      expect(navigation.state).toBe(initialState);
      expect(navigation.setParamsCalls).toBe(0);

      await act(async () => {
        renderer?.unmount();
        await Promise.resolve();
      });
    }
  });

  test("fails before adoption when a managed cold-start response cannot prove exact alignment", async () => {
    const scenarios = [
      {
        name: "redirect",
        fetch: async (request: TurboRequest) =>
          response(request, {
            redirected: true,
            url: GALLERY_URL,
          }),
      },
      {
        name: "redirect flag",
        fetch: async (request: TurboRequest) =>
          response(request, { redirected: true }),
      },
      {
        name: "wrong MIME",
        fetch: async (request: TurboRequest) =>
          response(request, { contentType: "text/html" }),
      },
      {
        name: "empty response",
        fetch: async (request: TurboRequest) => response(request, { status: 204 }),
      },
      {
        name: "network failure",
        fetch: async () => {
          throw new Error("secret transport failure");
        },
      },
    ] as const;

    for (const scenario of scenarios) {
      const runtime = createDemoRuntime({ documentFetch: { fetch: scenario.fetch } });
      const entry = {
        restorationIdentifier: `failed-${scenario.name}`,
        restorationIndex: 2,
        url: LINKED_URL,
      } as const;
      const navigation = new TestNavigation(
        routeParams(entry.url, encodeDemoRouterHistoryEntry(entry)),
      );
      const initialState = navigation.state;
      const initialTree = runtime.session.tree;
      let renderer: ReactTestRenderer | undefined;

      await act(async () => {
        renderer = create(routeTree(runtime, navigation));
        await nextTurn();
      });

      const rendered = JSON.stringify(renderer?.toJSON());
      expect(runtime.documentRuntime.history.current).toBeUndefined();
      expect(runtime.session.tree).toBe(initialTree);
      expect(navigation.state).toBe(initialState);
      expect(navigation.pushCalls).toBe(0);
      expect(navigation.resetCalls).toBe(0);
      expect(navigation.setParamsCalls).toBe(0);
      expect(rendered).toContain("Error");
      expect(rendered).not.toContain("secret");

      await act(async () => {
        renderer?.unmount();
        await Promise.resolve();
      });
    }
  });

  test("rejects forged managed targets outside the document root or with fragments", async () => {
    for (const url of [
      "https://example.test/outside",
      "https://example.test/demo/linked#details",
    ]) {
      let fetches = 0;
      const runtime = createDemoRuntime({
        documentFetch: {
          async fetch(request) {
            fetches += 1;
            return response(request);
          },
        },
      });
      const navigation = new TestNavigation(
        encodeDemoRouterHistoryEntry({
          restorationIdentifier: "forged-target",
          restorationIndex: 1,
          url,
        }),
      );
      const initialState = navigation.state;
      const initialTree = runtime.session.tree;
      let renderer: ReactTestRenderer | undefined;

      await act(async () => {
        renderer = create(routeTree(runtime, navigation));
        await nextTurn();
      });

      expect(fetches).toBe(0);
      expect(runtime.session.tree).toBe(initialTree);
      expect(runtime.documentRuntime.history.current).toBeUndefined();
      expect(navigation.state).toBe(initialState);
      expect(JSON.stringify(renderer?.toJSON())).toContain("StateError");

      await act(async () => {
        renderer?.unmount();
        await Promise.resolve();
      });
    }
  });

  test("does not commit a managed document after its Router entry changes", async () => {
    const fetch = new ControlledFetch();
    const runtime = createDemoRuntime({ documentFetch: fetch });
    const initialEntry = {
      restorationIdentifier: "first-entry",
      restorationIndex: 1,
      url: LINKED_QUERY_URL,
    } as const;
    const replacementEntry = {
      restorationIdentifier: "second-entry",
      restorationIndex: 2,
      url: LINKED_REPLACEMENT_QUERY_URL,
    } as const;
    const navigation = new TestNavigation(
      routeParams(initialEntry.url, encodeDemoRouterHistoryEntry(initialEntry)),
    );
    const initialTree = runtime.session.tree;
    let renderer: ReactTestRenderer | undefined;

    await act(async () => {
      renderer = create(routeTree(runtime, navigation));
      await Promise.resolve();
    });
    const pending = fetch.pending[0];
    if (!pending) throw new Error("missing stale-entry request");

    act(() =>
      navigation.replaceFocusedParams(
        routeParams(replacementEntry.url, encodeDemoRouterHistoryEntry(replacementEntry)),
      ),
    );
    await act(async () => {
      pending.resolve(response(pending.request));
      await nextTurn();
    });

    expect(runtime.session.tree).toBe(initialTree);
    expect(runtime.documentRuntime.history.current).toBeUndefined();
    expect(JSON.stringify(renderer?.toJSON())).toContain("StateError");
    expect(navigation.state.routes[0]?.params).toEqual(
      routeParams(replacementEntry.url, encodeDemoRouterHistoryEntry(replacementEntry)),
    );

    await act(async () => {
      renderer?.update(routeTree(runtime, navigation, false));
      await Promise.resolve();
    });
    await act(async () => {
      renderer?.update(routeTree(runtime, navigation));
      await Promise.resolve();
    });
    const retry = fetch.pending[1];
    if (!retry) throw new Error("missing replacement-entry request");
    expect(retry.request.url).toBe(replacementEntry.url);
    await act(async () => {
      retry.resolve(response(retry.request));
      await nextTurn();
    });

    expect(runtime.session.tree.document.url).toBe(replacementEntry.url);
    expect(runtime.documentRuntime.history.current).toEqual(replacementEntry);
    expect(renderer?.root.findAll((node) => String(node.type) === "active-route")).toHaveLength(1);
    expect(navigation.pushCalls).toBe(0);
    expect(navigation.resetCalls).toBe(0);
    expect(navigation.setParamsCalls).toBe(0);

    await act(async () => {
      renderer?.unmount();
      await Promise.resolve();
    });
  });

  test("keeps managed history aligned when tree finalization reports a committed error", async () => {
    let fetches = 0;
    const runtime = createDemoRuntime({
      documentFetch: {
        async fetch(request) {
          fetches += 1;
          return response(request);
        },
      },
    });
    const entry = {
      restorationIdentifier: "committed-finalization",
      restorationIndex: 6,
      url: LINKED_URL,
    } as const;
    const navigation = new TestNavigation(
      routeParams(entry.url, encodeDemoRouterHistoryEntry(entry)),
    );
    const unsubscribe = runtime.session.subscribe(runtime.session.tree.document.key, () => {
      throw new Error("secret finalization failure");
    });
    let renderer: ReactTestRenderer | undefined;

    await act(async () => {
      renderer = create(routeTree(runtime, navigation));
      await nextTurn();
    });

    expect(fetches).toBe(1);
    expect(runtime.session.tree.document.url).toBe(entry.url);
    expect(runtime.documentRuntime.history.current).toEqual(entry);
    expect(JSON.stringify(renderer?.toJSON())).toContain("DocumentCommitError");
    expect(JSON.stringify(renderer?.toJSON())).not.toContain("secret");

    unsubscribe();
    await act(async () => {
      renderer?.update(routeTree(runtime, navigation, false));
      await Promise.resolve();
    });
    await act(async () => {
      renderer?.update(routeTree(runtime, navigation));
      await nextTurn();
    });

    expect(fetches).toBe(1);
    expect(runtime.session.tree.document.url).toBe(entry.url);
    expect(runtime.documentRuntime.history.current).toEqual(entry);
    expect(renderer?.root.findAll((node) => String(node.type) === "active-route")).toHaveLength(1);
    expect(navigation.setParamsCalls).toBe(0);

    await act(async () => {
      renderer?.unmount();
      await Promise.resolve();
    });
  });

  test("retries a failed managed bootstrap when the route is focused again", async () => {
    let attempt = 0;
    const runtime = createDemoRuntime({
      documentFetch: {
        async fetch(request) {
          attempt += 1;
          return response(request, {
            ...(attempt === 1 ? { contentType: "text/html" } : {}),
          });
        },
      },
    });
    const entry = {
      restorationIdentifier: "retry-linked",
      restorationIndex: 5,
      url: LINKED_URL,
    } as const;
    const navigation = new TestNavigation(
      routeParams(entry.url, encodeDemoRouterHistoryEntry(entry)),
    );
    let renderer: ReactTestRenderer | undefined;

    await act(async () => {
      renderer = create(routeTree(runtime, navigation));
      await nextTurn();
    });
    expect(attempt).toBe(1);
    expect(runtime.documentRuntime.history.current).toBeUndefined();

    await act(async () => {
      renderer?.update(routeTree(runtime, navigation, false));
      await Promise.resolve();
    });
    await act(async () => {
      renderer?.update(routeTree(runtime, navigation));
      await nextTurn();
    });

    expect(attempt).toBe(2);
    expect(runtime.session.tree.document.url).toBe(entry.url);
    expect(runtime.documentRuntime.history.current).toEqual(entry);
    expect(renderer?.root.findAll((node) => String(node.type) === "active-route")).toHaveLength(1);
    expect(navigation.setParamsCalls).toBe(0);

    await act(async () => {
      renderer?.unmount();
      await Promise.resolve();
    });
  });

  test("cancels a pending managed bootstrap when its route loses focus", async () => {
    const fetch = new ControlledFetch();
    const runtime = createDemoRuntime({ documentFetch: fetch });
    const entry = {
      restorationIdentifier: "canceled-linked",
      restorationIndex: 1,
      url: LINKED_URL,
    } as const;
    const navigation = new TestNavigation(
      routeParams(entry.url, encodeDemoRouterHistoryEntry(entry)),
    );
    const initialTree = runtime.session.tree;
    let renderer: ReactTestRenderer | undefined;

    await act(async () => {
      renderer = create(routeTree(runtime, navigation));
      await Promise.resolve();
    });
    const first = fetch.pending[0];
    if (!first) throw new Error("missing pending bootstrap");

    await act(async () => {
      renderer?.update(routeTree(runtime, navigation, false));
      await Promise.resolve();
    });
    expect(first.request.signal?.aborted).toBeTrue();
    expect(navigation.listenerCount).toBe(0);

    await act(async () => {
      first.resolve(response(first.request));
      await nextTurn();
    });
    expect(runtime.session.tree).toBe(initialTree);
    expect(runtime.documentRuntime.history.current).toBeUndefined();

    await act(async () => {
      renderer?.update(routeTree(runtime, navigation));
      await Promise.resolve();
    });
    const second = fetch.pending[1];
    if (!second) throw new Error("missing retry bootstrap");
    await act(async () => {
      second.resolve(response(second.request));
      await nextTurn();
    });

    expect(runtime.session.tree.document.url).toBe(entry.url);
    expect(runtime.documentRuntime.history.current).toEqual(entry);
    expect(renderer?.root.findAll((node) => String(node.type) === "active-route")).toHaveLength(1);

    await act(async () => {
      renderer?.unmount();
      await Promise.resolve();
    });
  });
});
