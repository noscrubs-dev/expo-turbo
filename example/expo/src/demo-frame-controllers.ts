import type { NavigationAdapter, VisibilityAdapter } from "expo-turbo/adapters";
import type {
  DocumentHistory,
  DocumentRefreshRequester,
  DocumentSession,
  DocumentSnapshotCache,
  DocumentVisitController,
  DocumentVisitLifecycle,
  StreamLifecycle,
} from "expo-turbo/core";
import {
  EXPO_TURBO_MIME_TYPE,
  FrameControllerRegistry,
  FrameHistoryCoordinator,
  FrameRequestLoader,
} from "expo-turbo/core";

export function createDemoFrameControllers(
  session: DocumentSession,
  navigation: NavigationAdapter,
  documentController: DocumentVisitController,
  refresh: DocumentRefreshRequester,
  history: DocumentHistory,
  snapshotCache: DocumentSnapshotCache,
  visitLifecycle: DocumentVisitLifecycle,
  streamLifecycle: StreamLifecycle,
  visibility: VisibilityAdapter,
): FrameControllerRegistry {
  let requestId = 0;
  return new FrameControllerRegistry(
    session,
    new FrameRequestLoader(
      session,
      {
        fetch: async (request) => {
          const frameId = request.headers["Turbo-Frame"];
          const flatListFrameId =
            frameId === "flatlist-lazy-frame-one" ||
            frameId === "flatlist-lazy-frame-two" ||
            frameId === "flatlist-lazy-frame-three"
              ? frameId
              : undefined;
          return {
            headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
            redirected: false,
            status: 200,
            text: async () =>
              frameId === "link-frame"
                ? `<Gallery><turbo-frame id="link-frame">
                    <DemoCard title="Frame link loaded">
                      <DemoText>The registered native link reused the Frame controller and replaced only this Frame.</DemoText>
                    </DemoCard>
                    <DemoForm action="/demo/frame-autofocus">
                      <DemoFormInput id="frame-autofocus-name" autofocus="" label="Autofocused Frame field" name="frame_autofocus_name" value="" />
                    </DemoForm>
                  </turbo-frame></Gallery>`
                : frameId === "nested-lazy-frame"
                  ? `<Gallery><turbo-frame id="nested-lazy-frame">
                      <DemoCard title="Nested lazy Frame loaded">
                        <DemoText>The nested clipping chain admitted this Frame exactly once after it entered both visible regions.</DemoText>
                      </DemoCard>
                    </turbo-frame></Gallery>`
                  : flatListFrameId
                    ? `<Gallery><turbo-frame id="${flatListFrameId}">
                        <DemoCard title="Virtualized lazy Frame loaded" tone="positive" style-tokens="space:compact">
                          <DemoText>The current FlatList row was both measured inside its clipping chain and reported viewable by the native virtualizer.</DemoText>
                        </DemoCard>
                      </turbo-frame></Gallery>`
                  : request.url.endsWith("/demo/frame")
                  ? '<Gallery><turbo-frame id="demo-recurse" src="/demo/recurse" recurse="preview-frame" /></Gallery>'
                  : `<Gallery><turbo-frame id="preview-frame">
                      <DemoCard title="Recursive Frame source loaded">
                        <DemoText>The lazy Frame followed a bounded recurse intermediary and preserved its mounted wrapper.</DemoText>
                      </DemoCard>
                    </turbo-frame></Gallery>`,
            url: request.url,
          };
        },
      },
      { next: () => `demo-frame-${++requestId}` },
      { refresh, streamLifecycle },
    ),
    visibility,
    navigation,
    documentController,
    {
      frameHistory: new FrameHistoryCoordinator(session, {
        history,
        navigation,
        snapshotCache,
        visitLifecycle,
      }),
    },
  );
}
