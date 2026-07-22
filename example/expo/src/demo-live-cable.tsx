import {
  ActionCableV1WebSocketAdapter,
  resolveActionCableEndpoint,
  type ActionCableWebSocket,
  type ActionCableWebSocketAdapterOptions,
  type ActionCableWebSocketEventType,
  type ClockAdapter,
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
import { type ReactNode, useCallback, useEffect, useState } from "react";
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
const CABLE_PATH = "/cable";
const LOADING_DOCUMENT = `<Gallery id="demo-live-loading"><DemoText id="demo-live-loading-message">Loading the standalone Rails demo</DemoText></Gallery>`;
const liveRuntimeOwners = new WeakMap<DemoLiveCableRuntime, number>();
const nativeClock: ClockAdapter = {
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: Date.now,
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
};

export interface DemoLiveCableRuntimeOptions {
  readonly clock?: ClockAdapter;
  readonly createSocket?: ActionCableWebSocketAdapterOptions["createSocket"];
  readonly fetch?: DemoLiveFetch;
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
  subscribeErrors(listener: (error: Error | undefined) => void): () => void;
  dispose(): void;
}

export type DemoLiveCableLifecycleState = "active" | "background" | "inactive";

export interface DemoLiveCableLifecycle {
  currentState(): DemoLiveCableLifecycleState;
  subscribe(listener: (state: DemoLiveCableLifecycleState) => void): () => void;
}

export interface DemoLiveCableProofProps {
  readonly createRuntime?: () => Promise<DemoLiveCableRuntime>;
  readonly lifecycle?: DemoLiveCableLifecycle;
  readonly origin: string;
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
): ActionCableWebSocket {
  const NativeWebSocket = globalThis.WebSocket;
  if (typeof NativeWebSocket !== "function") {
    throw new StateError("The native WebSocket API is unavailable");
  }
  const socket = new NativeWebSocket(url, [...protocols]) as unknown as ActionCableWebSocket;
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
  currentState: () => asDemoLiveCableLifecycleState(AppState.currentState),
  subscribe(listener: (state: DemoLiveCableLifecycleState) => void) {
    const subscription = AppState.addEventListener("change", (state) => {
      listener(asDemoLiveCableLifecycleState(state));
    });
    return () => {
      subscription.remove();
    };
  },
});

export function resolveDemoLiveCableEndpoints(origin: string): DemoLiveCableEndpoints {
  const cableUrl = resolveActionCableEndpoint(origin, CABLE_PATH);
  const base = new URL(origin).origin;
  return Object.freeze({
    broadcastUrl: new URL(BROADCAST_PATH, base).toString(),
    cableUrl,
    documentUrl: new URL(DOCUMENT_PATH, base).toString(),
  });
}

export async function createDemoLiveCableRuntime(
  options: DemoLiveCableRuntimeOptions,
): Promise<DemoLiveCableRuntime> {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new StateError("Standalone Rails demo options are invalid");
  }
  const endpoints = resolveDemoLiveCableEndpoints(options.origin);
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
  const cable = new ActionCableV1WebSocketAdapter({
    createSocket: options.createSocket ?? createNativeActionCableSocket,
    onError: reportError,
    url: endpoints.cableUrl,
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

function useDemoLiveCableRuntimeOwner(proof: DemoLiveCableRuntime): void {
  useEffect(() => {
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
  }, [proof]);
}

export function DemoLiveCableRuntimeProvider({
  children,
  proof,
}: Readonly<{ children?: ReactNode; proof: DemoLiveCableRuntime }>) {
  useDemoLiveCableRuntimeOwner(proof);
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

export function DemoLiveCablePanel({ proof }: Readonly<{ proof: DemoLiveCableRuntime }>) {
  const [broadcasting, setBroadcasting] = useState<"refresh" | "replace" | undefined>();
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<Error | undefined>();
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
      setConnected(
        proof.streamSources.connectionSnapshot.sources.some(
          (source) =>
            source.nodeKey === DEMO_STREAM_SOURCE_KEY && source.state === "connected",
        ),
      );
    };
    updateConnection();
    return proof.streamSources.subscribeConnection(updateConnection);
  }, [proof]);

  useEffect(
    () =>
      proof.subscribeErrors((nextError) => {
        setError(nextError);
      }),
    [proof],
  );

  return (
    <DemoLiveCableRuntimeProvider proof={proof}>
      <View style={{ borderColor: "#6d7f93", borderRadius: 12, borderWidth: 1, gap: 12, padding: 16 }}>
        <Text selectable style={{ fontSize: 18, fontWeight: "600" }}>
          Anonymous Action Cable proof
        </Text>
        <Text selectable style={{ color: "#435160", lineHeight: 20 }}>
          This native-only panel loads the sibling Rails XML document and its eager public Cable Frame. Its Rails-authored GET link applies one sibling HTTP Stream response; fixed local controls broadcast either a replace or ordinary refresh Stream. Refresh debounces a canonical document GET, while an explicit server reconnect still reloads only that active Frame. This example host pauses the panel runtime in AppState background and reboots it on active; it has no user document navigation, server-owned Frame form, auth, heartbeat, network policy, or client retry.
        </Text>
        <ExpoTurboRoot />
        <Pressable
          accessibilityLabel="Broadcast XML replace"
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
                ? "Broadcast XML replace"
                : "Waiting for Action Cable…"}
          </Text>
        </Pressable>
        <Pressable
          accessibilityLabel="Refresh canonical document"
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
                ? "Refresh canonical document"
                : "Waiting for Action Cable…"}
          </Text>
        </Pressable>
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
}: DemoLiveCableProofProps) {
  const startRuntime = useCallback(
    () => createRuntime?.() ?? createDemoLiveCableRuntime({ origin }),
    [createRuntime, origin],
  );
  const [backgrounded, setBackgrounded] = useState(
    () => lifecycle.currentState() === "background",
  );
  const [error, setError] = useState<Error | undefined>();
  const [proof, setProof] = useState<DemoLiveCableRuntime | undefined>();

  useEffect(() => {
    let disposed = false;
    let inBackground = lifecycle.currentState() === "background";
    let currentProof: DemoLiveCableRuntime | undefined;
    let generation = 0;
    let starting = false;

    const release = () => {
      generation += 1;
      starting = false;
      currentProof?.dispose();
      currentProof = undefined;
      if (!disposed) setProof(undefined);
    };
    const start = () => {
      if (disposed || inBackground || starting || currentProof) return;
      const requestGeneration = ++generation;
      starting = true;
      setError(undefined);
      void Promise.resolve()
        .then(() => {
          if (disposed || inBackground || requestGeneration !== generation) return undefined;
          return startRuntime();
        })
        .then((nextProof) => {
          if (!nextProof) return;
          if (disposed || inBackground || requestGeneration !== generation) {
            nextProof.dispose();
            return;
          }
          currentProof = nextProof;
          setProof(nextProof);
        })
        .catch((nextError) => {
          if (!disposed && !inBackground && requestGeneration === generation) {
            setError(asDisplayError(nextError));
          }
        })
        .finally(() => {
          if (requestGeneration === generation) starting = false;
        });
    };
    const unsubscribe = lifecycle.subscribe((state) => {
      if (state === "background") {
        if (inBackground) return;
        inBackground = true;
        setBackgrounded(true);
        setError(undefined);
        release();
        return;
      }
      if (state === "active" && inBackground) {
        inBackground = false;
        setBackgrounded(false);
        start();
      }
    });
    if (!inBackground) start();

    return () => {
      disposed = true;
      unsubscribe();
      release();
    };
  }, [lifecycle, startRuntime]);

  if (backgrounded) {
    return (
      <Text
        accessibilityLabel="Action Cable paused in background"
        selectable
        style={{ color: "#435160" }}
      >
        Action Cable pauses while the app is in the background.
      </Text>
    );
  }
  if (error) {
    return (
      <Text selectable style={{ color: "#a62525" }}>
        {error.name}: {error.message}
      </Text>
    );
  }
  if (!proof) {
    return (
      <Text selectable style={{ color: "#435160" }}>
        Loading the standalone Rails Action Cable proof…
      </Text>
    );
  }
  return <DemoLiveCablePanel proof={proof} />;
}
