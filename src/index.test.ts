import { describe, expect, test } from "bun:test"

import {
  DocumentHistory,
  EXPO_TURBO_STATUS,
  FormSubmissionController,
  type FormSubmissionReport,
} from "./index"

describe("package status", () => {
  test("does not claim runtime compatibility", () => {
    expect(EXPO_TURBO_STATUS).toBe("foundation")
    expect(FormSubmissionController).toBeFunction()
    expect(DocumentHistory).toBeFunction()
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
