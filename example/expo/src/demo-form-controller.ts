import type { TurboResponse } from "expo-turbo/adapters";
import {
  EXPO_TURBO_MIME_TYPE,
  FormSubmissionController,
  type DocumentSession,
} from "expo-turbo/core";

export function createDemoFormController(
  session: DocumentSession,
): FormSubmissionController {
  return new FormSubmissionController(session, {
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
  });
}
