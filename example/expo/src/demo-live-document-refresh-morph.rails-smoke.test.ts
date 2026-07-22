/// <reference types="bun" />

import { expect, mock, test } from "bun:test";
import { EXPO_TURBO_MIME_TYPE, nodeTextContent } from "expo-turbo/core";
import { createElement } from "react";

import { nativeDemoLiveFetch, type DemoLiveFetchRequest } from "./demo-live-transport";

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
  TextInput: (props: Readonly<Record<string, unknown>>) => createElement("text-input", props),
  View: (props: Readonly<Record<string, unknown>>) => createElement("view", props),
}));

const {
  createDemoLiveDocumentRefreshMorphRuntime,
  resolveDemoLiveDocumentRefreshMorphEndpoints,
} = await import("./demo-live-document-refresh-morph");

const origin = process.env.EXPO_TURBO_DEMO_ORIGIN;
const liveTest = origin ? test : test.skip;
const TURBO_STREAM_MIME_TYPE = "text/vnd.turbo-stream.html";

type RecordedRequest = Readonly<{ request: DemoLiveFetchRequest; url: string }>;

async function waitFor(check: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}

liveTest("applies the Rails current-document Refresh Stream morph through one canonical native GET", async () => {
  if (!origin) throw new Error("EXPO_TURBO_DEMO_ORIGIN is required for the Rails refresh-morph smoke");

  const endpoints = resolveDemoLiveDocumentRefreshMorphEndpoints(origin);
  const requests: RecordedRequest[] = [];
  const proof = await createDemoLiveDocumentRefreshMorphRuntime({
    fetch: async (url, request) => {
      requests.push({ request, url });
      return nativeDemoLiveFetch(url, request);
    },
    origin,
  });

  try {
    const rootBefore = proof.session.tree.getElementById("demo-document-refresh-morph");
    const probeBefore = proof.session.tree.getElementById("demo-document-refresh-morph-probe");
    const initialResponse = proof.session.tree.getElementById("demo-document-refresh-morph-response");
    if (!rootBefore || !probeBefore || !initialResponse) {
      throw new Error("The standalone Rails refresh-morph document is incomplete");
    }
    const initialResponseText = nodeTextContent(initialResponse);

    await expect(
      proof.formLinks.submit(
        "id:demo-document-refresh-morph-link",
        "/api/expo_turbo/demo/stream?mode=refresh-morph",
      ),
    ).resolves.toMatchObject({
      application: "stream",
      destination: { kind: "document" },
      status: "applied",
    });

    await waitFor(
      () => requests.filter((request) => request.url === endpoints.documentUrl).length === 2,
      "The Rails Refresh Stream did not trigger its canonical document GET",
    );

    const streamRequest = requests.find((request) => request.url === endpoints.streamUrl);
    const refreshedDocumentRequest = requests.filter(
      (request) => request.url === endpoints.documentUrl,
    )[1];
    expect(streamRequest).toMatchObject({
      request: {
        headers: {
          Accept: `${TURBO_STREAM_MIME_TYPE}, ${EXPO_TURBO_MIME_TYPE}`,
          "X-Turbo-Request-Id": "demo-live-document-refresh-morph-link-1",
        },
        method: "GET",
      },
      url: endpoints.streamUrl,
    });
    expect(refreshedDocumentRequest).toMatchObject({
      request: {
        headers: {
          Accept: EXPO_TURBO_MIME_TYPE,
          "X-Turbo-Request-Id": "demo-live-document-refresh-morph-2",
        },
        method: "GET",
      },
      url: endpoints.documentUrl,
    });
    expect(refreshedDocumentRequest?.request.headers["Turbo-Frame"]).toBeUndefined();
    expect(proof.session.tree.getElementById("demo-document-refresh-morph")).toBe(rootBefore);
    expect(proof.session.tree.getElementById("demo-document-refresh-morph-probe")).toBe(probeBefore);
    const refreshedResponse = proof.session.tree.getElementById("demo-document-refresh-morph-response");
    expect(refreshedResponse ? nodeTextContent(refreshedResponse) : undefined)
      .not.toBe(initialResponseText);
  } finally {
    proof.dispose();
  }
});
