import type { ClockAdapter, TurboResponse } from "expo-turbo/adapters";
import {
  DocumentRequestLoader,
  type DocumentSession,
  DocumentVisitController,
  EXPO_TURBO_MIME_TYPE,
} from "expo-turbo/core";

import { DEMO_DOCUMENT } from "./demo-registry";

const LINKED_DOCUMENT = `<Gallery data-turbo-root="/demo">
  <DemoCard id="linked-document" title="Document visit completed" style-tokens="tone:info space:comfortable surface:elevated">
    <DemoText>The app-owned native link used the host-injected document controller and replaced this session from XML.</DemoText>
  </DemoCard>
  <DemoDocumentLink href="/demo">
    <DemoText>Return to the compatibility gallery.</DemoText>
  </DemoDocumentLink>
</Gallery>`;

const clock: ClockAdapter = {
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: Date.now,
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
};

export function createDemoDocumentController(
  session: DocumentSession,
): DocumentVisitController {
  let requestId = 0;
  return new DocumentVisitController(
    new DocumentRequestLoader(
      session,
      {
        async fetch(request): Promise<TurboResponse> {
          const url = new URL(request.url);
          const xml = url.pathname === "/demo" ? DEMO_DOCUMENT : LINKED_DOCUMENT;
          return {
            headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
            redirected: false,
            status: 200,
            text: async () => xml,
            url: request.url,
          };
        },
      },
      { next: () => `demo-document-${++requestId}` },
    ),
    clock,
  );
}
