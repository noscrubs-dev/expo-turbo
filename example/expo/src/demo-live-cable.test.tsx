/// <reference types="bun" />

import { describe, expect, mock, test } from "bun:test";
import {
  ACTION_CABLE_V1_JSON_PROTOCOL,
  encodeActionCableSubscribe,
  encodeActionCableUnsubscribe,
  type ActionCableWebSocket,
  type ActionCableWebSocketEventType,
  type ClockAdapter,
} from "expo-turbo/adapters";
import { EXPO_TURBO_MIME_TYPE, nodeTextContent } from "expo-turbo/core";
import { createElement, StrictMode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import type { DemoLiveCableFetchRequest } from "./demo-live-cable";

mock.module("react-native", () => ({
  AccessibilityInfo: { announceForAccessibility: () => undefined },
  Alert: { alert: () => undefined },
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

const { createDemoLiveCableRuntime, DemoLiveCablePanel } = await import("./demo-live-cable");

const globalWithAct = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean;
};
globalWithAct.IS_REACT_ACT_ENVIRONMENT = true;

type CableSocketListener = (event: Readonly<{ readonly data?: unknown }>) => void;

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
    if (!timer) throw new Error("Missing timer " + index);
    if (!timer.cleared) timer.callback();
  }
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

const nextTurn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("standalone Rails Action Cable proof", () => {
  test("waits for confirmation, applies XML Streams, and releases its socket", async () => {
    const documentUrl = "http://demo.example:3000/api/expo_turbo/demo/document";
    const broadcastUrl = "http://demo.example:3000/api/expo_turbo/demo/broadcast";
    const signedStreamName = "signed-demo-stream";
    const identifier = JSON.stringify({
      channel: "Turbo::StreamsChannel",
      signed_stream_name: signedStreamName,
    });
    const document = `<Gallery id="demo-document"><DemoText id="demo-stream-message">Waiting for a public Action Cable broadcast</DemoText><turbo-cable-stream-source id="demo-stream-source" channel="Turbo::StreamsChannel" signed-stream-name="${signedStreamName}" /></Gallery>`;
    const requests: Readonly<{ request: DemoLiveCableFetchRequest; url: string }>[] = [];
    const sockets: FakeActionCableSocket[] = [];
    const socketCalls: Readonly<{ protocols: readonly string[]; url: string }>[] = [];
    const fetch = async (url: string, request: DemoLiveCableFetchRequest) => {
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
      if (url === broadcastUrl) {
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
        await Promise.resolve();
      });
      const socket = sockets[0];
      if (!socket) throw new Error("missing Action Cable socket");

      expect(socketCalls).toEqual([
        { protocols: [ACTION_CABLE_V1_JSON_PROTOCOL], url: "ws://demo.example:3000/cable" },
      ]);
      const broadcastButton = () => renderer?.root.findByProps({ accessibilityRole: "button" });
      expect(broadcastButton()?.props.disabled).toBe(true);
      broadcastButton()?.props.onPress();
      expect(requests).toHaveLength(1);

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

      expect(broadcastButton()?.props.disabled).toBe(false);
      const message = proof.session.tree.getElementById("demo-stream-message");
      expect(message ? nodeTextContent(message) : undefined).toBe(
        "Broadcast from the standalone Rails demo",
      );

      await act(async () => {
        socket.emitMessage(
          `{"identifier":${JSON.stringify(identifier)},"message":"<turbo-stream action=\\"refresh\\"></turbo-stream>"}`,
        );
        await Promise.resolve();
      });
      expect(errors.at(-1)?.message).toBe(
        "Turbo Stream refresh requires a document refresh controller",
      );
      expect(JSON.stringify(renderer?.toJSON())).toContain(
        "Turbo Stream refresh requires a document refresh controller",
      );
      expect(requests).toHaveLength(1);

      await act(async () => {
        broadcastButton()?.props.onPress();
        await Promise.resolve();
      });
      expect(requests[1]).toMatchObject({
        request: { headers: { Accept: EXPO_TURBO_MIME_TYPE }, method: "POST" },
        url: broadcastUrl,
      });
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

  test("reconciles canonical XML after a server-directed reconfirmation", async () => {
    const documentUrl = "http://demo.example:3000/api/expo_turbo/demo/document";
    const signedStreamName = "signed-demo-stream";
    const identifier = JSON.stringify({
      channel: "Turbo::StreamsChannel",
      signed_stream_name: signedStreamName,
    });
    const initialDocument =
      '<Gallery id="demo-document"><DemoText id="demo-stream-message">Initial XML document</DemoText><turbo-cable-stream-source id="demo-stream-source" channel="Turbo::StreamsChannel" signed-stream-name="signed-demo-stream" /></Gallery>';
    const reconciledDocument =
      '<Gallery id="demo-document"><DemoText id="demo-stream-message">Canonical XML after reconnect</DemoText><turbo-cable-stream-source id="demo-stream-source" channel="Turbo::StreamsChannel" signed-stream-name="signed-demo-stream" /></Gallery>';
    const clock = new ManualClock();
    const requests: Readonly<{ request: DemoLiveCableFetchRequest; url: string }>[] = [];
    const sockets: FakeActionCableSocket[] = [];
    let documentRequests = 0;
    const proof = await createDemoLiveCableRuntime({
      clock,
      createSocket() {
        const socket = new FakeActionCableSocket();
        sockets.push(socket);
        return socket;
      },
      fetch: async (url, request) => {
        requests.push({ request, url });
        if (url !== documentUrl) throw new Error("unexpected demo request");
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
            documentRequests === 1 ? initialDocument : reconciledDocument,
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
        await Promise.resolve();
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
        await Promise.resolve();
      });
      expect(replacement.sent).toEqual([encodeActionCableSubscribe(identifier)]);
      expect(clock.timers).toHaveLength(1);
      expect(clock.timers[0]?.delayMs).toBe(150);
      expect(requests).toHaveLength(1);

      await act(async () => {
        clock.fire(0);
        await nextTurn();
      });

      expect(requests).toHaveLength(2);
      expect(requests[1]).toMatchObject({
        request: { headers: { Accept: EXPO_TURBO_MIME_TYPE }, method: "GET" },
        url: documentUrl,
      });
      expect(requests[0]?.request.headers["X-Turbo-Request-Id"]).toBe(
        "demo-live-document-1",
      );
      expect(requests[1]?.request.headers["X-Turbo-Request-Id"]).toBe(
        "demo-live-document-2",
      );
      const message = proof.session.tree.getElementById("demo-stream-message");
      expect(message ? nodeTextContent(message) : undefined).toBe(
        "Canonical XML after reconnect",
      );
      const rebound = sockets[2];
      if (!rebound) throw new Error("missing canonical document source socket");
      const timerCount = clock.timers.length;

      await act(async () => {
        rebound.emitOpen();
        rebound.emitMessage('{"type":"welcome"}');
        rebound.emitMessage(
          '{"identifier":' + JSON.stringify(identifier) + ',"type":"confirm_subscription"}',
        );
        await Promise.resolve();
      });

      expect(rebound.sent).toEqual([encodeActionCableSubscribe(identifier)]);
      expect(clock.timers).toHaveLength(timerCount);
      expect(requests).toHaveLength(2);
    } finally {
      await act(async () => {
        renderer?.unmount();
        await Promise.resolve();
      });
      await nextTurn();
    }
  });

  test("cancels a pending reconnect reconciliation when the runtime is disposed", async () => {
    const documentUrl = "http://demo.example:3000/api/expo_turbo/demo/document";
    const signedStreamName = "signed-demo-stream";
    const identifier = JSON.stringify({
      channel: "Turbo::StreamsChannel",
      signed_stream_name: signedStreamName,
    });
    const document =
      '<Gallery id="demo-document"><DemoText id="demo-stream-message">Initial XML document</DemoText><turbo-cable-stream-source id="demo-stream-source" channel="Turbo::StreamsChannel" signed-stream-name="signed-demo-stream" /></Gallery>';
    const clock = new ManualClock();
    const requests: Readonly<{ request: DemoLiveCableFetchRequest; url: string }>[] = [];
    const sockets: FakeActionCableSocket[] = [];
    const proof = await createDemoLiveCableRuntime({
      clock,
      createSocket() {
        const socket = new FakeActionCableSocket();
        sockets.push(socket);
        return socket;
      },
      fetch: async (url, request) => {
        requests.push({ request, url });
        if (url !== documentUrl) throw new Error("unexpected demo request");
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
      },
      origin: "http://demo.example:3000",
    });
    const source = proof.session.tree.getElementById("demo-stream-source");
    if (!source) throw new Error("missing demo stream source");
    proof.streamSources.retain(source);

    const original = sockets[0];
    if (!original) throw new Error("missing original Action Cable socket");
    original.emitOpen();
    original.emitMessage('{"type":"welcome"}');
    original.emitMessage(
      '{"identifier":' + JSON.stringify(identifier) + ',"type":"confirm_subscription"}',
    );
    original.emitMessage('{"type":"disconnect","reason":"restart","reconnect":true}');

    const replacement = sockets[1];
    if (!replacement) throw new Error("missing replacement Action Cable socket");
    replacement.emitOpen();
    replacement.emitMessage('{"type":"welcome"}');
    replacement.emitMessage(
      '{"identifier":' + JSON.stringify(identifier) + ',"type":"confirm_subscription"}',
    );
    expect(clock.timers).toHaveLength(1);

    proof.dispose();
    clock.fire(0);
    await nextTurn();

    expect(requests).toHaveLength(1);
    expect(replacement.closeCalls).toBe(1);
  });
});
