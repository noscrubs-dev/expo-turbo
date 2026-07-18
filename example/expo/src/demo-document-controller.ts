import type { ClockAdapter, TurboResponse } from "expo-turbo/adapters";
import {
  DocumentHistory,
  DocumentRequestLoader,
  type DocumentSession,
  DocumentSnapshotCache,
  DocumentVisitController,
  EXPO_TURBO_MIME_TYPE,
} from "expo-turbo/core";

import { DEMO_DOCUMENT } from "./demo-registry";

const LINKED_DOCUMENT = `<Gallery data-turbo-root="/demo">
  <DemoCard id="linked-document" title="Document visit completed" style-tokens="tone:info space:comfortable surface:elevated">
    <DemoText>The app-owned native link used the host-injected document controller and replaced this session from XML.</DemoText>
  </DemoCard>
  <DemoDocumentLink href="/demo" data-turbo-action="restore">
    <DemoText>Restore the compatibility gallery from the document cache.</DemoText>
  </DemoDocumentLink>
</Gallery>`;

export const DEMO_CLOCK: ClockAdapter = {
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: Date.now,
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
};

export interface DemoDocumentRuntime {
  readonly controller: DocumentVisitController;
  readonly history: DocumentHistory;
  readonly snapshotCache: DocumentSnapshotCache;
}

export function createDemoDocumentRuntime(
  session: DocumentSession,
): DemoDocumentRuntime {
  let requestId = 0;
  let restorationIdentifier = 0;
  const documentUrl = session.tree.document.url;
  if (!documentUrl) throw new Error("The Expo Turbo demo requires an active document URL");
  const history = new DocumentHistory(
    { next: () => `demo-history-${++restorationIdentifier}` },
    { write: () => undefined },
  );
  history.initialize({
    entry: {
      restorationIdentifier: "demo-history-current",
      restorationIndex: 0,
      url: documentUrl,
    },
    kind: "managed",
  });
  const snapshotCache = new DocumentSnapshotCache();
  return Object.freeze({
    controller: new DocumentVisitController(
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
      DEMO_CLOCK,
      { history, snapshotCache },
    ),
    history,
    snapshotCache,
  });
}
