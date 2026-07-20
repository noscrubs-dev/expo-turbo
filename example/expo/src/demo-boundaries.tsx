import {
  type ExpoTurboDocumentBoundaryProps,
  type ExpoTurboFormBoundaryProps,
  type ExpoTurboFrameBoundaryProps,
} from "expo-turbo/react";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";
import { Platform, Pressable, ScrollView, Text, View } from "react-native";

import { demoFormAnnouncement, demoFormLiveRegion } from "./demo-form-announcements";
import { DemoFrameAutoscrollRegistry } from "./demo-frame-autoscroll";
import {
  DEMO_ROOT_VISIBILITY_CONTAINER_ID,
  DemoVisibilityRegistry,
} from "./demo-visibility";

const DemoVisibilityContext = createContext<DemoVisibilityRegistry | undefined>(undefined);
const DemoVisibilityClipContext = createContext<readonly string[]>([
  DEMO_ROOT_VISIBILITY_CONTAINER_ID,
]);
const DemoFrameAutoscrollContext = createContext<DemoFrameAutoscrollRegistry | undefined>(
  undefined,
);

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
    >
      <DemoVisibilityClipContext.Provider value={clips}>
        {children}
      </DemoVisibilityClipContext.Provider>
    </ScrollView>
  );
}

export function DemoFrameBoundary({
  accessibilityState,
  children,
  state,
}: ExpoTurboFrameBoundaryProps) {
  const visibility = useDemoVisibility();
  const clips = useDemoVisibilityClips();
  const frameAutoscroll = useDemoFrameAutoscroll();
  const boundary = useRef<View>(null);
  useLayoutEffect(
    () =>
      visibility.register(state.frameId, (listener) => {
        boundary.current?.measureInWindow(listener);
      }, clips),
    [clips, state.frameId, visibility],
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
