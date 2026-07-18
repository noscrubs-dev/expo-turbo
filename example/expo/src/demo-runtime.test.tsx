/// <reference types="bun" />

import { describe, expect, mock, test } from "bun:test";
import { StateError } from "expo-turbo/core";
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

const { encodeDemoRouterHistoryEntry } = await import("./demo-router-history");
const { DemoRouterRouteOwner } = await import("./demo-router-route-owner");
const { createDemoRuntime, DemoRuntimeProvider, useDemoRuntime } = await import(
  "./demo-runtime"
);

const globalWithAct = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean;
};
globalWithAct.IS_REACT_ACT_ENVIRONMENT = true;

class TestNavigation implements DemoRouterNavigation {
  private key = 1;
  private readonly listeners = new Set<() => void>();
  state: DemoRouterState;

  constructor(params?: Readonly<Record<string, unknown>>) {
    this.state = Object.freeze({
      stale: false,
      type: "stack",
      key: "stack-1",
      index: 0,
      routeNames: Object.freeze(["index"]),
      preloadedRoutes: Object.freeze([]),
      routes: Object.freeze([
        Object.freeze({
          key: "index-1",
          name: "index",
          ...(params ? { params } : {}),
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
    this.state = state;
    this.emit();
  }

  setParams(params: Readonly<Record<string, unknown>>): void {
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
          routeOwner(false, "index-1", "first"),
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
          routeOwner(true, "index-1", "first"),
        ),
      );
      await Promise.resolve();
    });
    expect(navigation.listenerCount).toBe(1);
    expect(runtime.documentRuntime.history.current?.url).toBe("https://example.test/demo");
    expect(activeRoutes()).toHaveLength(1);
    expect(activeRoutes()[0]?.props.label).toBe("first");

    act(() => runtime.navigation.reportError(new StateError("temporary traversal failure")));
    expect(activeRoutes()).toHaveLength(0);
    act(() => runtime.navigation.clearError());
    expect(activeRoutes()).toHaveLength(1);

    const proposal = runtime.documentRuntime.history.proposeAdvance(
      "https://example.test/linked",
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
            routeOwner(false, "index-1", "first"),
            routeOwner(true, "index-2", "second"),
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
    const runtime = createDemoRuntime();
    const navigation = new TestNavigation(
      encodeDemoRouterHistoryEntry({
        restorationIdentifier: "demo-history-1",
        restorationIndex: 0,
        url: "https://example.test/demo",
      }),
    );
    let renderer: ReactTestRenderer | undefined;

    await act(async () => {
      renderer = create(
        createElement(
          DemoRuntimeProvider,
          { runtime },
          createElement(
            DemoRouterRouteOwner,
            { focused: true, navigation, routeKey: "index-1", runtime },
            createElement("active-route"),
          ),
        ),
      );
      await Promise.resolve();
    });

    expect(runtime.documentRuntime.history.current?.restorationIdentifier).toBe(
      "demo-history-1",
    );
    const proposal = runtime.documentRuntime.history.proposeAdvance(
      "https://example.test/linked",
    );
    expect(proposal.entry.restorationIdentifier).not.toBe("demo-history-1");
    expect(runtime.documentRuntime.history.commitProposal(proposal)).toBe(proposal.entry);

    await act(async () => {
      renderer?.unmount();
      await Promise.resolve();
    });
  });
});
