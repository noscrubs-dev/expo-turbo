import type { TurboResponse } from "expo-turbo/adapters";
import {
  type DocumentRefreshRequester,
  EXPO_TURBO_MIME_TYPE,
  FormSubmissionController,
  type DocumentSession,
} from "expo-turbo/core";
import { Alert, Platform } from "react-native";

import { createDemoFormConfirmationAdapter } from "./demo-form-confirmation";

export function createDemoFormController(
  session: DocumentSession,
  refresh: DocumentRefreshRequester,
): FormSubmissionController {
  let failedOnce = false;
  return new FormSubmissionController(
    session,
    {
      async fetch(request): Promise<TurboResponse> {
        await new Promise((resolve) => setTimeout(resolve, 400));
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
      refresh,
    },
  );
}
