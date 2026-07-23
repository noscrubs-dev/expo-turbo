/// <reference types="bun" />

import { expect, test } from "bun:test";
import {
  ContentTypeError,
  DocumentRequestLoader,
  DocumentSession,
  FrameMissingError,
  FrameRequestLoader,
  nodeTextContent,
  parseExpoTurboDocument,
} from "expo-turbo/core";

import { createDemoLiveFetchAdapter, nativeDemoLiveFetch } from "./demo-live-transport";

const origin = process.env.EXPO_TURBO_DEMO_ORIGIN;
const liveTest = origin ? test : test.skip;
const FRAME_ID = "demo-response-frame";
const MATRIX_PATH = "/api/expo_turbo/demo/response_scenarios";

function url(base: string, scenario: string): string {
  return new URL(`${MATRIX_PATH}/${scenario}`, base).toString();
}

liveTest("applies the standalone Rails document response matrix through the public loader", async () => {
  if (!origin) throw new Error("EXPO_TURBO_DEMO_ORIGIN is required for the Rails response smoke");

  const base = new URL(origin).origin;
  const session = new DocumentSession(
    parseExpoTurboDocument('<Gallery id="response-matrix-loading" />', {
      url: url(base, "document-client-error"),
    }),
  );
  let requestId = 0;
  const loader = new DocumentRequestLoader(
    session,
    createDemoLiveFetchAdapter(nativeDemoLiveFetch),
    { next: () => `response-matrix-document-${++requestId}` },
  );

  await expect(loader.load(url(base, "document-client-error"))).resolves.toMatchObject({
    classification: "client-error",
    responseStatus: 422,
    status: "committed",
  });
  expect(nodeTextContent(session.tree.getElementById("demo-response-status")!)).toBe(
    "Handled Rails XML response 422",
  );

  await expect(loader.load(url(base, "document-server-error"))).resolves.toMatchObject({
    classification: "server-error",
    responseStatus: 500,
    status: "committed",
  });
  expect(nodeTextContent(session.tree.getElementById("demo-response-status")!)).toBe(
    "Handled Rails XML response 500",
  );

  const tree = session.tree;
  await expect(loader.load(url(base, "empty"))).resolves.toMatchObject({
    classification: "success",
    responseStatus: 204,
    status: "empty",
  });
  expect(session.tree).toBe(tree);

  await expect(loader.load(url(base, "wrong-mime"))).rejects.toBeInstanceOf(ContentTypeError);
  expect(session.tree).toBe(tree);
});

liveTest("applies matching and delayed Rails Frames and rejects a missing Frame", async () => {
  if (!origin) throw new Error("EXPO_TURBO_DEMO_ORIGIN is required for the Rails response smoke");

  const base = new URL(origin).origin;
  const session = new DocumentSession(
    parseExpoTurboDocument(`<Gallery><turbo-frame id="${FRAME_ID}" /></Gallery>`, {
      url: url(base, "frame"),
    }),
  );
  let requestId = 0;
  const loader = new FrameRequestLoader(
    session,
    createDemoLiveFetchAdapter(nativeDemoLiveFetch),
    { next: () => `response-matrix-frame-${++requestId}` },
  );

  await expect(loader.load(FRAME_ID, url(base, "frame"))).resolves.toMatchObject({
    responseStatus: 200,
    status: "completed",
  });
  expect(nodeTextContent(session.tree.getElementById("demo-response-frame-message")!)).toBe(
    "Rendered from the Rails response matrix",
  );

  await expect(
    loader.load(FRAME_ID, `${url(base, "delayed-frame")}?delay_ms=25`),
  ).resolves.toMatchObject({
    responseStatus: 200,
    status: "completed",
  });

  const frame = session.tree.getElementById(FRAME_ID);
  await expect(loader.load(FRAME_ID, url(base, "missing-frame"))).rejects.toBeInstanceOf(
    FrameMissingError,
  );
  expect(session.tree.getElementById(FRAME_ID)).toBe(frame);
});
