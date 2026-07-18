import { describe, expect, test } from "bun:test";
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

const INITIAL_ROUTE_KEY = "demo-route-1";
const GALLERY_URL = "https://example.test/demo";
const LINKED_URL = "https://example.test/demo/linked";

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

  constructor(params?: Readonly<Record<string, unknown>>) {
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
          path: "/demo",
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

  replaceFocusedParams(params: Readonly<Record<string, unknown>>): void {
    const route = this.state.routes[this.state.index] as DemoRouterRoute;
    const routes = [...this.state.routes];
    routes[this.state.index] = Object.freeze({ ...route, params: Object.freeze({ ...params }) });
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

function harness(params?: Readonly<Record<string, unknown>>) {
  const navigation = new FakeNavigation(params);
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
    const entry = managedEntry("restoration-1", 7, "https://example.test:443/demo?x=1");
    const encoded = encodeDemoRouterHistoryEntry(entry);

    expect(encoded).toEqual({
      [DEMO_ROUTER_HISTORY_PARAMS.restorationIdentifier]: "restoration-1",
      [DEMO_ROUTER_HISTORY_PARAMS.restorationIndex]: "7",
      [DEMO_ROUTER_HISTORY_PARAMS.url]: "https://example.test:443/demo?x=1",
    });
    expect(decodeDemoRouterHistoryEntry(encoded)).toEqual({
      restorationIdentifier: "restoration-1",
      restorationIndex: 7,
      url: "https://example.test/demo?x=1",
    });

    for (const params of [
      undefined,
      {},
      { [DEMO_ROUTER_HISTORY_PARAMS.restorationIdentifier]: "partial" },
      { ...encoded, [DEMO_ROUTER_HISTORY_PARAMS.restorationIndex]: ["7"] },
      { ...encoded, [DEMO_ROUTER_HISTORY_PARAMS.restorationIndex]: "07" },
      { ...encoded, [DEMO_ROUTER_HISTORY_PARAMS.restorationIndex]: "9007199254740992" },
      { ...encoded, [DEMO_ROUTER_HISTORY_PARAMS.url]: "https://user:secret@example.test/demo" },
      { ...encoded, [DEMO_ROUTER_HISTORY_PARAMS.url]: "file:///tmp/demo" },
    ]) {
      expect(decodeDemoRouterHistoryEntry(params)).toBeUndefined();
    }
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
    const fixture = harness(encodeDemoRouterHistoryEntry(entry));

    expect(() => fixture.bridge.readRouteState()).toThrow(StateError);
    expect(() => initialize(fixture)).toThrow(StateError);
    expect(fixture.history.current).toBeUndefined();
    expect(decodeDemoRouterHistoryEntry(fixture.navigation.state.routes[0]?.params)?.url).toBe(
      LINKED_URL,
    );
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
    const proposal = fixture.history.proposeAdvance(LINKED_URL);

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
    fixture.navigation.reset(forwardState);

    expect(traversals).toEqual([initial, proposal.entry]);
    expect(fixture.history.current).toEqual(proposal.entry);
    expect(fixture.navigation.state.routes[1]?.key).toBe(`${DEMO_ROUTER_ROUTE_NAME}-2`);
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
