import type { TurboResponse } from "expo-turbo/adapters";
import {
  EXPO_TURBO_MIME_TYPE,
  FormSubmissionController,
  type DocumentSession,
} from "expo-turbo/core";
import { Alert, Platform } from "react-native";

import { createDemoFormConfirmationAdapter } from "./demo-form-confirmation";

export function createDemoFormController(
  session: DocumentSession,
): FormSubmissionController {
  return new FormSubmissionController(
    session,
    {
      async fetch(request): Promise<TurboResponse> {
        await new Promise((resolve) => setTimeout(resolve, 400));
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
    },
  );
}
