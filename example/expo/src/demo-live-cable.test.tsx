/// <reference types="bun" />

import { describe, expect, mock, test } from "bun:test";
import {
  ACTION_CABLE_STALE_THRESHOLD_MS,
  ACTION_CABLE_V1_JSON_PROTOCOL,
  ActionCableV1WebSocketAdapter,
  encodeActionCableSubscribe,
  encodeActionCableUnsubscribe,
  type ActionCableWebSocket,
  type ActionCableWebSocketEventType,
  type ClockAdapter,
  type NetworkReachabilityAdapter,
  type NetworkReachabilityState,
} from "expo-turbo/adapters";
import { EXPO_TURBO_MIME_TYPE, nodeTextContent } from "expo-turbo/core";
import { createElement, StrictMode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import type {
  DemoLiveCableFetchRequest,
  DemoLiveCableFetchResponse,
  DemoLiveCableLifecycle,
  DemoLiveCableLifecycleState,
  DemoLiveCableRuntime,
} from "./demo-live-cable";

mock.module("react-native", () => ({
  AccessibilityInfo: { announceForAccessibility: () => undefined },
  Alert: { alert: () => undefined },
  AppState: {
    addEventListener: () => ({ remove: () => undefined }),
    currentState: "active",
  },
  FlatList: (props: Readonly<Record<string, unknown>>) => createElement("flat-list", props),
  Linking: { openURL: async () => undefined },
  Platform: { OS: "web" },
  Pressable: (props: Readonly<Record<string, unknown>>) => createElement("pressable", props),
  ScrollView: (props: Readonly<Record<string, unknown>>) =>
    createElement("scroll-view", props),
  Text: (props: Readonly<Record<string, unknown>>) => createElement("native-text", props),
  TextInput: (props: Readonly<Record<string, unknown>>) =>
    createElement("text-input", props),
  View: (props: Readonly<Record<string, unknown>>) => createElement("view", props),
}));

const {
  createDemoLiveCableRuntime,
  createDemoLiveProtectedCableRuntime,
  createNativeActionCableSocket,
  DemoLiveCablePanel,
  DemoLiveCableProof,
} = await import("./demo-live-cable");
const TURBO_STREAM_MIME_TYPE = "text/vnd.turbo-stream.html";

const globalWithAct = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean;
};
globalWithAct.IS_REACT_ACT_ENVIRONMENT = true;

type CableSocketListener = (event: Readonly<{ readonly data?: unknown }>) => void;

type RecordedRequest = Readonly<{ request: DemoLiveCableFetchRequest; url: string }>;

function unabortedRequests(requests: readonly RecordedRequest[]): readonly RecordedRequest[] {
  return requests.filter(({ request }) => !request.signal?.aborted);
}

class FakeActionCableSocket implements ActionCableWebSocket {
  closeCalls = 0;
  protocol = ACTION_CABLE_V1_JSON_PROTOCOL;
  readonly sent: string[] = [];
  private readonly listeners: Record<ActionCableWebSocketEventType, Set<CableSocketListener>> = {
    close: new Set(),
    error: new Set(),
    message: new Set(),
    open: new Set(),
  };

  addEventListener(type: ActionCableWebSocketEventType, listener: CableSocketListener): void {
    this.listeners[type].add(listener);
  }

  close(): void {
    this.closeCalls += 1;
  }

  removeEventListener(type: ActionCableWebSocketEventType, listener: CableSocketListener): void {
    this.listeners[type].delete(listener);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  emitOpen(): void {
    this.emit("open");
  }

  emitClose(): void {
    this.emit("close");
  }

  emitMessage(data: unknown): void {
    this.emit("message", { data });
  }

  private emit(
    type: ActionCableWebSocketEventType,
    event: Readonly<{ readonly data?: unknown }> = {},
  ): void {
    for (const listener of this.listeners[type]) listener(event);
  }
}

class FakeDemoLiveCableLifecycle implements DemoLiveCableLifecycle {
  private readonly listeners = new Set<(state: DemoLiveCableLifecycleState) => void>();

  constructor(private state: DemoLiveCableLifecycleState = "active") {}

  getState(): DemoLiveCableLifecycleState {
    return this.state;
  }

  subscribe(listener: (state: DemoLiveCableLifecycleState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(state: DemoLiveCableLifecycleState): void {
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }
}

class FakeDemoLiveCableNetwork implements NetworkReachabilityAdapter {
  private readonly listeners = new Set<(state: NetworkReachabilityState) => void>();

  constructor(private state: NetworkReachabilityState = "online") {}

  getState(): NetworkReachabilityState {
    return this.state;
  }

  get listenerCount(): number {
    return this.listeners.size;
  }

  subscribe(listener: (state: NetworkReachabilityState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(state: NetworkReachabilityState): void {
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }
}

const nextTurn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

interface TimerRecord {
  readonly callback: () => void;
  cleared: boolean;
  readonly delayMs: number;
  readonly handle: object;
}

class ManualClock implements ClockAdapter {
  readonly timers: TimerRecord[] = [];

  clearTimeout(handle: unknown): void {
    const timer = this.timers.find((candidate) => candidate.handle === handle);
    if (timer) timer.cleared = true;
  }

  now(): number {
    return 0;
  }

  setTimeout(callback: () => void, delayMs: number): unknown {
    const handle = Object.freeze({});
    this.timers.push({ callback, cleared: false, delayMs, handle });
    return handle;
  }

  fire(index: number): void {
    const timer = this.timers[index];
    if (!timer) throw new Error(`Missing timer ${index}`);
    if (!timer.cleared) timer.callback();
  }
}

test("buffers an early native welcome until the Action Cable adapter is listening", async () => {
  const originalWebSocket = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
  const sockets: EagerNativeSocket[] = [];

  class EagerNativeSocket {
    protocol = ACTION_CABLE_V1_JSON_PROTOCOL;
    readonly sent: string[] = [];
    private readonly listeners: Record<ActionCableWebSocketEventType, Set<CableSocketListener>> = {
      close: new Set(),
      error: new Set(),
      message: new Set(),
      open: new Set(),
    };

    constructor() {
      sockets.push(this);
    }

    addEventListener(type: ActionCableWebSocketEventType, listener: CableSocketListener): void {
      this.listeners[type].add(listener);
      if (type !== "message" || this.listeners.message.size !== 1) return;
      this.emit("open");
      this.emit("message", { data: '{"type":"welcome"}' });
    }

    close(): void {}

    removeEventListener(type: ActionCableWebSocketEventType, listener: CableSocketListener): void {
      this.listeners[type].delete(listener);
    }

    send(data: string): void {
      this.sent.push(data);
      const identifier = JSON.parse(data).identifier;
      this.emit("message", {
        data: JSON.stringify({ identifier, type: "confirm_subscription" }),
      });
    }

    private emit(
      type: ActionCableWebSocketEventType,
      event: Readonly<{ readonly data?: unknown }> = {},
    ): void {
      for (const listener of this.listeners[type]) listener(event);
    }
  }

  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    value: EagerNativeSocket,
  });

  try {
    const connected: boolean[] = [];
    const identifier = '{"channel":"Turbo::StreamsChannel","signed_stream_name":"demo"}';
    const adapter = new ActionCableV1WebSocketAdapter({
      createSocket: createNativeActionCableSocket,
      onError: (error) => {
        throw error;
      },
      url: "ws://demo.example.test/cable",
    });

    adapter.subscribe(identifier, {
      connected: (reconnected) => connected.push(reconnected),
      disconnected: () => undefined,
      received: () => undefined,
      rejected: () => undefined,
    });
    await nextTurn();

    expect(sockets).toHaveLength(1);
    expect(sockets[0]?.sent).toEqual([encodeActionCableSubscribe(identifier)]);
    expect(connected).toEqual([false]);
  } finally {
    if (originalWebSocket) Object.defineProperty(globalThis, "WebSocket", originalWebSocket);
    else Reflect.deleteProperty(globalThis, "WebSocket");
  }
});

test("passes an explicit protected ticket through native WebSocket headers, not the Cable URL", () => {
  const originalWebSocket = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
  const constructions: Readonly<{
    headers: Readonly<Record<string, string>> | undefined;
    protocols: readonly string[];
    url: string;
  }>[] = [];

  class HeaderNativeSocket {
    protocol = ACTION_CABLE_V1_JSON_PROTOCOL;

    constructor(
      url: string,
      protocols: readonly string[],
      options?: Readonly<{ headers: Readonly<Record<string, string>> }>,
    ) {
      constructions.push({ headers: options?.headers, protocols, url });
    }

    addEventListener(): void {}

    close(): void {}

    removeEventListener(): void {}

    send(): void {}
  }

  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    value: HeaderNativeSocket,
  });

  try {
    const socket = createNativeActionCableSocket(
      "ws://demo.example.test/cable",
      [ACTION_CABLE_V1_JSON_PROTOCOL],
      { "X-Expo-Turbo-Demo-Ticket": "short-lived-ticket" },
    );

    expect(constructions).toEqual([
      {
        headers: { "X-Expo-Turbo-Demo-Ticket": "short-lived-ticket" },
        protocols: [ACTION_CABLE_V1_JSON_PROTOCOL],
        url: "ws://demo.example.test/cable",
      },
    ]);
    socket.close();
  } finally {
    if (originalWebSocket) Object.defineProperty(globalThis, "WebSocket", originalWebSocket);
    else Reflect.deleteProperty(globalThis, "WebSocket");
  }
});

describe("standalone Rails Action Cable proof", () => {
  test("waits for confirmation, applies XML Streams, and releases its socket", async () => {
    const documentUrl = "http://demo.example:3000/api/expo_turbo/demo/document";
    const frameUrl = "http://demo.example:3000/api/expo_turbo/demo/frame";
    const broadcastUrl = "http://demo.example:3000/api/expo_turbo/demo/broadcast";
    const signedStreamName = "signed-demo-stream";
    const identifier = JSON.stringify({
      channel: "Turbo::StreamsChannel",
      signed_stream_name: signedStreamName,
    });
    const initialDocument = `<Gallery id="demo-document"><DemoText id="demo-document-state">Initial canonical document</DemoText><turbo-frame id="demo-frame" src="/api/expo_turbo/demo/frame"><DemoText id="demo-frame-loading">Loading the public Action Cable Frame</DemoText></turbo-frame></Gallery>`;
    const refreshedDocument = `<Gallery id="demo-document"><DemoText id="demo-document-state">Refreshed canonical document</DemoText><turbo-frame id="demo-frame" src="/api/expo_turbo/demo/frame"><DemoText id="demo-frame-loading">Loading the public Action Cable Frame</DemoText></turbo-frame></Gallery>`;
    const frame = `<turbo-frame id="demo-frame"><DemoText id="demo-stream-message">Waiting for a public Action Cable broadcast</DemoText><turbo-cable-stream-source id="demo-stream-source" channel="Turbo::StreamsChannel" signed-stream-name="${signedStreamName}" /></turbo-frame>`;
    const requests: RecordedRequest[] = [];
    const sockets: FakeActionCableSocket[] = [];
    const socketCalls: Readonly<{ protocols: readonly string[]; url: string }>[] = [];
    const clock = new ManualClock();
    let documentRequests = 0;
    const fetch = async (url: string, request: DemoLiveCableFetchRequest) => {
      requests.push({ request, url });
      if (url === documentUrl) {
        documentRequests += 1;
        return {
          headers: {
            forEach(callback: (value: string, name: string) => void): void {
              callback(EXPO_TURBO_MIME_TYPE, "Content-Type");
            },
          },
          redirected: false,
          status: 200,
          text: async () =>
            documentRequests === 1 ? initialDocument : refreshedDocument,
          url,
        };
      }
      if (url === frameUrl) {
        return {
          headers: {
            forEach(callback: (value: string, name: string) => void): void {
              callback(EXPO_TURBO_MIME_TYPE, "Content-Type");
            },
          },
          redirected: false,
          status: 200,
          text: async () => frame,
          url,
        };
      }
      if (url === broadcastUrl || url === `${broadcastUrl}?kind=refresh`) {
        return {
          headers: { forEach: () => undefined },
          redirected: false,
          status: 204,
          text: async () => "",
          url,
        };
      }
      throw new Error("unexpected demo request");
    };
    const proof = await createDemoLiveCableRuntime({
      createSocket(url, protocols) {
        const socket = new FakeActionCableSocket();
        socketCalls.push({ protocols, url });
        sockets.push(socket);
        return socket;
      },
      fetch,
      origin: "http://demo.example:3000",
      clock,
    });
    let renderer: ReactTestRenderer | undefined;
    const errors: (Error | undefined)[] = [];
    const unsubscribeErrors = proof.subscribeErrors((error) => {
      errors.push(error);
    });

    try {
      expect(proof.documentUrl).toBe(documentUrl);
      expect(proof.cableUrl).toBe("ws://demo.example:3000/cable");
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        request: {
          headers: { Accept: EXPO_TURBO_MIME_TYPE },
          method: "GET",
        },
        url: documentUrl,
      });

      await act(async () => {
        renderer = create(
          createElement(
            StrictMode,
            undefined,
            createElement(DemoLiveCablePanel, { proof }),
          ),
        );
        await nextTurn();
        await proof.frames.get("demo-frame").loaded;
      });
      const socket = sockets[0];
      if (!socket) throw new Error("missing Action Cable socket");

      expect(socketCalls).toEqual([
        { protocols: [ACTION_CABLE_V1_JSON_PROTOCOL], url: "ws://demo.example:3000/cable" },
      ]);
      expect(requests).toHaveLength(3);
      expect(requests.filter(({ request }) => request.signal?.aborted)).toHaveLength(1);
      const initialRequests = unabortedRequests(requests);
      expect(initialRequests).toHaveLength(2);
      expect(initialRequests[1]).toMatchObject({
        request: {
          headers: { "Turbo-Frame": "demo-frame", Accept: EXPO_TURBO_MIME_TYPE },
          method: "GET",
        },
        url: frameUrl,
      });
      const replaceButton = () =>
        renderer?.root.findByProps({ accessibilityLabel: "Broadcast XML replace" });
      const refreshButton = () =>
        renderer?.root.findByProps({ accessibilityLabel: "Refresh canonical document" });
      expect(replaceButton()?.props.disabled).toBe(true);
      expect(refreshButton()?.props.disabled).toBe(true);
      replaceButton()?.props.onPress();
      expect(requests).toHaveLength(3);

      await act(async () => {
        socket.emitOpen();
        socket.emitMessage('{"type":"welcome"}');
        await Promise.resolve();
      });
      expect(socket.sent).toEqual([encodeActionCableSubscribe(identifier)]);

      await act(async () => {
        socket.emitMessage(`{"identifier":${JSON.stringify(identifier)},"type":"confirm_subscription"}`);
        socket.emitMessage(
          `{"identifier":${JSON.stringify(identifier)},"message":"<turbo-stream action=\\"replace\\" target=\\"demo-stream-message\\"><template><DemoText id=\\"demo-stream-message\\">Broadcast from the standalone Rails demo</DemoText></template></turbo-stream>"}`,
        );
        await Promise.resolve();
      });

      expect(
        clock.timers.some(
          (timer) => !timer.cleared && timer.delayMs === ACTION_CABLE_STALE_THRESHOLD_MS + 1,
        ),
      ).toBe(true);
      expect(replaceButton()?.props.disabled).toBe(false);
      expect(refreshButton()?.props.disabled).toBe(false);
      const message = proof.session.tree.getElementById("demo-stream-message");
      expect(message ? nodeTextContent(message) : undefined).toBe(
        "Broadcast from the standalone Rails demo",
      );

      await act(async () => {
        refreshButton()?.props.onPress();
        await Promise.resolve();
      });
      const broadcastRequests = unabortedRequests(requests);
      expect(broadcastRequests).toHaveLength(3);
      expect(broadcastRequests[2]).toMatchObject({
        request: { headers: { Accept: EXPO_TURBO_MIME_TYPE }, method: "POST" },
        url: `${broadcastUrl}?kind=refresh`,
      });

      await act(async () => {
        socket.emitMessage(
          `{"identifier":${JSON.stringify(identifier)},"message":"<turbo-stream action=\\"refresh\\"></turbo-stream>"}`,
        );
        await Promise.resolve();
      });
      const refreshTimer = clock.timers.findIndex(
        (timer) => !timer.cleared && timer.delayMs === 150,
      );
      expect(refreshTimer).not.toBe(-1);
      expect(unabortedRequests(requests)).toHaveLength(3);

      await act(async () => {
        clock.fire(refreshTimer);
        await Promise.resolve();
        await nextTurn();
      });
      const refreshedRequests = unabortedRequests(requests);
      const refreshedDocumentRequest = refreshedRequests.findLast(
        (request) => request.url === documentUrl,
      );
      expect(refreshedDocumentRequest).toMatchObject({
        request: { headers: { Accept: EXPO_TURBO_MIME_TYPE }, method: "GET" },
        url: documentUrl,
      });
      expect(refreshedDocumentRequest?.request.headers["Turbo-Frame"]).toBeUndefined();
      expect(refreshedDocumentRequest?.request.headers["X-Turbo-Request-Id"]).toBe(
        "demo-live-document-2",
      );
      const documentState = proof.session.tree.getElementById("demo-document-state");
      expect(documentState ? nodeTextContent(documentState) : undefined).toBe(
        "Refreshed canonical document",
      );
      expect(errors.at(-1)).toBeUndefined();
    } finally {
      await act(async () => {
        renderer?.unmount();
        await Promise.resolve();
      });
      await nextTurn();
      unsubscribeErrors();
    }

    const socket = sockets[0];
    if (!socket) throw new Error("missing Action Cable socket");
    expect(socket.sent).toEqual([
      encodeActionCableSubscribe(identifier),
      encodeActionCableUnsubscribe(identifier),
    ]);
    expect(socket.closeCalls).toBe(1);
  });

  test("fetches a fresh protected Rails header ticket for each socket generation", async () => {
    const tickets = ["short-lived-ticket-1", "short-lived-ticket-2"] as const;
    const ticketUrl = "http://demo.example:3000/api/expo_turbo/demo/protected_ticket";
    const documentUrl = "http://demo.example:3000/api/expo_turbo/demo/protected_document";
    const frameUrl = "http://demo.example:3000/api/expo_turbo/demo/protected_frame";
    const broadcastUrl = "http://demo.example:3000/api/expo_turbo/demo/protected_broadcast";
    const signedStreamName = "protected-signed-stream";
    const identifier = JSON.stringify({
      channel: "ExpoTurbo::Rails::Cable::ProtectedStreamsChannel",
      signed_stream_name: signedStreamName,
      grant: "demo-protected-frame",
    });
    const document = `<Gallery id="demo-protected-document"><turbo-frame id="demo-protected-frame" src="/api/expo_turbo/demo/protected_frame"><DemoText id="demo-protected-frame-loading">Loading the protected Action Cable Frame</DemoText></turbo-frame></Gallery>`;
    const frame = `<turbo-frame id="demo-protected-frame"><DemoText id="demo-protected-stream-message">Waiting for a protected Action Cable broadcast</DemoText><turbo-cable-stream-source id="demo-protected-stream-source" channel="ExpoTurbo::Rails::Cable::ProtectedStreamsChannel" signed-stream-name="${signedStreamName}" data-grant="demo-protected-frame" /></turbo-frame>`;
    const requests: RecordedRequest[] = [];
    const lifecycle = new FakeDemoLiveCableLifecycle();
    const sockets: FakeActionCableSocket[] = [];
    const socketCalls: Readonly<{
      headers: Readonly<Record<string, string>> | undefined;
      protocols: readonly string[];
      url: string;
    }>[] = [];
    let ticketIssue = 0;
    const proof = await createDemoLiveProtectedCableRuntime({
      createSocket(url, protocols, headers) {
        const socket = new FakeActionCableSocket();
        socketCalls.push({ headers, protocols, url });
        sockets.push(socket);
        return socket;
      },
      fetch: async (url, request) => {
        requests.push({ request, url });
        if (url === ticketUrl) {
          const ticket = tickets[ticketIssue++];
          if (!ticket) throw new Error("unexpected protected ticket request");
          return {
            headers: { forEach: () => undefined },
            redirected: false,
            status: 200,
            text: async () => ticket,
            url,
          };
        }
        if (url === documentUrl || url === frameUrl) {
          return {
            headers: {
              forEach(callback: (value: string, name: string) => void): void {
                callback(EXPO_TURBO_MIME_TYPE, "Content-Type");
              },
            },
            redirected: false,
            status: 200,
            text: async () => (url === documentUrl ? document : frame),
            url,
          };
        }
        if (url === broadcastUrl) {
          return {
            headers: { forEach: () => undefined },
            redirected: false,
            status: 204,
            text: async () => "",
            url,
          };
        }
        throw new Error("unexpected protected demo request");
      },
      lifecycle,
      origin: "http://demo.example:3000",
    });
    let renderer: ReactTestRenderer | undefined;

    try {
      expect(requests[0]).toMatchObject({
        request: { headers: { Accept: EXPO_TURBO_MIME_TYPE }, method: "GET" },
        url: documentUrl,
      });
      expect(requests.some((request) => request.url === ticketUrl)).toBe(false);
      await act(async () => {
        renderer = create(
          createElement(DemoLiveCablePanel, {
            proof,
            refreshButtonLabel: false,
            replaceButtonLabel: "Broadcast protected XML replace",
            sourceKey: "id:demo-protected-stream-source",
          }),
        );
        await nextTurn();
        await proof.frames.get("demo-protected-frame").loaded;
      });
      const socket = sockets[0];
      if (!socket) throw new Error("missing protected Action Cable socket");
      expect(requests.filter((request) => request.url === ticketUrl)).toHaveLength(1);
      expect(requests.find((request) => request.url === ticketUrl)).toMatchObject({
        request: { headers: { Accept: "text/plain" }, method: "GET" },
        url: ticketUrl,
      });

      expect(socketCalls).toEqual([
        {
          headers: { "X-Expo-Turbo-Demo-Ticket": tickets[0] },
          protocols: [ACTION_CABLE_V1_JSON_PROTOCOL],
          url: "ws://demo.example:3000/cable",
        },
      ]);
      expect(socketCalls[0]?.url).not.toContain("?");
      expect(requests.every((request) => !tickets.some((ticket) => request.url.includes(ticket)))).toBe(
        true,
      );
      const button = () =>
        renderer?.root.findByProps({ accessibilityLabel: "Broadcast protected XML replace" });
      expect(button()?.props.disabled).toBe(true);

      await act(async () => {
        socket.emitOpen();
        socket.emitMessage('{"type":"welcome"}');
        await Promise.resolve();
      });
      expect(socket.sent).toEqual([encodeActionCableSubscribe(identifier)]);

      await act(async () => {
        socket.emitMessage(`{"identifier":${JSON.stringify(identifier)},"type":"confirm_subscription"}`);
        await Promise.resolve();
      });
      expect(button()?.props.disabled).toBe(false);

      await act(async () => {
        button()?.props.onPress();
        await Promise.resolve();
      });
      const broadcastRequest = unabortedRequests(requests).find(
        (request) => request.url === broadcastUrl,
      );
      expect(broadcastRequest).toMatchObject({
        request: { headers: { Accept: EXPO_TURBO_MIME_TYPE }, method: "POST" },
        url: broadcastUrl,
      });
      expect(broadcastRequest?.request.headers["X-Expo-Turbo-Demo-Ticket"]).toBeUndefined();

      await act(async () => {
        socket.emitMessage(
          `{"identifier":${JSON.stringify(identifier)},"message":"<turbo-stream action=\\"replace\\" target=\\"demo-protected-stream-message\\"><template><DemoText id=\\"demo-protected-stream-message\\">Protected broadcast from the standalone Rails demo</DemoText></template></turbo-stream>"}`,
        );
        await Promise.resolve();
      });
      const message = proof.session.tree.getElementById("demo-protected-stream-message");
      expect(message ? nodeTextContent(message) : undefined).toBe(
        "Protected broadcast from the standalone Rails demo",
      );

      await act(async () => {
        lifecycle.emit("background");
        lifecycle.emit("active");
        await nextTurn();
        await nextTurn();
      });
      expect(requests.filter((request) => request.url === ticketUrl)).toHaveLength(2);
      expect(socketCalls[1]).toEqual({
        headers: { "X-Expo-Turbo-Demo-Ticket": tickets[1] },
        protocols: [ACTION_CABLE_V1_JSON_PROTOCOL],
        url: "ws://demo.example:3000/cable",
      });
      expect(socketCalls[0]?.headers).not.toEqual(socketCalls[1]?.headers);
    } finally {
      await act(async () => {
        renderer?.unmount();
        await Promise.resolve();
      });
      await nextTurn();
    }

    const socket = sockets[0];
    if (!socket) throw new Error("missing protected Action Cable socket");
    expect(socket.sent).toEqual([encodeActionCableSubscribe(identifier)]);
    expect(socket.closeCalls).toBe(1);
    expect(sockets[1]?.closeCalls).toBe(1);
  });

  test("applies an ordered HTTP Stream response from a Rails-authored link", async () => {
    const documentUrl = "http://demo.example:3000/api/expo_turbo/demo/document";
    const frameUrl = "http://demo.example:3000/api/expo_turbo/demo/frame";
    const streamUrl = "http://demo.example:3000/api/expo_turbo/demo/stream";
    const document = `<Gallery id="demo-document"><DemoDocumentLink id="demo-http-stream-link" href="/api/expo_turbo/demo/stream" data-turbo-stream=""><DemoText>Apply sibling Rails HTTP Stream response</DemoText></DemoDocumentLink><Gallery id="demo-http-stream-message"><DemoText id="demo-http-stream-message-value">Waiting for a Rails HTTP Stream response</DemoText></Gallery><Gallery id="demo-http-stream-list"></Gallery><turbo-frame id="demo-frame" src="/api/expo_turbo/demo/frame"><DemoText id="demo-frame-loading">Loading the public Action Cable Frame</DemoText></turbo-frame></Gallery>`;
    const frame =
      '<turbo-frame id="demo-frame"><DemoText id="demo-stream-message">Waiting for a public Action Cable broadcast</DemoText><turbo-cable-stream-source id="demo-stream-source" channel="Turbo::StreamsChannel" signed-stream-name="signed-demo-stream" /></turbo-frame>';
    const stream = `<turbo-stream action="update" target="demo-http-stream-message"><template><DemoText id="demo-http-stream-message-value">Rendered from XML partial</DemoText></template></turbo-stream><turbo-stream action="append" target="demo-http-stream-list"><template><DemoText id="demo-http-stream-item">Second sibling</DemoText></template></turbo-stream>`;
    const requests: RecordedRequest[] = [];
    const proof = await createDemoLiveCableRuntime({
      createSocket: () => new FakeActionCableSocket(),
      fetch: async (url, request) => {
        requests.push({ request, url });
        if (url === documentUrl || url === frameUrl) {
          return {
            headers: {
              forEach(callback: (value: string, name: string) => void): void {
                callback(EXPO_TURBO_MIME_TYPE, "Content-Type");
              },
            },
            redirected: false,
            status: 200,
            text: async () => (url === documentUrl ? document : frame),
            url,
          };
        }
        if (url === streamUrl) {
          return {
            headers: {
              forEach(callback: (value: string, name: string) => void): void {
                callback(TURBO_STREAM_MIME_TYPE, "Content-Type");
              },
            },
            redirected: false,
            status: 200,
            text: async () => stream,
            url,
          };
        }
        throw new Error("unexpected demo request");
      },
      origin: "http://demo.example:3000",
    });
    let renderer: ReactTestRenderer | undefined;

    try {
      await act(async () => {
        renderer = create(createElement(DemoLiveCablePanel, { proof }));
        await nextTurn();
        await proof.frames.get("demo-frame").loaded;
      });
      const streamLink = renderer?.root.findByProps({ accessibilityRole: "link" });

      await act(async () => {
        streamLink?.props.onPress();
        await nextTurn();
        await nextTurn();
      });

      const streamRequest = unabortedRequests(requests).find(
        (request) => request.url === streamUrl,
      );
      expect(streamRequest).toMatchObject({
        request: {
          headers: {
            Accept: `${TURBO_STREAM_MIME_TYPE}, ${EXPO_TURBO_MIME_TYPE}`,
            "X-Turbo-Request-Id": "demo-live-http-stream-1",
          },
          method: "GET",
        },
        url: streamUrl,
      });
      const message = proof.session.tree.getElementById("demo-http-stream-message-value");
      const item = proof.session.tree.getElementById("demo-http-stream-item");
      expect(message ? nodeTextContent(message) : undefined).toBe("Rendered from XML partial");
      expect(item ? nodeTextContent(item) : undefined).toBe("Second sibling");
    } finally {
      await act(async () => {
        renderer?.unmount();
        await Promise.resolve();
      });
      await nextTurn();
    }
  });

  test("retains local native state through a Rails-authored HTTP Stream morph", async () => {
    const documentUrl = "http://demo.example:3000/api/expo_turbo/demo/document";
    const streamUrl = "http://demo.example:3000/api/expo_turbo/demo/stream?mode=morph";
    const document = `<Gallery id="demo-document"><DemoDocumentLink id="demo-http-stream-morph-link" href="/api/expo_turbo/demo/stream?mode=morph" data-turbo-stream=""><DemoText>Apply state-preserving Rails Stream morph</DemoText></DemoDocumentLink><DemoStreamMorphProbe id="demo-http-stream-morph-probe" message="Waiting for a Rails Stream morph" /></Gallery>`;
    const stream = '<turbo-stream action="replace" target="demo-http-stream-morph-probe" method="morph"><template><DemoStreamMorphProbe id="demo-http-stream-morph-probe" message="Rendered from Rails Stream morph" /></template></turbo-stream>';
    const requests: RecordedRequest[] = [];
    const proof = await createDemoLiveCableRuntime({
      createSocket: () => new FakeActionCableSocket(),
      fetch: async (url, request) => {
        requests.push({ request, url });
        if (url === documentUrl) {
          return {
            headers: {
              forEach(callback: (value: string, name: string) => void): void {
                callback(EXPO_TURBO_MIME_TYPE, "Content-Type");
              },
            },
            redirected: false,
            status: 200,
            text: async () => document,
            url,
          };
        }
        if (url === streamUrl) {
          return {
            headers: {
              forEach(callback: (value: string, name: string) => void): void {
                callback(TURBO_STREAM_MIME_TYPE, "Content-Type");
              },
            },
            redirected: false,
            status: 200,
            text: async () => stream,
            url,
          };
        }
        throw new Error("unexpected demo request");
      },
      origin: "http://demo.example:3000",
    });
    let renderer: ReactTestRenderer | undefined;

    try {
      await act(async () => {
        renderer = create(createElement(DemoLiveCablePanel, { proof }));
        await nextTurn();
      });
      const probeBefore = proof.session.tree.getElementById("demo-http-stream-morph-probe");
      if (!probeBefore) throw new Error("The initial Rails Stream morph probe is missing");
      const localCount = () =>
        renderer?.root.findByProps({ testID: "demo-http-stream-morph-count" }).props.accessibilityLabel;

      act(() => {
        const increment = renderer?.root.findByProps({
          accessibilityLabel: "Increment HTTP Stream morph counter",
        });
        increment?.props.onPress();
      });
      expect(localCount()).toBe("Local count: 1");

      const streamLink = renderer?.root.findByProps({ accessibilityRole: "link" });
      await act(async () => {
        streamLink?.props.onPress();
        await nextTurn();
        await nextTurn();
      });

      expect(unabortedRequests(requests).find((request) => request.url === streamUrl)).toMatchObject({
        request: {
          headers: {
            Accept: `${TURBO_STREAM_MIME_TYPE}, ${EXPO_TURBO_MIME_TYPE}`,
            "X-Turbo-Request-Id": "demo-live-http-stream-1",
          },
          method: "GET",
        },
        url: streamUrl,
      });
      expect(proof.session.tree.getElementById("demo-http-stream-morph-probe")).toBe(probeBefore);
      expect(JSON.stringify(renderer?.toJSON())).toContain("Rendered from Rails Stream morph");
      expect(localCount()).toBe("Local count: 1");
    } finally {
      await act(async () => {
        renderer?.unmount();
        await Promise.resolve();
      });
      await nextTurn();
    }
  });

  test("cancels a pending HTTP Stream link when its host runtime is disposed", async () => {
    const documentUrl = "http://demo.example:3000/api/expo_turbo/demo/document";
    const streamUrl = "http://demo.example:3000/api/expo_turbo/demo/stream";
    const document = `<Gallery id="demo-document"><DemoDocumentLink id="demo-http-stream-link" href="/api/expo_turbo/demo/stream" data-turbo-stream=""><DemoText>Apply sibling Rails HTTP Stream response</DemoText></DemoDocumentLink><Gallery id="demo-http-stream-message"><DemoText id="demo-http-stream-message-value">Waiting for a Rails HTTP Stream response</DemoText></Gallery><Gallery id="demo-http-stream-list"></Gallery></Gallery>`;
    const stream = `<turbo-stream action="update" target="demo-http-stream-message"><template><DemoText id="demo-http-stream-message-value">Rendered too late</DemoText></template></turbo-stream><turbo-stream action="append" target="demo-http-stream-list"><template><DemoText id="demo-http-stream-item">Too late</DemoText></template></turbo-stream>`;
    const requests: RecordedRequest[] = [];
    let resolveStreamResponse: ((response: DemoLiveCableFetchResponse) => void) | undefined;
    const proof = await createDemoLiveCableRuntime({
      createSocket: () => new FakeActionCableSocket(),
      fetch: async (url, request) => {
        requests.push({ request, url });
        if (url === documentUrl) {
          return {
            headers: {
              forEach(callback: (value: string, name: string) => void): void {
                callback(EXPO_TURBO_MIME_TYPE, "Content-Type");
              },
            },
            redirected: false,
            status: 200,
            text: async () => document,
            url,
          };
        }
        if (url === streamUrl) {
          return new Promise<DemoLiveCableFetchResponse>((resolve) => {
            resolveStreamResponse = resolve;
          });
        }
        throw new Error("unexpected demo request");
      },
      origin: "http://demo.example:3000",
    });

    const submission = proof.formLinks.submit("id:demo-http-stream-link", streamUrl);
    await nextTurn();
    const streamRequest = requests.find((request) => request.url === streamUrl);

    try {
      expect(streamRequest?.request.signal?.aborted).toBe(false);
      proof.dispose();
      expect(streamRequest?.request.signal?.aborted).toBe(true);
      expect((await submission).status).toBe("canceled");

      resolveStreamResponse?.({
        headers: {
          forEach(callback: (value: string, name: string) => void): void {
            callback(TURBO_STREAM_MIME_TYPE, "Content-Type");
          },
        },
        redirected: false,
        status: 200,
        text: async () => stream,
        url: streamUrl,
      });
      await nextTurn();

      const message = proof.session.tree.getElementById("demo-http-stream-message-value");
      expect(message ? nodeTextContent(message) : undefined).toBe(
        "Waiting for a Rails HTTP Stream response",
      );
      expect(proof.session.tree.getElementById("demo-http-stream-item")).toBeUndefined();
    } finally {
      proof.dispose();
    }
  });

  test("suspends one stable runtime and restores its subscriptions after an iOS lifecycle transition", async () => {
    const documentUrl = "http://demo.example:3000/api/expo_turbo/demo/document";
    const frameUrl = "http://demo.example:3000/api/expo_turbo/demo/frame";
    const broadcastUrl = "http://demo.example:3000/api/expo_turbo/demo/broadcast";
    const signedStreamName = "signed-demo-stream";
    const identifier = JSON.stringify({
      channel: "Turbo::StreamsChannel",
      signed_stream_name: signedStreamName,
    });
    const document =
      '<Gallery id="demo-document"><DemoText id="demo-document-state">Canonical document</DemoText><turbo-frame id="demo-frame" src="/api/expo_turbo/demo/frame"><DemoText id="demo-frame-loading">Loading the public Action Cable Frame</DemoText></turbo-frame></Gallery>';
    const frame =
      '<turbo-frame id="demo-frame"><DemoText id="demo-stream-message">Waiting for a public Action Cable broadcast</DemoText><turbo-cable-stream-source id="demo-stream-source" channel="Turbo::StreamsChannel" signed-stream-name="signed-demo-stream" /></turbo-frame>';
    const lifecycle = new FakeDemoLiveCableLifecycle();
    const proofs: DemoLiveCableRuntime[] = [];
    const requests: RecordedRequest[] = [];
    const sockets: FakeActionCableSocket[] = [];
    let runtimeCreations = 0;
    const createRuntime = async () => {
      runtimeCreations += 1;
      const proof = await createDemoLiveCableRuntime({
        createSocket() {
          const socket = new FakeActionCableSocket();
          sockets.push(socket);
          return socket;
        },
        fetch: async (url, request) => {
          requests.push({ request, url });
          if (url !== documentUrl && url !== frameUrl && url !== broadcastUrl) {
            throw new Error("unexpected demo request");
          }
          return {
            headers: {
              forEach(callback: (value: string, name: string) => void): void {
                if (url !== broadcastUrl) callback(EXPO_TURBO_MIME_TYPE, "Content-Type");
              },
            },
            redirected: false,
            status: url === broadcastUrl ? 204 : 200,
            text: async () => (url === documentUrl ? document : url === frameUrl ? frame : ""),
            url,
          };
        },
        lifecycle,
        origin: "http://demo.example:3000",
      });
      proofs.push(proof);
      return proof;
    };
    let renderer: ReactTestRenderer | undefined;

    try {
      await act(async () => {
        renderer = create(
          createElement(DemoLiveCableProof, {
            createRuntime,
            lifecycle,
            origin: "http://demo.example:3000",
          }),
        );
        await nextTurn();
        await nextTurn();
      });
      expect(runtimeCreations).toBe(1);
      const initialProof = proofs[0];
      if (!initialProof) throw new Error("missing initial Cable runtime");
      await act(async () => {
        await initialProof.frames.get("demo-frame").loaded;
        await nextTurn();
      });
      const initialSocket = sockets[0];
      if (!initialSocket) throw new Error("missing initial Action Cable socket");
      await act(async () => {
        initialSocket.emitOpen();
        initialSocket.emitMessage('{"type":"welcome"}');
        initialSocket.emitMessage(
          `{"identifier":${JSON.stringify(identifier)},"type":"confirm_subscription"}`,
        );
        await Promise.resolve();
      });
      const replaceButton = () =>
        renderer?.root.findByProps({ accessibilityLabel: "Broadcast XML replace" });
      expect(replaceButton()?.props.disabled).toBe(false);

      await act(async () => {
        lifecycle.emit("inactive");
        await nextTurn();
      });
      expect(initialSocket.closeCalls).toBe(1);
      expect(runtimeCreations).toBe(1);
      expect(
        renderer?.root.findByProps({ accessibilityLabel: "Action Cable paused in background" }),
      ).toBeDefined();

      await act(async () => {
        lifecycle.emit("background");
        await nextTurn();
      });
      expect(initialSocket.closeCalls).toBe(1);
      expect(runtimeCreations).toBe(1);
      expect(
        renderer?.root.findByProps({ accessibilityLabel: "Action Cable paused in background" }),
      ).toBeDefined();

      await act(async () => {
        lifecycle.emit("background");
        lifecycle.emit("active");
        await nextTurn();
        await nextTurn();
      });
      expect(runtimeCreations).toBe(1);
      const recreatedSocket = sockets[1];
      if (!recreatedSocket) throw new Error("missing recreated Action Cable socket");
      expect(
        unabortedRequests(requests).filter(({ url }) => url === documentUrl),
      ).toHaveLength(1);
      expect(unabortedRequests(requests).filter(({ url }) => url === frameUrl)).toHaveLength(1);

      await act(async () => {
        recreatedSocket.emitOpen();
        recreatedSocket.emitMessage('{"type":"welcome"}');
        recreatedSocket.emitMessage(
          `{"identifier":${JSON.stringify(identifier)},"type":"confirm_subscription"}`,
        );
        await nextTurn();
      });
      await act(async () => {
        await initialProof.frames.get("demo-frame").loaded;
        await nextTurn();
      });
      expect(unabortedRequests(requests).filter(({ url }) => url === frameUrl)).toHaveLength(2);
      expect(sockets).toHaveLength(3);
      const reconciledSocket = sockets[2];
      if (!reconciledSocket) throw new Error("missing reconciled Action Cable socket");
      await act(async () => {
        reconciledSocket.emitOpen();
        reconciledSocket.emitMessage('{"type":"welcome"}');
        reconciledSocket.emitMessage(
          `{"identifier":${JSON.stringify(identifier)},"type":"confirm_subscription"}`,
        );
        await Promise.resolve();
      });
      expect(replaceButton()?.props.disabled).toBe(false);

      await act(async () => {
        lifecycle.emit("active");
        replaceButton()?.props.onPress();
        await Promise.resolve();
      });
      expect(runtimeCreations).toBe(1);
      expect(unabortedRequests(requests).at(-1)).toMatchObject({
        request: { headers: { Accept: EXPO_TURBO_MIME_TYPE }, method: "POST" },
        url: broadcastUrl,
      });
    } finally {
      await act(async () => {
        renderer?.unmount();
        await Promise.resolve();
      });
      await nextTurn();
    }

    const recreatedSocket = sockets[1];
    if (!recreatedSocket) throw new Error("missing recreated Action Cable socket");
    expect(recreatedSocket.closeCalls).toBe(1);
  });

  test("recovers one stable runtime after reachability loss and bounded transport retry", async () => {
    const documentUrl = "http://demo.example:3000/api/expo_turbo/demo/document";
    const identifier = JSON.stringify({
      channel: "Turbo::StreamsChannel",
      signed_stream_name: "signed-demo-stream",
    });
    const document =
      '<Gallery id="demo-document"><turbo-frame id="demo-frame" src="/api/expo_turbo/demo/frame"><DemoText>Loading</DemoText></turbo-frame></Gallery>';
    const frame =
      '<turbo-frame id="demo-frame"><DemoText id="demo-stream-message">Network recovery</DemoText><turbo-cable-stream-source id="demo-stream-source" channel="Turbo::StreamsChannel" signed-stream-name="signed-demo-stream" /></turbo-frame>';
    const clock = new ManualClock();
    const network = new FakeDemoLiveCableNetwork();
    const sockets: FakeActionCableSocket[] = [];
    const proof = await createDemoLiveCableRuntime({
      clock,
      createSocket() {
        const socket = new FakeActionCableSocket();
        sockets.push(socket);
        return socket;
      },
      fetch: async (url) => ({
        headers: {
          forEach(callback: (value: string, name: string) => void): void {
            callback(EXPO_TURBO_MIME_TYPE, "Content-Type");
          },
        },
        redirected: false,
        status: 200,
        text: async () => (url === documentUrl ? document : frame),
        url,
      }),
      network,
      origin: "http://demo.example:3000",
    });
    let renderer: ReactTestRenderer | undefined;

    try {
      await act(async () => {
        renderer = create(createElement(DemoLiveCablePanel, { proof }));
        await nextTurn();
        await proof.frames.get("demo-frame").loaded;
      });
      const original = sockets[0];
      if (!original) throw new Error("missing original Action Cable socket");
      await act(async () => {
        original.emitOpen();
        original.emitMessage('{"type":"welcome"}');
        original.emitMessage(
          `{"identifier":${JSON.stringify(identifier)},"type":"confirm_subscription"}`,
        );
        await Promise.resolve();
      });

      expect(network.listenerCount).toBe(1);
      act(() => network.emit("offline"));
      expect(original.closeCalls).toBe(1);
      expect(sockets).toHaveLength(1);
      act(() => network.emit("online"));
      expect(sockets).toHaveLength(2);

      const onlineSocket = sockets[1];
      if (!onlineSocket) throw new Error("missing online Action Cable socket");
      act(() => onlineSocket.emitClose());
      const retryTimerIndex = clock.timers.findIndex(
        (timer) => timer.delayMs === 1_000 && !timer.cleared,
      );
      expect(retryTimerIndex).toBeGreaterThanOrEqual(0);
      act(() => clock.fire(retryTimerIndex));
      expect(sockets).toHaveLength(3);

      const recovered = sockets[2];
      if (!recovered) throw new Error("missing recovered Action Cable socket");
      await act(async () => {
        recovered.emitOpen();
        recovered.emitMessage('{"type":"welcome"}');
        recovered.emitMessage(
          `{"identifier":${JSON.stringify(identifier)},"type":"confirm_subscription"}`,
        );
        await nextTurn();
        await proof.frames.get("demo-frame").loaded;
        await nextTurn();
      });
      expect(sockets).toHaveLength(4);
      const reconciled = sockets[3];
      if (!reconciled) throw new Error("missing reconciled Action Cable socket");
      await act(async () => {
        reconciled.emitOpen();
        reconciled.emitMessage('{"type":"welcome"}');
        reconciled.emitMessage(
          `{"identifier":${JSON.stringify(identifier)},"type":"confirm_subscription"}`,
        );
        await Promise.resolve();
      });
      expect(
        renderer?.root.findByProps({ accessibilityLabel: "Broadcast XML replace" }).props.disabled,
      ).toBe(false);
      expect(
        renderer?.root.findByProps({
          accessibilityLabel: "Action Cable recovered and reconciled",
        }),
      ).toBeDefined();
    } finally {
      await act(async () => {
        renderer?.unmount();
        await Promise.resolve();
      });
      await nextTurn();
    }
  });

  test("disposes a runtime that resolves after its pending owner unmounts", async () => {
    const lifecycle = new FakeDemoLiveCableLifecycle();
    const lateProof = {
      dispose: mock(() => undefined),
    } as unknown as DemoLiveCableRuntime;
    let resolveRuntime: ((proof: DemoLiveCableRuntime) => void) | undefined;
    const createRuntime = () =>
      new Promise<DemoLiveCableRuntime>((resolve) => {
        resolveRuntime = resolve;
      });
    let renderer: ReactTestRenderer | undefined;

    try {
      await act(async () => {
        renderer = create(
          createElement(DemoLiveCableProof, {
            createRuntime,
            lifecycle,
            origin: "http://demo.example:3000",
          }),
        );
        await nextTurn();
      });
      if (!resolveRuntime) throw new Error("missing pending Cable runtime");

      await act(async () => {
        renderer?.unmount();
        await Promise.resolve();
      });
      resolveRuntime?.(lateProof);
      await nextTurn();
    } finally {
      await act(async () => {
        renderer?.unmount();
        await Promise.resolve();
      });
    }
    expect(lateProof.dispose).toHaveBeenCalledTimes(1);
  });

  test("keeps a parent-owned runtime alive while its panel remounts", async () => {
    const documentUrl = "http://demo.example:3000/api/expo_turbo/demo/document";
    const proof = await createDemoLiveCableRuntime({
      createSocket: () => new FakeActionCableSocket(),
      fetch: async (url) => ({
        headers: {
          forEach(callback: (value: string, name: string) => void): void {
            callback(EXPO_TURBO_MIME_TYPE, "Content-Type");
          },
        },
        redirected: false,
        status: 200,
        text: async () => '<Gallery id="demo-document"></Gallery>',
        url,
      }),
      origin: "http://demo.example:3000",
    });
    const originalDispose = proof.dispose.bind(proof);
    const dispose = mock(() => originalDispose());
    const retainedProof: DemoLiveCableRuntime = { ...proof, dispose };
    let renderer: ReactTestRenderer | undefined;

    try {
      await act(async () => {
        renderer = create(
          createElement(DemoLiveCablePanel, { ownsRuntime: false, proof: retainedProof }),
        );
        await nextTurn();
      });
      await act(async () => {
        renderer?.unmount();
        await nextTurn();
      });
      expect(dispose).not.toHaveBeenCalled();

      await act(async () => {
        renderer = create(
          createElement(DemoLiveCablePanel, { ownsRuntime: false, proof: retainedProof }),
        );
        await nextTurn();
      });
      if (!renderer) throw new Error("missing remounted Cable panel");
      expect(proof.documentUrl).toBe(documentUrl);
      expect(
        renderer.root.findByProps({ accessibilityLabel: "Broadcast XML replace" }),
      ).toBeDefined();
    } finally {
      await act(async () => {
        renderer?.unmount();
        await nextTurn();
      });
      originalDispose();
    }
    expect(dispose).not.toHaveBeenCalled();
  });

  test("reconciles its active Frame after a server-directed reconfirmation", async () => {
    const documentUrl = "http://demo.example:3000/api/expo_turbo/demo/document";
    const frameUrl = "http://demo.example:3000/api/expo_turbo/demo/frame";
    const signedStreamName = "signed-demo-stream";
    const identifier = JSON.stringify({
      channel: "Turbo::StreamsChannel",
      signed_stream_name: signedStreamName,
    });
    const document =
      '<Gallery id="demo-document"><turbo-frame id="demo-frame" src="/api/expo_turbo/demo/frame"><DemoText id="demo-frame-loading">Loading the public Action Cable Frame</DemoText></turbo-frame></Gallery>';
    const initialFrame =
      '<turbo-frame id="demo-frame"><DemoText id="demo-stream-message">Initial XML Frame</DemoText><turbo-cable-stream-source id="demo-stream-source" channel="Turbo::StreamsChannel" signed-stream-name="signed-demo-stream" /></turbo-frame>';
    const reconciledFrame =
      '<turbo-frame id="demo-frame"><DemoText id="demo-stream-message">Canonical XML Frame after reconnect</DemoText><turbo-cable-stream-source id="demo-stream-source" channel="Turbo::StreamsChannel" signed-stream-name="signed-demo-stream" /></turbo-frame>';
    const requests: RecordedRequest[] = [];
    const sockets: FakeActionCableSocket[] = [];
    let frameRequests = 0;
    const proof = await createDemoLiveCableRuntime({
      createSocket() {
        const socket = new FakeActionCableSocket();
        sockets.push(socket);
        return socket;
      },
      fetch: async (url, request) => {
        requests.push({ request, url });
        if (url !== documentUrl && url !== frameUrl) throw new Error("unexpected demo request");
        return {
          headers: {
            forEach(callback: (value: string, name: string) => void): void {
              callback(EXPO_TURBO_MIME_TYPE, "Content-Type");
            },
          },
          redirected: false,
          status: 200,
          text: async () => {
            if (url === documentUrl) return document;
            frameRequests += 1;
            return frameRequests === 1 ? initialFrame : reconciledFrame;
          },
          url,
        };
      },
      origin: "http://demo.example:3000",
    });
    let renderer: ReactTestRenderer | undefined;

    try {
      await act(async () => {
        renderer = create(
          createElement(
            StrictMode,
            undefined,
            createElement(DemoLiveCablePanel, { proof }),
          ),
        );
        await nextTurn();
        await proof.frames.get("demo-frame").loaded;
      });
      const original = sockets[0];
      if (!original) throw new Error("missing original Action Cable socket");

      await act(async () => {
        original.emitOpen();
        original.emitMessage('{"type":"welcome"}');
        original.emitMessage(
          '{"identifier":' + JSON.stringify(identifier) + ',"type":"confirm_subscription"}',
        );
        await Promise.resolve();
      });
      expect(original.sent).toEqual([encodeActionCableSubscribe(identifier)]);

      await act(async () => {
        original.emitMessage('{"type":"disconnect","reason":"restart","reconnect":true}');
        await Promise.resolve();
      });
      expect(original.closeCalls).toBe(1);
      expect(sockets).toHaveLength(2);
      const replacement = sockets[1];
      if (!replacement) throw new Error("missing replacement Action Cable socket");

      await act(async () => {
        replacement.emitOpen();
        replacement.emitMessage('{"type":"welcome"}');
        replacement.emitMessage(
          '{"identifier":' + JSON.stringify(identifier) + ',"type":"confirm_subscription"}',
        );
        await nextTurn();
      });
      expect(replacement.sent).toContain(encodeActionCableSubscribe(identifier));
      expect(requests).toHaveLength(4);
      expect(requests.filter(({ request }) => request.signal?.aborted)).toHaveLength(1);
      const reconciledRequests = unabortedRequests(requests);
      expect(reconciledRequests).toHaveLength(3);
      expect(reconciledRequests.filter((request) => request.url === documentUrl)).toHaveLength(1);
      expect(reconciledRequests[1]).toMatchObject({
        request: {
          headers: { "Turbo-Frame": "demo-frame", Accept: EXPO_TURBO_MIME_TYPE },
          method: "GET",
        },
        url: frameUrl,
      });
      expect(requests[0]?.request.headers["X-Turbo-Request-Id"]).toBe(
        "demo-live-document-1",
      );
      expect(reconciledRequests[1]?.request.headers["X-Turbo-Request-Id"]).toBe(
        "demo-live-frame-2",
      );
      expect(reconciledRequests[2]).toMatchObject({
        request: {
          headers: { "Turbo-Frame": "demo-frame", Accept: EXPO_TURBO_MIME_TYPE },
          method: "GET",
        },
        url: frameUrl,
      });
      expect(reconciledRequests[2]?.request.headers["X-Turbo-Request-Id"]).toBe(
        "demo-live-frame-3",
      );
      expect(requests[1]?.request.headers["X-Turbo-Request-Id"]).toBe(
        "demo-live-frame-1",
      );
      const message = proof.session.tree.getElementById("demo-stream-message");
      expect(message ? nodeTextContent(message) : undefined).toBe(
        "Canonical XML Frame after reconnect",
      );
    } finally {
      await act(async () => {
        renderer?.unmount();
        await Promise.resolve();
      });
      await nextTurn();
    }
  });

  test("does not reload the active Frame after runtime disposal during reconnect", async () => {
    const documentUrl = "http://demo.example:3000/api/expo_turbo/demo/document";
    const frameUrl = "http://demo.example:3000/api/expo_turbo/demo/frame";
    const signedStreamName = "signed-demo-stream";
    const identifier = JSON.stringify({
      channel: "Turbo::StreamsChannel",
      signed_stream_name: signedStreamName,
    });
    const document =
      '<Gallery id="demo-document"><turbo-frame id="demo-frame" src="/api/expo_turbo/demo/frame"><DemoText id="demo-frame-loading">Loading the public Action Cable Frame</DemoText></turbo-frame></Gallery>';
    const frame =
      '<turbo-frame id="demo-frame"><DemoText id="demo-stream-message">Initial XML Frame</DemoText><turbo-cable-stream-source id="demo-stream-source" channel="Turbo::StreamsChannel" signed-stream-name="signed-demo-stream" /></turbo-frame>';
    const requests: RecordedRequest[] = [];
    const sockets: FakeActionCableSocket[] = [];
    const proof = await createDemoLiveCableRuntime({
      createSocket() {
        const socket = new FakeActionCableSocket();
        sockets.push(socket);
        return socket;
      },
      fetch: async (url, request) => {
        requests.push({ request, url });
        if (url !== documentUrl && url !== frameUrl) throw new Error("unexpected demo request");
        return {
          headers: {
            forEach(callback: (value: string, name: string) => void): void {
              callback(EXPO_TURBO_MIME_TYPE, "Content-Type");
            },
          },
          redirected: false,
          status: 200,
          text: async () => (url === documentUrl ? document : frame),
          url,
        };
      },
      origin: "http://demo.example:3000",
    });
    let renderer: ReactTestRenderer | undefined;

    try {
      await act(async () => {
        renderer = create(
          createElement(
            StrictMode,
            undefined,
            createElement(DemoLiveCablePanel, { proof }),
          ),
        );
        await nextTurn();
        await proof.frames.get("demo-frame").loaded;
      });
      const original = sockets[0];
      if (!original) throw new Error("missing original Action Cable socket");
      await act(async () => {
        original.emitOpen();
        original.emitMessage('{"type":"welcome"}');
        original.emitMessage(
          '{"identifier":' + JSON.stringify(identifier) + ',"type":"confirm_subscription"}',
        );
        await Promise.resolve();
      });
      await act(async () => {
        original.emitMessage('{"type":"disconnect","reason":"restart","reconnect":true}');
        await Promise.resolve();
      });

      const replacement = sockets[1];
      if (!replacement) throw new Error("missing replacement Action Cable socket");
      await act(async () => {
        replacement.emitOpen();
        replacement.emitMessage('{"type":"welcome"}');
        await Promise.resolve();
      });
      expect(replacement.sent).toEqual([encodeActionCableSubscribe(identifier)]);

      await act(async () => {
        renderer?.unmount();
        renderer = undefined;
        await Promise.resolve();
      });
      await nextTurn();

      expect(requests).toHaveLength(3);
      expect(unabortedRequests(requests)).toHaveLength(2);
      expect(replacement.closeCalls).toBe(1);
    } finally {
      await act(async () => {
        renderer?.unmount();
        await Promise.resolve();
      });
      await nextTurn();
    }
  });
});
