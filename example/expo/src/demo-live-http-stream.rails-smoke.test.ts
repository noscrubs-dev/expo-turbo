/// <reference types="bun" />

import { expect, mock, test } from "bun:test";
import { EXPO_TURBO_MIME_TYPE, nodeTextContent } from "expo-turbo/core";
import { createElement } from "react";

import { nativeDemoLiveFetch } from "./demo-live-transport";

import type { DemoLiveCableFetchRequest } from "./demo-live-cable";

mock.module("react-native", () => ({
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

const { createDemoLiveCableRuntime } = await import("./demo-live-cable");
const origin = process.env.EXPO_TURBO_DEMO_ORIGIN;
const liveTest = origin ? test : test.skip;
const TURBO_STREAM_MIME_TYPE = "text/vnd.turbo-stream.html";

type RecordedRequest = Readonly<{ request: DemoLiveCableFetchRequest; url: string }>;

liveTest("applies the standalone Rails HTTP Stream link through the native generated-form path", async () => {
  if (!origin) throw new Error("EXPO_TURBO_DEMO_ORIGIN is required for the Rails HTTP Stream smoke");

  const streamUrl = new URL("/api/expo_turbo/demo/stream", new URL(origin).origin).toString();
  const requests: RecordedRequest[] = [];
  const proof = await createDemoLiveCableRuntime({
    fetch: async (url, request) => {
      requests.push({ request, url });
      return nativeDemoLiveFetch(url, request);
    },
    origin,
  });

  try {
    await expect(
      proof.formLinks.submit("id:demo-http-stream-link", "/api/expo_turbo/demo/stream"),
    ).resolves.toMatchObject({
      application: "stream",
      destination: { kind: "document" },
      status: "applied",
    });

    const streamRequest = requests.find((request) => request.url === streamUrl);
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
    proof.dispose();
  }
});
