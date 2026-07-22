import {
  type ExpoTurboDocumentBoundaryProps,
  type ExpoTurboFormBoundaryProps,
  type ExpoTurboFrameBoundaryProps,
} from "expo-turbo/react";
import {
  Children,
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";
import {
  FlatList,
  type FlatListProps,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";

import {
  demoDocumentAnnouncement,
  demoDocumentLiveRegion,
} from "./demo-document-announcements";
import { demoFormAnnouncement, demoFormLiveRegion } from "./demo-form-announcements";
import {
  DemoDocumentAnchorContainerProvider,
  useDemoDocumentAnchorScroll,
  useDemoDocumentAnchorScrollContent,
} from "./demo-document-anchor-scroll";
import { DemoFrameAutoscrollRegistry } from "./demo-frame-autoscroll";
import { useOptionalDemoRouterRouteReady } from "./demo-router-route-owner";
import {
  DEMO_ROOT_VISIBILITY_CONTAINER_ID,
  type DemoFrameViewability,
  type DemoViewabilityRegion,
  DemoVisibilityRegistry,
} from "./demo-visibility";

const DemoVisibilityContext = createContext<DemoVisibilityRegistry | undefined>(undefined);
const DemoVisibilityClipContext = createContext<readonly string[]>([
  DEMO_ROOT_VISIBILITY_CONTAINER_ID,
]);
const DemoVisibilityViewabilityContext = createContext<DemoFrameViewability | undefined>(
  undefined,
);
const DemoFrameAutoscrollContext = createContext<DemoFrameAutoscrollRegistry | undefined>(
  undefined,
);

interface DemoFlatListItem {
  readonly id: string;
  readonly node: ReactNode;
}

const DEMO_FLAT_LIST_VIEWABILITY_CONFIG = Object.freeze({ viewAreaCoveragePercentThreshold: 0 });
type DemoFlatListViewabilityCallback = NonNullable<
  FlatListProps<DemoFlatListItem>["onViewableItemsChanged"]
>;

export function DemoVisibilityProvider({
  children,
  visibility,
}: Readonly<{ children: ReactNode; visibility: DemoVisibilityRegistry }>) {
  return (
    <DemoVisibilityContext.Provider value={visibility}>
      {children}
    </DemoVisibilityContext.Provider>
  );
}

function useDemoVisibility(): DemoVisibilityRegistry {
  const visibility = useContext(DemoVisibilityContext);
  if (!visibility) throw new Error("Demo Frame visibility is not configured");
  return visibility;
}

function useDemoVisibilityClips(): readonly string[] {
  return useContext(DemoVisibilityClipContext);
}

function useDemoFrameViewability(): DemoFrameViewability | undefined {
  return useContext(DemoVisibilityViewabilityContext);
}

export function DemoFrameAutoscrollProvider({
  children,
  frameAutoscroll,
}: Readonly<{ children: ReactNode; frameAutoscroll: DemoFrameAutoscrollRegistry }>) {
  return (
    <DemoFrameAutoscrollContext.Provider value={frameAutoscroll}>
      {children}
    </DemoFrameAutoscrollContext.Provider>
  );
}

function useDemoFrameAutoscroll(): DemoFrameAutoscrollRegistry {
  const frameAutoscroll = useContext(DemoFrameAutoscrollContext);
  if (!frameAutoscroll) throw new Error("Demo Frame autoscroll is not configured");
  return frameAutoscroll;
}

export function DemoNestedScrollRegion({
  children,
  id,
}: Readonly<{ children?: ReactNode; id: string }>) {
  const visibility = useDemoVisibility();
  const anchorScroll = useDemoDocumentAnchorScroll();
  const parentClips = useDemoVisibilityClips();
  const scrollView = useRef<ScrollView>(null);
  const clips = useMemo(() => Object.freeze([...parentClips, id]), [id, parentClips]);
  const remeasure = useCallback(() => visibility.remeasureAll(), [visibility]);

  useLayoutEffect(
    () =>
      visibility.registerContainer(id, (listener) => {
        scrollView.current?.getNativeScrollRef?.()?.measureInWindow(listener);
      }),
    [id, visibility],
  );
  useLayoutEffect(
    () =>
      anchorScroll.registerNestedContainer(id, {
        isAvailable: () => Boolean(scrollView.current?.getNativeScrollRef?.()),
        scrollTo: ({ x, y }) => scrollView.current?.scrollTo({ animated: true, x, y }),
      }),
    [anchorScroll, id],
  );

  return (
    <ScrollView
      contentContainerStyle={{ gap: 10, padding: 10 }}
      nestedScrollEnabled
      onContentSizeChange={remeasure}
      onLayout={remeasure}
      onScroll={remeasure}
      ref={scrollView}
      scrollEventThrottle={32}
      style={{ borderColor: "#9eb0c3", borderRadius: 10, borderWidth: 1, height: 160 }}
      testID={`demo-nested-scroll-${id}`}
    >
      <DemoDocumentAnchorContainerProvider id={id}>
        <DemoVisibilityClipContext.Provider value={clips}>
          {children}
        </DemoVisibilityClipContext.Provider>
      </DemoDocumentAnchorContainerProvider>
    </ScrollView>
  );
}

function flatListItems(
  children: ReactNode,
  frameIds: readonly string[],
): readonly DemoFlatListItem[] {
  const nodes = Children.toArray(children);
  if (nodes.length !== frameIds.length) {
    throw new TypeError("Demo FlatList regions require one direct Frame row per frame id");
  }
  const ids = new Set<string>();
  const items = nodes.map((node, index) => {
    const id = frameIds[index];
    if (typeof id !== "string" || id === "" || ids.has(id)) {
      throw new TypeError("Demo FlatList regions require unique nonempty frame ids");
    }
    ids.add(id);
    return Object.freeze({ id, node });
  });
  return Object.freeze(items);
}

/**
 * Example-only horizontal virtualizer. A Frame must intersect the root/list
 * clipping geometry and be in this FlatList's native viewability set to load.
 */
export function DemoFlatListRegion({
  children,
  frameIds,
  id,
}: Readonly<{ children?: ReactNode; frameIds: readonly string[]; id: string }>) {
  const visibility = useDemoVisibility();
  const parentClips = useDemoVisibilityClips();
  const flatList = useRef<FlatList<DemoFlatListItem>>(null);
  const regionRef = useRef<DemoViewabilityRegion | undefined>(undefined);
  const items = useMemo(() => flatListItems(children, frameIds), [children, frameIds]);
  const region = useMemo(
    () => visibility.createViewabilityRegion(id, items.map((item) => item.id)),
    [id, items, visibility],
  );
  const clips = useMemo(() => Object.freeze([...parentClips, id]), [id, parentClips]);
  const remeasure = useCallback(() => visibility.remeasureAll(), [visibility]);
  const onViewableItemsChanged = useCallback<DemoFlatListViewabilityCallback>(
    ({ viewableItems }) => {
      if (regionRef.current !== region) return;
      const visibleItems: string[] = [];
      for (const token of viewableItems) {
        const item = typeof token.index === "number" ? items[token.index] : undefined;
        if (
          token.isViewable &&
          item === token.item &&
          token.key === item?.id
        ) {
          visibleItems.push(item.id);
        }
      }
      region.setVisibleItems(visibleItems);
    },
    [items, region],
  );

  useLayoutEffect(() => {
    regionRef.current = region;
    const deactivate = visibility.activateViewabilityRegion(region);
    return () => {
      if (regionRef.current === region) regionRef.current = undefined;
      deactivate();
    };
  }, [region, visibility]);

  useLayoutEffect(
    () =>
      visibility.registerContainer(id, (listener) => {
        const nativeScrollRef = flatList.current?.getNativeScrollRef?.();
        if (
          nativeScrollRef &&
          "measureInWindow" in nativeScrollRef &&
          typeof nativeScrollRef.measureInWindow === "function"
        ) {
          nativeScrollRef.measureInWindow(listener);
        }
      }),
    [id, region, visibility],
  );

  return (
    <FlatList
      contentContainerStyle={{ gap: 10, padding: 10 }}
      data={items}
      horizontal
      keyExtractor={(item) => item.id}
      onContentSizeChange={remeasure}
      onLayout={remeasure}
      onScroll={remeasure}
      onViewableItemsChanged={onViewableItemsChanged}
      ref={flatList}
      renderItem={({ item }) => (
        <DemoVisibilityClipContext.Provider value={clips}>
          <DemoVisibilityViewabilityContext.Provider
            value={Object.freeze({ itemId: item.id, region })}
          >
            <View collapsable={false} style={{ width: 260 }}>
              {item.node}
            </View>
          </DemoVisibilityViewabilityContext.Provider>
        </DemoVisibilityClipContext.Provider>
      )}
      scrollEventThrottle={32}
      showsHorizontalScrollIndicator
      style={{ borderColor: "#9eb0c3", borderRadius: 10, borderWidth: 1, height: 176 }}
      viewabilityConfig={DEMO_FLAT_LIST_VIEWABILITY_CONFIG}
    />
  );
}

export function DemoFrameBoundary({
  accessibilityState,
  children,
  state,
}: ExpoTurboFrameBoundaryProps) {
  const visibility = useDemoVisibility();
  const clips = useDemoVisibilityClips();
  const viewability = useDemoFrameViewability();
  if (viewability && viewability.itemId !== state.frameId) {
    throw new Error("Demo FlatList rows must contain exactly one direct Frame with the declared id");
  }
  const frameViewability = useMemo(
    () =>
      viewability
        ? Object.freeze({ itemId: viewability.itemId, region: viewability.region })
        : undefined,
    [viewability],
  );
  const frameAutoscroll = useDemoFrameAutoscroll();
  const boundary = useRef<View>(null);
  useLayoutEffect(
    () =>
      visibility.register(state.frameId, (listener) => {
        boundary.current?.measureInWindow(listener);
      }, clips, frameViewability),
    [clips, frameViewability, state.frameId, visibility],
  );
  useLayoutEffect(
    () =>
      frameAutoscroll.register(state.frameId, (listener) => {
        boundary.current?.measureInWindow(listener);
      }),
    [frameAutoscroll, state.frameId],
  );
  return (
    <View
      collapsable={false}
      onLayout={() => {
        visibility.remeasure(state.frameId);
        frameAutoscroll.remeasure(state.frameId);
      }}
      ref={boundary}
      style={{ gap: 8 }}
    >
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

export function DemoDocumentBoundary({
  accessibilityState,
  children,
  state,
}: ExpoTurboDocumentBoundaryProps) {
  const anchorScrollContent = useDemoDocumentAnchorScrollContent();
  const markRouteReady = useOptionalDemoRouterRouteReady();
  const announcement =
    state.status === "initialized" ? undefined : demoDocumentAnnouncement(state.status);
  const accessibilityLabel = state.previewVisible
    ? `Document visit: ${state.status}, showing cached preview`
    : `Document visit: ${state.status}`;
  const liveRegion = demoDocumentLiveRegion(Platform.OS, state.status);

  useEffect(() => {
    markRouteReady?.();
  }, [markRouteReady]);

  return (
    <View style={{ gap: 12 }}>
      <View
        accessibilityLabel={accessibilityLabel}
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
        {state.previewVisible ? (
          <Text selectable style={{ color: "#435160", fontSize: 12 }}>
            Showing cached preview while loading canonical response.
          </Text>
        ) : null}
        {state.progressVisible ? (
          <Text selectable style={{ color: "#435160", fontSize: 12 }}>
            Visit is taking longer than 500 ms…
          </Text>
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
      <View
        collapsable={false}
        onLayout={anchorScrollContent.onLayout}
        testID="demo-document-anchor-content"
      >
        {children}
      </View>
    </View>
  );
}

export function DemoFormBoundary({
  accessibilityState,
  children,
  dismissTerminal,
  retryFailure,
  state,
  terminalState,
}: ExpoTurboFormBoundaryProps) {
  const retryRequestId = useRef(0);
  const failed =
    terminalState.status === "failed" || terminalState.status === "committed-error";
  const retryable =
    terminalState.status === "failed" && terminalState.retryDisposition === "safe";
  const announcement =
    terminalState.status === "none" ? undefined : demoFormAnnouncement(terminalState);
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
