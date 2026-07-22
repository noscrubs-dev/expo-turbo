import type { FetchAdapter } from "expo-turbo/adapters";
import {
  DocumentFormControls,
  DocumentSession,
  DocumentStateStore,
  ExpoTurboError,
  FormSubmissionController,
  FrameControllerRegistry,
  FrameRequestLoader,
  parseExpoTurboDocument,
  StateError,
} from "expo-turbo/core";
import { ExpoTurboProvider, ExpoTurboRoot } from "expo-turbo/react";
import { type ReactNode, useEffect, useMemo } from "react";
import { Text, View } from "react-native";

import { DemoFocusProvider, DemoFocusRegistry } from "./demo-focus";
import { DEMO_REGISTRY } from "./demo-registry";
import { DEMO_STYLE_ADAPTER } from "./demo-style-runtime";
import {
  createDemoLiveFetchAdapter,
  nativeDemoLiveFetch,
  type DemoLiveFetch,
} from "./demo-live-transport";

const FORM_PATH = "/api/expo_turbo/demo/form";
const FRAME_ID = "demo-form-frame";
const liveRuntimeOwners = new WeakMap<DemoLiveFormRuntime, number>();

export interface DemoLiveFormRuntimeOptions {
  readonly fetch?: DemoLiveFetch;
  readonly origin: string;
}

export interface DemoLiveFormRuntime {
  dispose(): void;
  readonly focus: DemoFocusRegistry;
  readonly formUrl: string;
  readonly forms: DocumentFormControls;
  readonly frames: FrameControllerRegistry;
  readonly session: DocumentSession;
  readonly state: DocumentStateStore;
}

type DemoLiveFormInitialization = Readonly<{
  readonly error?: Error;
  readonly proof?: DemoLiveFormRuntime;
}>;

function asDisplayError(error: unknown): Error {
  return error instanceof ExpoTurboError
    ? error
    : new StateError("The standalone Rails form is unavailable");
}

function loadingDocument(formUrl: string): string {
  return `<Gallery id="demo-live-form"><turbo-frame id="${FRAME_ID}" src="${formUrl}"><DemoText id="demo-live-form-loading">Loading the standalone Rails form</DemoText></turbo-frame></Gallery>`;
}

export function resolveDemoLiveFormEndpoint(origin: string): string {
  return new URL(FORM_PATH, new URL(origin).origin).toString();
}

export function createDemoLiveFormRuntime(
  options: DemoLiveFormRuntimeOptions,
): DemoLiveFormRuntime {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new StateError("Standalone Rails form options are invalid");
  }
  const fetch = options.fetch ?? nativeDemoLiveFetch;
  if (typeof fetch !== "function") {
    throw new StateError("Standalone Rails form fetch is invalid");
  }
  const formUrl = resolveDemoLiveFormEndpoint(options.origin);
  const session = new DocumentSession(
    parseExpoTurboDocument(loadingDocument(formUrl), { url: formUrl }),
  );
  const transport: FetchAdapter = createDemoLiveFetchAdapter(fetch);
  let frameRequestId = 0;
  const frames = new FrameControllerRegistry(
    session,
    new FrameRequestLoader(session, transport, {
      next: () => `demo-live-form-frame-${++frameRequestId}`,
    }),
  );
  const focus = new DemoFocusRegistry();
  const state = new DocumentStateStore();
  const forms = new DocumentFormControls(session, {
    focus,
    formSemantics: DEMO_REGISTRY,
    submissionController: new FormSubmissionController(session, transport, {
      frameControllers: frames,
    }),
  });
  let disposed = false;

  return Object.freeze({
    dispose(): void {
      if (disposed) return;
      disposed = true;
      forms.dispose();
      frames.dispose();
      focus.dispose();
      state.dispose();
    },
    focus,
    formUrl,
    forms,
    frames,
    session,
    state,
  });
}

function useDemoLiveFormRuntimeOwner(proof: DemoLiveFormRuntime): void {
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

export function DemoLiveFormRuntimeProvider({
  children,
  proof,
}: Readonly<{ children?: ReactNode; proof: DemoLiveFormRuntime }>) {
  useDemoLiveFormRuntimeOwner(proof);
  return (
    <DemoFocusProvider focus={proof.focus}>
      <ExpoTurboProvider
        forms={proof.forms}
        frames={proof.frames}
        registry={DEMO_REGISTRY}
        renderError={({ error }) => (
          <Text selectable style={{ color: "#a62525" }}>
            {error.name}: {error.message}
          </Text>
        )}
        session={proof.session}
        state={proof.state}
        styles={DEMO_STYLE_ADAPTER}
      >
        {children}
      </ExpoTurboProvider>
    </DemoFocusProvider>
  );
}

export function DemoLiveFormPanel({ proof }: Readonly<{ proof: DemoLiveFormRuntime }>) {
  return (
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
        Standalone Rails Frame form
      </Text>
      <Text selectable style={{ color: "#435160", lineHeight: 20 }}>
        This native-only panel loads one canonical Rails Frame form. Validation stays server-owned:
        submit an unavailable name to render matching 422 XML, complete a valid name without
        replacing this Frame, save it to follow the canonical redirect, or use the narrowly scoped
        text/plain submitter for the same Rails-owned response path. It also starts with one bounded,
        host-owned Blob and can replace it through the native Files picker; the Rails demo accepts
        only a bounded UTF-8 text/plain file and discards its bytes after validation.
      </Text>
      <DemoLiveFormRuntimeProvider proof={proof}>
        <ExpoTurboRoot />
      </DemoLiveFormRuntimeProvider>
    </View>
  );
}

export function DemoLiveFormProof({ origin }: Readonly<{ origin: string }>) {
  const result = useMemo<DemoLiveFormInitialization>(() => {
    try {
      return Object.freeze({ proof: createDemoLiveFormRuntime({ origin }) });
    } catch (nextError) {
      return Object.freeze({ error: asDisplayError(nextError) });
    }
  }, [origin]);

  if (result.error) {
    return (
      <Text selectable style={{ color: "#a62525" }}>
        {result.error.name}: {result.error.message}
      </Text>
    );
  }
  if (!result.proof) throw new StateError("Standalone Rails form initialization failed");
  return <DemoLiveFormPanel proof={result.proof} />;
}
