import type { NavigationAdapter, VisibilityAdapter } from "expo-turbo/adapters";
import type { DocumentSession, DocumentVisitController } from "expo-turbo/core";
import {
  EXPO_TURBO_MIME_TYPE,
  FrameControllerRegistry,
  FrameRequestLoader,
} from "expo-turbo/core";

export function createDemoFrameControllers(
  session: DocumentSession,
  navigation: NavigationAdapter,
  documentController: DocumentVisitController,
): FrameControllerRegistry {
  let requestId = 0;
  const visibility: VisibilityAdapter = {
    isVisible: () => true,
    subscribe: () => () => {},
  };
  return new FrameControllerRegistry(
    session,
    new FrameRequestLoader(
      session,
      {
        fetch: async (request) => {
          const frameId = request.headers["Turbo-Frame"];
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
    ),
    visibility,
    navigation,
    documentController,
  );
}
