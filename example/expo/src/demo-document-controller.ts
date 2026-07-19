import type { ClockAdapter, FetchAdapter, TurboResponse } from "expo-turbo/adapters";
import {
  DocumentHistory,
  type DocumentHistoryHostAdapter,
  type DocumentHistoryState,
  type DocumentLoadReport,
  DocumentPreloader,
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
  bootstrapInitialState(
    state: DocumentHistoryState,
    currentState: () => DocumentHistoryState,
  ): DemoDocumentBootstrap;
  readonly controller: DocumentVisitController;
  readonly history: DocumentHistory;
  readonly preloader: DocumentPreloader;
  readonly snapshotCache: DocumentSnapshotCache;
  dispose(): void;
}

export interface DemoDocumentBootstrap {
  cancel(): void;
  readonly result: Promise<DocumentLoadReport>;
}

function statesEqual(left: DocumentHistoryState, right: DocumentHistoryState): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "unmanaged" && right.kind === "unmanaged") {
    return left.url === right.url;
  }
  if (left.kind !== "managed" || right.kind !== "managed") return false;
  return (
    left.entry.restorationIdentifier === right.entry.restorationIdentifier &&
    left.entry.restorationIndex === right.entry.restorationIndex &&
    left.entry.url === right.entry.url
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
  let preloadRequestId = 0;
  const preloader = new DocumentPreloader(
    session,
    fetchAdapter,
    { next: () => `demo-document-preload-${++preloadRequestId}` },
    snapshotCache,
  );
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
    bootstrapInitialState(
      state: DocumentHistoryState,
      currentState: () => DocumentHistoryState,
    ): DemoDocumentBootstrap {
      const targetUrl = state.kind === "managed" ? state.entry.url : state.url;
      const disposition = loader.classifyTopLevelSource(targetUrl);
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
      const assertCurrentState = (): undefined => {
        let current: DocumentHistoryState;
        try {
          current = currentState();
        } catch {
          throw new StateError("Demo Router cold-start restoration state is unavailable");
        }
        if (history.current || !statesEqual(current, state)) {
          throw new StateError("Demo Router cold-start restoration state changed");
        }
        return undefined;
      };
      const result = loader
        .load(expectedUrl, owner, {
          beforeClaim: assertCurrentState,
          beforeCommit(candidate) {
            assertCurrentState();
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
            assertCurrentState();
            history.initialize(state);
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
      preloader.cancelAll();
      controller.cancel();
      loader.cancel();
    },
    history,
    preloader,
    snapshotCache,
  });
}
