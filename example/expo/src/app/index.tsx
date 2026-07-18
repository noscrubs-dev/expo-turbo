import { Stack } from "expo-router";
import { EXPO_TURBO_STATUS } from "expo-turbo";
import {
  dispatchTurboStreamFragment,
  DocumentRefreshController,
  DocumentFormControls,
  DocumentSession,
  FormLinkSubmissionController,
  parseExpoTurboDocument,
} from "expo-turbo/core";
import type { NavigationAdapter } from "expo-turbo/adapters";
import {
  type ExpoTurboDocumentBoundaryProps,
  type ExpoTurboFormBoundaryProps,
  type ExpoTurboFrameBoundaryProps,
  ExpoTurboProvider,
  ExpoTurboRoot,
} from "expo-turbo/react";
import { type Href, useRouter } from "expo-router";
import { useEffect, useMemo, useRef } from "react";
import { Linking, Platform, Pressable, ScrollView, Text, View } from "react-native";

import { DEMO_DOCUMENT, DEMO_REGISTRY } from "../demo-registry";
import { createDemoActionRuntime } from "../demo-actions";
import {
  createDemoDocumentRuntime,
  DEMO_CLOCK,
} from "../demo-document-controller";
import { createDemoFrameControllers } from "../demo-frame-controllers";
import { createDemoFormController } from "../demo-form-controller";
import { DEMO_FORM_ANNOUNCEMENTS } from "../demo-form-announcement-runtime";
import {
  demoFormAnnouncement,
  demoFormLiveRegion,
} from "../demo-form-announcements";
import { DEMO_STYLE_ADAPTER } from "../demo-style-runtime";
import { PROTOCOL_SMOKE } from "../protocol-smoke";
import { REGISTRY_CAPABILITY_SMOKE } from "../registry-smoke";

function DemoFrameBoundary({
  accessibilityState,
  children,
  state,
}: ExpoTurboFrameBoundaryProps) {
  return (
    <View style={{ gap: 8 }}>
      <View
        accessibilityLabel={`Frame ${state.frameId}: ${state.status}`}
        accessibilityState={accessibilityState}
        accessible
        style={{
          backgroundColor: "#f6f8fa",
          borderCurve: "continuous",
          borderRadius: 10,
          gap: 2,
          padding: 10,
        }}
      >
        <Text selectable style={{ color: "#435160", fontSize: 12 }}>
          Frame {state.frameId}
        </Text>
        <Text selectable style={{ color: "#435160", fontSize: 12 }}>
          {state.busy ? "Loading" : `Status: ${state.status}`}
        </Text>
      </View>
      {children}
    </View>
  );
}

function DemoDocumentBoundary({
  accessibilityState,
  children,
  state,
}: ExpoTurboDocumentBoundaryProps) {
  return (
    <View style={{ gap: 12 }}>
      <View
        accessibilityLabel={`Document visit: ${state.status}`}
        accessibilityState={accessibilityState}
        accessible
        style={{
          backgroundColor: "#eef6ff",
          borderCurve: "continuous",
          borderRadius: 10,
          gap: 2,
          padding: 10,
        }}
      >
        <Text selectable style={{ color: "#435160", fontSize: 12 }}>
          Document: {state.busy ? "Loading" : state.status}
        </Text>
        {state.progressVisible ? (
          <Text selectable style={{ color: "#435160", fontSize: 12 }}>
            Visit is taking longer than 500 ms…
          </Text>
        ) : null}
      </View>
      {children}
    </View>
  );
}

function DemoFormBoundary({
  accessibilityState,
  children,
  dismissTerminal,
  retryFailure,
  state,
  terminalState,
}: ExpoTurboFormBoundaryProps) {
  const retryRequestId = useRef(0);
  const failed =
    terminalState.status === "failed" ||
    terminalState.status === "committed-error";
  const retryable =
    terminalState.status === "failed" &&
    terminalState.retryDisposition === "safe";
  const announcement =
    terminalState.status === "none"
      ? undefined
      : demoFormAnnouncement(terminalState);
  const liveRegion = demoFormLiveRegion(Platform.OS, state.busy, terminalState);
  const label = state.busy
    ? "Submitting current form"
    : terminalState.status === "none"
      ? "No terminal submission result"
      : announcement?.message;

  return (
    <View style={{ gap: 10 }}>
      <View
        accessibilityLabel={label}
        accessibilityState={accessibilityState}
        accessible
        style={{
          backgroundColor: failed ? "#fff1f0" : "#eef6ff",
          borderColor: failed ? "#d14343" : "#9bbce0",
          borderRadius: 10,
          borderWidth: 1,
          gap: 8,
          padding: 10,
        }}
      >
        <Text selectable style={{ color: failed ? "#8d2020" : "#435160", fontSize: 12 }}>
          {label}
        </Text>
        {retryable ? (
          <Pressable
            accessibilityRole="button"
            disabled={state.busy}
            onPress={() => {
              void retryFailure({
                protocol: {
                  requestId: `demo-form-retry-${++retryRequestId.current}`,
                },
              }).catch(() => undefined);
            }}
            style={({ pressed }) => ({
              alignSelf: "flex-start",
              backgroundColor: pressed ? "#19375a" : "#285589",
              borderRadius: 8,
              paddingHorizontal: 12,
              paddingVertical: 8,
            })}
          >
            <Text style={{ color: "white", fontWeight: "600" }}>
              Retry from current values
            </Text>
          </Pressable>
        ) : null}
        {terminalState.status !== "none" && !state.busy ? (
          <Pressable accessibilityRole="button" onPress={dismissTerminal}>
            <Text style={{ color: "#285589", fontSize: 12 }}>Dismiss result</Text>
          </Pressable>
        ) : null}
      </View>
      {Platform.OS === "web" ? (
        <View
          style={{
            height: 1,
            left: -10000,
            overflow: "hidden",
            position: "absolute",
            width: 1,
          }}
        >
          <View aria-live="polite">
            <Text>{liveRegion === "polite" ? announcement?.message : ""}</Text>
          </View>
          <View aria-live="assertive">
            <Text>{liveRegion === "assertive" ? announcement?.message : ""}</Text>
          </View>
        </View>
      ) : null}
      {children}
    </View>
  );
}

export default function HomeScreen() {
  const router = useRouter();
  const session = useMemo(
    () =>
      new DocumentSession(
        parseExpoTurboDocument(DEMO_DOCUMENT, {
          url: "https://example.test/demo",
        }),
      ),
    [],
  );
  const documentRuntime = useMemo(
    () => createDemoDocumentRuntime(session),
    [session],
  );
  const documentController = documentRuntime.controller;
  const refresh = useMemo(
    () => new DocumentRefreshController(session, documentController, DEMO_CLOCK),
    [documentController, session],
  );
  const actionRuntime = useMemo(() => createDemoActionRuntime(), []);
  const navigation = useMemo<NavigationAdapter>(
    () => ({
      back: () => router.back(),
      openExternal: (url) => Linking.openURL(url).then(() => undefined),
      visit: (url, action) => {
        if (action === "restore") {
          router.back();
          return;
        }
        const resolved = new URL(url);
        const href = `${resolved.pathname}${resolved.search}` as Href;
        if (action === "replace") router.replace(href);
        else router.push(href);
      },
    }),
    [router],
  );
  const frames = useMemo(
    () =>
      createDemoFrameControllers(
        session,
        navigation,
        documentController,
        refresh,
        documentRuntime.history,
        documentRuntime.snapshotCache,
      ),
    [
      documentController,
      documentRuntime.history,
      documentRuntime.snapshotCache,
      navigation,
      refresh,
      session,
    ],
  );
  const formController = useMemo(
    () =>
      createDemoFormController(
        session,
        refresh,
        frames,
        documentRuntime.snapshotCache,
      ),
    [documentRuntime.snapshotCache, frames, refresh, session],
  );
  const forms = useMemo(
    () =>
      new DocumentFormControls(session, {
        formSemantics: DEMO_REGISTRY,
        submissionController: formController,
      }),
    [formController, session],
  );
  const formLinks = useMemo(() => {
    let requestId = 0;
    return new FormLinkSubmissionController(session, formController, {
      next: () => `demo-generated-form-link-${++requestId}`,
    });
  }, [formController, session]);
  useEffect(
    () => () => {
      refresh.dispose();
      documentController.cancel();
    },
    [documentController, refresh],
  );

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ gap: 16, padding: 24 }}
    >
      <Stack.Screen options={{ title: "Expo Turbo" }} />
      <View style={{ gap: 8 }}>
        <Text selectable style={{ fontSize: 28, fontWeight: "700" }}>
          Compatibility gallery
        </Text>
        <Text
          selectable
          style={{ color: "#59636e", fontSize: 16, lineHeight: 24 }}
        >
          The standalone device harness is ready for protocol scenarios.
        </Text>
      </View>
      <View
        style={{
          backgroundColor: "#eef6ff",
          borderCurve: "continuous",
          borderRadius: 16,
          gap: 6,
          padding: 16,
        }}
      >
        <Text selectable style={{ color: "#435160", fontSize: 13 }}>
          Package status
        </Text>
        <Text selectable style={{ fontSize: 17, fontWeight: "600" }}>
          {EXPO_TURBO_STATUS}
        </Text>
        <Text selectable style={{ color: "#435160", fontSize: 13 }}>
          Parser/tree/selector probe: {PROTOCOL_SMOKE}
        </Text>
        <Text selectable style={{ color: "#435160", fontSize: 13 }}>
          Registry capability: {REGISTRY_CAPABILITY_SMOKE}
        </Text>
      </View>
      <ExpoTurboProvider
        actions={actionRuntime.actions}
        documentComponent={DemoDocumentBoundary}
        documentController={documentController}
        frameComponent={DemoFrameBoundary}
        formComponent={DemoFormBoundary}
        formAnnouncements={DEMO_FORM_ANNOUNCEMENTS}
        formLinks={formLinks}
        frames={frames}
        forms={forms}
        navigation={navigation}
        registry={DEMO_REGISTRY}
        renderError={({ error }) => (
          <Text selectable style={{ color: "#a62525" }}>
            {error.name}: {error.message}
          </Text>
        )}
        session={session}
        state={actionRuntime.state}
        styles={DEMO_STYLE_ADAPTER}
      >
        <ExpoTurboRoot />
      </ExpoTurboProvider>
      <Pressable
        accessibilityRole="button"
        onPress={() =>
          dispatchTurboStreamFragment(
            session,
            '<turbo-stream action="update" target="static-renderer"><template><DemoText>Updated in place by an ordered Turbo Stream action.</DemoText></template></turbo-stream>',
          )
        }
        style={({ pressed }) => ({
          alignItems: "center",
          backgroundColor: pressed ? "#19375a" : "#285589",
          borderRadius: 12,
          padding: 14,
        })}
      >
        <Text style={{ color: "white", fontSize: 15, fontWeight: "600" }}>
          Apply Stream update
        </Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        onPress={() =>
          dispatchTurboStreamFragment(
            session,
            '<turbo-stream action="refresh" method="replace" target="ignored"><template><DemoText>Ignored refresh payload.</DemoText></template></turbo-stream>',
            { refresh },
          )
        }
        style={({ pressed }) => ({
          alignItems: "center",
          backgroundColor: pressed ? "#254a36" : "#34704d",
          borderRadius: 12,
          padding: 14,
        })}
      >
        <Text style={{ color: "white", fontSize: 15, fontWeight: "600" }}>
          Refresh current document
        </Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        onPress={() => {
          void frames
            .visit("/demo/frame", { frame: "preview-frame" })
            .catch(() => undefined);
        }}
        style={({ pressed }) => ({
          alignItems: "center",
          backgroundColor: pressed ? "#3c4350" : "#59636e",
          borderRadius: 12,
          padding: 14,
        })}
      >
        <Text style={{ color: "white", fontSize: 15, fontWeight: "600" }}>
          Visit Frame source
        </Text>
      </Pressable>
    </ScrollView>
  );
}
