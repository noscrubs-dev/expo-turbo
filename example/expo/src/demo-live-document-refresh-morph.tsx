import type { ClockAdapter } from "expo-turbo/adapters";
import {
  DocumentRefreshController,
  DocumentRequestLoader,
  DocumentSession,
  DocumentVisitController,
  ExpoTurboError,
  FormLinkSubmissionController,
  FormSubmissionController,
  FormSubmissionLifecycle,
  type FormSubmissionHandle,
  parseExpoTurboDocument,
  RequestError,
  StateError,
} from "expo-turbo/core";
import { ExpoTurboProvider, ExpoTurboRoot } from "expo-turbo/react";
import { type ReactNode, useEffect, useState } from "react";
import { Text, View } from "react-native";

import { DEMO_REGISTRY } from "./demo-registry";
import { DEMO_STYLE_ADAPTER } from "./demo-style-runtime";
import {
  createDemoLiveFetchAdapter,
  nativeDemoLiveFetch,
  type DemoLiveFetch,
} from "./demo-live-transport";

const DOCUMENT_PATH = "/api/expo_turbo/demo/refresh_morph_document";
const LOADING_DOCUMENT = `<Gallery id="demo-live-document-refresh-morph-loading"><DemoText id="demo-live-document-refresh-morph-loading-message">Loading the standalone Rails refresh-morph document</DemoText></Gallery>`;
const STREAM_PATH = "/api/expo_turbo/demo/stream?mode=refresh-morph";
const liveRuntimeOwners = new WeakMap<DemoLiveDocumentRefreshMorphRuntime, number>();
const nativeClock: ClockAdapter = {
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: Date.now,
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
};

export interface DemoLiveDocumentRefreshMorphRuntimeOptions {
  readonly clock?: ClockAdapter;
  readonly fetch?: DemoLiveFetch;
  readonly origin: string;
}

export interface DemoLiveDocumentRefreshMorphEndpoints {
  readonly documentUrl: string;
  readonly streamUrl: string;
}

export interface DemoLiveDocumentRefreshMorphRuntime {
  clearError(): void;
  readonly documentController: DocumentVisitController;
  dispose(): void;
  readonly endpoints: DemoLiveDocumentRefreshMorphEndpoints;
  readonly formLinks: FormLinkSubmissionController;
  readonly session: DocumentSession;
  subscribeErrors(listener: (error: Error | undefined) => void): () => void;
}

function asDisplayError(error: unknown): Error {
  return error instanceof ExpoTurboError
    ? error
    : new StateError("The standalone Rails document refresh morph is unavailable");
}

export function resolveDemoLiveDocumentRefreshMorphEndpoints(
  origin: string,
): DemoLiveDocumentRefreshMorphEndpoints {
  const base = new URL(origin).origin;
  return Object.freeze({
    documentUrl: new URL(DOCUMENT_PATH, base).toString(),
    streamUrl: new URL(STREAM_PATH, base).toString(),
  });
}

export async function createDemoLiveDocumentRefreshMorphRuntime(
  options: DemoLiveDocumentRefreshMorphRuntimeOptions,
): Promise<DemoLiveDocumentRefreshMorphRuntime> {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new StateError("Standalone Rails document refresh morph options are invalid");
  }
  const fetch = options.fetch ?? nativeDemoLiveFetch;
  if (typeof fetch !== "function") {
    throw new StateError("Standalone Rails document refresh morph fetch is invalid");
  }
  const endpoints = resolveDemoLiveDocumentRefreshMorphEndpoints(options.origin);
  const clock = options.clock ?? nativeClock;
  const session = new DocumentSession(
    parseExpoTurboDocument(LOADING_DOCUMENT, { url: endpoints.documentUrl }),
  );
  const transport = createDemoLiveFetchAdapter(fetch);
  let documentRequestId = 0;
  const loader = new DocumentRequestLoader(session, transport, {
    next: () => `demo-live-document-refresh-morph-${++documentRequestId}`,
  });
  const loaded = await loader.load(endpoints.documentUrl);
  if (loaded.status !== "committed") {
    throw new RequestError("The standalone Rails document refresh morph did not commit");
  }

  let error: Error | undefined;
  const errorListeners = new Set<(error: Error | undefined) => void>();
  const reportError = (nextError: Error | undefined): void => {
    error = nextError;
    for (const listener of [...errorListeners]) listener(error);
  };
  const visits = new DocumentVisitController(loader, clock);
  const refresh = new DocumentRefreshController(session, visits, clock, { onError: reportError });
  const submissionLifecycle = new FormSubmissionLifecycle();
  const activeFormSubmissions = new Set<FormSubmissionHandle>();
  const unsubscribeFormSubmissionStart = submissionLifecycle.subscribe("submit-start", (event) => {
    activeFormSubmissions.add(event.detail.formSubmission);
    return undefined;
  });
  const unsubscribeFormSubmissionEnd = submissionLifecycle.subscribe("submit-end", (event) => {
    activeFormSubmissions.delete(event.detail.formSubmission);
    return undefined;
  });
  const formController = new FormSubmissionController(session, transport, {
    onActionError: (report) => {
      if (report.error) reportError(report.error);
    },
    refresh,
    submissionLifecycle,
  });
  let streamRequestId = 0;
  const formLinks = new FormLinkSubmissionController(session, formController, {
    next: () => `demo-live-document-refresh-morph-link-${++streamRequestId}`,
  });
  let disposed = false;

  return Object.freeze({
    clearError(): void {
      reportError(undefined);
    },
    documentController: visits,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const submission of activeFormSubmissions) submission.stop();
      activeFormSubmissions.clear();
      unsubscribeFormSubmissionStart();
      unsubscribeFormSubmissionEnd();
      refresh.dispose();
      visits.cancel();
      errorListeners.clear();
      error = undefined;
    },
    endpoints,
    formLinks,
    session,
    subscribeErrors(listener: (nextError: Error | undefined) => void): () => void {
      if (typeof listener !== "function") {
        throw new StateError("Standalone Rails document refresh morph error listener is invalid");
      }
      errorListeners.add(listener);
      listener(error);
      return () => {
        errorListeners.delete(listener);
      };
    },
  });
}

function useDemoLiveDocumentRefreshMorphRuntimeOwner(
  proof: DemoLiveDocumentRefreshMorphRuntime,
): void {
  useEffect(() => {
    liveRuntimeOwners.set(proof, (liveRuntimeOwners.get(proof) ?? 0) + 1);
    return () => {
      const owners = Math.max(0, (liveRuntimeOwners.get(proof) ?? 0) - 1);
      liveRuntimeOwners.set(proof, owners);
      queueMicrotask(() => {
        if (liveRuntimeOwners.get(proof) !== 0) return;
        liveRuntimeOwners.delete(proof);
        proof.dispose();
      });
    };
  }, [proof]);
}

export function DemoLiveDocumentRefreshMorphRuntimeProvider({
  children,
  proof,
}: Readonly<{ children?: ReactNode; proof: DemoLiveDocumentRefreshMorphRuntime }>) {
  useDemoLiveDocumentRefreshMorphRuntimeOwner(proof);
  return (
    <ExpoTurboProvider
      documentController={proof.documentController}
      formLinks={proof.formLinks}
      registry={DEMO_REGISTRY}
      renderError={({ error }) => (
        <Text selectable style={{ color: "#a62525" }}>
          {error.name}: {error.message}
        </Text>
      )}
      session={proof.session}
      styles={DEMO_STYLE_ADAPTER}
    >
      {children}
    </ExpoTurboProvider>
  );
}

export function DemoLiveDocumentRefreshMorphPanel({
  proof,
}: Readonly<{ proof: DemoLiveDocumentRefreshMorphRuntime }>) {
  const [error, setError] = useState<Error | undefined>();

  useEffect(() => proof.subscribeErrors(setError), [proof]);

  return (
    <DemoLiveDocumentRefreshMorphRuntimeProvider proof={proof}>
      <View
        style={{
          borderColor: "#6d7f93",
          borderRadius: 12,
          borderWidth: 1,
          gap: 12,
          padding: 16,
        }}
      >
        <Text selectable style={{ fontSize: 18, fontWeight: "600" }}>
          Rails document Refresh morph
        </Text>
        <Text selectable style={{ color: "#435160", lineHeight: 20 }}>
          This native-only panel loads one ordinary Rails XML document. Its Rails-authored Stream
          link returns standard request-id-free refresh morph, then the document refresh controller
          performs one canonical GET. The server timestamp changes while the compatible local counter
          stays mounted. Its second link echoes the initiating request ID: the status changes from the
          sibling Stream action, while the matching Refresh Stream suppresses a duplicate document GET.
        </Text>
        <ExpoTurboRoot />
        {error ? (
          <Text selectable style={{ color: "#a62525" }}>
            {error.name}: {error.message}
          </Text>
        ) : null}
      </View>
    </DemoLiveDocumentRefreshMorphRuntimeProvider>
  );
}

export function DemoLiveDocumentRefreshMorphProof({ origin }: Readonly<{ origin: string }>) {
  const [error, setError] = useState<Error | undefined>();
  const [proof, setProof] = useState<DemoLiveDocumentRefreshMorphRuntime | undefined>();

  useEffect(() => {
    let disposed = false;
    let currentProof: DemoLiveDocumentRefreshMorphRuntime | undefined;
    void Promise.resolve()
      .then(() => {
        if (disposed) return undefined;
        setError(undefined);
        setProof(undefined);
        return createDemoLiveDocumentRefreshMorphRuntime({ origin });
      })
      .then((nextProof) => {
        if (disposed) {
          nextProof?.dispose();
          return;
        }
        if (!nextProof) return;
        currentProof = nextProof;
        setProof(nextProof);
      })
      .catch((nextError) => {
        if (!disposed) setError(asDisplayError(nextError));
      });
    return () => {
      disposed = true;
      currentProof?.dispose();
    };
  }, [origin]);

  if (error) {
    return (
      <Text selectable style={{ color: "#a62525" }}>
        {error.name}: {error.message}
      </Text>
    );
  }
  if (!proof) {
    return (
      <Text selectable style={{ color: "#435160" }}>
        Loading the standalone Rails document Refresh morph proof…
      </Text>
    );
  }
  return <DemoLiveDocumentRefreshMorphPanel proof={proof} />;
}
