import type {
  DocumentVisitAnnouncementAdapter,
  DocumentVisitAnnouncementEvent,
  DocumentVisitAnnouncementStatus,
} from "expo-turbo/adapters";
import type { DocumentVisitStatus } from "expo-turbo/core";

import type { DemoAccessibilityAnnouncementApi, DemoAnnouncementPriority } from "./demo-form-announcements";

export interface DemoDocumentAnnouncement {
  readonly message: string;
  readonly priority: DemoAnnouncementPriority;
}

export function demoDocumentAnnouncement(
  status: DocumentVisitAnnouncementStatus,
): DemoDocumentAnnouncement {
  switch (status) {
    case "canceled":
      return { message: "Document visit canceled.", priority: "polite" };
    case "completed":
      return { message: "Document loaded.", priority: "polite" };
    case "failed":
      return { message: "Document visit failed. Try again.", priority: "assertive" };
    case "started":
      return { message: "Loading document.", priority: "polite" };
  }
}

export function createDemoDocumentAnnouncementAdapter(
  platform: string,
  accessibility: DemoAccessibilityAnnouncementApi,
): DocumentVisitAnnouncementAdapter {
  return Object.freeze({
    announce({ status }: DocumentVisitAnnouncementEvent) {
      if (platform === "web") return;
      const announcement = demoDocumentAnnouncement(status);
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

export function demoDocumentLiveRegion(
  platform: string,
  status: DocumentVisitStatus,
): "assertive" | "off" | "polite" {
  if (platform !== "web" || status === "initialized") return "off";
  return demoDocumentAnnouncement(status).priority;
}
