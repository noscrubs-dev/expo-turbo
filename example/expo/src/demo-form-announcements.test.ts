/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import type {
  FormSubmissionAnnouncementEvent,
  FormSubmissionAnnouncementTerminalSnapshot,
} from "expo-turbo/adapters";

import {
  createDemoFormAnnouncementAdapter,
  demoFormAnnouncement,
  demoFormLiveRegion,
  type DemoAccessibilityAnnouncementApi,
} from "./demo-form-announcements";

const applied = Object.freeze({
  application: "document",
  classification: "success",
  effectiveMethod: "POST",
  requestId: "redacted",
  responseStatus: 200,
  revision: 1,
  status: "applied",
}) satisfies FormSubmissionAnnouncementTerminalSnapshot;

const safeFailure = Object.freeze({
  effectiveMethod: "GET",
  error: { code: "request", context: {}, message: "ignored", name: "RequestError" },
  requestId: "redacted",
  retryDisposition: "safe",
  revision: 5,
  status: "failed",
} satisfies FormSubmissionAnnouncementTerminalSnapshot);

function event(
  terminalState: FormSubmissionAnnouncementTerminalSnapshot,
): FormSubmissionAnnouncementEvent {
  return Object.freeze({ formNodeKey: "id:form", terminalState });
}

describe("demo form announcements", () => {
  test("maps every terminal class to static host-owned copy", () => {
    const snapshots = [
      applied,
      {
        effectiveMethod: "GET",
        requestId: "redacted",
        revision: 2,
        status: "canceled",
      },
      {
        application: "stream",
        classification: "success",
        effectiveMethod: "POST",
        error: { code: "state", context: {}, message: "ignored", name: "StateError" },
        requestId: "redacted",
        responseStatus: 200,
        retryDisposition: "committed",
        revision: 3,
        status: "committed-error",
      },
      {
        classification: "success",
        effectiveMethod: "POST",
        requestId: "redacted",
        responseStatus: 204,
        revision: 4,
        status: "empty",
      },
      {
        classification: "success",
        effectiveMethod: "POST",
        reason: "visit-prevented",
        requestId: "redacted",
        responseStatus: 200,
        revision: 7,
        status: "unapplied",
      },
      safeFailure,
      {
        effectiveMethod: "POST",
        error: { code: "request", context: {}, message: "ignored", name: "RequestError" },
        requestId: "redacted",
        retryDisposition: "unsafe",
        revision: 6,
        status: "failed",
      },
    ] as const satisfies readonly FormSubmissionAnnouncementTerminalSnapshot[];

    const announcements = snapshots.map(demoFormAnnouncement);

    expect(announcements.map(({ priority }) => priority)).toEqual([
      "polite",
      "polite",
      "assertive",
      "polite",
      "polite",
      "assertive",
      "assertive",
    ]);
    expect(JSON.stringify(announcements)).not.toContain("ignored");
    expect(JSON.stringify(announcements)).not.toContain("redacted");
  });

  test("uses queued low-priority speech for polite iOS results", () => {
    const calls: unknown[] = [];
    const accessibility: DemoAccessibilityAnnouncementApi = {
      announceForAccessibility: (message) => calls.push(["basic", message]),
      announceForAccessibilityWithOptions: (message, options) =>
        calls.push(["options", message, options]),
    };

    createDemoFormAnnouncementAdapter("ios", accessibility).announce(event(applied));

    expect(calls).toEqual([
      ["options", "Form submission applied.", { priority: "low", queue: true }],
    ]);
  });

  test("uses interruptible default-priority speech for assertive iOS results", () => {
    const calls: unknown[] = [];
    const accessibility: DemoAccessibilityAnnouncementApi = {
      announceForAccessibility: (message) => calls.push(["basic", message]),
      announceForAccessibilityWithOptions: (message, options) =>
        calls.push(["options", message, options]),
    };

    createDemoFormAnnouncementAdapter("ios", accessibility).announce(event(safeFailure));

    expect(calls).toEqual([
      [
        "options",
        "Form submission failed. Check the form and retry.",
        { priority: "default", queue: false },
      ],
    ]);
  });

  test("falls back to basic speech on older iOS and Android", () => {
    const calls: string[] = [];
    const accessibility: DemoAccessibilityAnnouncementApi = {
      announceForAccessibility: (message) => calls.push(message),
    };

    createDemoFormAnnouncementAdapter("ios", accessibility).announce(event(applied));
    createDemoFormAnnouncementAdapter("android", accessibility).announce(event(applied));

    expect(calls).toEqual(["Form submission applied.", "Form submission applied."]);
  });

  test("leaves web delivery to the rendered aria-live region", () => {
    const calls: string[] = [];
    const accessibility: DemoAccessibilityAnnouncementApi = {
      announceForAccessibility: (message) => calls.push(message),
      announceForAccessibilityWithOptions: (message) => calls.push(message),
    };

    createDemoFormAnnouncementAdapter("web", accessibility).announce(event(applied));

    expect(calls).toEqual([]);
    expect(demoFormLiveRegion("web", false, applied)).toBe("polite");
    expect(demoFormLiveRegion("web", false, safeFailure)).toBe("assertive");
    expect(demoFormLiveRegion("web", true, applied)).toBe("off");
    expect(demoFormLiveRegion("web", false, { revision: 0, status: "none" })).toBe("off");
    expect(demoFormLiveRegion("ios", false, applied)).toBe("off");
  });
});
