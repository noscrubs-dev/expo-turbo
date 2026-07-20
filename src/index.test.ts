import { describe, expect, test } from "bun:test"

import * as core from "./core"
import {
  BeforeCacheEvent,
  BeforePrefetchEvent,
  DocumentHistory,
  EXPO_TURBO_STATUS,
  FormSubmissionController,
  type FormSubmissionReport,
  FrameCommitError,
  FrameLifecycle,
  FrameMissingEvent,
  subscribeDocumentHistoryTraversal,
} from "./index"

describe("package status", () => {
  test("does not claim runtime compatibility", () => {
    expect(EXPO_TURBO_STATUS).toBe("foundation")
    expect(FormSubmissionController).toBeFunction()
    expect(FrameCommitError).toBeFunction()
    expect(FrameLifecycle).toBeFunction()
    expect(FrameMissingEvent).toBeFunction()
    expect(DocumentHistory).toBeFunction()
    expect(subscribeDocumentHistoryTraversal).toBeFunction()
    expect(BeforeCacheEvent).toBeFunction()
    expect(BeforePrefetchEvent).toBeFunction()
    expect("morphStreamReplaceElement" in core).toBe(false)
    expect("morphStreamUpdateChildren" in core).toBe(false)
    expect("morphFrameRefreshChildren" in core).toBe(false)
    expect("morphCurrentDocumentRoot" in core).toBe(false)
  })
})

function inspectSubmissionReport(report: FormSubmissionReport): string {
  if (report.status === "applied" && report.application === "frame") {
    return report.applicationDestination.frameId
  }
  if (report.destination.kind === "frame") return report.destination.frameId
  if (report.status === "applied") return report.application
  if (report.status === "empty") return report.responseUrl
  return report.requestedUrl
}
void inspectSubmissionReport
