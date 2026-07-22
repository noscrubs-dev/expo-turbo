import type {
  ClockAdapter,
  NavigationAdapter,
  TurboRequest,
  VisibilityAdapter,
} from "expo-turbo/adapters";
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
  FramePreloadCache,
  FramePreloader,
  FrameControllerRegistry,
  FrameHistoryCoordinator,
  FrameRequestLoader,
} from "expo-turbo/core";

export interface DemoFrameControllers {
  readonly frames: FrameControllerRegistry;
  readonly preloader: FramePreloader;
}

const FRAME_PREVIEW_REVALIDATION_DELAY_MS = 1_500;

const LINK_FRAME_PREVIEW = `<Gallery><turbo-frame id="link-frame">
  <DemoCard id="frame-preload-preview" title="Preloaded Frame preview" tone="warning">
    <DemoText>This cached Frame is visible while the canonical request revalidates it.</DemoText>
  </DemoCard>
</turbo-frame></Gallery>`;

const LINK_FRAME_CANONICAL = `<Gallery><turbo-frame id="link-frame">
  <DemoCard title="Frame link loaded">
    <DemoText>The registered native link reused the Frame controller and replaced only this Frame.</DemoText>
  </DemoCard>
  <DemoForm action="/demo/frame-autofocus">
    <DemoFormInput id="frame-autofocus-name" autofocus="" label="Autofocused Frame field" name="frame_autofocus_name" value="" />
  </DemoForm>
  <DemoCard title="Frame fragment spacer" style-tokens="space:comfortable">
    <DemoText>The response target remains below the newly loaded Frame content.</DemoText>
  </DemoCard>
  <DemoAnchorTarget id="frame-linked-fragment-target">
    <DemoCard title="Loaded Frame fragment target" tone="positive" style-tokens="space:comfortable surface:elevated">
      <DemoText>The Frame request omitted the fragment, then native scrolling resolved this target from the committed response.</DemoText>
    </DemoCard>
  </DemoAnchorTarget>
</turbo-frame></Gallery>`;

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
  clock: ClockAdapter,
): DemoFrameControllers {
  let requestId = 0;
  const transport = {
    fetch: async (request: TurboRequest) => {
      const frameId = request.headers["Turbo-Frame"];
      const url = new URL(request.url);
      const flatListFrameId =
        frameId === "flatlist-lazy-frame-one" ||
        frameId === "flatlist-lazy-frame-two" ||
        frameId === "flatlist-lazy-frame-three"
          ? frameId
          : undefined;
      let xml: string;
      if (frameId === "link-frame") {
        const previews = url.searchParams.get("preview") === "automatic";
        xml =
          previews && request.headers["X-Sec-Purpose"] === "prefetch"
            ? LINK_FRAME_PREVIEW
            : previews
              ? await delayedFrameFixture(
                  clock,
                  request.signal,
                  LINK_FRAME_CANONICAL,
                  FRAME_PREVIEW_REVALIDATION_DELAY_MS,
                )
              : LINK_FRAME_CANONICAL;
      } else if (frameId === "nested-lazy-frame") {
        xml = `<Gallery><turbo-frame id="nested-lazy-frame">
          <DemoCard title="Nested lazy Frame loaded">
            <DemoText>The nested clipping chain admitted this Frame exactly once after it entered both visible regions.</DemoText>
          </DemoCard>
        </turbo-frame></Gallery>`;
      } else if (flatListFrameId) {
        xml = `<Gallery><turbo-frame id="${flatListFrameId}">
          <DemoCard title="Virtualized lazy Frame loaded" tone="positive" style-tokens="space:compact">
            <DemoText>The current FlatList row was both measured inside its clipping chain and reported viewable by the native virtualizer.</DemoText>
          </DemoCard>
        </turbo-frame></Gallery>`;
      } else if (request.url.endsWith("/demo/frame")) {
        xml = '<Gallery><turbo-frame id="demo-recurse" src="/demo/recurse" recurse="preview-frame" /></Gallery>';
      } else {
        xml = `<Gallery><turbo-frame id="preview-frame">
          <DemoCard title="Recursive Frame source loaded">
            <DemoText>The lazy Frame followed a bounded recurse intermediary and preserved its mounted wrapper.</DemoText>
          </DemoCard>
        </turbo-frame></Gallery>`;
      }
      return {
        headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
        redirected: false,
        status: 200,
        text: async () => xml,
        url: request.url,
      };
    },
  };
  const preloadCache = new FramePreloadCache();
  const preloader = new FramePreloader(
    session,
    transport,
    { next: () => `demo-frame-preload-${++requestId}` },
    preloadCache,
  );
  const frames = new FrameControllerRegistry(
    session,
    new FrameRequestLoader(
      session,
      transport,
      { next: () => `demo-frame-${++requestId}` },
      { preloadBehavior: "preview", preloadCache, refresh, streamLifecycle },
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
  return Object.freeze({ frames, preloader });
}

function delayedFrameFixture(
  clock: ClockAdapter,
  signal: AbortSignal | undefined,
  xml: string,
  delayMs: number,
): Promise<string> {
  if (signal?.aborted) return Promise.reject(frameFixtureAbortError());

  return new Promise<string>((resolve, reject) => {
    let settled = false;
    let handle: unknown;
    const cleanup = () => signal?.removeEventListener("abort", abort);
    const abort = () => {
      if (settled) return;
      settled = true;
      if (handle !== undefined) clock.clearTimeout(handle);
      cleanup();
      reject(frameFixtureAbortError());
    };

    signal?.addEventListener("abort", abort, { once: true });
    handle = clock.setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(xml);
    }, delayMs);
  });
}

function frameFixtureAbortError(): Error {
  const error = new Error("Demo Frame fixture request was aborted");
  error.name = "AbortError";
  return error;
}
