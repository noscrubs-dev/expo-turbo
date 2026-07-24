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
import {
  type ExpoTurboFrameBoundaryProps,
  ExpoTurboProvider,
  ExpoTurboRoot,
} from "expo-turbo/react";
import {
  type ComponentType,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import * as ReactNative from "react-native";
import { Text, View } from "react-native";

import { DemoFocusProvider, DemoFocusRegistry } from "./demo-focus";
import { DEMO_REGISTRY } from "./demo-registry";
import { DEMO_STYLE_ADAPTER } from "./demo-style-runtime";
import {
  createDemoLiveFetchAdapter,
  nativeDemoLiveFetch,
  type DemoLiveFetch,
} from "./demo-live-transport";
import { DemoVisibilityRegistry } from "./demo-visibility";

const FORM_PATH = "/api/expo_turbo/demo/form";
const FRAME_ID = "demo-form-frame";
const liveRuntimeOwners = new WeakMap<DemoLiveFormRuntime, number>();

export interface DemoLiveFormRuntimeOptions {
  readonly fetch?: DemoLiveFetch;
  readonly origin: string;
  readonly visibility?: DemoVisibilityRegistry;
}

export interface DemoLiveFormRuntime {
  dispose(): void;
  readonly focus: DemoFocusRegistry;
  readonly frameComponent?: ComponentType<ExpoTurboFrameBoundaryProps>;
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

function loadingDocument(formUrl: string, lazy: boolean): string {
  return `<Gallery id="demo-live-form"><turbo-frame id="${FRAME_ID}"${lazy ? ' loading="lazy"' : ""} src="${formUrl}"><DemoText id="demo-live-form-loading">Loading the standalone Rails form</DemoText></turbo-frame></Gallery>`;
}

function createVisibleFrameComponent(
  visibility: DemoVisibilityRegistry,
): ComponentType<ExpoTurboFrameBoundaryProps> {
  return function VisibleFrame({ children, state }: ExpoTurboFrameBoundaryProps) {
    const boundary = useRef<View>(null);

    useLayoutEffect(
      () =>
        visibility.register(state.frameId, (listener) => {
          boundary.current?.measureInWindow(listener);
        }),
      [state.frameId],
    );

    return (
      <View
        collapsable={false}
        onLayout={() => visibility.remeasure(state.frameId)}
        ref={boundary}
        style={{ gap: 8 }}
      >
        {children}
      </View>
    );
  };
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
  const frameComponent = options.visibility
    ? createVisibleFrameComponent(options.visibility)
    : undefined;
  const session = new DocumentSession(
    parseExpoTurboDocument(loadingDocument(formUrl, options.visibility !== undefined), { url: formUrl }),
  );
  const transport: FetchAdapter = createDemoLiveFetchAdapter(fetch);
  let frameRequestId = 0;
  const frames = new FrameControllerRegistry(
    session,
    new FrameRequestLoader(session, transport, {
      next: () => `demo-live-form-frame-${++frameRequestId}`,
    }),
    options.visibility,
  );
  const focus = new DemoFocusRegistry();
  const state = new DocumentStateStore();
  const forms = new DocumentFormControls(session, {
    focus,
    ...(frameComponent ? { frameComponent } : {}),
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
        defaultDirection={ReactNative.I18nManager?.isRTL ? "rtl" : "ltr"}
        frameComponent={proof.frameComponent}
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

export function DemoLiveFormPanel({
  proof,
  showExplanation = true,
}: Readonly<{ proof: DemoLiveFormRuntime; showExplanation?: boolean }>) {
  const [error, setError] = useState<Error>();

  useEffect(() => proof.frames.get(FRAME_ID).subscribeErrors(setError), [proof]);

  return (
    <View
      testID="demo-live-form-panel"
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
      {showExplanation ? (
        <Text selectable style={{ color: "#435160", lineHeight: 20 }}>
          This native-only panel loads one canonical Rails Frame form. Ordinary invalid names render
          matching 422 XML. The explicit local-draft action instead uses a standard 422 Stream morph:
          compatible native components retain their draft while Rails adds the validation error. Complete
          a valid name without replacing this Frame, save it to follow the canonical redirect, or use the
          narrowly scoped text/plain submitter for the same Rails-owned response path. It also starts with
          one bounded, host-owned Blob and can replace it through the native Files picker; the Rails demo
          accepts only a bounded UTF-8 text/plain file and discards its bytes after validation.
        </Text>
      ) : null}
      <DemoLiveFormRuntimeProvider proof={proof}>
        <ExpoTurboRoot />
      </DemoLiveFormRuntimeProvider>
      {error ? (
        <Text selectable style={{ color: "#a62525" }}>
          {error.name}: {error.message}
        </Text>
      ) : null}
    </View>
  );
}

export function DemoLiveFormProof({
  origin,
  showExplanation,
  visibility,
}: Readonly<{
  origin: string;
  showExplanation?: boolean;
  visibility?: DemoVisibilityRegistry;
}>) {
  const result = useMemo<DemoLiveFormInitialization>(() => {
    try {
      return Object.freeze({ proof: createDemoLiveFormRuntime({ origin, visibility }) });
    } catch (nextError) {
      return Object.freeze({ error: asDisplayError(nextError) });
    }
  }, [origin, visibility]);

  if (result.error) {
    return (
      <Text selectable style={{ color: "#a62525" }}>
        {result.error.name}: {result.error.message}
      </Text>
    );
  }
  if (!result.proof) throw new StateError("Standalone Rails form initialization failed");
  return <DemoLiveFormPanel proof={result.proof} showExplanation={showExplanation} />;
}
