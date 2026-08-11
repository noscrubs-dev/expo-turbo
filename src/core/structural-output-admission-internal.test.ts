import { describe, expect, test } from "bun:test"

import { parseExpoTurboDocument } from "./parser"
import { DocumentSession } from "./session"
import {
  admitStructuralOutput,
  registerStructuralOutputAdmission,
} from "./structural-output-admission-internal"

describe("structural output admission", () => {
  test("keeps a renderable verdict regardless of registration order", () => {
    // Nested providers commit their effects child-first, so the combined result
    // must not depend on which one registered last.
    const session = new DocumentSession(parseExpoTurboDocument("<Root />"))
    const nodes = session.tree.document.children
    const reports: string[] = []
    const blank = () =>
      registerStructuralOutputAdmission(session, () => ({
        hasOutput: false,
        hasVocabularyIssues: true,
        report: () => reports.push("blank"),
      }))
    const renderable = () =>
      registerStructuralOutputAdmission(session, () => ({
        hasOutput: true,
        hasVocabularyIssues: false,
        report: () => reports.push("renderable"),
      }))

    const releaseBlank = blank()
    const releaseRenderable = renderable()
    expect(admitStructuralOutput(session, { kind: "stream", nodes })?.hasOutput).toBe(true)
    releaseRenderable()
    expect(admitStructuralOutput(session, { kind: "stream", nodes })?.hasOutput).toBe(false)

    const releaseSecond = renderable()
    expect(admitStructuralOutput(session, { kind: "stream", nodes })?.hasOutput).toBe(true)
    releaseSecond()
    releaseBlank()
    expect(admitStructuralOutput(session, { kind: "stream", nodes })).toBeUndefined()
  })

  test("reports through every mounted admission and ignores repeat releases", () => {
    const session = new DocumentSession(parseExpoTurboDocument("<Root />"))
    const nodes = session.tree.document.children
    const reports: string[] = []
    const release = ["first", "second"].map((name) =>
      registerStructuralOutputAdmission(session, () => ({
        hasOutput: false,
        hasVocabularyIssues: true,
        report: () => reports.push(name),
      })),
    )

    admitStructuralOutput(session, { kind: "frame", nodes })?.report()
    expect(reports).toEqual(["first", "second"])

    release[0]?.()
    release[0]?.()
    expect(admitStructuralOutput(session, { kind: "frame", nodes })).toBeDefined()
    release[1]?.()
    expect(admitStructuralOutput(session, { kind: "frame", nodes })).toBeUndefined()
  })
})
