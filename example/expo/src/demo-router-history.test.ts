import { describe, expect, mock, test } from "bun:test";
import {
  DocumentHistory,
  type DocumentHistoryEntry,
  StateError,
} from "expo-turbo/core";

import {
  DEMO_ROUTER_HISTORY_PARAMS,
  DEMO_ROUTER_ROUTE_NAME,
  DemoRouterHistoryBridge,
  type DemoRouterNavigation,
  type DemoRouterRoute,
  type DemoRouterState,
  decodeDemoRouterHistoryEntry,
  encodeDemoRouterHistoryEntry,
} from "./demo-router-history";
import { DEMO_ROUTER_PATH_PARAM } from "./demo-router-path";

mock.module("expo-router/build/react-navigation/native", () => ({
  validatePathConfig: () => undefined,
}));

const { getStateFromPath } = await import("expo-router/build/fork/getStateFromPath");
const { extractExpoPathFromURL } = await import("expo-router/build/fork/extractPathFromURL");

const INITIAL_ROUTE_KEY = "demo-route-1";
const GALLERY_URL = "https://example.test/demo";
const LINKED_URL = "https://example.test/demo/linked";
const GALLERY_QUERY_URL = "https://example.test/demo?source=deep-link&tag=a&tag=b";
const LINKED_QUERY_URL = "https://example.test/demo/linked?flag=&space=+&encoded=%20";
const NESTED_QUERY_URL =
  "https://example.test/demo/routes/ios-proof/details?source=gallery&tag=a&tag=b&empty=";
const DIRECT_QUERY_INPUT_PATH =
  "/demo/routes/ios-proof/details?source=direct&tag=a&tag=b&empty=&plus=+&encoded=%20";
const DIRECT_QUERY_PATH =
  "/demo/routes/ios-proof/details?source=direct&tag=a&tag=b&empty=&plus= &encoded= ";
const DIRECT_QUERY_URL =
  "https://example.test/demo/routes/ios-proof/details?source=direct&tag=a&tag=b&empty=&plus=%20&encoded=";

type WriteBehavior =
  | "collateral"
  | "commit"
  | "commit-throw"
  | "noop"
  | "partial"
  | "throw";

class FakeNavigation implements DemoRouterNavigation {
  private deferred: (() => void)[] = [];
  private key = 1;
  private readonly listeners = new Set<() => void>();
  pushBehavior: WriteBehavior = "commit";
  resetBehavior: WriteBehavior = "commit";
  setParamsBehavior: WriteBehavior = "commit";
  synchronousEvents = true;
  state: DemoRouterState;

  constructor(
    params?: Readonly<Record<string, unknown>>,
    path?: string,
  ) {
    this.state = Object.freeze({
      stale: false,
      type: "stack",
      key: "stack-1",
      index: 0,
      history: Object.freeze([Object.freeze({ key: INITIAL_ROUTE_KEY, type: "route" })]),
      routeNames: Object.freeze([DEMO_ROUTER_ROUTE_NAME]),
      preloadedRoutes: Object.freeze([]),
      routes: Object.freeze([
        Object.freeze({
          key: INITIAL_ROUTE_KEY,
          name: DEMO_ROUTER_ROUTE_NAME,
          path,
          state: Object.freeze({ index: 0, routes: Object.freeze([]) }),
          params: Object.freeze({
            [DEMO_ROUTER_PATH_PARAM]: Object.freeze(["demo"]),
            ...(params ?? {}),
          }),
        }),
      ]),
    });
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
    const routes = this.state.routes.slice(0, this.state.index);
    this.state = Object.freeze({
      ...this.state,
      index: routes.length - 1,
      routes: Object.freeze(routes),
    });
    this.emit();
  }

  push(name: string, params: Readonly<Record<string, unknown>>): void {
    if (this.pushBehavior === "throw") throw new Error("secret push failure");
    if (this.pushBehavior === "noop") return;
    const committedParams =
      this.pushBehavior === "partial"
        ? Object.freeze({
            ...params,
            [DEMO_ROUTER_HISTORY_PARAMS.url]: "https://example.test/wrong",
          })
        : params;
    const retainedRoutes = this.state.routes.slice(0, this.state.index + 1);
    if (this.pushBehavior === "collateral" && retainedRoutes[0]) {
      retainedRoutes[0] = Object.freeze({
        ...retainedRoutes[0],
        path: "/corrupt",
        state: Object.freeze({ index: 1, routes: Object.freeze([]) }),
      });
    }
    const preloaded = this.state.preloadedRoutes.find((route) => route.name === name);
    const pushed = preloaded
      ? Object.freeze({ ...preloaded, path: preloaded.path, params: committedParams })
      : Object.freeze({
          key: `${name}-${++this.key}`,
          name,
          path: undefined,
          params: committedParams,
        });
    const routes = [...retainedRoutes, pushed];
    this.state = Object.freeze({
      ...this.state,
      ...(this.pushBehavior === "collateral" ? { key: "stack-corrupt" } : {}),
      index: routes.length - 1,
      preloadedRoutes: Object.freeze(
        this.state.preloadedRoutes.filter((route) => route.key !== pushed.key),
      ),
      routes: Object.freeze(routes),
    });
    this.emit();
    if (this.pushBehavior === "commit-throw") throw new Error("secret late push failure");
  }

  setParams(params: Readonly<Record<string, unknown>>): void {
    if (this.setParamsBehavior === "throw") throw new Error("secret setParams failure");
    if (this.setParamsBehavior === "noop") return;
    const route = this.state.routes[this.state.index] as DemoRouterRoute;
    const routes = [...this.state.routes];
    const committedParams =
      this.setParamsBehavior === "partial"
        ? Object.freeze({
            ...params,
            [DEMO_ROUTER_HISTORY_PARAMS.url]: "https://example.test/wrong",
          })
        : params;
    routes[this.state.index] = Object.freeze({
      ...route,
      ...(this.setParamsBehavior === "collateral"
        ? { state: Object.freeze({ index: 1, routes: Object.freeze([]) }) }
        : {}),
      params: Object.freeze({ ...(route.params ?? {}), ...committedParams }),
    });
    this.state = Object.freeze({
      ...this.state,
      ...(this.setParamsBehavior === "collateral"
        ? { routeNames: Object.freeze([DEMO_ROUTER_ROUTE_NAME, "corrupt"]) }
        : {}),
      routes: Object.freeze(routes),
    });
    this.emit();
    if (this.setParamsBehavior === "commit-throw") {
      throw new Error("secret late setParams failure");
    }
  }

  reset(state: DemoRouterState): void {
    if (this.resetBehavior === "throw") throw new Error("secret reset failure");
    if (this.resetBehavior === "noop") return;
    if (this.resetBehavior === "partial") {
      const routes = state.routes.map((route, index) =>
        index === state.index ? Object.freeze({ ...route, path: "/wrong" }) : route,
      );
      this.state = Object.freeze({ ...state, routes: Object.freeze(routes) });
      this.emit();
      return;
    }
    this.state = state;
    this.emit();
  }

  focus(index: number): void {
    this.state = Object.freeze({ ...this.state, index });
    this.emit();
  }

  replaceFocusedParams(params: Readonly<Record<string, unknown>>, path?: string): void {
    const route = this.state.routes[this.state.index] as DemoRouterRoute;
    const routes = [...this.state.routes];
    routes[this.state.index] = Object.freeze({
      ...route,
      ...(path === undefined ? {} : { path }),
      params: Object.freeze({ ...params }),
    });
    this.state = Object.freeze({ ...this.state, routes: Object.freeze(routes) });
    this.emit();
  }

  preload(route: DemoRouterRoute): void {
    this.state = Object.freeze({
      ...this.state,
      preloadedRoutes: Object.freeze([...this.state.preloadedRoutes, route]),
    });
  }

  flush(): void {
    const deferred = this.deferred;
    this.deferred = [];
    for (const notify of deferred) notify();
  }

  private emit(): void {
    const notify = () => {
      for (const listener of [...this.listeners]) listener();
    };
    if (this.synchronousEvents) notify();
    else this.deferred.push(notify);
  }
}

function managedEntry(
  restorationIdentifier: string,
  restorationIndex: number,
  url: string,
): DocumentHistoryEntry {
  return Object.freeze({ restorationIdentifier, restorationIndex, url });
}

function harness(
  params?: Readonly<Record<string, unknown>>,
  path?: string,
) {
  const navigation = new FakeNavigation(params, path);
  let history!: DocumentHistory;
  let identifier = 0;
  const external: string[] = [];
  const bridge = new DemoRouterHistoryBridge({
    currentEntry: () => history.current,
    openExternal: (url) => {
      external.push(url);
    },
  });
  history = new DocumentHistory(
    { next: () => `history-${++identifier}` },
    bridge,
  );
  const detach = bridge.attach(navigation, INITIAL_ROUTE_KEY);
  return { bridge, detach, external, history, navigation };
}

function initialize(fixture: ReturnType<typeof harness>, url = GALLERY_URL) {
  const initialized = fixture.history.initialize(fixture.bridge.readInitialState(url));
  fixture.bridge.reconcile();
  return initialized;
}

describe("demo Expo Router history bridge", () => {
  test("encodes string params and classifies malformed metadata as unmanaged", () => {
    const entry = managedEntry("restoration-1", 7, "https://example.test/demo?x=1");
    const encoded = encodeDemoRouterHistoryEntry(entry);

    expect(encoded).toMatchObject({
      [DEMO_ROUTER_HISTORY_PARAMS.restorationIdentifier]: "restoration-1",
      [DEMO_ROUTER_HISTORY_PARAMS.restorationIndex]: "7",
    });
    expect(encoded[DEMO_ROUTER_HISTORY_PARAMS.url]).toMatch(/^v1~/);
    expect(encoded[DEMO_ROUTER_HISTORY_PARAMS.url]).not.toMatch(/[&%+?=()/]/);
    expect(decodeDemoRouterHistoryEntry(encoded)).toEqual(entry);

    for (const url of [
      "https://example.test/demo?flag",
      "https://example.test/demo?flag=",
      "https://example.test/demo?tag=a&tag=b&&space=+&encoded=%20&slash=%2f",
      "https://example.test/demo?raw=/foo/(group)/bar",
    ]) {
      const queryEntry = managedEntry("query-round-trip", 8, url);
      const outerParams = Object.fromEntries(
        new URLSearchParams(encodeDemoRouterHistoryEntry(queryEntry)),
      );

      expect(decodeDemoRouterHistoryEntry(outerParams)).toEqual(queryEntry);
    }

    for (const params of [
      undefined,
      {},
      { [DEMO_ROUTER_HISTORY_PARAMS.restorationIdentifier]: "partial" },
      { ...encoded, [DEMO_ROUTER_HISTORY_PARAMS.restorationIndex]: ["7"] },
      { ...encoded, [DEMO_ROUTER_HISTORY_PARAMS.restorationIndex]: "07" },
      { ...encoded, [DEMO_ROUTER_HISTORY_PARAMS.restorationIndex]: "9007199254740992" },
      {
        [DEMO_ROUTER_HISTORY_PARAMS.restorationIdentifier]: "raw-external",
        [DEMO_ROUTER_HISTORY_PARAMS.restorationIndex]: "7",
        [DEMO_ROUTER_HISTORY_PARAMS.url]: "https://example.test/demo?x=1",
      },
      { ...encoded, [DEMO_ROUTER_HISTORY_PARAMS.url]: "v1~not-a-byte" },
      { ...encoded, [DEMO_ROUTER_HISTORY_PARAMS.url]: "https://user:secret@example.test/demo" },
      { ...encoded, [DEMO_ROUTER_HISTORY_PARAMS.url]: "file:///tmp/demo" },
    ]) {
      expect(decodeDemoRouterHistoryEntry(params)).toBeUndefined();
    }

    expect(() =>
      encodeDemoRouterHistoryEntry(
        managedEntry("alias", 8, "https://example.test:443/demo?x=1"),
      ),
    ).toThrow(StateError);
  });

  test("survives Expo Router native deep-link parsing with opaque URL metadata", () => {
    const entry = managedEntry(
      "native-query",
      9,
      "https://example.test/demo?tag=a&tag=b&&space=a+b&encoded=%20&flag&raw=/foo/(group)/bar&tilde=~",
    );
    const encoded = encodeDemoRouterHistoryEntry(entry);
    const path = extractExpoPathFromURL(
      [],
      `expoturboexample://demo?${new URLSearchParams(encoded).toString()}`,
    );
    const state = getStateFromPath(`/${path}`, {
      screens: { [DEMO_ROUTER_ROUTE_NAME]: { path: "*expoTurboPath" } },
    });
    const route = state?.routes[0];

    expect(route?.params).toEqual({
      [DEMO_ROUTER_PATH_PARAM]: ["demo"],
      ...encoded,
    });
    expect(decodeDemoRouterHistoryEntry(route?.params)).toEqual(entry);
  });

  test("adopts managed initial state without writing the route", () => {
    const entry = managedEntry("persisted", 4, GALLERY_URL);
    const fixture = harness({ source: "deep-link", ...encodeDemoRouterHistoryEntry(entry) });
    const route = fixture.navigation.state.routes[0];

    const initialized = initialize(fixture);

    expect(initialized).toEqual({ entry, hostState: "adopted" });
    expect(fixture.history.current).toEqual(entry);
    expect(fixture.navigation.state.routes[0]).toBe(route);
  });

  test("gates managed metadata that does not describe the active document", () => {
    const entry = managedEntry("stale-document", 3, LINKED_URL);

    expect(() => harness(encodeDemoRouterHistoryEntry(entry))).toThrow(StateError);
  });

  test("decodes unmanaged canonical paths and adopts matching managed paths", () => {
    const unmanaged = harness({ [DEMO_ROUTER_PATH_PARAM]: ["demo", "linked"] });
    expect(unmanaged.bridge.readRouteState()).toEqual({
      kind: "unmanaged",
      url: LINKED_URL,
    });
    unmanaged.detach();

    const entry = managedEntry("linked-entry", 2, LINKED_URL);
    const managed = harness({
      [DEMO_ROUTER_PATH_PARAM]: ["demo", "linked"],
      ...encodeDemoRouterHistoryEntry(entry),
    });
    expect(managed.bridge.readRouteState()).toEqual({ entry, kind: "managed" });
  });

  test("round-trips a generic nested demo path through the Router history bridge", () => {
    const fixture = harness({ source: "gallery" });
    initialize(fixture);
    const proposal = fixture.history.proposeAdvance(NESTED_QUERY_URL);

    expect(fixture.history.commitProposal(proposal)).toBe(proposal.entry);

    const pushed = fixture.navigation.state.routes[1] as DemoRouterRoute;
    expect(pushed.params?.[DEMO_ROUTER_PATH_PARAM]).toEqual([
      "demo",
      "routes",
      "ios-proof",
      "details",
    ]);
    expect(pushed.params?.source).toBe("gallery");
    expect(decodeDemoRouterHistoryEntry(pushed.params)).toEqual(proposal.entry);
    const detach = fixture.bridge.attach(fixture.navigation, pushed.key);
    expect(fixture.bridge.readRouteState()).toEqual({ entry: proposal.entry, kind: "managed" });
    detach();
  });

  test("uses Expo Router's canonical direct-link path as authoritative query input", () => {
    const state = getStateFromPath(DIRECT_QUERY_INPUT_PATH, {
      screens: { [DEMO_ROUTER_ROUTE_NAME]: { path: "*expoTurboPath" } },
    });
    const route = state?.routes[0];
    if (!route?.params || !route.path) throw new Error("missing direct Router route");
    const params = route.params as Readonly<Record<string, unknown>>;
    expect(route.path).toBe(DIRECT_QUERY_INPUT_PATH);
    expect(params.plus).toBe(" ");
    expect(params.encoded).toBe(" ");
    const nativeParams = Object.freeze({ ...params, encoded: "" });

    for (const path of [DIRECT_QUERY_PATH, `/--${DIRECT_QUERY_PATH}`]) {
      const fixture = harness(nativeParams, path);
      expect(fixture.bridge.readRouteState()).toEqual({
        kind: "unmanaged",
        url: DIRECT_QUERY_URL,
      });

      const initialized = initialize(fixture, DIRECT_QUERY_URL);
      expect(initialized.entry.url).toBe(DIRECT_QUERY_URL);
      expect(fixture.navigation.state.routes[0]?.params?.source).toBe("direct");
      expect(fixture.navigation.state.routes[0]?.params?.tag).toEqual(["a", "b"]);
      expect(decodeDemoRouterHistoryEntry(fixture.navigation.state.routes[0]?.params)).toEqual(
        initialized.entry,
      );
      fixture.detach();
    }
  });

  test("rejects malformed or path-mismatched direct Router links", () => {
    for (const path of [
      "/demo?",
      "/demo#anchor",
      "//other.test/demo",
      "/demo\\linked",
      "/demo/linked?source=wrong",
      "/demo%2Flinked?source=wrong",
    ]) {
      expect(() => harness(undefined, path)).toThrow(StateError);
    }
    expect(() => harness({ source: "wrong" }, "/demo?source=direct")).toThrow(StateError);
  });

  test("recovers exact cold and later Expo Go anchors without changing Router ownership", () => {
    const fixture = harness(undefined, "/demo");

    expect(
      fixture.bridge.readInitialExpoGoAnchor(
        "exp://127.0.0.1:8081/--/demo#native-anchor-target",
      ),
    ).toBe("native-anchor-target");
    expect(
      fixture.bridge.readInitialExpoGoAnchor(
        "exps://127.0.0.1:8081/--/demo#native%2Danchor%2Dtarget",
      ),
    ).toBe("native-anchor-target");
    for (const value of [
      "https://127.0.0.1:8081/--/demo#native-anchor-target",
      "exp://127.0.0.1:8081/--/demo/linked#native-anchor-target",
      "exp://127.0.0.1:8081/--/demo?source=wrong#native-anchor-target",
      "exp://127.0.0.1:8081/--/demo#",
      "exp://127.0.0.1:8081/--/demo#%E0%A4%A",
    ]) {
      expect(fixture.bridge.readInitialExpoGoAnchor(value)).toBeUndefined();
    }
    fixture.detach();

    const managed = harness(
      encodeDemoRouterHistoryEntry(managedEntry("managed", 1, GALLERY_URL)),
      "/demo",
    );
    expect(
      managed.bridge.readInitialExpoGoAnchor(
        "exp://127.0.0.1:8081/--/demo#native-anchor-target",
      ),
    ).toBeUndefined();
    expect(
      managed.bridge.readExpoGoAnchor(
        "exp://127.0.0.1:8081/--/demo#native-anchor-target",
      ),
    ).toBe("native-anchor-target");
    expect(
      managed.bridge.readExpoGoAnchor(
        "exp://127.0.0.1:8081/--/demo?source=wrong#native-anchor-target",
      ),
    ).toBeUndefined();
    managed.detach();

    const managedQuery = harness(
      encodeDemoRouterHistoryEntry(managedEntry("managed-query", 2, GALLERY_QUERY_URL)),
      "/demo",
    );
    expect(
      managedQuery.bridge.readExpoGoAnchor(
        "exp://127.0.0.1:8081/--/demo?source=deep-link&tag=a&tag=b#native-anchor-target",
      ),
    ).toBe("native-anchor-target");
    expect(
      managedQuery.bridge.readExpoGoAnchor(
        "exp://127.0.0.1:8081/--/demo?tag=a&tag=b&source=deep-link#native-anchor-target",
      ),
    ).toBeUndefined();
    managedQuery.detach();

    const coldLinked = harness(
      { [DEMO_ROUTER_PATH_PARAM]: ["demo", "linked"] },
      "/demo/linked",
    );
    expect(
      coldLinked.bridge.readInitialExpoGoAnchor(
        "exp://127.0.0.1:8081/--/demo/linked#linked-native-anchor-target",
      ),
    ).toBe("linked-native-anchor-target");
    expect(
      coldLinked.bridge.readInitialExpoGoAnchor(
        "exp://127.0.0.1:8081/--/demo#linked-native-anchor-target",
      ),
    ).toBeUndefined();
    coldLinked.detach();
  });

  test("repairs one same-document Router metadata loss caused by a raw Expo Go URL event", async () => {
    const entry = managedEntry("native-event", 1, GALLERY_URL);
    const fixture = harness(encodeDemoRouterHistoryEntry(entry), "/demo");
    initialize(fixture);
    const errors: (Error | undefined)[] = [];
    fixture.bridge.subscribeErrors((error) => errors.push(error));

    fixture.navigation.replaceFocusedParams({ [DEMO_ROUTER_PATH_PARAM]: ["demo"] }, "demo");

    expect(
      fixture.bridge.handleExpoGoLinkEvent(
        "exp://127.0.0.1:8081/--/demo#native-anchor-target",
      ),
    ).toBe("native-anchor-target");
    expect(decodeDemoRouterHistoryEntry(fixture.navigation.state.routes[0]?.params)).toEqual(entry);

    await Promise.resolve();

    expect(errors.filter(Boolean)).toEqual([]);
    expect(fixture.history.current).toEqual(entry);
    fixture.detach();

    const queryEntry = managedEntry("native-event-query", 2, GALLERY_QUERY_URL);
    const queryFixture = harness(encodeDemoRouterHistoryEntry(queryEntry), "/demo");
    initialize(queryFixture, GALLERY_QUERY_URL);
    queryFixture.navigation.replaceFocusedParams(
      { [DEMO_ROUTER_PATH_PARAM]: ["demo"] },
      "demo",
    );

    expect(
      queryFixture.bridge.handleExpoGoLinkEvent(
        "exp://127.0.0.1:8081/--/demo?source=deep-link&tag=a&tag=b#native-anchor-target",
      ),
    ).toBe("native-anchor-target");
    expect(decodeDemoRouterHistoryEntry(queryFixture.navigation.state.routes[0]?.params)).toEqual(
      queryEntry,
    );
    await Promise.resolve();
    queryFixture.detach();
  });

  test("keeps ordinary Router query-shaped params unmanaged while history owns query URLs", () => {
    const unmanaged = harness({
      source: "gallery",
      tag: ["a", "b"],
    });
    expect(unmanaged.bridge.readRouteState()).toEqual({
      kind: "unmanaged",
      url: GALLERY_URL,
    });
    unmanaged.detach();

    const rawReserved = harness({
      [DEMO_ROUTER_HISTORY_PARAMS.restorationIdentifier]: "raw-external",
      [DEMO_ROUTER_HISTORY_PARAMS.restorationIndex]: "2",
      [DEMO_ROUTER_HISTORY_PARAMS.url]: GALLERY_QUERY_URL,
    });
    expect(rawReserved.bridge.readRouteState()).toEqual({
      kind: "unmanaged",
      url: GALLERY_URL,
    });
    rawReserved.detach();

    const entry = managedEntry("query-entry", 2, GALLERY_QUERY_URL);
    const managed = harness({
      source: "gallery",
      tag: ["a", "b"],
      ...encodeDemoRouterHistoryEntry(entry),
    });
    expect(managed.bridge.readRouteState()).toEqual({ entry, kind: "managed" });
  });

  test("repairs absent, partial, and malformed initial metadata with same-key setParams", () => {
    for (const params of [
      { source: "initial" },
      {
        source: "partial",
        [DEMO_ROUTER_HISTORY_PARAMS.restorationIdentifier]: "partial",
      },
      {
        source: "malformed",
        [DEMO_ROUTER_HISTORY_PARAMS.restorationIdentifier]: "bad",
        [DEMO_ROUTER_HISTORY_PARAMS.restorationIndex]: "x",
        [DEMO_ROUTER_HISTORY_PARAMS.url]: "not-a-url",
      },
    ]) {
      const fixture = harness(params);
      const key = fixture.navigation.state.routes[0]?.key;

      const initialized = initialize(fixture);
      const route = fixture.navigation.state.routes[0] as DemoRouterRoute;

      expect(initialized.hostState).toBe("replaced");
      expect(route.key).toBe(key);
      expect(route.params?.source).toBe(params.source);
      expect(decodeDemoRouterHistoryEntry(route.params)).toEqual(initialized.entry);
      expect(fixture.history.current).toBe(initialized.entry);
    }
  });

  test("pushes a new exact route and suppresses synchronous own traversal events", () => {
    const fixture = harness({ source: "gallery" });
    initialize(fixture);
    const traversals: DocumentHistoryEntry[] = [];
    fixture.bridge.subscribe((entry) => traversals.push(entry));
    const firstRoute = fixture.navigation.state.routes[0];
    const proposal = fixture.history.proposeAdvance(LINKED_URL);

    expect(fixture.history.commitProposal(proposal)).toBe(proposal.entry);

    expect(fixture.navigation.state.routes).toHaveLength(2);
    expect(fixture.navigation.state.routes[0]).toBe(firstRoute);
    const pushed = fixture.navigation.state.routes[1] as DemoRouterRoute;
    expect(pushed.key).not.toBe(firstRoute?.key);
    expect(pushed.name).toBe(DEMO_ROUTER_ROUTE_NAME);
    expect(pushed.params?.[DEMO_ROUTER_PATH_PARAM]).toEqual(["demo", "linked"]);
    expect(pushed.params?.source).toBe("gallery");
    expect(decodeDemoRouterHistoryEntry(pushed.params)).toEqual(proposal.entry);
    expect(traversals).toEqual([]);
  });

  test("pushes an ordered query-bearing URL through authoritative history metadata", () => {
    const fixture = harness({ source: "gallery" });
    initialize(fixture);
    const proposal = fixture.history.proposeAdvance(LINKED_QUERY_URL);

    expect(fixture.history.commitProposal(proposal)).toBe(proposal.entry);

    const pushed = fixture.navigation.state.routes[1] as DemoRouterRoute;
    expect(pushed.params?.[DEMO_ROUTER_PATH_PARAM]).toEqual(["demo", "linked"]);
    expect(pushed.params?.source).toBe("gallery");
    expect(decodeDemoRouterHistoryEntry(pushed.params)).toEqual(proposal.entry);
    const detach = fixture.bridge.attach(fixture.navigation, pushed.key);
    expect(fixture.bridge.readRouteState()).toEqual({ entry: proposal.entry, kind: "managed" });
    detach();
  });

  test("reuses the first matching Expo Router preload without changing its native state", () => {
    const fixture = harness({ source: "gallery" });
    initialize(fixture);
    const nestedState = Object.freeze({ index: 0, routes: Object.freeze([]) });
    fixture.navigation.preload(
      Object.freeze({
        key: "index-preloaded",
        name: DEMO_ROUTER_ROUTE_NAME,
        path: "/preview",
        params: Object.freeze({ preview: "discarded" }),
        state: nestedState,
      }),
    );
    const proposal = fixture.history.proposeAdvance(LINKED_QUERY_URL);

    fixture.history.commitProposal(proposal);

    const pushed = fixture.navigation.state.routes[1] as DemoRouterRoute & {
      readonly state?: unknown;
    };
    expect(pushed.key).toBe("index-preloaded");
    expect(pushed.path).toBe("/preview");
    expect(pushed.state).toBe(nestedState);
    expect(pushed.params?.preview).toBeUndefined();
    expect(pushed.params?.source).toBe("gallery");
    expect(pushed.params?.[DEMO_ROUTER_PATH_PARAM]).toEqual(["demo", "linked"]);
    expect(decodeDemoRouterHistoryEntry(pushed.params)).toEqual(proposal.entry);
    expect(fixture.navigation.state.preloadedRoutes).toEqual([]);
  });

  test("preserves the focused route identity for replacement and deferred own events", () => {
    const fixture = harness({ source: "gallery" });
    initialize(fixture);
    fixture.navigation.synchronousEvents = false;
    const traversals: DocumentHistoryEntry[] = [];
    fixture.bridge.subscribe((entry) => traversals.push(entry));
    const route = fixture.navigation.state.routes[0] as DemoRouterRoute;
    const proposal = fixture.history.proposeReplace(LINKED_URL);

    fixture.history.commitProposal(proposal);
    fixture.navigation.flush();

    const replaced = fixture.navigation.state.routes[0] as DemoRouterRoute;
    expect(replaced.key).toBe(route.key);
    expect(replaced.name).toBe(route.name);
    expect(replaced.params?.source).toBe("gallery");
    expect(replaced.params?.[DEMO_ROUTER_PATH_PARAM]).toEqual(["demo", "linked"]);
    expect(decodeDemoRouterHistoryEntry(replaced.params)).toEqual(proposal.entry);
    expect(traversals).toEqual([]);
  });

  test("replaces a query-bearing route by overwriting its authoritative document URL", () => {
    const initial = managedEntry("query-initial", 0, GALLERY_QUERY_URL);
    const fixture = harness({
      source: "gallery",
      ...encodeDemoRouterHistoryEntry(initial),
    });
    const initialized = initialize(fixture, GALLERY_QUERY_URL).entry;
    const route = fixture.navigation.state.routes[0] as DemoRouterRoute;
    const proposal = fixture.history.proposeReplace(GALLERY_URL);

    expect(fixture.history.commitProposal(proposal)).toBe(proposal.entry);

    const replaced = fixture.navigation.state.routes[0] as DemoRouterRoute;
    expect(replaced.key).toBe(route.key);
    expect(replaced.params?.source).toBe("gallery");
    expect(decodeDemoRouterHistoryEntry(replaced.params)).toEqual(proposal.entry);
    expect(initialized).toEqual(initial);
  });

  test("emits popped back and restored-state forward traversal exactly once", () => {
    const fixture = harness();
    const initial = initialize(fixture).entry;
    const proposal = fixture.history.proposeAdvance(LINKED_URL);
    fixture.history.commitProposal(proposal);
    const forwardState = fixture.navigation.state;
    const traversals: DocumentHistoryEntry[] = [];
    fixture.bridge.subscribe((entry) => {
      traversals.push(entry);
      fixture.history.adoptTraversal(entry);
    });

    fixture.navigation.goBack();
    fixture.navigation.reset(fixture.navigation.state);
    fixture.navigation.reset(forwardState);
    const forwardRouteKey = forwardState.routes[forwardState.index]?.key;
    if (!forwardRouteKey) throw new Error("forward route key was missing");
    const detachForward = fixture.bridge.attach(fixture.navigation, forwardRouteKey);
    fixture.bridge.reconcile();
    fixture.navigation.reset(forwardState);

    expect(traversals).toEqual([initial, proposal.entry]);
    expect(fixture.history.current).toEqual(proposal.entry);
    expect(fixture.navigation.state.routes[1]?.key).toBe(`${DEMO_ROUTER_ROUTE_NAME}-2`);
    detachForward();
  });

  test("restores query-bearing entries after Router back and forward traversal", () => {
    const initialEntry = managedEntry("query-initial", 0, GALLERY_QUERY_URL);
    const fixture = harness(encodeDemoRouterHistoryEntry(initialEntry));
    const initial = initialize(fixture, GALLERY_QUERY_URL).entry;
    const proposal = fixture.history.proposeAdvance(LINKED_QUERY_URL);
    fixture.history.commitProposal(proposal);
    const forwardState = fixture.navigation.state;
    const traversals: DocumentHistoryEntry[] = [];
    fixture.bridge.subscribe((entry) => {
      traversals.push(entry);
      fixture.history.adoptTraversal(entry);
    });

    fixture.navigation.goBack();
    fixture.navigation.reset(forwardState);
    const forwardRouteKey = forwardState.routes[forwardState.index]?.key;
    if (!forwardRouteKey) throw new Error("forward route key was missing");
    const detachForward = fixture.bridge.attach(fixture.navigation, forwardRouteKey);
    fixture.bridge.reconcile();

    expect(traversals).toEqual([initial, proposal.entry]);
    expect(fixture.history.current).toEqual(proposal.entry);
    detachForward();
  });

  test("reconciles a focus change that happened before a replacement attachment", () => {
    const fixture = harness();
    const initial = initialize(fixture).entry;
    const proposal = fixture.history.proposeAdvance(LINKED_URL);
    fixture.history.commitProposal(proposal);
    fixture.navigation.focus(0);
    const traversals: DocumentHistoryEntry[] = [];
    fixture.bridge.subscribe((entry) => {
      traversals.push(entry);
      fixture.history.adoptTraversal(entry);
    });
    const detachReplacement = fixture.bridge.attach(fixture.navigation, INITIAL_ROUTE_KEY);

    fixture.bridge.reconcile();

    expect(traversals).toEqual([initial]);
    expect(fixture.history.current).toEqual(initial);
    detachReplacement();
  });

  test("waits for the focused destination root before reconciling a traversal", () => {
    const fixture = harness();
    const initial = initialize(fixture).entry;
    const proposal = fixture.history.proposeAdvance(LINKED_URL);
    fixture.history.commitProposal(proposal);
    const linkedRouteKey = fixture.navigation.state.routes[1]?.key;
    if (!linkedRouteKey) throw new Error("linked route key was missing");

    const detachLinked = fixture.bridge.attach(fixture.navigation, linkedRouteKey);
    fixture.navigation.goBack();
    detachLinked();

    const detachInitial = fixture.bridge.attach(fixture.navigation, INITIAL_ROUTE_KEY, {
      deferReconciliation: true,
    });
    const traversals: DocumentHistoryEntry[] = [];
    fixture.bridge.subscribe((entry) => {
      traversals.push(entry);
      fixture.history.adoptTraversal(entry);
    });
    fixture.navigation.reset(fixture.navigation.state);

    expect(traversals).toEqual([]);
    expect(fixture.history.current).toEqual(proposal.entry);

    fixture.bridge.reconcile();

    expect(traversals).toEqual([initial]);
    expect(fixture.history.current).toEqual(initial);
    detachInitial();
  });

  test("keeps no-op and thrown Router writes retryable", () => {
    for (const behavior of ["noop", "partial", "commit-throw", "throw"] as const) {
      const fixture = harness();
      initialize(fixture);
      const initial = fixture.history.current;
      const proposal = fixture.history.proposeAdvance(LINKED_URL);
      fixture.navigation.pushBehavior = behavior;

      let error: unknown;
      try {
        fixture.history.commitProposal(proposal);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(StateError);
      expect(String(error)).not.toContain("secret");
      expect(fixture.history.current).toBe(initial);
      expect(fixture.navigation.state.routes).toHaveLength(1);
      expect(
        decodeDemoRouterHistoryEntry(fixture.navigation.state.routes[0]?.params),
      ).toEqual(initial);

      fixture.navigation.pushBehavior = "commit";
      expect(fixture.history.commitProposal(proposal)).toBe(proposal.entry);
    }
  });

  test("suppresses synchronous partial-write traversal and errors before retry", () => {
    const fixture = harness();
    initialize(fixture);
    const traversals: DocumentHistoryEntry[] = [];
    const errors: (Error | undefined)[] = [];
    fixture.bridge.subscribe((entry) => traversals.push(entry));
    fixture.bridge.subscribeErrors((error) => errors.push(error));
    const proposal = fixture.history.proposeAdvance(LINKED_URL);
    fixture.navigation.pushBehavior = "partial";

    expect(() => fixture.history.commitProposal(proposal)).toThrow(StateError);

    expect(traversals).toEqual([]);
    expect(errors.filter(Boolean)).toEqual([]);
    fixture.navigation.pushBehavior = "commit";
    expect(fixture.history.commitProposal(proposal)).toBe(proposal.entry);
  });

  test("keeps established replacement writes retryable", () => {
    for (const behavior of ["noop", "partial", "commit-throw", "throw"] as const) {
      const fixture = harness();
      initialize(fixture);
      const initial = fixture.history.current;
      const proposal = fixture.history.proposeReplace(LINKED_URL);
      fixture.navigation.setParamsBehavior = behavior;

      expect(() => fixture.history.commitProposal(proposal)).toThrow(StateError);

      expect(fixture.history.current).toBe(initial);
      expect(fixture.navigation.state.routes).toHaveLength(1);
      expect(
        decodeDemoRouterHistoryEntry(fixture.navigation.state.routes[0]?.params),
      ).toEqual(initial);
      fixture.navigation.setParamsBehavior = "commit";
      expect(fixture.history.commitProposal(proposal)).toBe(proposal.entry);
    }
  });

  test("rolls back a failed query-to-no-query replacement without leaving stale route state", () => {
    const initialEntry = managedEntry("query-initial", 0, GALLERY_QUERY_URL);
    const fixture = harness(encodeDemoRouterHistoryEntry(initialEntry));
    const initial = initialize(fixture, GALLERY_QUERY_URL).entry;
    const before = fixture.navigation.state;
    const proposal = fixture.history.proposeReplace(GALLERY_URL);
    fixture.navigation.setParamsBehavior = "partial";

    expect(() => fixture.history.commitProposal(proposal)).toThrow(StateError);

    expect(fixture.navigation.state).toBe(before);
    expect(decodeDemoRouterHistoryEntry(fixture.navigation.state.routes[0]?.params)).toEqual(
      initial,
    );
    expect(fixture.history.current).toEqual(initial);
  });

  test("rolls back collateral Stack state changes before committing history", () => {
    for (const method of ["push", "replace"] as const) {
      const fixture = harness();
      initialize(fixture);
      const before = fixture.navigation.state;
      const proposal =
        method === "push"
          ? fixture.history.proposeAdvance(LINKED_URL)
          : fixture.history.proposeReplace(LINKED_URL);
      if (method === "push") fixture.navigation.pushBehavior = "collateral";
      else fixture.navigation.setParamsBehavior = "collateral";

      expect(() => fixture.history.commitProposal(proposal)).toThrow(StateError);

      expect(fixture.navigation.state).toBe(before);
      expect(fixture.history.current?.url).toBe(GALLERY_URL);
      if (method === "push") fixture.navigation.pushBehavior = "commit";
      else fixture.navigation.setParamsBehavior = "commit";
      expect(fixture.history.commitProposal(proposal)).toBe(proposal.entry);
    }
  });

  test("suppresses deferred mutation and rollback echoes before retry", () => {
    const fixture = harness();
    initialize(fixture);
    fixture.navigation.synchronousEvents = false;
    const traversals: DocumentHistoryEntry[] = [];
    fixture.bridge.subscribe((entry) => traversals.push(entry));
    const proposal = fixture.history.proposeAdvance(LINKED_URL);
    fixture.navigation.pushBehavior = "partial";

    expect(() => fixture.history.commitProposal(proposal)).toThrow(StateError);
    fixture.navigation.flush();

    expect(traversals).toEqual([]);
    fixture.navigation.pushBehavior = "commit";
    expect(fixture.history.commitProposal(proposal)).toBe(proposal.entry);
    fixture.navigation.flush();
    expect(traversals).toEqual([]);
  });

  test("fails closed when Router rollback cannot be verified", () => {
    for (const scenario of [
      { method: "push", reset: "noop" },
      { method: "push", reset: "throw" },
      { method: "push", reset: "partial" },
      { method: "replace", reset: "noop" },
      { method: "replace", reset: "throw" },
    ] as const) {
      const fixture = harness();
      initialize(fixture);
      const initial = fixture.history.current;
      const errors: (Error | undefined)[] = [];
      fixture.bridge.subscribeErrors((error) => errors.push(error));
      const proposal =
        scenario.method === "push"
          ? fixture.history.proposeAdvance(LINKED_URL)
          : fixture.history.proposeReplace(LINKED_URL);
      fixture.navigation.resetBehavior = scenario.reset;
      if (scenario.method === "push") fixture.navigation.pushBehavior = "partial";
      else fixture.navigation.setParamsBehavior = "partial";

      expect(() => fixture.history.commitProposal(proposal)).toThrow(StateError);

      expect(fixture.history.current).toBe(initial);
      expect(errors.at(-1)).toBeInstanceOf(StateError);
      expect(() => fixture.bridge.attach(fixture.navigation, INITIAL_ROUTE_KEY)).toThrow(
        StateError,
      );
      expect(() => fixture.bridge.reconcile()).toThrow(StateError);
    }
  });

  test("keeps unmanaged repairs retryable after failed setParams writes", () => {
    for (const behavior of ["noop", "partial", "commit-throw", "throw"] as const) {
      const fixture = harness();
      fixture.navigation.setParamsBehavior = behavior;

      expect(() =>
        fixture.history.initialize(
          fixture.bridge.readInitialState(GALLERY_URL),
        ),
      ).toThrow(StateError);
      expect(fixture.history.current).toBeUndefined();
      expect(
        decodeDemoRouterHistoryEntry(fixture.navigation.state.routes[0]?.params),
      ).toBeUndefined();

      fixture.navigation.setParamsBehavior = "commit";
      const initialized = initialize(fixture);
      expect(initialized.entry.restorationIdentifier).toBe("history-2");
    }
  });

  test("reports malformed traversal metadata once without changing established history", () => {
    const fixture = harness();
    const initialized = initialize(fixture);
    const errors: (Error | undefined)[] = [];
    fixture.bridge.subscribeErrors((error) => errors.push(error));

    fixture.navigation.replaceFocusedParams({
      [DEMO_ROUTER_PATH_PARAM]: ["demo"],
      [DEMO_ROUTER_HISTORY_PARAMS.restorationIdentifier]: "malformed",
    });
    fixture.navigation.replaceFocusedParams({
      [DEMO_ROUTER_PATH_PARAM]: ["demo"],
      [DEMO_ROUTER_HISTORY_PARAMS.restorationIdentifier]: "still-malformed",
    });

    expect(errors.filter(Boolean)).toHaveLength(1);
    expect(errors.at(-1)).toBeInstanceOf(StateError);
    expect(fixture.history.current).toBe(initialized.entry);
  });

  test("revalidates malformed metadata when the same route key is attached again", () => {
    const fixture = harness();
    initialize(fixture);
    fixture.navigation.replaceFocusedParams({
      [DEMO_ROUTER_PATH_PARAM]: ["demo"],
      [DEMO_ROUTER_HISTORY_PARAMS.restorationIdentifier]: "malformed",
    });
    fixture.detach();

    const detach = fixture.bridge.attach(fixture.navigation, INITIAL_ROUTE_KEY);

    expect(() => fixture.bridge.reconcile()).toThrow(StateError);
    detach();
  });

  test("makes stale cleanup and inactive attachments harmless", () => {
    const fixture = harness();
    initialize(fixture);
    const proposal = fixture.history.proposeAdvance(LINKED_URL);
    fixture.history.commitProposal(proposal);
    const oldDetach = fixture.detach;
    const newDetach = fixture.bridge.attach(
      fixture.navigation,
      `${DEMO_ROUTER_ROUTE_NAME}-2`,
    );
    fixture.bridge.reconcile();

    oldDetach();
    const replacement = fixture.history.proposeReplace(LINKED_URL);
    expect(fixture.history.commitProposal(replacement)).toBe(replacement.entry);

    newDetach();
    const detached = fixture.history.proposeReplace(GALLERY_URL);
    expect(() => fixture.history.commitProposal(detached)).toThrow(StateError);
    expect(fixture.history.current).toBe(replacement.entry);
  });

  test("uses the active Router for back and external navigation only", () => {
    const fixture = harness();
    initialize(fixture);
    expect(() => fixture.bridge.back()).toThrow(StateError);
    fixture.bridge.openExternal("https://example.com/");
    expect(fixture.external).toEqual(["https://example.com/"]);
    expect(() => fixture.bridge.visit("https://example.test/file.pdf", "advance")).toThrow(
      StateError,
    );
  });

  test("redacts malformed Router state shapes as protocol errors", () => {
    for (const state of [
      { index: 0 },
      { index: 0, routes: {} },
      { index: 0, routes: [{ key: 1, name: DEMO_ROUTER_ROUTE_NAME }] },
      { index: 0, routes: [{ key: INITIAL_ROUTE_KEY, name: 1 }] },
      {
        index: 0,
        routes: [{ key: INITIAL_ROUTE_KEY, name: DEMO_ROUTER_ROUTE_NAME, params: [] }],
      },
    ]) {
      const fixture = harness();
      fixture.detach();
      fixture.navigation.state = state as unknown as DemoRouterState;

      expect(() => fixture.bridge.attach(fixture.navigation, INITIAL_ROUTE_KEY)).toThrow(
        StateError,
      );
    }
  });
});
