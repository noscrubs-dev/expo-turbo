import type { ClockAdapter, FetchAdapter, TurboResponse } from "expo-turbo/adapters";
import {
  DocumentHistory,
  type DocumentHistoryEntry,
  type DocumentHistoryHostAdapter,
  type DocumentLoadReport,
  DocumentRequestLoader,
  type DocumentSession,
  DocumentSnapshotCache,
  DocumentVisitController,
  EXPO_TURBO_MIME_TYPE,
  StateError,
} from "expo-turbo/core";

import { DEMO_DOCUMENT } from "./demo-registry";

let demoHistoryRuntime = 0;

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
  bootstrapManagedEntry(
    entry: DocumentHistoryEntry,
    currentEntry: () => DocumentHistoryEntry | undefined,
  ): DemoDocumentBootstrap;
  readonly controller: DocumentVisitController;
  readonly history: DocumentHistory;
  readonly snapshotCache: DocumentSnapshotCache;
  dispose(): void;
}

export interface DemoDocumentBootstrap {
  cancel(): void;
  readonly result: Promise<DocumentLoadReport>;
}

function entriesEqual(
  left: DocumentHistoryEntry | undefined,
  right: DocumentHistoryEntry,
): boolean {
  return (
    left?.restorationIdentifier === right.restorationIdentifier &&
    left.restorationIndex === right.restorationIndex &&
    left.url === right.url
  );
}

export function createDemoDocumentRuntime(
  session: DocumentSession,
  historyHost: DocumentHistoryHostAdapter,
  fetchAdapter: FetchAdapter = {
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
): DemoDocumentRuntime {
  let requestId = 0;
  let restorationIdentifier = 0;
  const restorationNamespace = `demo-history-${Date.now().toString(36)}-${++demoHistoryRuntime}`;
  const documentUrl = session.tree.document.url;
  if (!documentUrl) throw new Error("The Expo Turbo demo requires an active document URL");
  const history = new DocumentHistory(
    { next: () => `${restorationNamespace}-${++restorationIdentifier}` },
    historyHost,
  );
  const snapshotCache = new DocumentSnapshotCache();
  const loader = new DocumentRequestLoader(
    session,
    fetchAdapter,
    { next: () => `demo-document-${++requestId}` },
  );
  const controller = new DocumentVisitController(loader, DEMO_CLOCK, {
    history,
    snapshotCache,
  });
  return Object.freeze({
    bootstrapManagedEntry(
      entry: DocumentHistoryEntry,
      currentEntry: () => DocumentHistoryEntry | undefined,
    ): DemoDocumentBootstrap {
      const disposition = loader.classifyTopLevelSource(entry.url);
      if (
        disposition.classification !== "visitable" ||
        new URL(disposition.url).hash !== ""
      ) {
        throw new StateError(
          "Demo Router cold-start restoration requires a root-visitable URL without a fragment",
        );
      }
      const expectedUrl = disposition.url;
      const owner = Object.freeze({});
      let settled = false;
      const assertCurrentEntry = (): undefined => {
        let current: DocumentHistoryEntry | undefined;
        try {
          current = currentEntry();
        } catch {
          throw new StateError("Demo Router cold-start restoration entry is unavailable");
        }
        if (history.current || !entriesEqual(current, entry)) {
          throw new StateError("Demo Router cold-start restoration entry changed");
        }
        return undefined;
      };
      const result = loader
        .load(expectedUrl, owner, {
          beforeClaim: assertCurrentEntry,
          beforeCommit(candidate) {
            assertCurrentEntry();
            if (
              candidate.status !== "committed" ||
              candidate.redirected ||
              candidate.url !== expectedUrl
            ) {
              throw new StateError(
                "Demo Router cold-start restoration requires an exact document response",
              );
            }
            return "commit";
          },
          beforeTreeCommit() {
            assertCurrentEntry();
            history.initialize(Object.freeze({ entry, kind: "managed" }));
            return undefined;
          },
        })
        .finally(() => {
          settled = true;
        });
      return Object.freeze({
        cancel(): void {
          if (!settled) loader.cancel(owner);
        },
        result,
      });
    },
    controller,
    dispose(): void {
      controller.cancel();
      loader.cancel();
    },
    history,
    snapshotCache,
  });
}
