/// <reference types="bun" />

import { describe, expect, mock, test } from "bun:test";
import type { FetchAdapter, TurboRequest, TurboResponse } from "expo-turbo/adapters";
import { EXPO_TURBO_MIME_TYPE, StateError } from "expo-turbo/core";
import { createElement, Fragment, StrictMode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import type {
  DemoRouterNavigation,
  DemoRouterRoute,
  DemoRouterState,
} from "./demo-router-history";
mock.module("react-native", () => ({
  AccessibilityInfo: { announceForAccessibility: () => undefined },
  Alert: { alert: () => undefined },
  Linking: { openURL: async () => undefined },
  Platform: { OS: "web" },
  Pressable: (props: Readonly<Record<string, unknown>>) =>
    createElement("pressable", props),
  Text: (props: Readonly<Record<string, unknown>>) => createElement("native-text", props),
  TextInput: (props: Readonly<Record<string, unknown>>) =>
    createElement("text-input", props),
  View: (props: Readonly<Record<string, unknown>>) => createElement("view", props),
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
  test("direct disposal releases every runtime-owned state surface", () => {
    const runtime = createDemoRuntime();

    runtime.dispose();
    runtime.dispose();

    expect(runtime.forms.isDisposed).toBeTrue();
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
      url: LINKED_URL,
    } as const;
    const replacementEntry = {
      restorationIdentifier: "second-entry",
      restorationIndex: 2,
      url: LINKED_URL,
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
