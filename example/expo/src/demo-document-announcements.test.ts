/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import type {
  DocumentVisitAnnouncementEvent,
  DocumentVisitAnnouncementStatus,
} from "expo-turbo/adapters";

import {
  createDemoDocumentAnnouncementAdapter,
  demoDocumentAnnouncement,
  demoDocumentLiveRegion,
} from "./demo-document-announcements";
import type { DemoAccessibilityAnnouncementApi } from "./demo-form-announcements";

function event(status: DocumentVisitAnnouncementStatus): DocumentVisitAnnouncementEvent {
  return Object.freeze({ status });
}

describe("demo document announcements", () => {
  test("maps every visit transition to static host-owned copy", () => {
    const announcements = ["started", "completed", "canceled", "failed"] as const;

    expect(announcements.map(demoDocumentAnnouncement)).toEqual([
      { message: "Loading document.", priority: "polite" },
      { message: "Document loaded.", priority: "polite" },
      { message: "Document visit canceled.", priority: "polite" },
      { message: "Document visit failed. Try again.", priority: "assertive" },
    ]);
  });

  test("uses queued low-priority iOS speech for ordinary visit transitions", () => {
    const calls: unknown[] = [];
    const accessibility: DemoAccessibilityAnnouncementApi = {
      announceForAccessibility: (message) => calls.push(["basic", message]),
      announceForAccessibilityWithOptions: (message, options) =>
        calls.push(["options", message, options]),
    };
    const adapter = createDemoDocumentAnnouncementAdapter("ios", accessibility);

    adapter.announce(event("started"));
    adapter.announce(event("failed"));

    expect(calls).toEqual([
      ["options", "Loading document.", { priority: "low", queue: true }],
      ["options", "Document visit failed. Try again.", { priority: "default", queue: false }],
    ]);
  });

  test("uses the basic native API outside iOS and reserves live regions for web", () => {
    const calls: string[] = [];
    const accessibility: DemoAccessibilityAnnouncementApi = {
      announceForAccessibility: (message) => calls.push(message),
    };

    createDemoDocumentAnnouncementAdapter("android", accessibility).announce(event("completed"));
    createDemoDocumentAnnouncementAdapter("web", accessibility).announce(event("completed"));

    expect(calls).toEqual(["Document loaded."]);
    expect(demoDocumentLiveRegion("web", "started")).toBe("polite");
    expect(demoDocumentLiveRegion("web", "failed")).toBe("assertive");
    expect(demoDocumentLiveRegion("web", "initialized")).toBe("off");
    expect(demoDocumentLiveRegion("ios", "completed")).toBe("off");
  });
});
