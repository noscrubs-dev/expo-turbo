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
            `<turbo-frame id="preview-frame">
              <DemoCard title="Eager Frame source loaded">
                <DemoText>The mounted React Frame connected its controller and loaded this fixture response.</DemoText>
              </DemoCard>
            </turbo-frame>`,
          url: request.url,
        }),
      },
      { next: () => `demo-frame-${++requestId}` },
    ),
    visibility,
  );
}
