import type { FetchAdapter } from "expo-turbo/adapters";
import { Linking, Text } from "react-native";
import {
  DocumentFormControls,
  DocumentRefreshController,
  DocumentSession,
  FormSubmissionLifecycle,
  FormLinkSubmissionController,
  parseExpoTurboDocument,
  subscribeDocumentHistoryTraversal,
  StreamLifecycle,
  type FormSubmissionController,
  type FrameControllerRegistry,
} from "expo-turbo/core";
import { ExpoTurboProvider } from "expo-turbo/react";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
} from "react";

import { createDemoActionRuntime } from "./demo-actions";
import {
  DemoDocumentBoundary,
  DemoFormBoundary,
  DemoFrameBoundary,
  DemoFrameAutoscrollProvider,
  DemoVisibilityProvider,
} from "./demo-boundaries";
import { DemoDocumentRefreshScrollRegistry } from "./demo-document-refresh-scroll";
import { DemoFrameAutoscrollRegistry } from "./demo-frame-autoscroll";
import {
  createDemoDocumentRuntime,
  DEMO_CLOCK,
  type DemoDocumentRuntime,
} from "./demo-document-controller";
import { createDemoFrameControllers } from "./demo-frame-controllers";
import { DemoFocusProvider, DemoFocusRegistry } from "./demo-focus";
import { DEMO_FORM_ANNOUNCEMENTS } from "./demo-form-announcement-runtime";
import { createDemoFormController } from "./demo-form-controller";
import { DEMO_DOCUMENT, DEMO_REGISTRY } from "./demo-registry";
import { DemoRouterHistoryBridge } from "./demo-router-history";
import { DEMO_STYLE_ADAPTER } from "./demo-style-runtime";
import { DemoVisibilityRegistry } from "./demo-visibility";

type DemoActionRuntime = ReturnType<typeof createDemoActionRuntime>;

export interface DemoRuntime {
  readonly actionRuntime: DemoActionRuntime;
  readonly documentRuntime: DemoDocumentRuntime;
  readonly documentRefreshScroll: DemoDocumentRefreshScrollRegistry;
  readonly frameAutoscroll: DemoFrameAutoscrollRegistry;
  readonly formController: FormSubmissionController;
  readonly formLinks: FormLinkSubmissionController;
  readonly forms: DocumentFormControls;
  readonly focus: DemoFocusRegistry;
  readonly frames: FrameControllerRegistry;
  readonly navigation: DemoRouterHistoryBridge;
  readonly refresh: DocumentRefreshController;
  readonly session: DocumentSession;
  readonly submissionLifecycle: FormSubmissionLifecycle;
  readonly streamLifecycle: StreamLifecycle;
  readonly visibility: DemoVisibilityRegistry;
  dispose(): void;
}

export interface DemoRuntimeOptions {
  readonly documentFetch?: FetchAdapter;
}

const DemoRuntimeContext = createContext<DemoRuntime | undefined>(undefined);
const runtimeOwners = new WeakMap<DemoRuntime, number>();
let sharedRuntime: DemoRuntime | undefined;

export function createDemoRuntime(options: DemoRuntimeOptions = {}): DemoRuntime {
  const session = new DocumentSession(
    parseExpoTurboDocument(DEMO_DOCUMENT, {
      url: "https://example.test/demo",
    }),
  );
  let documentRuntime!: DemoDocumentRuntime;
  const navigation = new DemoRouterHistoryBridge({
    currentEntry: () => documentRuntime.history.current,
    openExternal: (url) => Linking.openURL(url).then(() => undefined),
  });
  documentRuntime = createDemoDocumentRuntime(
    session,
    navigation,
    options.documentFetch,
  );
  const refresh = new DocumentRefreshController(
    session,
    documentRuntime.controller,
    DEMO_CLOCK,
  );
  const actionRuntime = createDemoActionRuntime();
  const documentRefreshScroll = new DemoDocumentRefreshScrollRegistry();
  const focus = new DemoFocusRegistry();
  const frameAutoscroll = new DemoFrameAutoscrollRegistry();
  const visibility = new DemoVisibilityRegistry();
  const submissionLifecycle = new FormSubmissionLifecycle();
  const streamLifecycle = new StreamLifecycle();
  const frames = createDemoFrameControllers(
    session,
    navigation,
    documentRuntime.controller,
    refresh,
    documentRuntime.history,
    documentRuntime.snapshotCache,
    documentRuntime.visitLifecycle,
    streamLifecycle,
    visibility,
  );
  const formController = createDemoFormController(
    session,
    refresh,
    frames,
    documentRuntime.snapshotCache,
    navigation,
    documentRuntime.visitLifecycle,
    submissionLifecycle,
    streamLifecycle,
  );
  const forms = new DocumentFormControls(session, {
    focus,
    formSemantics: DEMO_REGISTRY,
    submissionController: formController,
  });
  let formLinkRequestId = 0;
  const formLinks = new FormLinkSubmissionController(session, formController, {
    next: () => `demo-generated-form-link-${++formLinkRequestId}`,
  });
  const unsubscribeTraversal = subscribeDocumentHistoryTraversal(
    navigation,
    documentRuntime.controller,
    {
      onError: (error) => navigation.reportError(error),
      onResult: () => navigation.clearError(),
    },
  );
  let disposed = false;

  return Object.freeze({
    actionRuntime,
    documentRuntime,
    documentRefreshScroll,
    frameAutoscroll,
    formController,
    formLinks,
    forms,
    focus,
    frames,
    navigation,
    refresh,
    session,
    submissionLifecycle,
    streamLifecycle,
    visibility,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      unsubscribeTraversal();
      navigation.dispose();
      forms.dispose();
      documentRefreshScroll.dispose();
      focus.dispose();
      frameAutoscroll.dispose();
      visibility.dispose();
      frames.dispose();
      refresh.dispose();
      documentRuntime.dispose();
      actionRuntime.state.dispose();
    },
  });
}

function getSharedDemoRuntime(): DemoRuntime {
  sharedRuntime ??= createDemoRuntime();
  return sharedRuntime;
}

function useDemoRuntimeOwner(runtime: DemoRuntime): void {
  useEffect(() => {
    runtimeOwners.set(runtime, (runtimeOwners.get(runtime) ?? 0) + 1);
    return () => {
      const owners = Math.max(0, (runtimeOwners.get(runtime) ?? 0) - 1);
      runtimeOwners.set(runtime, owners);
      queueMicrotask(() => {
        if (runtimeOwners.get(runtime) !== 0) return;
        runtimeOwners.delete(runtime);
        runtime.dispose();
        if (sharedRuntime === runtime) sharedRuntime = undefined;
      });
    };
  }, [runtime]);
}

export function DemoRuntimeProvider({
  children,
  runtime = getSharedDemoRuntime(),
}: Readonly<{ children?: ReactNode; runtime?: DemoRuntime }>) {
  useDemoRuntimeOwner(runtime);
  return (
    <DemoRuntimeContext.Provider value={runtime}>
      <DemoFocusProvider focus={runtime.focus}>
        <DemoVisibilityProvider visibility={runtime.visibility}>
          <DemoFrameAutoscrollProvider frameAutoscroll={runtime.frameAutoscroll}>
            <ExpoTurboProvider
              actions={runtime.actionRuntime.actions}
              autofocus={runtime.focus}
              documentComponent={DemoDocumentBoundary}
              documentController={runtime.documentRuntime.controller}
              documentHistoryScroll={runtime.documentRefreshScroll}
              documentPreloader={runtime.documentRuntime.preloader}
              documentRefreshScroll={runtime.documentRefreshScroll}
              frameAutoscroll={runtime.frameAutoscroll}
              frameComponent={DemoFrameBoundary}
              formComponent={DemoFormBoundary}
              formAnnouncements={DEMO_FORM_ANNOUNCEMENTS}
              formLinks={runtime.formLinks}
              frames={runtime.frames}
              forms={runtime.forms}
              navigation={runtime.navigation}
              registry={DEMO_REGISTRY}
              renderError={({ error }) => (
                <Text selectable style={{ color: "#a62525" }}>
                  {error.name}: {error.message}
                </Text>
              )}
              session={runtime.session}
              state={runtime.actionRuntime.state}
              styles={DEMO_STYLE_ADAPTER}
            >
              {children}
            </ExpoTurboProvider>
          </DemoFrameAutoscrollProvider>
        </DemoVisibilityProvider>
      </DemoFocusProvider>
    </DemoRuntimeContext.Provider>
  );
}

export function useDemoRuntime(): DemoRuntime {
  const runtime = useContext(DemoRuntimeContext);
  if (!runtime) throw new Error("The Expo Turbo demo runtime is not configured");
  return runtime;
}
