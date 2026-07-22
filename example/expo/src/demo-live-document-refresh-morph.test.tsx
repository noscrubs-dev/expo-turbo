/// <reference types="bun" />

import { expect, mock, test } from "bun:test";
import { type ClockAdapter } from "expo-turbo/adapters";
import { EXPO_TURBO_MIME_TYPE, nodeTextContent } from "expo-turbo/core";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import type { DemoLiveFetchRequest } from "./demo-live-transport";

interface PressableProps {
  readonly accessibilityLabel?: string;
  readonly accessibilityRole?: string;
  readonly onPress?: () => void;
}

mock.module("react-native", () => ({
  AccessibilityInfo: { announceForAccessibility: () => undefined },
  Alert: { alert: () => undefined },
  FlatList: (props: Readonly<Record<string, unknown>>) => createElement("flat-list", props),
  Linking: { openURL: async () => undefined },
  Platform: { OS: "web" },
  Pressable: (props: PressableProps) => createElement("pressable", props),
  ScrollView: (props: Readonly<Record<string, unknown>>) =>
    createElement("scroll-view", props),
  Text: (props: Readonly<Record<string, unknown>>) => createElement("native-text", props),
  TextInput: (props: Readonly<Record<string, unknown>>) => createElement("text-input", props),
  View: (props: Readonly<Record<string, unknown>>) => createElement("view", props),
}));

const { createDemoLiveDocumentRefreshMorphRuntime, DemoLiveDocumentRefreshMorphPanel } =
  await import("./demo-live-document-refresh-morph");
const TURBO_STREAM_MIME_TYPE = "text/vnd.turbo-stream.html";

const globalWithAct = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean;
};
globalWithAct.IS_REACT_ACT_ENVIRONMENT = true;

type RecordedRequest = Readonly<{ request: DemoLiveFetchRequest; url: string }>;

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

const nextTurn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test("preserves local native state through a Rails current-document Refresh Stream morph", async () => {
  const documentUrl = "http://demo.example:3000/api/expo_turbo/demo/refresh_morph_document";
  const streamUrl = "http://demo.example:3000/api/expo_turbo/demo/stream?mode=refresh-morph";
  const initialDocument = `<Gallery id="demo-document-refresh-morph"><DemoText id="demo-document-refresh-morph-response">Canonical Rails response one</DemoText><DemoDocumentLink id="demo-document-refresh-morph-link" href="/api/expo_turbo/demo/stream?mode=refresh-morph" data-turbo-stream="" accessibility-label="Refresh current Rails document with a state-preserving morph"><DemoText>Refresh current Rails document with a state-preserving morph</DemoText></DemoDocumentLink><DemoStreamMorphProbe id="demo-document-refresh-morph-probe" message="Local state survives the Rails document refresh" increment-label="Increment document refresh morph counter" /></Gallery>`;
  const refreshedDocument = `<Gallery id="demo-document-refresh-morph"><DemoText id="demo-document-refresh-morph-response">Canonical Rails response two</DemoText><DemoDocumentLink id="demo-document-refresh-morph-link" href="/api/expo_turbo/demo/stream?mode=refresh-morph" data-turbo-stream="" accessibility-label="Refresh current Rails document with a state-preserving morph"><DemoText>Refresh current Rails document with a state-preserving morph</DemoText></DemoDocumentLink><DemoStreamMorphProbe id="demo-document-refresh-morph-probe" message="Local state survives the Rails document refresh" increment-label="Increment document refresh morph counter" /></Gallery>`;
  const stream = '<turbo-stream action="refresh" method="morph"></turbo-stream>';
  const requests: RecordedRequest[] = [];
  const clock = new ManualClock();
  let documentRequests = 0;
  const proof = await createDemoLiveDocumentRefreshMorphRuntime({
    clock,
    fetch: async (url, request) => {
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
          text: async () => (documentRequests === 1 ? initialDocument : refreshedDocument),
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
      throw new Error("Unexpected standalone Rails refresh-morph request");
    },
    origin: "http://demo.example:3000",
  });
  let renderer: ReactTestRenderer | undefined;
  const errors: (Error | undefined)[] = [];
  const unsubscribeErrors = proof.subscribeErrors((error) => {
    errors.push(error);
  });

  try {
    await act(async () => {
      renderer = create(createElement(DemoLiveDocumentRefreshMorphPanel, { proof }));
      await nextTurn();
    });
    const rootBefore = proof.session.tree.getElementById("demo-document-refresh-morph");
    const probeBefore = proof.session.tree.getElementById("demo-document-refresh-morph-probe");
    if (!rootBefore || !probeBefore) throw new Error("The Rails refresh-morph document is missing");
    const localCount = () =>
      renderer?.root.findByProps({ testID: "demo-http-stream-morph-count" }).props.accessibilityLabel;

    act(() => {
      const increment = renderer?.root.findByProps({
        accessibilityLabel: "Increment document refresh morph counter",
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

    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      request: {
        headers: {
          Accept: EXPO_TURBO_MIME_TYPE,
          "X-Turbo-Request-Id": "demo-live-document-refresh-morph-1",
        },
        method: "GET",
      },
      url: documentUrl,
    });
    expect(requests[1]).toMatchObject({
      request: {
        headers: {
          Accept: `${TURBO_STREAM_MIME_TYPE}, ${EXPO_TURBO_MIME_TYPE}`,
          "X-Turbo-Request-Id": "demo-live-document-refresh-morph-link-1",
        },
        method: "GET",
      },
      url: streamUrl,
    });
    expect(clock.timers).toHaveLength(1);
    expect(clock.timers[0]?.delayMs).toBe(150);

    await act(async () => {
      clock.fire(0);
      await Promise.resolve();
      await nextTurn();
    });

    expect(requests).toHaveLength(3);
    expect(requests[2]).toMatchObject({
      request: {
        headers: {
          Accept: EXPO_TURBO_MIME_TYPE,
          "X-Turbo-Request-Id": "demo-live-document-refresh-morph-2",
        },
        method: "GET",
      },
      url: documentUrl,
    });
    expect(proof.session.tree.getElementById("demo-document-refresh-morph")).toBe(rootBefore);
    expect(proof.session.tree.getElementById("demo-document-refresh-morph-probe")).toBe(probeBefore);
    const response = proof.session.tree.getElementById("demo-document-refresh-morph-response");
    expect(response ? nodeTextContent(response) : undefined).toBe("Canonical Rails response two");
    expect(localCount()).toBe("Local count: 1");
    expect(errors.at(-1)).toBeUndefined();
  } finally {
    await act(async () => {
      renderer?.unmount();
      await Promise.resolve();
    });
    await nextTurn();
    unsubscribeErrors();
    proof.dispose();
  }
});

test("shows Rails request-id suppression without issuing a duplicate canonical document GET", async () => {
  const documentUrl = "http://demo.example:3000/api/expo_turbo/demo/refresh_morph_document";
  const streamUrl = "http://demo.example:3000/api/expo_turbo/demo/stream?mode=refresh-morph-originating";
  const initialDocument = `<Gallery id="demo-document-refresh-morph"><DemoText id="demo-document-refresh-morph-response">Canonical Rails response one</DemoText><DemoText id="demo-document-refresh-morph-suppression">No originating request-ID refresh has been demonstrated yet.</DemoText><DemoDocumentLink id="demo-document-refresh-morph-suppression-link" href="/api/expo_turbo/demo/stream?mode=refresh-morph-originating" data-turbo-stream="" accessibility-label="Echo request ID and suppress document refresh"><DemoText>Echo request ID and suppress document refresh</DemoText></DemoDocumentLink><DemoStreamMorphProbe id="demo-document-refresh-morph-probe" message="Local state survives the Rails document refresh" increment-label="Increment document refresh morph counter" /></Gallery>`;
  const stream = '<turbo-stream action="replace" target="demo-document-refresh-morph-suppression"><template><DemoText id="demo-document-refresh-morph-suppression">Rails echoed the originating request ID, so the document Refresh Stream was suppressed.</DemoText></template></turbo-stream><turbo-stream action="refresh" method="morph" request-id="demo-live-document-refresh-morph-link-1"></turbo-stream>';
  const requests: RecordedRequest[] = [];
  const clock = new ManualClock();
  const proof = await createDemoLiveDocumentRefreshMorphRuntime({
    clock,
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
          text: async () => initialDocument,
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
      throw new Error("Unexpected standalone Rails originating refresh-morph request");
    },
    origin: "http://demo.example:3000",
  });
  let renderer: ReactTestRenderer | undefined;
  const errors: (Error | undefined)[] = [];
  const unsubscribeErrors = proof.subscribeErrors((error) => {
    errors.push(error);
  });

  try {
    await act(async () => {
      renderer = create(createElement(DemoLiveDocumentRefreshMorphPanel, { proof }));
      await nextTurn();
    });
    const initialResponse = proof.session.tree.getElementById("demo-document-refresh-morph-response");
    if (!initialResponse) throw new Error("The Rails suppression document is missing its canonical response");
    const initialResponseText = nodeTextContent(initialResponse);

    const streamLink = renderer?.root
      .findAllByProps({ accessibilityRole: "link" })
      .find(
        (candidate) =>
          candidate.props.accessibilityLabel === "Echo request ID and suppress document refresh" &&
          typeof candidate.props.onPress === "function",
      );
    if (!streamLink) throw new Error("The Rails originating-refresh link is missing its native handler");
    await act(async () => {
      streamLink.props.onPress();
      await nextTurn();
      await nextTurn();
    });

    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({
      request: {
        headers: {
          Accept: `${TURBO_STREAM_MIME_TYPE}, ${EXPO_TURBO_MIME_TYPE}`,
          "X-Turbo-Request-Id": "demo-live-document-refresh-morph-link-1",
        },
        method: "GET",
      },
      url: streamUrl,
    });
    const suppression = proof.session.tree.getElementById("demo-document-refresh-morph-suppression");
    expect(suppression ? nodeTextContent(suppression) : undefined).toBe(
      "Rails echoed the originating request ID, so the document Refresh Stream was suppressed.",
    );
    expect(clock.timers).toHaveLength(1);

    await act(async () => {
      clock.fire(0);
      await nextTurn();
    });

    expect(requests).toHaveLength(2);
    const response = proof.session.tree.getElementById("demo-document-refresh-morph-response");
    expect(response ? nodeTextContent(response) : undefined).toBe(initialResponseText);
    expect(errors.at(-1)).toBeUndefined();
  } finally {
    await act(async () => {
      renderer?.unmount();
      await Promise.resolve();
    });
    await nextTurn();
    unsubscribeErrors();
    proof.dispose();
  }
});
