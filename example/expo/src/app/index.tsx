import { Stack } from "expo-router";
import { EXPO_TURBO_STATUS } from "expo-turbo";
import {
  dispatchTurboStreamFragment,
  DocumentSession,
  parseExpoTurboDocument,
} from "expo-turbo/core";
import type { NavigationAdapter } from "expo-turbo/adapters";
import {
  type ExpoTurboDocumentBoundaryProps,
  type ExpoTurboFrameBoundaryProps,
  ExpoTurboProvider,
  ExpoTurboRoot,
} from "expo-turbo/react";
import { type Href, useRouter } from "expo-router";
import { useEffect, useMemo } from "react";
import { Linking, Pressable, ScrollView, Text, View } from "react-native";

import { DEMO_DOCUMENT, DEMO_REGISTRY } from "../demo-registry";
import { createDemoActionRuntime } from "../demo-actions";
import { createDemoDocumentController } from "../demo-document-controller";
import { createDemoFrameControllers } from "../demo-frame-controllers";
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
  const documentController = useMemo(
    () => createDemoDocumentController(session),
    [session],
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
    () => createDemoFrameControllers(session, navigation, documentController),
    [documentController, navigation, session],
  );
  useEffect(() => () => documentController.cancel(), [documentController]);

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
        frames={frames}
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
