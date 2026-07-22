import { StateError } from "expo-turbo/core";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import { Text } from "react-native";

import type { DemoDocumentBootstrap } from "./demo-document-controller";
import type { DemoRouterNavigation } from "./demo-router-history";
import type { DemoRuntime } from "./demo-runtime";

interface DemoRouterRouteOwnerState {
  readonly error?: Error;
  readonly routeKey: string;
  readonly status: "error" | "pending" | "ready";
}

const DemoRouterRouteReadyContext = createContext<(() => void) | undefined>(undefined);

export function useOptionalDemoRouterRouteReady(): (() => void) | undefined {
  return useContext(DemoRouterRouteReadyContext);
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
  readonly incomingLink?: Readonly<{ sequence: number; url: string }>;
  readonly initialUrl?: string;
  readonly navigation: DemoRouterNavigation;
  readonly routeKey: string;
  readonly runtime: DemoRuntime;
}

function ActiveDemoRouterRouteOwner({
  children,
  incomingLink,
  initialUrl,
  navigation,
  routeKey,
  runtime,
}: Omit<DemoRouterRouteOwnerProps, "focused">) {
  const gate = useMemo(() => new DemoRouterRouteGate(routeKey), [routeKey]);
  const owner = useSyncExternalStore(gate.subscribe, gate.snapshot, gate.snapshot);
  const initialAnchor = useRef<string | undefined>(undefined);
  const initialAnchorRequested = useRef(false);
  const handledIncomingLink = useRef<number | undefined>(undefined);
  const latestIncomingLink = useRef(incomingLink);
  const reconciled = useRef(false);
  useEffect(() => {
    latestIncomingLink.current = incomingLink;
  }, [incomingLink]);
  const markRootReady = useCallback(() => {
    if (reconciled.current) return;
    try {
      runtime.navigation.reconcile();
      reconciled.current = true;
    } catch (error) {
      runtime.navigation.reportError(
        error instanceof Error
          ? error
          : new StateError("Demo Router history reconciliation failed"),
      );
      return;
    }
  }, [runtime.navigation]);

  useEffect(() => {
    let active = true;
    let bootstrap: DemoDocumentBootstrap | undefined;
    let initialized = false;
    let detach: (() => undefined) | undefined;
    const unsubscribeErrors = runtime.navigation.subscribeErrors((error) => {
      if (!active) return;
      if (error) gate.fail(routeKey, error);
      else if (initialized) gate.ready(routeKey);
    });
    const initialize = async (): Promise<void> => {
      try {
        detach = runtime.navigation.attach(navigation, routeKey, { deferReconciliation: true });
        const pendingIncomingLink = latestIncomingLink.current;
        const incomingAnchor =
          pendingIncomingLink &&
          Number.isSafeInteger(pendingIncomingLink.sequence) &&
          pendingIncomingLink.sequence >= 1
            ? (() => {
                handledIncomingLink.current = pendingIncomingLink.sequence;
                return runtime.navigation.handleExpoGoLinkEvent(pendingIncomingLink.url);
              })()
            : runtime.navigation.takePendingRecoveredExpoGoAnchor();
        initialAnchor.current = runtime.navigation.readInitialExpoGoAnchor(initialUrl);
        let documentUrl = runtime.session.tree.document.url;
        if (!documentUrl) throw new StateError("The Expo Turbo demo has no active document URL");
        const routeState = runtime.navigation.readRouteState();
        const routeUrl = routeState.kind === "managed" ? routeState.entry.url : routeState.url;
        if (
          !runtime.documentRuntime.history.current &&
          routeUrl !== documentUrl
        ) {
          bootstrap = runtime.documentRuntime.bootstrapInitialState(
            routeState,
            () => runtime.navigation.readRouteState(),
          );
          const report = await bootstrap.result;
          if (!active) return;
          if (report.status !== "committed") {
            throw new StateError("Demo Router cold-start restoration was canceled");
          }
          documentUrl = runtime.session.tree.document.url;
          if (!documentUrl) {
            throw new StateError("The Expo Turbo demo has no active document URL");
          }
        }
        if (!active) return;
        if (!runtime.documentRuntime.history.current) {
          runtime.documentRuntime.history.initialize(
            runtime.navigation.readInitialState(documentUrl),
          );
        }
        const targetId = incomingAnchor ?? initialAnchor.current;
        if (targetId && !initialAnchorRequested.current) {
          initialAnchorRequested.current = true;
          runtime.documentAnchorScroll.requestDeferredAnchor(targetId);
        }
        initialized = true;
        runtime.navigation.clearError();
        if (active) gate.ready(routeKey);
      } catch (error) {
        if (!active) return;
        runtime.navigation.reportError(
          error instanceof Error
            ? error
            : new StateError("Demo Router history initialization failed"),
        );
      }
    };
    void initialize();

    return () => {
      active = false;
      bootstrap?.cancel();
      initialAnchor.current = undefined;
      initialAnchorRequested.current = false;
      handledIncomingLink.current = undefined;
      runtime.documentAnchorScroll.cancelDeferredAnchor();
      unsubscribeErrors();
      detach?.();
    };
  }, [gate, initialUrl, navigation, routeKey, runtime]);

  useEffect(() => {
    if (
      owner.status !== "ready" ||
      !incomingLink ||
      !Number.isSafeInteger(incomingLink.sequence) ||
      incomingLink.sequence < 1 ||
      handledIncomingLink.current === incomingLink.sequence
    ) {
      return;
    }
    handledIncomingLink.current = incomingLink.sequence;
    try {
      const targetId =
        runtime.navigation.handleExpoGoLinkEvent(incomingLink.url) ??
        runtime.navigation.readExpoGoAnchor(incomingLink.url);
      if (targetId) runtime.documentAnchorScroll.requestDeferredAnchor(targetId);
    } catch (error) {
      runtime.navigation.reportError(
        error instanceof Error ? error : new StateError("Demo Router link handling failed"),
      );
    }
  }, [incomingLink, owner.status, runtime.documentAnchorScroll, runtime.navigation]);

  if (owner.routeKey !== routeKey || owner.status === "pending") return null;
  if (owner.status === "error") {
    return (
      <Text selectable style={{ color: "#a62525", padding: 24 }}>
        {owner.error?.name}: {owner.error?.message}
      </Text>
    );
  }
  return (
    <DemoRouterRouteReadyContext.Provider value={markRootReady}>
      {children}
    </DemoRouterRouteReadyContext.Provider>
  );
}

/** Owns the one focused Router attachment and logical document root. */
export function DemoRouterRouteOwner({
  children,
  focused,
  incomingLink,
  initialUrl,
  navigation,
  routeKey,
  runtime,
}: DemoRouterRouteOwnerProps) {
  if (!focused) return null;
  return (
    <ActiveDemoRouterRouteOwner
      key={routeKey}
      incomingLink={incomingLink}
      initialUrl={initialUrl}
      navigation={navigation}
      routeKey={routeKey}
      runtime={runtime}
    >
      {children}
    </ActiveDemoRouterRouteOwner>
  );
}
