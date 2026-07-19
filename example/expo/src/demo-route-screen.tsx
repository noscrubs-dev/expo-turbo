import {
  Stack,
  useIsFocused,
  useNavigation,
  useNavigationContainerRef,
  useRoute,
} from "expo-router";
import { EXPO_TURBO_STATUS } from "expo-turbo";
import { dispatchTurboStreamFragment } from "expo-turbo/core";
import { ExpoTurboRoot } from "expo-turbo/react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Pressable,
  ScrollView,
  Text,
  useWindowDimensions,
  View,
} from "react-native";

import type { DemoRouterNavigation } from "./demo-router-history";
import { DemoRouterRouteOwner } from "./demo-router-route-owner";
import { useDemoRuntime } from "./demo-runtime";
import { PROTOCOL_SMOKE } from "./protocol-smoke";
import { REGISTRY_CAPABILITY_SMOKE } from "./registry-smoke";

function CompatibilityGallery() {
  const runtime = useDemoRuntime();
  const window = useWindowDimensions();
  const scrollView = useRef<ScrollView>(null);
  const measureViewport = useCallback(() => {
    runtime.visibility.measureViewport((listener) => {
      scrollView.current?.getNativeScrollRef()?.measureInWindow(listener);
    });
  }, [runtime.visibility]);
  useEffect(() => {
    measureViewport();
  }, [measureViewport, window.height, window.width]);

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ gap: 16, padding: 24 }}
      onContentSizeChange={() => runtime.visibility.remeasure()}
      onLayout={measureViewport}
      onScroll={() => runtime.visibility.remeasure()}
      ref={scrollView}
      scrollEventThrottle={32}
    >
      <View style={{ gap: 8 }}>
        <Text selectable style={{ fontSize: 28, fontWeight: "700" }}>
          Compatibility gallery
        </Text>
        <Text selectable style={{ color: "#59636e", fontSize: 16, lineHeight: 24 }}>
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
      <ExpoTurboRoot />
      <Pressable
        accessibilityRole="button"
        onPress={() =>
          dispatchTurboStreamFragment(
            runtime.session,
            '<turbo-stream action="update" target="static-renderer"><template><DemoText>Updated in place by an ordered Turbo Stream action.</DemoText></template></turbo-stream>',
            { streamLifecycle: runtime.streamLifecycle },
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
            runtime.session,
            '<turbo-stream action="refresh" method="replace" target="ignored"><template><DemoText>Ignored refresh payload.</DemoText></template></turbo-stream>',
            { refresh: runtime.refresh, streamLifecycle: runtime.streamLifecycle },
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
          void runtime.frames
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

export function DemoRouteScreen() {
  const focused = useIsFocused();
  const navigation = useNavigation<DemoRouterNavigation>();
  const navigationContainer = useNavigationContainerRef();
  const [navigationReady, setNavigationReady] = useState(false);
  const route = useRoute();
  const runtime = useDemoRuntime();

  useEffect(() => {
    let active = true;
    const markReady = () => {
      if (active) setNavigationReady(true);
    };
    const unsubscribe = navigationContainer.addListener("ready", markReady);
    if (navigationContainer.isReady()) queueMicrotask(markReady);
    return () => {
      active = false;
      unsubscribe();
    };
  }, [navigationContainer]);

  return (
    <>
      <Stack.Screen options={{ title: "Expo Turbo" }} />
      <DemoRouterRouteOwner
        focused={focused && navigationReady}
        navigation={navigation}
        routeKey={route.key}
        runtime={runtime}
      >
        <CompatibilityGallery />
      </DemoRouterRouteOwner>
    </>
  );
}
