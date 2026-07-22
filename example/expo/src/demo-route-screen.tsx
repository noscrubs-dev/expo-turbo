import {
  Stack,
  useIsFocused,
  useNavigation,
  useNavigationContainerRef,
  useRoute,
} from "expo-router";
import * as Linking from "expo-linking";
import { EXPO_TURBO_STATUS } from "expo-turbo";
import { dispatchTurboStreamFragment } from "expo-turbo/core";
import { ExpoTurboRoot } from "expo-turbo/react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  Pressable,
  Platform,
  ScrollView,
  Text,
  useWindowDimensions,
  View,
} from "react-native";

import type { DemoRouterNavigation } from "./demo-router-history";
import { DemoRouterRouteOwner } from "./demo-router-route-owner";
import { DemoLiveCableProof, DemoLiveProtectedCableProof } from "./demo-live-cable";
import { DemoLiveDocumentRefreshMorphProof } from "./demo-live-document-refresh-morph";
import { DemoLiveFormProof } from "./demo-live-form";
import { DemoLiveMorphProof } from "./demo-live-morph";
import { useDemoRuntime } from "./demo-runtime";
import { DEMO_ROOT_VISIBILITY_CONTAINER_ID } from "./demo-visibility";
import { PROTOCOL_SMOKE } from "./protocol-smoke";
import { REGISTRY_CAPABILITY_SMOKE } from "./registry-smoke";

const DEMO_LIVE_RAILS_ORIGIN = process.env.EXPO_PUBLIC_EXPO_TURBO_DEMO_ORIGIN;

export function DemoCompatibilityGallery() {
  const runtime = useDemoRuntime();
  const window = useWindowDimensions();
  const scrollView = useRef<ScrollView>(null);
  const autofocusScrollContainerCleanup = useRef<(() => void) | undefined>(undefined);
  const scrollX = useRef(0);
  const scrollY = useRef(0);
  const setScrollView = useCallback(
    (node: ScrollView | null) => {
      autofocusScrollContainerCleanup.current?.();
      autofocusScrollContainerCleanup.current = undefined;
      scrollView.current = node;
      if (!node) return;
      autofocusScrollContainerCleanup.current = runtime.autofocusScroll.registerContainer({
        getScrollY: () => scrollY.current,
        isAvailable: () => Boolean(node.getNativeScrollRef?.()),
        measure: (listener) => {
          node.getNativeScrollRef?.()?.measureInWindow(listener);
        },
        scrollTo: (options) => node.scrollTo(options),
      });
    },
    [runtime.autofocusScroll],
  );
  const remeasure = useCallback(() => {
    runtime.autofocusScroll.remeasure();
    runtime.visibility.remeasureAll();
    runtime.frameAutoscroll.remeasure();
  }, [runtime.autofocusScroll, runtime.frameAutoscroll, runtime.visibility]);
  useLayoutEffect(
    () =>
      runtime.visibility.registerContainer(DEMO_ROOT_VISIBILITY_CONTAINER_ID, (listener) => {
        scrollView.current?.getNativeScrollRef?.()?.measureInWindow(listener);
      }),
    [runtime.visibility],
  );
  useLayoutEffect(
    () =>
      runtime.frameAutoscroll.registerContainer({
        getScrollY: () => scrollY.current,
        isAvailable: () => Boolean(scrollView.current?.getNativeScrollRef?.()),
        measure: (listener) => {
          scrollView.current?.getNativeScrollRef?.()?.measureInWindow(listener);
        },
        scrollTo: (options) => scrollView.current?.scrollTo(options),
      }),
    [runtime.frameAutoscroll],
  );
  useLayoutEffect(
    () =>
      runtime.documentRefreshScroll.registerContainer({
        isAvailable: () => Boolean(scrollView.current?.getNativeScrollRef?.()),
        scrollTo: ({ x, y }) => scrollView.current?.scrollTo({ animated: false, x, y }),
        scrollToTop: () => scrollView.current?.scrollTo({ animated: false, x: 0, y: 0 }),
      }),
    [runtime.documentRefreshScroll],
  );
  useLayoutEffect(
    () =>
      runtime.documentAnchorScroll.registerContainer({
        isAvailable: () => Boolean(scrollView.current?.getNativeScrollRef?.()),
        scrollTo: ({ x, y }) => scrollView.current?.scrollTo({ animated: true, x, y }),
      }),
    [runtime.documentAnchorScroll],
  );
  useLayoutEffect(
    () => () => runtime.documentAnchorScroll.setDocumentOffset(undefined),
    [runtime.documentAnchorScroll],
  );
  useLayoutEffect(
    () => () => autofocusScrollContainerCleanup.current?.(),
    [runtime.autofocusScroll],
  );
  useEffect(() => {
    remeasure();
  }, [remeasure, window.height, window.width]);

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ gap: 16, padding: 24 }}
      onContentSizeChange={() => {
        runtime.autofocusScroll.remeasure();
        runtime.visibility.remeasureAll();
        runtime.frameAutoscroll.remeasure();
      }}
      onLayout={remeasure}
      onScroll={(event) => {
        scrollX.current = event.nativeEvent.contentOffset.x;
        scrollY.current = event.nativeEvent.contentOffset.y;
        const history = runtime.documentRuntime.history;
        const entry = history.current;
        if (!runtime.documentRuntime.controller.state.busy && entry) {
          history.updateRestorationData(entry.restorationIdentifier, {
            scrollPosition: { x: scrollX.current, y: scrollY.current },
          });
        }
        runtime.autofocusScroll.remeasure();
        runtime.visibility.remeasureAll();
        runtime.frameAutoscroll.remeasure();
      }}
      ref={setScrollView}
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
      <View
        collapsable={false}
        onLayout={(event) =>
          runtime.documentAnchorScroll.setDocumentOffset(event.nativeEvent.layout.y)
        }
      >
        <ExpoTurboRoot />
      </View>
      {Platform.OS !== "web" && DEMO_LIVE_RAILS_ORIGIN ? (
        <>
          <DemoLiveCableProof origin={DEMO_LIVE_RAILS_ORIGIN} />
          <DemoLiveProtectedCableProof origin={DEMO_LIVE_RAILS_ORIGIN} />
          <DemoLiveDocumentRefreshMorphProof origin={DEMO_LIVE_RAILS_ORIGIN} />
          <DemoLiveFormProof origin={DEMO_LIVE_RAILS_ORIGIN} />
          <DemoLiveMorphProof origin={DEMO_LIVE_RAILS_ORIGIN} />
        </>
      ) : null}
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
        accessibilityLabel="Refresh current document and reset root scroll"
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
          Refresh current document and reset root scroll
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
  const initialUrl = useMemo(() => {
    if (Platform.OS === "web") return undefined;
    try {
      const value = Linking.getLinkingURL();
      return typeof value === "string" ? value : undefined;
    } catch {
      return undefined;
    }
  }, []);

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
        initialUrl={initialUrl}
        navigation={navigation}
        routeKey={route.key}
        runtime={runtime}
      >
        <DemoCompatibilityGallery />
      </DemoRouterRouteOwner>
    </>
  );
}
