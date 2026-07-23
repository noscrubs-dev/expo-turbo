import {
  ActionCableV1WebSocketAdapter,
  LifecycleCableAdapter,
  resolveActionCableEndpoint,
  type ActionCableWebSocket,
  type ActionCableWebSocketAdapterOptions,
  type ActionCableWebSocketEventType,
  type ClockAdapter,
  type DisposableCableAdapter,
  type LifecycleAdapter,
  type LifecycleState,
  type NetworkReachabilityAdapter,
  type NetworkReachabilityState,
} from "expo-turbo/adapters";
import {
  CableStreamSourceRegistry,
  DocumentRefreshController,
  DocumentRequestLoader,
  DocumentSession,
  DocumentVisitController,
  EXPO_TURBO_MIME_TYPE,
  ExpoTurboError,
  FormLinkSubmissionController,
  FormSubmissionController,
  FormSubmissionLifecycle,
  type FormSubmissionHandle,
  FrameControllerRegistry,
  FrameReconnectReconciler,
  FrameRequestLoader,
  parseExpoTurboDocument,
  RequestError,
  StateError,
} from "expo-turbo/core";
import { ExpoTurboProvider, ExpoTurboRoot } from "expo-turbo/react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { AppState, Pressable, Text, View } from "react-native";

import { DEMO_REGISTRY } from "./demo-registry";
import { DEMO_STYLE_ADAPTER } from "./demo-style-runtime";
import {
  createDemoLiveFetchAdapter,
  nativeDemoLiveFetch,
  type DemoLiveFetch,
} from "./demo-live-transport";

export type {
  DemoLiveFetch as DemoLiveCableFetch,
  DemoLiveFetchRequest as DemoLiveCableFetchRequest,
  DemoLiveFetchResponse as DemoLiveCableFetchResponse,
} from "./demo-live-transport";

const BROADCAST_PATH = "/api/expo_turbo/demo/broadcast";
const DOCUMENT_PATH = "/api/expo_turbo/demo/document";
const PROTECTED_BROADCAST_PATH = "/api/expo_turbo/demo/protected_broadcast";
const PROTECTED_DOCUMENT_PATH = "/api/expo_turbo/demo/protected_document";
const PROTECTED_REVOCATION_PATH = "/api/expo_turbo/demo/protected_revocation";
const PROTECTED_TICKET_PATH = "/api/expo_turbo/demo/protected_ticket";
const CABLE_PATH = "/cable";
const NATIVE_CABLE_TICKET_HEADER = "X-Expo-Turbo-Demo-Ticket";
const LOADING_DOCUMENT = `<Gallery id="demo-live-loading"><DemoText id="demo-live-loading-message">Loading the standalone Rails demo</DemoText></Gallery>`;
const liveRuntimeOwners = new WeakMap<DemoLiveCableRuntime, number>();
const nativeClock: ClockAdapter = {
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: Date.now,
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
};
const DEMO_CABLE_RETRY_POLICY = Object.freeze({
  initialDelayMs: 1_000,
  maxAttempts: 5,
  maxDelayMs: 30_000,
  multiplier: 2,
});

export interface DemoLiveCableRuntimeOptions {
  readonly clock?: ClockAdapter;
  readonly createSocket?: ActionCableWebSocketAdapterOptions["createSocket"];
  readonly fetch?: DemoLiveFetch;
  readonly lifecycle?: LifecycleAdapter;
  readonly network?: NetworkReachabilityAdapter;
  readonly origin: string;
}

export type NativeActionCableSocketFactory = (
  url: string,
  protocols: readonly ["actioncable-v1-json"],
  headers?: Readonly<Record<string, string>>,
) => ActionCableWebSocket;

export interface DemoLiveProtectedCableRuntimeOptions {
  readonly clock?: ClockAdapter;
  readonly createSocket?: NativeActionCableSocketFactory;
  readonly fetch?: DemoLiveFetch;
  readonly lifecycle?: LifecycleAdapter;
  readonly network?: NetworkReachabilityAdapter;
  readonly origin: string;
}

export interface DemoLiveCableEndpoints {
  readonly broadcastUrl: string;
  readonly cableUrl: string;
  readonly documentUrl: string;
}

export interface DemoLiveCableRuntime {
  broadcast(): Promise<void>;
  broadcastRefresh(): Promise<void>;
  clearError(): void;
  readonly cableUrl: string;
  readonly documentController: DocumentVisitController;
  readonly documentUrl: string;
  readonly formLinks: FormLinkSubmissionController;
  readonly frames: FrameControllerRegistry;
  readonly session: DocumentSession;
  readonly streamSources: CableStreamSourceRegistry;
  revokeCableCredentials(): Promise<void>;
  rotateCableCredentials(): void;
  subscribeErrors(listener: (error: Error | undefined) => void): () => void;
  dispose(): void;
}

export type DemoLiveCableLifecycleState = LifecycleState;
export type DemoLiveCableLifecycle = LifecycleAdapter;

export interface DemoLiveCablePanelOptions {
  readonly description?: string;
  readonly revokeCredentialsButtonLabel?: string | false;
  readonly rotateCredentialsButtonLabel?: string | false;
  readonly refreshButtonLabel?: string | false;
  readonly replaceButtonLabel?: string;
  readonly sourceKey?: string;
  readonly title?: string;
}

export interface DemoLiveCableProofProps {
  readonly createRuntime?: () => Promise<DemoLiveCableRuntime>;
  readonly lifecycle?: DemoLiveCableLifecycle;
  readonly origin: string;
  readonly panelOptions?: DemoLiveCablePanelOptions;
}

function asDisplayError(error: unknown): Error {
  return error instanceof ExpoTurboError
    ? error
    : new StateError("The standalone Rails demo is unavailable");
}

type NativeSocketListener = (event: Readonly<{ readonly data?: unknown }>) => void;

type BufferedNativeSocketEvent = Readonly<{
  readonly event: Readonly<{ readonly data?: unknown }>;
  readonly type: ActionCableWebSocketEventType;
}>;

const actionCableSocketEventTypes = ["open", "close", "error", "message"] as const;

export function createNativeActionCableSocket(
  url: string,
  protocols: readonly ["actioncable-v1-json"],
  headers?: Readonly<Record<string, string>>,
): ActionCableWebSocket {
  const NativeWebSocket = globalThis.WebSocket as unknown as
    | (new (
        url: string,
        protocols: readonly string[],
        options?: Readonly<{ headers: Readonly<Record<string, string>> }>,
      ) => ActionCableWebSocket)
    | undefined;
  if (typeof NativeWebSocket !== "function") {
    throw new StateError("The native WebSocket API is unavailable");
  }
  const socket = headers
    ? new NativeWebSocket(url, [...protocols], { headers })
    : new NativeWebSocket(url, [...protocols]);
  const listeners = new Map<ActionCableWebSocketEventType, Set<NativeSocketListener>>(
    actionCableSocketEventTypes.map((type) => [type, new Set()]),
  );
  const pending: BufferedNativeSocketEvent[] = [];
  let messageFlushScheduled = false;

  const flush = (allowMessages = false) => {
    while (pending[0]) {
      const next = pending[0];
      if (!next) return;
      const callbacks = listeners.get(next.type);
      if (!callbacks || callbacks.size === 0) return;
      if (next.type === "message" && !allowMessages) {
        if (!messageFlushScheduled) {
          messageFlushScheduled = true;
          setTimeout(() => {
            messageFlushScheduled = false;
            flush(true);
          }, 0);
        }
        return;
      }
      pending.shift();
      for (const callback of callbacks) callback(next.event);
    }
  };

  const receive = (
    type: ActionCableWebSocketEventType,
    event: Readonly<{ readonly data?: unknown }>,
  ) => {
    pending.push({
      event: type === "message" ? { data: event.data } : {},
      type,
    });
    flush();
  };

  for (const type of actionCableSocketEventTypes)
    socket.addEventListener(type, (event) => receive(type, event));

  return Object.freeze({
    addEventListener(type: ActionCableWebSocketEventType, listener: NativeSocketListener) {
      listeners.get(type)?.add(listener);
      flush();
    },
    close() {
      socket.close();
    },
    get protocol() {
      return socket.protocol;
    },
    removeEventListener(type: ActionCableWebSocketEventType, listener: NativeSocketListener) {
      listeners.get(type)?.delete(listener);
    },
    send(data: string) {
      socket.send(data);
    },
  });
}

function asDemoLiveCableLifecycleState(
  state: string | null | undefined,
): DemoLiveCableLifecycleState {
  if (state === "active" || state === "background") return state;
  return "inactive";
}

const nativeDemoLiveCableLifecycle: DemoLiveCableLifecycle = Object.freeze({
  getState: () => asDemoLiveCableLifecycleState(AppState.currentState),
  subscribe(listener: (state: DemoLiveCableLifecycleState) => void) {
    const subscription = AppState.addEventListener("change", (state) => {
      listener(asDemoLiveCableLifecycleState(state));
    });
    return () => {
      subscription.remove();
    };
  },
});

type ExpoNetworkState = Readonly<{
  readonly isConnected?: boolean;
  readonly isInternetReachable?: boolean;
}>;

type ExpoNetworkModule = Readonly<{
  addNetworkStateListener(listener: (state: ExpoNetworkState) => void): Readonly<{ remove(): void }>;
  getNetworkStateAsync(): Promise<ExpoNetworkState>;
}>;

function asDemoLiveNetworkState(state: ExpoNetworkState): NetworkReachabilityState {
  return state.isConnected === false || state.isInternetReachable === false ? "offline" : "online";
}

export async function createNativeDemoLiveCableNetwork(): Promise<NetworkReachabilityAdapter> {
  const network = (await import("expo-network")) as ExpoNetworkModule;
  let state: NetworkReachabilityState;
  try {
    state = asDemoLiveNetworkState(await network.getNetworkStateAsync());
  } catch {
    throw new StateError("The native network state is unavailable");
  }
  return Object.freeze({
    getState: () => state,
    subscribe(listener: (nextState: NetworkReachabilityState) => void) {
      const subscription = network.addNetworkStateListener((event) => {
        const nextState = asDemoLiveNetworkState(event);
        if (nextState === state) return;
        state = nextState;
        listener(nextState);
      });
      return () => {
        subscription.remove();
      };
    },
  });
}

export function resolveDemoLiveCableEndpoints(origin: string): DemoLiveCableEndpoints {
  return resolveDemoLiveCableEndpointsFor(origin, {
    broadcastPath: BROADCAST_PATH,
    documentPath: DOCUMENT_PATH,
  });
}

interface DemoLiveCablePaths {
  readonly broadcastPath: string;
  readonly documentPath: string;
  readonly revocationPath?: string;
}

type DemoLiveCableFactory = (
  context: Readonly<{
    clock: ClockAdapter;
    endpoints: DemoLiveCableEndpoints;
    onError: (error: Error | undefined) => void;
  }>,
) => DisposableCableAdapter | PromiseLike<DisposableCableAdapter>;

function resolveDemoLiveCableEndpointsFor(
  origin: string,
  paths: DemoLiveCablePaths,
): DemoLiveCableEndpoints {
  const cableUrl = resolveActionCableEndpoint(origin, CABLE_PATH);
  const base = new URL(origin).origin;
  return Object.freeze({
    broadcastUrl: new URL(paths.broadcastPath, base).toString(),
    cableUrl,
    documentUrl: new URL(paths.documentPath, base).toString(),
  });
}

export async function createDemoLiveCableRuntime(
  options: DemoLiveCableRuntimeOptions,
): Promise<DemoLiveCableRuntime> {
  return createDemoLiveCableRuntimeFor(options, {
    broadcastPath: BROADCAST_PATH,
    documentPath: DOCUMENT_PATH,
  });
}

async function createDemoLiveCableRuntimeFor(
  options: DemoLiveCableRuntimeOptions,
  paths: DemoLiveCablePaths,
  createCable?: DemoLiveCableFactory,
): Promise<DemoLiveCableRuntime> {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new StateError("Standalone Rails demo options are invalid");
  }
  const endpoints = resolveDemoLiveCableEndpointsFor(options.origin, paths);
  const revocationUrl = paths.revocationPath
    ? new URL(paths.revocationPath, new URL(options.origin).origin).toString()
    : undefined;
  const fetch = options.fetch ?? nativeDemoLiveFetch;
  if (typeof fetch !== "function") {
    throw new StateError("Standalone Rails demo fetch is invalid");
  }
  const clock = options.clock ?? nativeClock;
  const documentFetch = createDemoLiveFetchAdapter(fetch);
  const session = new DocumentSession(
    parseExpoTurboDocument(LOADING_DOCUMENT, { url: endpoints.documentUrl }),
  );
  let documentRequestId = 0;
  const loader = new DocumentRequestLoader(session, documentFetch, {
    next: () => `demo-live-document-${++documentRequestId}`,
  });
  const result = await loader.load(endpoints.documentUrl);
  if (result.status !== "committed") {
    throw new RequestError("The standalone Rails document did not commit");
  }
  let error: Error | undefined;
  const errorListeners = new Set<(error: Error | undefined) => void>();
  const reportError = (nextError: Error | undefined): void => {
    error = nextError;
    for (const listener of [...errorListeners]) listener(error);
  };
  const visits = new DocumentVisitController(loader, clock);
  const refresh = new DocumentRefreshController(session, visits, clock, {
    onError: reportError,
  });
  let frameRequestId = 0;
  const frames = new FrameControllerRegistry(
    session,
    new FrameRequestLoader(session, documentFetch, {
      next: () => `demo-live-frame-${++frameRequestId}`,
    }),
  );
  const formSubmissionLifecycle = new FormSubmissionLifecycle();
  const activeFormSubmissions = new Set<FormSubmissionHandle>();
  const unsubscribeFormSubmissionStart = formSubmissionLifecycle.subscribe("submit-start", (event) => {
    activeFormSubmissions.add(event.detail.formSubmission);
  });
  const unsubscribeFormSubmissionEnd = formSubmissionLifecycle.subscribe("submit-end", (event) => {
    activeFormSubmissions.delete(event.detail.formSubmission);
  });
  const formController = new FormSubmissionController(session, documentFetch, {
    frameControllers: frames,
    onActionError: (report) => {
      if (report.error) reportError(report.error);
    },
    refresh,
    submissionLifecycle: formSubmissionLifecycle,
  });
  let formLinkRequestId = 0;
  const formLinks = new FormLinkSubmissionController(session, formController, {
    next: () => `demo-live-http-stream-${++formLinkRequestId}`,
  });
  let sources: CableStreamSourceRegistry | undefined;
  const sourceConnections = Object.freeze({
    get connectionSnapshot() {
      if (!sources) throw new StateError("Standalone Rails Cable sources are unavailable");
      return sources.connectionSnapshot;
    },
    subscribeConnection(listener: () => void): () => void {
      if (!sources) throw new StateError("Standalone Rails Cable sources are unavailable");
      return sources.subscribeConnection(listener);
    },
  });
  const reconnectRefresh = new FrameReconnectReconciler(
    session,
    sourceConnections,
    frames,
    refresh,
    visits,
    { onError: reportError },
  );
  const cable = new LifecycleCableAdapter({
    clock,
    createCable: createCable
      ? () => createCable({ clock, endpoints, onError: reportError })
      : () =>
          new ActionCableV1WebSocketAdapter({
            clock,
            createSocket: options.createSocket ?? createNativeActionCableSocket,
            heartbeat: { now: () => clock.now() },
            onError: reportError,
            url: endpoints.cableUrl,
          }),
    lifecycle: options.lifecycle ?? nativeDemoLiveCableLifecycle,
    network: options.network,
    onError: reportError,
    retry: DEMO_CABLE_RETRY_POLICY,
  });
  const streamSources = new CableStreamSourceRegistry(session, cable, {
    onError: reportError,
    onMessage: (report) => {
      const failed = report.actions.find((action) => action.status === "error");
      if (failed?.error) reportError(failed.error);
    },
    reconnectRefresh,
    streamOptions: { refresh },
  });
  sources = streamSources;
  let disposed = false;

  const broadcast = async (kind: "refresh" | "replace"): Promise<void> => {
    const broadcastUrl = new URL(endpoints.broadcastUrl);
    if (kind === "refresh") broadcastUrl.searchParams.set("kind", kind);
    const response = await fetch(broadcastUrl.toString(), {
      headers: { Accept: EXPO_TURBO_MIME_TYPE },
      method: "POST",
    });
    if (response.status !== 204) {
      throw new RequestError("The standalone Rails broadcast request failed", {
        responseStatus: response.status,
      });
    }
  };

  const revokeCableCredentials = async (): Promise<void> => {
    if (!revocationUrl) throw new StateError("Standalone Rails credential revocation is unavailable");
    const response = await fetch(revocationUrl, {
      headers: { Accept: EXPO_TURBO_MIME_TYPE },
      method: "POST",
    });
    if (response.status !== 204) {
      throw new RequestError("The standalone Rails credential revocation request failed", {
        responseStatus: response.status,
      });
    }
  };

  return Object.freeze({
    broadcast: () => broadcast("replace"),
    broadcastRefresh: () => broadcast("refresh"),
    cableUrl: endpoints.cableUrl,
    clearError(): void {
      reportError(undefined);
    },
    documentController: visits,
    documentUrl: endpoints.documentUrl,
    formLinks,
    frames,
    revokeCableCredentials,
    rotateCableCredentials(): void {
      cable.rotateCredentials();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const submission of activeFormSubmissions) submission.stop();
      activeFormSubmissions.clear();
      unsubscribeFormSubmissionStart();
      unsubscribeFormSubmissionEnd();
      reconnectRefresh.dispose();
      streamSources.dispose();
      frames.dispose();
      refresh.dispose();
      visits.cancel();
      cable.dispose();
      errorListeners.clear();
      error = undefined;
    },
    session,
    streamSources,
    subscribeErrors(listener: (nextError: Error | undefined) => void): () => void {
      if (typeof listener !== "function") {
        throw new StateError("Standalone Rails demo error listener is invalid");
      }
      errorListeners.add(listener);
      listener(error);
      return () => {
        errorListeners.delete(listener);
      };
    },
  });
}

export async function createDemoLiveProtectedCableRuntime(
  options: DemoLiveProtectedCableRuntimeOptions,
): Promise<DemoLiveCableRuntime> {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new StateError("Standalone Rails protected Cable demo options are invalid");
  }
  const fetch = options.fetch ?? nativeDemoLiveFetch;
  if (typeof fetch !== "function") {
    throw new StateError("Standalone Rails protected Cable demo fetch is invalid");
  }
  const endpoints = resolveDemoLiveCableEndpointsFor(options.origin, {
    broadcastPath: PROTECTED_BROADCAST_PATH,
    documentPath: PROTECTED_DOCUMENT_PATH,
  });
  const createSocket = options.createSocket ?? createNativeActionCableSocket;
  const createProtectedCable: DemoLiveCableFactory = async ({ clock, onError }) => {
    const response = await fetch(new URL(PROTECTED_TICKET_PATH, endpoints.documentUrl).toString(), {
      headers: { Accept: "text/plain" },
      method: "GET",
    });
    if (response.status !== 200) {
      throw new RequestError("The standalone Rails protected Cable ticket request failed", {
        responseStatus: response.status,
      });
    }
    let ticket: string;
    try {
      ticket = await response.text();
    } catch {
      throw new RequestError("The standalone Rails protected Cable ticket response failed");
    }
    if (ticket === "" || ticket.trim() !== ticket) {
      throw new RequestError("The standalone Rails protected Cable ticket is invalid");
    }
    const headers = Object.freeze({ [NATIVE_CABLE_TICKET_HEADER]: ticket });
    return new ActionCableV1WebSocketAdapter({
      clock,
      createSocket: (url, protocols) => createSocket(url, protocols, headers),
      heartbeat: { now: () => clock.now() },
      onError,
      url: endpoints.cableUrl,
    });
  };

  return createDemoLiveCableRuntimeFor(
    {
      clock: options.clock,
      fetch,
      lifecycle: options.lifecycle,
      network: options.network,
      origin: options.origin,
    },
    {
      broadcastPath: PROTECTED_BROADCAST_PATH,
      documentPath: PROTECTED_DOCUMENT_PATH,
      revocationPath: PROTECTED_REVOCATION_PATH,
    },
    createProtectedCable,
  );
}

function useDemoLiveCableRuntimeOwner(proof: DemoLiveCableRuntime, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    liveRuntimeOwners.set(proof, (liveRuntimeOwners.get(proof) ?? 0) + 1);
    return () => {
      const owners = Math.max(0, (liveRuntimeOwners.get(proof) ?? 0) - 1);
      liveRuntimeOwners.set(proof, owners);
      queueMicrotask(() => {
        if (liveRuntimeOwners.get(proof) !== 0) return;
        liveRuntimeOwners.delete(proof);
        proof.dispose();
      });
    };
  }, [enabled, proof]);
}

export function DemoLiveCableRuntimeProvider({
  children,
  ownsRuntime = true,
  proof,
}: Readonly<{ children?: ReactNode; ownsRuntime?: boolean; proof: DemoLiveCableRuntime }>) {
  useDemoLiveCableRuntimeOwner(proof, ownsRuntime);
  return (
    <ExpoTurboProvider
      documentController={proof.documentController}
      formLinks={proof.formLinks}
      registry={DEMO_REGISTRY}
      renderError={({ error }) => (
        <Text selectable style={{ color: "#a62525" }}>
          {error.name}: {error.message}
        </Text>
      )}
      frames={proof.frames}
      session={proof.session}
      streamSources={proof.streamSources}
      styles={DEMO_STYLE_ADAPTER}
    >
      {children}
    </ExpoTurboProvider>
  );
}

const DEMO_STREAM_SOURCE_KEY = "id:demo-stream-source";
const DEMO_PROTECTED_STREAM_SOURCE_KEY = "id:demo-protected-stream-source";
const protectedCablePanelOptions = Object.freeze({
  description:
    "This native-only panel fetches a fresh short-lived standalone Rails ticket with no-store caching for each credential-bearing transport generation, then sends it only as the X-Expo-Turbo-Demo-Ticket native WebSocket header. The Action Cable URL has no credential query, and Rails must resolve that header-derived subject before it authorizes this exact protected grant and opaque stream token. One local-only control rotates the client generation; another invalidates prior ticket generations and remotely disconnects the demo subject before bounded fresh admission. It shares the example's injected AppState, Expo Network, heartbeat, and finite backoff policy, but is not a production identity, tenant, Android-interaction, or physical-device policy.",
  refreshButtonLabel: false,
  replaceButtonLabel: "Broadcast protected XML replace",
  revokeCredentialsButtonLabel: "Revoke protected Cable ticket",
  rotateCredentialsButtonLabel: "Rotate protected Cable ticket",
  sourceKey: DEMO_PROTECTED_STREAM_SOURCE_KEY,
  title: "Header-ticket Action Cable proof",
} satisfies DemoLiveCablePanelOptions);

export function DemoLiveCablePanel({
  description =
    "This native-only panel loads the sibling Rails XML document and its eager public Cable Frame. Its Rails-authored GET link applies one sibling HTTP Stream response; fixed local controls broadcast either a replace or ordinary refresh Stream. Refresh debounces a canonical document GET, while any re-confirmed lifecycle or network transport reloads only that active Frame. This example host injects AppState, Expo Network, a bounded stale monitor, and five finite exponential retry attempts; it has no user document navigation, server-owned Frame form, production auth, or unbounded client retry.",
  proof,
  ownsRuntime = true,
  revokeCredentialsButtonLabel = false,
  rotateCredentialsButtonLabel = false,
  refreshButtonLabel = "Refresh canonical document",
  replaceButtonLabel = "Broadcast XML replace",
  sourceKey = DEMO_STREAM_SOURCE_KEY,
  title = "Anonymous Action Cable proof",
}: Readonly<{ ownsRuntime?: boolean; proof: DemoLiveCableRuntime }> & DemoLiveCablePanelOptions) {
  const [broadcasting, setBroadcasting] = useState<"refresh" | "replace" | "revoke" | undefined>();
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<Error | undefined>();
  const [recovered, setRecovered] = useState(false);
  const connectionState = useRef({ connected: false, everConnected: false });
  const sendBroadcast = (kind: "refresh" | "replace") => {
    if (broadcasting || !connected) return;
    setBroadcasting(kind);
    proof.clearError();
    setError(undefined);
    void (kind === "refresh" ? proof.broadcastRefresh() : proof.broadcast())
      .catch((nextError) => setError(asDisplayError(nextError)))
      .finally(() => setBroadcasting(undefined));
  };

  useEffect(() => {
    const updateConnection = () => {
      const nextConnected = proof.streamSources.connectionSnapshot.sources.some(
          (source) =>
            source.nodeKey === sourceKey && source.state === "connected",
      );
      if (
        nextConnected &&
        !connectionState.current.connected &&
        connectionState.current.everConnected
      ) {
        setRecovered(true);
      }
      connectionState.current = {
        connected: nextConnected,
        everConnected: connectionState.current.everConnected || nextConnected,
      };
      setConnected(nextConnected);
    };
    updateConnection();
    return proof.streamSources.subscribeConnection(updateConnection);
  }, [proof, sourceKey]);

  useEffect(
    () =>
      proof.subscribeErrors((nextError) => {
        setError(nextError);
      }),
    [proof],
  );

  return (
    <DemoLiveCableRuntimeProvider ownsRuntime={ownsRuntime} proof={proof}>
      <View style={{ borderColor: "#6d7f93", borderRadius: 12, borderWidth: 1, gap: 12, padding: 16 }}>
        <Text selectable style={{ fontSize: 18, fontWeight: "600" }}>
          {title}
        </Text>
        <Text selectable style={{ color: "#435160", lineHeight: 20 }}>
          {description}
        </Text>
        <ExpoTurboRoot />
        {recovered ? (
          <Text accessibilityLabel="Action Cable recovered and reconciled" selectable>
            Action Cable recovered and reconciled.
          </Text>
        ) : null}
        <Pressable
          accessibilityLabel={replaceButtonLabel}
          accessibilityRole="button"
          disabled={broadcasting !== undefined || !connected}
          onPress={() => sendBroadcast("replace")}
          style={({ pressed }) => ({
            alignItems: "center",
            backgroundColor: pressed || broadcasting === "replace" ? "#33556f" : "#285589",
            borderRadius: 12,
            opacity: broadcasting !== undefined ? 0.65 : 1,
            padding: 14,
          })}
        >
          <Text style={{ color: "white", fontSize: 15, fontWeight: "600" }}>
            {broadcasting === "replace"
              ? "Broadcasting…"
              : connected
                ? replaceButtonLabel
                : "Waiting for Action Cable…"}
          </Text>
        </Pressable>
        {refreshButtonLabel ? (
          <Pressable
            accessibilityLabel={refreshButtonLabel}
            accessibilityRole="button"
            disabled={broadcasting !== undefined || !connected}
            onPress={() => sendBroadcast("refresh")}
            style={({ pressed }) => ({
              alignItems: "center",
              backgroundColor: pressed || broadcasting === "refresh" ? "#254a36" : "#34704d",
              borderRadius: 12,
              opacity: broadcasting !== undefined ? 0.65 : 1,
              padding: 14,
            })}
          >
            <Text style={{ color: "white", fontSize: 15, fontWeight: "600" }}>
              {broadcasting === "refresh"
                ? "Refreshing…"
                : connected
                  ? refreshButtonLabel
                  : "Waiting for Action Cable…"}
            </Text>
          </Pressable>
        ) : null}
        {rotateCredentialsButtonLabel ? (
          <Pressable
            accessibilityLabel={rotateCredentialsButtonLabel}
            accessibilityRole="button"
            disabled={broadcasting !== undefined || !connected}
            onPress={() => {
              setRecovered(false);
              proof.clearError();
              setError(undefined);
              proof.rotateCableCredentials();
            }}
            style={({ pressed }) => ({
              alignItems: "center",
              backgroundColor: pressed ? "#5b4522" : "#765a2c",
              borderRadius: 12,
              opacity: broadcasting !== undefined || !connected ? 0.65 : 1,
              padding: 14,
            })}
          >
            <Text style={{ color: "white", fontSize: 15, fontWeight: "600" }}>
              {rotateCredentialsButtonLabel}
            </Text>
          </Pressable>
        ) : null}
        {revokeCredentialsButtonLabel ? (
          <Pressable
            accessibilityLabel={revokeCredentialsButtonLabel}
            accessibilityRole="button"
            disabled={broadcasting !== undefined || !connected}
            onPress={() => {
              if (broadcasting || !connected) return;
              setRecovered(false);
              setBroadcasting("revoke");
              proof.clearError();
              setError(undefined);
              void proof
                .revokeCableCredentials()
                .catch((nextError) => setError(asDisplayError(nextError)))
                .finally(() => setBroadcasting(undefined));
            }}
            style={({ pressed }) => ({
              alignItems: "center",
              backgroundColor: pressed || broadcasting === "revoke" ? "#74352f" : "#933f36",
              borderRadius: 12,
              opacity: broadcasting !== undefined || !connected ? 0.65 : 1,
              padding: 14,
            })}
          >
            <Text style={{ color: "white", fontSize: 15, fontWeight: "600" }}>
              {broadcasting === "revoke" ? "Revoking…" : revokeCredentialsButtonLabel}
            </Text>
          </Pressable>
        ) : null}
        {error ? (
          <Text selectable style={{ color: "#a62525" }}>
            {error.name}: {error.message}
          </Text>
        ) : null}
      </View>
    </DemoLiveCableRuntimeProvider>
  );
}

export function DemoLiveCableProof({
  createRuntime,
  lifecycle = nativeDemoLiveCableLifecycle,
  origin,
  panelOptions,
}: DemoLiveCableProofProps) {
  const startRuntime = useCallback(
    async () => {
      if (createRuntime) return createRuntime();
      const network = await createNativeDemoLiveCableNetwork();
      return createDemoLiveCableRuntime({ lifecycle, network, origin });
    },
    [createRuntime, lifecycle, origin],
  );
  const [backgrounded, setBackgrounded] = useState(() => lifecycle.getState() !== "active");
  const [error, setError] = useState<Error | undefined>();
  const [proof, setProof] = useState<DemoLiveCableRuntime | undefined>();

  useEffect(() => {
    let disposed = false;
    let currentProof: DemoLiveCableRuntime | undefined;
    const unsubscribe = lifecycle.subscribe((state) => {
      setBackgrounded(state !== "active");
    });
    void startRuntime()
      .then((nextProof) => {
        if (disposed) {
          nextProof.dispose();
          return;
        }
        currentProof = nextProof;
        setProof(nextProof);
      })
      .catch((nextError) => {
        if (!disposed) setError(asDisplayError(nextError));
      });

    return () => {
      disposed = true;
      unsubscribe();
      currentProof?.dispose();
      currentProof = undefined;
    };
  }, [lifecycle, startRuntime]);

  const pausedMessage = (
    <Text
      accessibilityLabel="Action Cable paused in background"
      selectable
      style={{ color: "#435160" }}
    >
      Action Cable pauses while the app is in the background.
    </Text>
  );
  if (backgrounded && !proof) {
    return pausedMessage;
  }
  if (proof) {
    return (
      <>
        {backgrounded ? pausedMessage : null}
        <View style={{ display: backgrounded ? "none" : "flex" }}>
          <DemoLiveCablePanel ownsRuntime={false} proof={proof} {...panelOptions} />
        </View>
      </>
    );
  }
  if (error) {
    return (
      <Text selectable style={{ color: "#a62525" }}>
        {error.name}: {error.message}
      </Text>
    );
  }
  return (
    <Text selectable style={{ color: "#435160" }}>
      Loading the standalone Rails Action Cable proof…
    </Text>
  );
}

export function DemoLiveProtectedCableProof({
  createRuntime,
  lifecycle,
  origin,
}: Readonly<Omit<DemoLiveCableProofProps, "panelOptions">>) {
  const startRuntime = useCallback(
    async () => {
      if (createRuntime) return createRuntime();
      const network = await createNativeDemoLiveCableNetwork();
      return createDemoLiveProtectedCableRuntime({ lifecycle, network, origin });
    },
    [createRuntime, lifecycle, origin],
  );

  return (
    <DemoLiveCableProof
      createRuntime={startRuntime}
      lifecycle={lifecycle}
      origin={origin}
      panelOptions={protectedCablePanelOptions}
    />
  );
}
