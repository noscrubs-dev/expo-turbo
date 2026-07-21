/// <reference types="bun" />

import { expect, test } from "bun:test";
import {
  ACTION_CABLE_V1_JSON_PROTOCOL,
  ActionCableV1WebSocketAdapter,
  encodeActionCableSubscribe,
  encodeActionCableUnsubscribe,
  resolveActionCableEndpoint,
  type ActionCableWebSocket,
  type ActionCableWebSocketAdapterOptions,
  type ActionCableWebSocketEventType,
  type ClockAdapter,
  type FetchAdapter,
  type TurboRequest,
  type TurboResponse,
} from "expo-turbo/adapters";
import {
  CableStreamSourceRegistry,
  DocumentRefreshController,
  DocumentRequestLoader,
  DocumentSession,
  DocumentVisitController,
  EXPO_TURBO_MIME_TYPE,
  FrameControllerRegistry,
  FrameRequestLoader,
  nodeTextContent,
  parseExpoTurboDocument,
} from "expo-turbo/core";

const origin = process.env.EXPO_TURBO_DEMO_ORIGIN;
const liveTest = origin ? test : test.skip;
const DOCUMENT_PATH = "/api/expo_turbo/demo/document";
const FRAME_ID = "demo-frame";
const FRAME_PATH = "/api/expo_turbo/demo/frame";
const BROADCAST_PATH = "/api/expo_turbo/demo/broadcast";
const CABLE_PATH = "/cable";
const WAIT_TIMEOUT_MS = 5_000;

async function waitFor(
  label: string,
  predicate: () => boolean,
  errors: readonly Error[],
): Promise<void> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (!predicate()) {
    const error = errors.at(-1);
    if (error) throw error;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await Bun.sleep(20);
  }
}

function createFetchAdapter(requests?: TurboRequest[]): FetchAdapter {
  return Object.freeze({
    async fetch(request: TurboRequest): Promise<TurboResponse> {
      requests?.push(request);
      const response = await globalThis.fetch(request.url, {
        ...(request.body ? { body: request.body.value } : {}),
        headers: request.headers,
        method: request.method,
        ...(request.signal ? { signal: request.signal } : {}),
      } as RequestInit);
      const headers: Record<string, string> = {};
      response.headers.forEach((value, name) => {
        headers[name] = value;
      });
      return Object.freeze({
        headers: Object.freeze(headers),
        redirected: response.redirected,
        status: response.status,
        text: () => response.text(),
        url: response.url,
      });
    },
  });
}

liveTest("delivers a Redis-backed Rails Stream through a real Action Cable WebSocket", async () => {
  if (!origin) throw new Error("EXPO_TURBO_DEMO_ORIGIN is required for the Rails Cable smoke")

  const base = new URL(origin).origin;
  const documentUrl = new URL(DOCUMENT_PATH, base).toString();
  const frameUrl = new URL(FRAME_PATH, base).toString();
  const broadcastUrl = new URL(BROADCAST_PATH, base).toString();
  const cableUrl = resolveActionCableEndpoint(origin, CABLE_PATH);
  const session = new DocumentSession(
    parseExpoTurboDocument('<Gallery id="smoke-loading" />', { url: documentUrl }),
  );
  const documentRequests: TurboRequest[] = [];
  let documentRequestId = 0;
  const loader = new DocumentRequestLoader(session, createFetchAdapter(documentRequests), {
    next: () => `redis-websocket-smoke-document-${++documentRequestId}`,
  });
  const frames = new FrameControllerRegistry(
    session,
    new FrameRequestLoader(session, createFetchAdapter(), {
      next: () => "redis-websocket-smoke-frame",
    }),
  );
  const errors: Error[] = [];
  const clock: ClockAdapter = {
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    now: Date.now,
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  };
  const visits = new DocumentVisitController(loader, clock);
  const refresh = new DocumentRefreshController(session, visits, clock, {
    onError: (error) => errors.push(error),
  });
  const commands: string[] = [];
  const socketCalls: { protocols: readonly string[]; url: string }[] = [];
  let closeCalls = 0;
  let deliveredMessages = 0;
  const createSocket: ActionCableWebSocketAdapterOptions["createSocket"] = (url, protocols) => {
    const NativeWebSocket = globalThis.WebSocket;
    if (typeof NativeWebSocket !== "function") throw new Error("Bun WebSocket is unavailable");
    socketCalls.push({ protocols: [...protocols], url });
    const socket = new NativeWebSocket(url, [...protocols]) as unknown as ActionCableWebSocket;
    return {
      get protocol(): string {
        return socket.protocol;
      },
      addEventListener(
        type: ActionCableWebSocketEventType,
        listener: (event: Readonly<{ readonly data?: unknown }>) => void,
      ): void {
        socket.addEventListener(type, listener);
      },
      close(): void {
        closeCalls += 1;
        socket.close();
      },
      removeEventListener(
        type: ActionCableWebSocketEventType,
        listener: (event: Readonly<{ readonly data?: unknown }>) => void,
      ): void {
        socket.removeEventListener(type, listener);
      },
      send(data: string): void {
        commands.push(data);
        socket.send(data);
      },
    };
  };
  const cable = new ActionCableV1WebSocketAdapter({
    createSocket,
    onError: (error) => errors.push(error),
    url: cableUrl,
  });
  const streamSources = new CableStreamSourceRegistry(session, cable, {
    onError: (error) => errors.push(error),
    onMessage: () => {
      deliveredMessages += 1;
    },
    streamOptions: { refresh },
  });
  let identifier: string | undefined;
  let release: (() => void) | undefined;

  try {
    const document = await loader.load(documentUrl);
    expect(document.status).toBe("committed");

    await expect(frames.get(FRAME_ID).connect()).resolves.toMatchObject({
      frameId: FRAME_ID,
      status: "completed",
      url: frameUrl,
    });

    const source = session.tree.getElementById("demo-stream-source");
    if (!source || source.kind !== "stream-source") throw new Error("Demo stream source is missing");
    const signedStreamName = source.attributes.find((attribute) => attribute.name === "signed-stream-name")?.value;
    if (!signedStreamName) throw new Error("Demo signed stream name is missing");
    identifier = JSON.stringify({
      channel: "Turbo::StreamsChannel",
      signed_stream_name: signedStreamName,
    });

    release = streamSources.retain(source);
    await waitFor("Action Cable confirmation", () =>
      streamSources.connectionSnapshot.sources.some(
        (connection) => connection.nodeKey === source.key && connection.state === "connected",
      ),
      errors,
    );
    expect(commands).toContain(encodeActionCableSubscribe(identifier));

    const response = await globalThis.fetch(broadcastUrl, {
      headers: { Accept: EXPO_TURBO_MIME_TYPE },
      method: "POST",
    });
    expect(response.status).toBe(204);

    await waitFor(
      "Expo XML Stream delivery",
      () => {
        const message = session.tree.getElementById("demo-stream-message");
        return (
          message !== undefined &&
          nodeTextContent(message) === "Broadcast from the standalone Rails demo"
        );
      },
      errors,
    );
    expect(deliveredMessages).toBe(1);
    expect(errors).toEqual([]);

    const refreshResponse = await globalThis.fetch(`${broadcastUrl}?kind=refresh`, {
      headers: { Accept: EXPO_TURBO_MIME_TYPE },
      method: "POST",
    });
    expect(refreshResponse.status).toBe(204);

    await waitFor(
      "canonical document refresh",
      () => documentRequests.filter((request) => request.url === documentUrl).length === 2,
      errors,
    );
    const refreshedDocumentRequest = documentRequests.at(-1);
    expect(refreshedDocumentRequest).toMatchObject({
      headers: { Accept: EXPO_TURBO_MIME_TYPE },
      method: "GET",
      url: documentUrl,
    });
    expect(refreshedDocumentRequest?.headers["Turbo-Frame"]).toBeUndefined();
    expect(refreshedDocumentRequest?.headers["X-Turbo-Request-Id"]).toBe(
      "redis-websocket-smoke-document-2",
    );
    expect(deliveredMessages).toBe(2);
    expect(errors).toEqual([]);
  } finally {
    release?.();
    await Promise.resolve();
    streamSources.dispose();
    refresh.dispose();
    visits.cancel();
    frames.dispose();
    cable.dispose();
  }

  expect(socketCalls).toEqual([
    { protocols: [ACTION_CABLE_V1_JSON_PROTOCOL], url: cableUrl },
  ]);
  if (!identifier) throw new Error("Demo stream identifier is missing");
  expect(commands).toContain(encodeActionCableUnsubscribe(identifier));
  expect(closeCalls).toBe(1);
}, 15_000);
