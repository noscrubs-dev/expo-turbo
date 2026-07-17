import { Stack } from "expo-router";
import { EXPO_TURBO_STATUS } from "expo-turbo";
import {
  applyFrameResponse,
  dispatchTurboStreamFragment,
  DocumentSession,
  parseExpoTurboDocument,
} from "expo-turbo/core";
import { ExpoTurboProvider, ExpoTurboRoot } from "expo-turbo/react";
import { useMemo } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";

import { DEMO_DOCUMENT, DEMO_REGISTRY } from "../demo-registry";
import { createDemoFrameControllers } from "../demo-frame-controllers";
import { PROTOCOL_SMOKE } from "../protocol-smoke";
import { REGISTRY_CAPABILITY_SMOKE } from "../registry-smoke";

export default function HomeScreen() {
  const session = useMemo(
    () =>
      new DocumentSession(
        parseExpoTurboDocument(DEMO_DOCUMENT, {
          url: "https://example.test/demo",
        }),
      ),
    [],
  );
  const frames = useMemo(() => createDemoFrameControllers(session), [session]);

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
        frames={frames}
        registry={DEMO_REGISTRY}
        renderError={({ error }) => (
          <Text selectable style={{ color: "#a62525" }}>
            {error.name}: {error.message}
          </Text>
        )}
        session={session}
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
          applyFrameResponse(
            session,
            "preview-frame",
            '<turbo-frame id="preview-frame"><DemoCard title="Loaded Frame response"><DemoText>The mounted Frame wrapper stayed in place while its children changed.</DemoText></DemoCard></turbo-frame>',
            { finalUrl: "https://example.test/demo/frame" },
          )
        }
        style={({ pressed }) => ({
          alignItems: "center",
          backgroundColor: pressed ? "#3c4350" : "#59636e",
          borderRadius: 12,
          padding: 14,
        })}
      >
        <Text style={{ color: "white", fontSize: 15, fontWeight: "600" }}>
          Apply Frame response
        </Text>
      </Pressable>
    </ScrollView>
  );
}
