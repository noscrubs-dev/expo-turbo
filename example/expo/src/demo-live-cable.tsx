import {
  ActionCableV1WebSocketAdapter,
  resolveActionCableEndpoint,
  type ActionCableWebSocket,
  type ActionCableWebSocketAdapterOptions,
} from "expo-turbo/adapters";
import {
  CableStreamSourceRegistry,
  DocumentRequestLoader,
  DocumentSession,
  EXPO_TURBO_MIME_TYPE,
  ExpoTurboError,
  parseExpoTurboDocument,
  RequestError,
  StateError,
} from "expo-turbo/core";
import { ExpoTurboProvider, ExpoTurboRoot } from "expo-turbo/react";
import { type ReactNode, useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";

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

export interface DemoLiveCableRuntimeOptions {
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
  clearError(): void;
  readonly cableUrl: string;
  readonly documentUrl: string;
  readonly session: DocumentSession;
  readonly streamSources: CableStreamSourceRegistry;
  subscribeErrors(listener: (error: Error | undefined) => void): () => void;
  dispose(): void;
}

function asDisplayError(error: unknown): Error {
  return error instanceof ExpoTurboError
    ? error
    : new StateError("The standalone Rails demo is unavailable");
}

function nativeSocket(
  url: string,
  protocols: readonly ["actioncable-v1-json"],
): ActionCableWebSocket {
  const NativeWebSocket = globalThis.WebSocket;
  if (typeof NativeWebSocket !== "function") {
    throw new StateError("The native WebSocket API is unavailable");
  }
  return new NativeWebSocket(url, [...protocols]) as unknown as ActionCableWebSocket;
}

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
  const documentFetch = createDemoLiveFetchAdapter(fetch);
  const session = new DocumentSession(
    parseExpoTurboDocument(LOADING_DOCUMENT, { url: endpoints.documentUrl }),
  );
  const loader = new DocumentRequestLoader(session, documentFetch, {
    next: () => "demo-live-document-1",
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
  const cable = new ActionCableV1WebSocketAdapter({
    createSocket: options.createSocket ?? nativeSocket,
    onError: reportError,
    url: endpoints.cableUrl,
  });
  const streamSources = new CableStreamSourceRegistry(session, cable, {
    onError: reportError,
    onMessage: (report) => {
      const failed = report.actions.find((action) => action.status === "error");
      if (failed?.error) reportError(failed.error);
    },
  });
  let disposed = false;

  return Object.freeze({
    async broadcast(): Promise<void> {
      const response = await fetch(endpoints.broadcastUrl, {
        headers: { Accept: EXPO_TURBO_MIME_TYPE },
        method: "POST",
      });
      if (response.status !== 204) {
        throw new RequestError("The standalone Rails broadcast request failed", {
          responseStatus: response.status,
        });
      }
    },
    cableUrl: endpoints.cableUrl,
    clearError(): void {
      reportError(undefined);
    },
    documentUrl: endpoints.documentUrl,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      streamSources.dispose();
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
      registry={DEMO_REGISTRY}
      renderError={({ error }) => (
        <Text selectable style={{ color: "#a62525" }}>
          {error.name}: {error.message}
        </Text>
      )}
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
  const [broadcasting, setBroadcasting] = useState(false);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<Error | undefined>();

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
          This native-only panel loads the sibling Rails XML document and subscribes to its public demo stream. It is a static Stream subscriber with no document navigation, Forms, Frames, refresh, auth, heartbeat, background policy, or client retry; it only honors an explicit server reconnect instruction.
        </Text>
        <ExpoTurboRoot />
        <Pressable
          accessibilityRole="button"
          disabled={broadcasting || !connected}
          onPress={() => {
            if (broadcasting || !connected) return;
            setBroadcasting(true);
            proof.clearError();
            setError(undefined);
            void proof
              .broadcast()
              .catch((nextError) => setError(asDisplayError(nextError)))
              .finally(() => setBroadcasting(false));
          }}
          style={({ pressed }) => ({
            alignItems: "center",
            backgroundColor: pressed || broadcasting ? "#33556f" : "#285589",
            borderRadius: 12,
            opacity: broadcasting ? 0.65 : 1,
            padding: 14,
          })}
        >
          <Text style={{ color: "white", fontSize: 15, fontWeight: "600" }}>
            {broadcasting
              ? "Broadcasting…"
              : connected
                ? "Broadcast XML Stream"
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

export function DemoLiveCableProof({ origin }: Readonly<{ origin: string }>) {
  const [error, setError] = useState<Error | undefined>();
  const [proof, setProof] = useState<DemoLiveCableRuntime | undefined>();

  useEffect(() => {
    let active = true;
    let handedOff = false;
    let created: DemoLiveCableRuntime | undefined;
    void createDemoLiveCableRuntime({ origin })
      .then((nextProof) => {
        created = nextProof;
        if (!active) {
          nextProof.dispose();
          return;
        }
        handedOff = true;
        setProof(nextProof);
      })
      .catch((nextError) => {
        if (active) setError(asDisplayError(nextError));
      });
    return () => {
      active = false;
      if (!handedOff) created?.dispose();
    };
  }, [origin]);

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
