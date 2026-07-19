import type { NavigationAdapter, TurboResponse } from "expo-turbo/adapters";
import {
  type DocumentRefreshRequester,
  type DocumentSession,
  type DocumentSnapshotCache,
  type DocumentVisitLifecycle,
  EXPO_TURBO_MIME_TYPE,
  FormSubmissionController,
  type FormSubmissionLifecycle,
  type FrameControllerRegistry,
  type StreamLifecycle,
} from "expo-turbo/core";
import { Alert, Platform } from "react-native";

import { createDemoFormConfirmationAdapter } from "./demo-form-confirmation";

export function createDemoFormController(
  session: DocumentSession,
  refresh: DocumentRefreshRequester,
  frameControllers: FrameControllerRegistry,
  snapshotCache: DocumentSnapshotCache,
  navigation: NavigationAdapter,
  visitLifecycle: DocumentVisitLifecycle,
  submissionLifecycle: FormSubmissionLifecycle,
  streamLifecycle: StreamLifecycle,
): FormSubmissionController {
  let failedOnce = false;
  return new FormSubmissionController(
    session,
    {
      async fetch(request): Promise<TurboResponse> {
        await new Promise((resolve) => setTimeout(resolve, 400));
        if (request.headers["Turbo-Frame"] === "link-frame") {
          return {
            headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
            redirected: false,
            status: 200,
            text: async () => `<turbo-frame id="link-frame">
              <DemoCard title="Frame form promoted">
                <DemoText>The generated form reused the mounted Frame history scope and promoted its final URL.</DemoText>
              </DemoCard>
            </turbo-frame>`,
            url: request.url,
          };
        }
        if (!failedOnce) {
          failedOnce = true;
          return {
            headers: { "Content-Type": "text/plain" },
            redirected: false,
            status: 200,
            text: async () => "The fixture intentionally fails once.",
            url: request.url,
          };
        }
        return {
          headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
          redirected: false,
          status: 204,
          text: async () => "",
          url: request.url,
        };
      },
    },
    {
      confirmation: createDemoFormConfirmationAdapter({
        platform: Platform.OS,
        showAlert: (title, message, buttons, options) =>
          Alert.alert(title, message, [...buttons], options),
        webConfirm: (message) => globalThis.confirm(message),
      }),
      frameControllers,
      navigation,
      refresh,
      snapshotCache,
      submissionLifecycle,
      streamLifecycle,
      visitLifecycle,
    },
  );
}
