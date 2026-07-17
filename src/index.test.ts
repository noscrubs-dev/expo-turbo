import { describe, expect, test } from "bun:test"

import { EXPO_TURBO_STATUS, FormSubmissionController, type FormSubmissionReport } from "./index"

describe("package status", () => {
  test("does not claim runtime compatibility", () => {
    expect(EXPO_TURBO_STATUS).toBe("foundation")
    expect(FormSubmissionController).toBeFunction()
  })
})

function inspectSubmissionReport(report: FormSubmissionReport): string {
  if (report.destination.kind === "frame") return report.destination.frameId
  if (report.status === "xml" || report.status === "stream") return report.body
  return report.url
}
void inspectSubmissionReport
