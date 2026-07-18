import { StateError } from "expo-turbo/core";
import {
  type ReactNode,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from "react";
import { Text } from "react-native";

import type { DemoRouterNavigation } from "./demo-router-history";
import type { DemoRuntime } from "./demo-runtime";

interface DemoRouterRouteOwnerState {
  readonly error?: Error;
  readonly routeKey: string;
  readonly status: "error" | "pending" | "ready";
}

class DemoRouterRouteGate {
  private readonly listeners = new Set<() => void>();
  private state: DemoRouterRouteOwnerState;

  constructor(routeKey: string) {
    this.state = Object.freeze({ routeKey, status: "pending" });
  }

  readonly snapshot = (): DemoRouterRouteOwnerState => this.state;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  fail(routeKey: string, error: Error): void {
    this.update(Object.freeze({ error, routeKey, status: "error" }));
  }

  ready(routeKey: string): void {
    this.update(Object.freeze({ routeKey, status: "ready" }));
  }

  private update(state: DemoRouterRouteOwnerState): void {
    this.state = state;
    for (const listener of [...this.listeners]) listener();
  }
}

export interface DemoRouterRouteOwnerProps {
  readonly children?: ReactNode;
  readonly focused: boolean;
  readonly navigation: DemoRouterNavigation;
  readonly routeKey: string;
  readonly runtime: DemoRuntime;
}

function ActiveDemoRouterRouteOwner({
  children,
  navigation,
  routeKey,
  runtime,
}: Omit<DemoRouterRouteOwnerProps, "focused">) {
  const gate = useMemo(() => new DemoRouterRouteGate(routeKey), [routeKey]);
  const owner = useSyncExternalStore(gate.subscribe, gate.snapshot, gate.snapshot);

  useEffect(() => {
    let active = true;
    let initialized = false;
    let detach: (() => undefined) | undefined;
    const unsubscribeErrors = runtime.navigation.subscribeErrors((error) => {
      if (!active) return;
      if (error) gate.fail(routeKey, error);
      else if (initialized) gate.ready(routeKey);
    });
    try {
      detach = runtime.navigation.attach(navigation, routeKey);
      const documentUrl = runtime.session.tree.document.url;
      if (!documentUrl) throw new StateError("The Expo Turbo demo has no active document URL");
      if (!runtime.documentRuntime.history.current) {
        runtime.documentRuntime.history.initialize(
          runtime.navigation.readInitialState(documentUrl),
        );
      }
      runtime.navigation.reconcile();
      initialized = true;
      runtime.navigation.clearError();
      if (active) gate.ready(routeKey);
    } catch (error) {
      runtime.navigation.reportError(
        error instanceof Error
          ? error
          : new StateError("Demo Router history initialization failed"),
      );
    }

    return () => {
      active = false;
      unsubscribeErrors();
      detach?.();
    };
  }, [gate, navigation, routeKey, runtime]);

  if (owner.routeKey !== routeKey || owner.status === "pending") return null;
  if (owner.status === "error") {
    return (
      <Text selectable style={{ color: "#a62525", padding: 24 }}>
        {owner.error?.name}: {owner.error?.message}
      </Text>
    );
  }
  return children;
}

/** Owns the one focused Router attachment and logical document root. */
export function DemoRouterRouteOwner({
  children,
  focused,
  navigation,
  routeKey,
  runtime,
}: DemoRouterRouteOwnerProps) {
  if (!focused) return null;
  return (
    <ActiveDemoRouterRouteOwner
      key={routeKey}
      navigation={navigation}
      routeKey={routeKey}
      runtime={runtime}
    >
      {children}
    </ActiveDemoRouterRouteOwner>
  );
}
