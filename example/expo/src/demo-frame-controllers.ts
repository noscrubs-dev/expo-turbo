import type { VisibilityAdapter } from "expo-turbo/adapters";
import type { DocumentSession } from "expo-turbo/core";
import {
  EXPO_TURBO_MIME_TYPE,
  FrameControllerRegistry,
  FrameRequestLoader,
} from "expo-turbo/core";

export function createDemoFrameControllers(
  session: DocumentSession,
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
        fetch: async (request) => ({
          headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
          redirected: false,
          status: 200,
          text: async () =>
            request.url.endsWith("/demo/frame")
              ? '<Gallery><turbo-frame id="demo-recurse" src="/demo/recurse" recurse="preview-frame" /></Gallery>'
              : `<Gallery><turbo-frame id="preview-frame">
                  <DemoCard title="Recursive Frame source loaded">
                    <DemoText>The lazy Frame followed a bounded recurse intermediary and preserved its mounted wrapper.</DemoText>
                  </DemoCard>
                </turbo-frame></Gallery>`,
          url: request.url,
        }),
      },
      { next: () => `demo-frame-${++requestId}` },
    ),
    visibility,
  );
}
