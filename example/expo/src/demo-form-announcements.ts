import type {
  FormSubmissionAnnouncementAdapter,
  FormSubmissionAnnouncementEvent,
  FormSubmissionAnnouncementTerminalSnapshot,
} from "expo-turbo/adapters";
import type { FormSubmissionTerminalSnapshot } from "expo-turbo/core";

export type DemoAnnouncementPriority = "assertive" | "polite";

export interface DemoFormAnnouncement {
  readonly message: string;
  readonly priority: DemoAnnouncementPriority;
}

export interface DemoAccessibilityAnnouncementApi {
  announceForAccessibility(message: string): void;
  announceForAccessibilityWithOptions?(
    message: string,
    options: Readonly<{
      priority?: "default" | "high" | "low";
      queue?: boolean;
    }>,
  ): void;
}

export function demoFormAnnouncement(
  terminalState: FormSubmissionAnnouncementTerminalSnapshot,
): DemoFormAnnouncement {
  switch (terminalState.status) {
    case "applied":
      return { message: "Form submission applied.", priority: "polite" };
    case "canceled":
      return { message: "Form submission canceled.", priority: "polite" };
    case "committed-error":
      return {
        message: "The form response was applied, but its final update did not complete.",
        priority: "assertive",
      };
    case "empty":
      return { message: "Form submission complete. Nothing changed.", priority: "polite" };
    case "failed":
      return terminalState.retryDisposition === "safe"
        ? {
            message: "Form submission failed. Check the form and retry.",
            priority: "assertive",
          }
        : {
            message: "Form submission status is uncertain. Refresh before trying again.",
            priority: "assertive",
          };
    case "unapplied":
      return {
        message: "Form submission finished, but its response was not applied here.",
        priority: "polite",
      };
  }
}

export function createDemoFormAnnouncementAdapter(
  platform: string,
  accessibility: DemoAccessibilityAnnouncementApi,
): FormSubmissionAnnouncementAdapter {
  return Object.freeze({
    announce({ terminalState }: FormSubmissionAnnouncementEvent) {
      if (platform === "web") return;
      const announcement = demoFormAnnouncement(terminalState);
      if (platform === "ios" && accessibility.announceForAccessibilityWithOptions) {
        accessibility.announceForAccessibilityWithOptions(announcement.message, {
          priority: announcement.priority === "polite" ? "low" : "default",
          queue: announcement.priority === "polite",
        });
        return;
      }
      accessibility.announceForAccessibility(announcement.message);
    },
  });
}

export function demoFormLiveRegion(
  platform: string,
  busy: boolean,
  terminalState: FormSubmissionTerminalSnapshot,
): "assertive" | "off" | "polite" {
  if (platform !== "web" || busy || terminalState.status === "none") return "off";
  return demoFormAnnouncement(terminalState).priority;
}
