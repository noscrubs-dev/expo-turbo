import { describe, expect, test } from "bun:test"

import { formSubmissionActivity } from "./form-submission-activity"
import { parseExpoTurboDocument } from "./parser"
import { DocumentSession } from "./session"

function fixture(submitsWith?: string): DocumentSession {
  const pending =
    submitsWith === undefined ? "" : ` data-turbo-submits-with=${JSON.stringify(submitsWith)}`
  return new DocumentSession(
    parseExpoTurboDocument(
      `<Gallery><DemoForm id="form"><DemoButton id="submit"${pending} /><DemoButton id="other" /></DemoForm></Gallery>`,
      { url: "https://example.test/current" },
    ),
  )
}

function nodes(session: DocumentSession) {
  const form = session.tree.getElementById("form")
  const submitter = session.tree.getElementById("submit")
  const other = session.tree.getElementById("other")
  if (!form || !submitter || !other) throw new Error("missing activity fixture")
  return { form, other, submitter }
}

describe("exact form submission activity", () => {
  test("publishes stable frozen form and exact-submitter snapshots", () => {
    const session = fixture("Submitting…")
    const { form, other, submitter } = nodes(session)
    const activity = formSubmissionActivity(session, form)
    expect(formSubmissionActivity(session, form)).toBe(activity)
    expect(activity.state).toEqual({ busy: false, revision: 0, status: "idle" })
    expect(Object.isFrozen(activity.state)).toBe(true)
    expect(activity.stateForSubmitter(submitter)).toBe(activity.stateForSubmitter(submitter))

    let formCalls = 0
    let submitterCalls = 0
    let otherCalls = 0
    activity.subscribe(() => formCalls++)
    activity.subscribeSubmitter(submitter, () => submitterCalls++)
    activity.subscribeSubmitter(other, () => otherCalls++)

    const controller = new AbortController()
    const lease = activity.admit(controller, "request-1", submitter, "prevent")
    if (!lease) throw new Error("activity lease was not admitted")
    expect(activity.state.status).toBe("idle")
    expect(activity.start(lease)).toBe(true)
    expect(activity.state).toMatchObject({
      busy: true,
      requestId: "request-1",
      status: "submitting",
      submitterNodeKey: submitter.key,
    })
    expect(activity.stateForSubmitter(submitter)).toMatchObject({
      pending: true,
      submitsWith: "Submitting…",
    })
    expect(activity.stateForSubmitter(other)).toEqual({ pending: false, revision: 0 })
    expect(formCalls).toBe(1)
    expect(submitterCalls).toBe(1)
    expect(otherCalls).toBe(0)

    const activeSnapshot = activity.state
    activity.finish(lease)
    expect(activity.state).toMatchObject({ busy: false, status: "idle" })
    expect(activity.state).not.toBe(activeSnapshot)
    expect(activity.stateForSubmitter(submitter).pending).toBe(false)
    expect(formCalls).toBe(2)
    expect(submitterCalls).toBe(2)
    expect(otherCalls).toBe(0)
  })

  test("prevents duplicates without disturbing the incumbent", () => {
    const session = fixture()
    const { form, submitter } = nodes(session)
    const activity = formSubmissionActivity(session, form)
    const firstController = new AbortController()
    const first = activity.admit(firstController, "first", submitter, "prevent")
    if (!first) throw new Error("first activity was not admitted")
    activity.start(first)
    const firstState = activity.state

    const duplicateController = new AbortController()
    expect(activity.admit(duplicateController, "duplicate", submitter, "prevent")).toBeUndefined()
    expect(duplicateController.signal.aborted).toBe(true)
    expect(firstController.signal.aborted).toBe(false)
    expect(activity.state).toBe(firstState)
    expect(activity.owns(first)).toBe(true)
  })

  test("cancels only after the last exact-form scope releases", () => {
    const session = fixture()
    const { form, submitter } = nodes(session)
    const activity = formSubmissionActivity(session, form)
    const releaseFirst = activity.retainScope()
    const releaseSecond = activity.retainScope()
    const controller = new AbortController()
    const lease = activity.admit(controller, "owned", submitter, "prevent")
    if (!lease) throw new Error("owned activity was not admitted")
    activity.start(lease)

    releaseFirst()
    releaseFirst()
    expect(controller.signal.aborted).toBe(false)
    expect(activity.state.busy).toBe(true)

    releaseSecond()
    expect(controller.signal.aborted).toBe(true)
    expect(activity.state).toMatchObject({ busy: false, status: "idle" })
  })

  test("isolates activity ownership by document session even for a shared tree", () => {
    const firstSession = fixture()
    const secondSession = new DocumentSession(firstSession.tree)
    const firstNodes = nodes(firstSession)
    const secondNodes = nodes(secondSession)
    const first = formSubmissionActivity(firstSession, firstNodes.form)
    const second = formSubmissionActivity(secondSession, secondNodes.form)

    expect(secondNodes.form).toBe(firstNodes.form)
    expect(second).not.toBe(first)
    const lease = first.admit(
      new AbortController(),
      "first-session",
      firstNodes.submitter,
      "prevent",
    )
    if (!lease) throw new Error("first session activity was not admitted")
    first.start(lease)
    expect(first.state.busy).toBe(true)
    expect(second.state).toEqual({ busy: false, revision: 0, status: "idle" })
  })

  test("installs an explicit supersede before aborting stale work", () => {
    const session = fixture()
    const { form, other, submitter } = nodes(session)
    const activity = formSubmissionActivity(session, form)
    const firstController = new AbortController()
    const first = activity.admit(firstController, "first", submitter, "prevent")
    if (!first) throw new Error("first activity was not admitted")
    activity.start(first)

    const secondController = new AbortController()
    const second = activity.admit(secondController, "second", other, "supersede")
    if (!second) throw new Error("second activity was not admitted")
    expect(firstController.signal.aborted).toBe(true)
    expect(activity.state.requestId).toBe("first")
    expect(activity.start(second)).toBe(true)
    expect(activity.state.requestId).toBe("second")
    expect(activity.stateForSubmitter(submitter).pending).toBe(false)
    expect(activity.stateForSubmitter(other).pending).toBe(true)

    activity.finish(first)
    expect(activity.state.requestId).toBe("second")
    activity.finish(second)
    expect(activity.state).toMatchObject({ busy: false, status: "idle" })
  })

  test("treats empty submits-with as absent and preserves whitespace verbatim", () => {
    const emptySession = fixture("")
    const emptyNodes = nodes(emptySession)
    const empty = formSubmissionActivity(emptySession, emptyNodes.form)
    const emptyLease = empty.admit(new AbortController(), "empty", emptyNodes.submitter, "prevent")
    if (!emptyLease) throw new Error("empty activity was not admitted")
    empty.start(emptyLease)
    expect(empty.stateForSubmitter(emptyNodes.submitter)).toEqual({
      pending: true,
      revision: 1,
    })

    const spacedSession = fixture("  ")
    const spacedNodes = nodes(spacedSession)
    const spaced = formSubmissionActivity(spacedSession, spacedNodes.form)
    const spacedLease = spaced.admit(
      new AbortController(),
      "spaced",
      spacedNodes.submitter,
      "prevent",
    )
    if (!spacedLease) throw new Error("spaced activity was not admitted")
    spaced.start(spacedLease)
    expect(spaced.stateForSubmitter(spacedNodes.submitter).submitsWith).toBe("  ")
  })

  test("cancels on exact-node disposal and isolates same-key replacement", () => {
    const session = fixture("Working")
    const { form, submitter } = nodes(session)
    const oldActivity = formSubmissionActivity(session, form)
    const controller = new AbortController()
    const lease = oldActivity.admit(controller, "removal", submitter, "prevent")
    if (!lease) throw new Error("removal activity was not admitted")
    oldActivity.start(lease)

    session.replaceTree(
      parseExpoTurboDocument(
        '<Gallery><DemoForm id="form"><DemoButton id="submit" /></DemoForm></Gallery>',
        { url: "https://example.test/current" },
      ),
    )
    expect(controller.signal.aborted).toBe(true)
    expect(oldActivity.state).toMatchObject({ busy: false, status: "idle" })

    const replacement = session.tree.getElementById("form")
    if (!replacement) throw new Error("replacement form is missing")
    const replacementActivity = formSubmissionActivity(session, replacement)
    expect(replacementActivity).not.toBe(oldActivity)
    expect(replacementActivity.state).toEqual({ busy: false, revision: 0, status: "idle" })
  })
})
