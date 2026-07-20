/// <reference types="bun" />

import { describe, expect, mock, test } from "bun:test";
import type { FrameControllerSnapshot } from "expo-turbo/core";
import {
  createElement,
  forwardRef,
  type ReactNode,
  useImperativeHandle,
} from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

type MeasureListener = (x: number, y: number, width: number, height: number) => void;

interface NativeProps {
  readonly children?: ReactNode;
}

interface MockFlatListProps extends NativeProps {
  readonly data?: readonly unknown[];
  readonly onViewableItemsChanged?: unknown;
  readonly renderItem?: (item: Readonly<{ index: number; item: unknown }>) => ReactNode;
}

function FlatListHost(props: MockFlatListProps) {
  return createElement("flat-list", props, props.children);
}

const MockView = forwardRef<Readonly<{ measureInWindow(listener: MeasureListener): void }>, NativeProps>(
  ({ children }, ref) => {
    useImperativeHandle(
      ref,
      () =>
        Object.freeze({
          measureInWindow: (listener: MeasureListener) => listener(0, 0, 80, 40),
        }),
      [],
    );
    return createElement("view", undefined, children);
  },
);
MockView.displayName = "MockView";

const MockFlatList = forwardRef<
  Readonly<{ getNativeScrollRef(): Readonly<{ measureInWindow(listener: MeasureListener): void }> }>,
  MockFlatListProps
>((rawProps, ref) => {
  const { data = [], renderItem } = rawProps;
  useImperativeHandle(
    ref,
    () =>
      Object.freeze({
        getNativeScrollRef: () =>
          Object.freeze({
            measureInWindow: (listener: MeasureListener) => listener(0, 0, 100, 100),
          }),
      }),
    [],
  );
  return createElement(
    FlatListHost,
    rawProps,
    data.map((item, index) =>
      createElement("flat-list-row", { key: index }, renderItem?.({ index, item })),
    ),
  );
});
MockFlatList.displayName = "MockFlatList";

mock.module("react-native", () => ({
  FlatList: MockFlatList,
  Platform: { OS: "web" },
  Pressable: ({ children }: NativeProps) => createElement("pressable", undefined, children),
  ScrollView: ({ children }: NativeProps) => createElement("scroll-view", undefined, children),
  Text: ({ children }: NativeProps) => createElement("native-text", undefined, children),
  View: MockView,
}));

const {
  DemoFlatListRegion,
  DemoFrameAutoscrollProvider,
  DemoFrameBoundary,
  DemoVisibilityProvider,
} = await import("./demo-boundaries");
const { DemoFrameAutoscrollRegistry } = await import("./demo-frame-autoscroll");
const { DemoVisibilityRegistry } = await import("./demo-visibility");

const globalWithAct = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean;
};
globalWithAct.IS_REACT_ACT_ENVIRONMENT = true;

const FRAME_STATE: FrameControllerSnapshot = Object.freeze({
  busy: false,
  complete: false,
  connected: true,
  disabled: false,
  frameId: "flatlist-lazy-frame",
  hasBeenLoaded: false,
  loading: "lazy",
  revision: 0,
  status: "idle",
});

interface FlatListRow {
  readonly id: string;
  readonly node: ReactNode;
}

interface FlatListHostProps {
  readonly data: readonly FlatListRow[];
  onViewableItemsChanged(event: Readonly<{ viewableItems: readonly FlatListViewToken[] }>): void;
}

interface FlatListViewToken {
  readonly index: number;
  readonly isViewable: boolean;
  readonly item: FlatListRow;
  readonly key: string;
}

describe("DemoFlatListRegion", () => {
  test("uses full native viewability snapshots and rejects stale row tokens", () => {
    const visibility = new DemoVisibilityRegistry();
    const frameAutoscroll = new DemoFrameAutoscrollRegistry();
    visibility.setViewport({ height: 100, width: 100, x: 0, y: 0 });
    let renderer!: ReactTestRenderer;

    act(() => {
      renderer = create(
        <DemoVisibilityProvider visibility={visibility}>
          <DemoFrameAutoscrollProvider frameAutoscroll={frameAutoscroll}>
            <DemoFlatListRegion
              frameIds={["flatlist-lazy-frame"]}
              id="flatlist-frame-gallery"
            >
              <DemoFrameBoundary
                accessibilityState={{ busy: false }}
                controller={undefined as never}
                state={FRAME_STATE}
              />
            </DemoFlatListRegion>
          </DemoFrameAutoscrollProvider>
        </DemoVisibilityProvider>,
      );
    });

    const host = renderer.root.findByType(FlatListHost);
    const props = host.props as FlatListHostProps;
    const item = props.data[0];
    if (!item) throw new Error("Expected one FlatList Frame row");
    expect(visibility.isVisible("flatlist-lazy-frame")).toBe(false);

    act(() => {
      props.onViewableItemsChanged({
        viewableItems: [{ index: 0, isViewable: true, item, key: item.id }],
      });
    });
    expect(visibility.isVisible("flatlist-lazy-frame")).toBe(true);

    act(() => {
      renderer.update(
        <DemoVisibilityProvider visibility={visibility}>
          <DemoFrameAutoscrollProvider frameAutoscroll={frameAutoscroll}>
            <DemoFlatListRegion
              frameIds={["flatlist-lazy-frame"]}
              id="flatlist-frame-gallery"
            >
              <DemoFrameBoundary
                accessibilityState={{ busy: false }}
                controller={undefined as never}
                state={FRAME_STATE}
              />
            </DemoFlatListRegion>
          </DemoFrameAutoscrollProvider>
        </DemoVisibilityProvider>,
      );
    });
    const replacementHost = renderer.root.findByType(FlatListHost);
    const replacementProps = replacementHost.props as FlatListHostProps;
    const replacementItem = replacementProps.data[0];
    if (!replacementItem) throw new Error("Expected one replacement FlatList Frame row");
    expect(visibility.isVisible("flatlist-lazy-frame")).toBe(false);

    act(() => {
      replacementProps.onViewableItemsChanged({
        viewableItems: [{ index: 0, isViewable: true, item, key: item.id }],
      });
    });
    expect(visibility.isVisible("flatlist-lazy-frame")).toBe(false);

    act(() => {
      replacementProps.onViewableItemsChanged({
        viewableItems: [
          { index: 0, isViewable: true, item: replacementItem, key: replacementItem.id },
        ],
      });
    });
    expect(visibility.isVisible("flatlist-lazy-frame")).toBe(true);

    act(() => {
      replacementProps.onViewableItemsChanged({
        viewableItems: [{ index: 1, isViewable: true, item: replacementItem, key: replacementItem.id }],
      });
    });
    expect(visibility.isVisible("flatlist-lazy-frame")).toBe(false);

    act(() => {
      replacementProps.onViewableItemsChanged({
        viewableItems: [
          { index: 0, isViewable: true, item: replacementItem, key: "recycled-row" },
        ],
      });
    });
    expect(visibility.isVisible("flatlist-lazy-frame")).toBe(false);

    act(() => {
      replacementProps.onViewableItemsChanged({ viewableItems: [] });
      renderer.unmount();
    });
    expect(visibility.isVisible("flatlist-lazy-frame")).toBe(false);
    frameAutoscroll.dispose();
    visibility.dispose();
  });
});
