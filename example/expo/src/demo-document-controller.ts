import type { ClockAdapter, FetchAdapter, TurboRequest, TurboResponse } from "expo-turbo/adapters";
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
  DocumentVisitLifecycle,
  EXPO_TURBO_MIME_TYPE,
  StateError,
} from "expo-turbo/core";

import { DEMO_DOCUMENT } from "./demo-registry";

let demoHistoryRuntime = 0;

const LINKED_DOCUMENT = `<Gallery data-turbo-root="/demo">
  <DemoCard id="linked-document" title="Query-bearing document visit completed" style-tokens="tone:info space:comfortable surface:elevated">
    <DemoText>The app-owned native link retained source=gallery, repeated tag values, and an empty query value through the host-injected document controller and Router history.</DemoText>
  </DemoCard>
  <DemoDocumentLink href="/demo" data-turbo-action="restore">
    <DemoText>Restore the compatibility gallery from the document cache.</DemoText>
  </DemoDocumentLink>
</Gallery>`;

const CACHED_PREVIEW_DOCUMENT = `<Gallery data-turbo-root="/demo">
  <DemoCard id="cached-preview-document" title="Cached preview is visible" style-tokens="tone:info space:comfortable surface:elevated">
    <DemoText>This provisional document came from data-turbo-preload while its canonical response is still loading.</DemoText>
  </DemoCard>
</Gallery>`;

const CANONICAL_PREVIEW_DOCUMENT = `<Gallery data-turbo-root="/demo">
  <DemoCard id="canonical-preview-document" title="Canonical document replaced the preview" tone="positive" style-tokens="space:comfortable surface:elevated">
    <DemoText>The authoritative response replaced the cached preview and completed the document visit.</DemoText>
  </DemoCard>
  <DemoDocumentLink href="/demo" data-turbo-action="restore">
    <DemoText>Restore the compatibility gallery from the document cache.</DemoText>
  </DemoDocumentLink>
</Gallery>`;

const REFRESH_SCENARIO_DOCUMENT = `<Gallery data-turbo-root="/demo">
  <DemoCard id="refresh-ready-document" title="Refresh Stream is ready" style-tokens="tone:info space:comfortable surface:elevated">
    <DemoText>Scroll to the gallery control below, then dispatch one default Refresh Stream.</DemoText>
  </DemoCard>
  <DemoCard id="refresh-scroll-marker-one" title="Root-scroll marker one" style-tokens="space:comfortable">
    <DemoText>This scenario intentionally leaves the host control below the document content.</DemoText>
  </DemoCard>
  <DemoCard id="refresh-scroll-marker-two" title="Root-scroll marker two" style-tokens="space:comfortable">
    <DemoText>The reset belongs only to the owning gallery ScrollView.</DemoText>
  </DemoCard>
  <DemoCard id="refresh-scroll-marker-three" title="Root-scroll marker three" style-tokens="space:comfortable">
    <DemoText>Nested scroll regions and anchor restoration are separate host contracts.</DemoText>
  </DemoCard>
  <DemoCard id="refresh-scroll-marker-four" title="Root-scroll marker four" style-tokens="space:comfortable">
    <DemoText>The next document response has distinct XML so the commit is visible.</DemoText>
  </DemoCard>
  <DemoCard id="refresh-scroll-marker-five" title="Root-scroll marker five" style-tokens="space:comfortable">
    <DemoText>Use the host control after scrolling here to prove the one-shot reset.</DemoText>
  </DemoCard>
</Gallery>`;

const REFRESHED_DOCUMENT = `<Gallery data-turbo-root="/demo">
  <DemoCard id="refresh-completed-document" title="Refresh Stream committed" tone="positive" style-tokens="space:comfortable surface:elevated">
    <DemoText>The canonical XML replaced the scenario and reset the owning root ScrollView after React acknowledged this document.</DemoText>
  </DemoCard>
</Gallery>`;

const SAME_PATH_REPLACE_DOCUMENT = `<Gallery id="same-path-replace-root" data-turbo-root="/demo" data-turbo-refresh-method="morph">
  <DemoCard id="same-path-replace-card" title="Same-path replace morph is ready" style-tokens="tone:info space:comfortable surface:elevated">
    <DemoText>This document opts into the bounded native morph path for a fragment-free replace that keeps the /demo/linked pathname.</DemoText>
  </DemoCard>
  <DemoCard id="same-path-replace-marker-one" title="Root-scroll marker one" style-tokens="space:comfortable">
    <DemoText>The host control sits below several ordinary application cards so the root reset is visible on a physical device.</DemoText>
  </DemoCard>
  <DemoCard id="same-path-replace-marker-two" title="Root-scroll marker two" style-tokens="space:comfortable">
    <DemoText>The active document keeps its pathname while its query changes and Router history replaces the focused entry.</DemoText>
  </DemoCard>
  <DemoCard id="same-path-replace-marker-three" title="Root-scroll marker three" style-tokens="space:comfortable">
    <DemoText>No cached preview is rendered for this page-refresh-shaped visit; the canonical XML remains authoritative.</DemoText>
  </DemoCard>
  <DemoCard id="same-path-replace-marker-four" title="Root-scroll marker four" style-tokens="space:comfortable">
    <DemoText>The default root metadata resets the owning ScrollView only after React acknowledges the committed tree.</DemoText>
  </DemoCard>
  <DemoDocumentLink href="/demo/linked?replace=morph&amp;revision=next" data-turbo-action="replace">
    <DemoText>Commit a same-path replace morph and reset the owning root scroll.</DemoText>
  </DemoDocumentLink>
</Gallery>`;

const SAME_PATH_REPLACED_DOCUMENT = `<Gallery id="same-path-replace-root" data-turbo-root="/demo" data-turbo-refresh-method="morph">
  <DemoCard id="same-path-replace-card" title="Same-path replace morph committed" tone="positive" style-tokens="space:comfortable surface:elevated">
    <DemoText>The canonical document morphed this stable application card and then reset the owning root ScrollView after React acknowledged it.</DemoText>
  </DemoCard>
  <DemoCard id="same-path-replace-result" title="Canonical replace result" style-tokens="space:comfortable">
    <DemoText>The focused Router history entry now owns revision=next without adding a second stack entry.</DemoText>
  </DemoCard>
</Gallery>`;

const HISTORY_SCROLL_DOCUMENT = `<Gallery data-turbo-root="/demo">
  <DemoCard id="history-scroll-linked-document" title="Native history scroll restoration is ready" tone="positive" style-tokens="space:comfortable surface:elevated">
    <DemoText>Use the native iOS back action to return to the saved gallery root-scroll checkpoint without another document GET.</DemoText>
  </DemoCard>
</Gallery>`;

const AUTOFOCUS_SCROLL_DOCUMENT = `<Gallery data-turbo-root="/demo">
  <DemoCard id="autofocus-scroll-proof" title="Root autofocus-scroll proof" tone="positive" style-tokens="space:comfortable surface:elevated">
    <DemoText>The document owns one autofocus candidate below a measured root viewport. The example asks its explicit root ScrollView adapter to reveal that focused native field.</DemoText>
  </DemoCard>
  <DemoCard id="autofocus-scroll-spacer-one" title="Measured spacer one" style-tokens="space:comfortable">
    <DemoText>These ordinary cards keep the target below the initial viewport without relying on virtualized or inferred scroll containers.</DemoText>
  </DemoCard>
  <DemoCard id="autofocus-scroll-spacer-two" title="Measured spacer two" style-tokens="space:comfortable">
    <DemoText>The adapter compares exact window-coordinate rectangles for this root ScrollView and the registered input.</DemoText>
  </DemoCard>
  <DemoCard id="autofocus-scroll-spacer-three" title="Measured spacer three" style-tokens="space:comfortable">
    <DemoText>It requests nearest-edge scrolling only after the renderer has successfully focused the candidate.</DemoText>
  </DemoCard>
  <DemoCard id="autofocus-scroll-spacer-four" title="Measured spacer four" style-tokens="space:comfortable">
    <DemoText>Missing geometry is retained as one pending example-host request until the root and input measurements arrive.</DemoText>
  </DemoCard>
  <DemoCard id="autofocus-scroll-spacer-five" title="Measured spacer five" style-tokens="space:comfortable">
    <DemoText>No generic node discovery, nested scroll routing, virtualizer behavior, or physical completion promise is implied.</DemoText>
  </DemoCard>
  <DemoCard id="autofocus-scroll-spacer-six" title="Measured spacer six" style-tokens="space:comfortable">
    <DemoText>The root container is registered directly from the gallery ScrollView ref before renderer layout effects run.</DemoText>
  </DemoCard>
  <DemoCard id="autofocus-scroll-spacer-seven" title="Measured spacer seven" style-tokens="space:comfortable">
    <DemoText>This gives the iOS harness an observable offscreen autofocus target without changing ordinary Frame autoscroll behavior.</DemoText>
  </DemoCard>
  <DemoCard id="autofocus-scroll-target-card" title="Measured autofocus target" tone="positive" style-tokens="space:comfortable surface:elevated">
    <DemoForm id="root-autofocus-scroll-form">
      <DemoFormInput id="root-autofocus-scroll-target" autofocus="" label="Root autofocus scroll target" name="proof[target]" value="Focused and revealed" />
    </DemoForm>
  </DemoCard>
  <DemoDocumentLink href="/demo" data-turbo-action="restore">
    <DemoText>Restore the compatibility gallery from the document cache.</DemoText>
  </DemoDocumentLink>
</Gallery>`;

const GENERIC_ROUTE_DOCUMENT = `<Gallery data-turbo-root="/demo">
  <DemoCard id="generic-route-document" title="Generic nested Router path reached" tone="positive" style-tokens="space:comfortable surface:elevated">
    <DemoText>The standalone host safely mapped this document's nested /demo/routes/ios-proof/details path into Expo Router catch-all segments while the opaque history entry retained its repeated and empty query values.</DemoText>
  </DemoCard>
  <DemoDocumentLink href="/demo" data-turbo-action="restore">
    <DemoText>Restore the compatibility gallery from the document cache.</DemoText>
  </DemoDocumentLink>
</Gallery>`;

const DIRECT_QUERY_ROUTE_DOCUMENT = `<Gallery data-turbo-root="/demo">
  <DemoCard id="direct-query-route-document" title="Direct Router query reached" tone="positive" style-tokens="space:comfortable surface:elevated">
    <DemoText>The cold native link reached this document only after the catch-all path and Router-canonical query state agreed, then history metadata was repaired inside the document commit.</DemoText>
  </DemoCard>
  <DemoDocumentLink href="/demo" data-turbo-action="restore">
    <DemoText>Restore the compatibility gallery from the document cache.</DemoText>
  </DemoDocumentLink>
</Gallery>`;

const PREVIEW_REVALIDATION_DELAY_MS = 4_000;

export const DEMO_CLOCK: ClockAdapter = {
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: Date.now,
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
};

export interface DemoFixtureFetchAdapter extends FetchAdapter {
  armRefreshScenario(url: string): () => void;
}

export function createDemoFixtureFetchAdapter(
  clock: ClockAdapter = DEMO_CLOCK,
): DemoFixtureFetchAdapter {
  let refreshScenarioArm = 0;
  let refreshScenarioPending: number | undefined;

  return Object.freeze({
    async fetch(request: TurboRequest): Promise<TurboResponse> {
      const url = new URL(request.url);
      let xml: string;
      if (url.pathname === "/demo/linked" && url.search === "?replace=morph") {
        xml = SAME_PATH_REPLACE_DOCUMENT;
      } else if (url.pathname === "/demo/linked" && url.search === "?replace=morph&revision=next") {
        xml = SAME_PATH_REPLACED_DOCUMENT;
      } else if (url.pathname === "/demo") {
        xml = DEMO_DOCUMENT;
      } else if (url.pathname === "/demo/linked" && url.search === "?preview=automatic") {
        xml =
          request.headers["X-Sec-Purpose"] === "prefetch"
            ? CACHED_PREVIEW_DOCUMENT
            : await delayedFixtureXml(
                clock,
                request.signal,
                CANONICAL_PREVIEW_DOCUMENT,
                PREVIEW_REVALIDATION_DELAY_MS,
              );
      } else if (url.pathname === "/demo/linked" && url.search === "?refresh=scroll") {
        xml = refreshScenarioPending === undefined ? REFRESH_SCENARIO_DOCUMENT : REFRESHED_DOCUMENT;
        refreshScenarioPending = undefined;
      } else if (url.pathname === "/demo/linked" && url.search === "?history=scroll") {
        xml = HISTORY_SCROLL_DOCUMENT;
      } else if (url.pathname === "/demo/linked" && url.search === "?autofocus=scroll") {
        xml = AUTOFOCUS_SCROLL_DOCUMENT;
      } else if (url.pathname === "/demo/routes/ios-proof/details") {
        xml =
          url.searchParams.get("source") === "direct"
            ? DIRECT_QUERY_ROUTE_DOCUMENT
            : GENERIC_ROUTE_DOCUMENT;
      } else {
        xml = LINKED_DOCUMENT;
      }
      return {
        headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
        redirected: false,
        status: 200,
        text: async () => xml,
        url: request.url,
      };
    },
    armRefreshScenario(source: string): () => void {
      const url = new URL(source);
      if (url.pathname !== "/demo/linked" || url.search !== "?refresh=scroll") {
        return () => undefined;
      }
      const arm = ++refreshScenarioArm;
      refreshScenarioPending = arm;
      return () => {
        if (refreshScenarioPending === arm) refreshScenarioPending = undefined;
      };
    },
  });
}

function delayedFixtureXml(
  clock: ClockAdapter,
  signal: AbortSignal | undefined,
  xml: string,
  delayMs: number,
): Promise<string> {
  if (signal?.aborted) return Promise.reject(demoFixtureAbortError());

  return new Promise<string>((resolve, reject) => {
    let settled = false;
    let handle: unknown;
    const cleanup = () => signal?.removeEventListener("abort", abort);
    const abort = () => {
      if (settled) return;
      settled = true;
      if (handle !== undefined) clock.clearTimeout(handle);
      cleanup();
      reject(demoFixtureAbortError());
    };

    signal?.addEventListener("abort", abort, { once: true });
    handle = clock.setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(xml);
    }, delayMs);
  });
}

function demoFixtureAbortError(): Error {
  const error = new Error("Demo fixture request was aborted");
  error.name = "AbortError";
  return error;
}

export interface DemoDocumentRuntime {
  bootstrapInitialState(
    state: DocumentHistoryState,
    currentState: () => DocumentHistoryState,
  ): DemoDocumentBootstrap;
  readonly controller: DocumentVisitController;
  readonly history: DocumentHistory;
  readonly preloader: DocumentPreloader;
  readonly snapshotCache: DocumentSnapshotCache;
  readonly visitLifecycle: DocumentVisitLifecycle;
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
  fetchAdapter: FetchAdapter = createDemoFixtureFetchAdapter(),
  clock: ClockAdapter = DEMO_CLOCK,
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
  const visitLifecycle = new DocumentVisitLifecycle();
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
  const controller = new DocumentVisitController(loader, clock, {
    history,
    snapshotCache,
    visitLifecycle,
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
    visitLifecycle,
  });
}
