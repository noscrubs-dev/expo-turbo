import { describe, expect, test } from "bun:test"

import { PropsError, RequestError, StateError } from "./errors"
import {
  createFormSubmissionHandle,
  FORM_SUBMISSION_LIFECYCLE_END_DISPATCH,
  FORM_SUBMISSION_LIFECYCLE_START_DISPATCH,
  FormSubmissionLifecycle,
  finishFormSubmissionHandle,
  formSubmissionLifecycleOption,
  SubmitEndEvent,
  SubmitStartEvent,
} from "./form-submission-lifecycle"

function handle(controller = new AbortController()) {
  return createFormSubmissionHandle({
    controller,
    destination: Object.freeze({ frameId: "profile", kind: "frame" }),
    formNodeKey: "id:profile-form",
    requestId: "request-1",
    stop: () => controller.abort(),
    submitterNodeKey: "id:save",
  })
}

function capturedError(operation: () => unknown): Error {
  try {
    operation()
  } catch (error) {
    if (error instanceof Error) return error
  }
  throw new Error("Expected operation to throw an Error")
}

describe("form submission lifecycle", () => {
  test("exposes a frozen identity-bound handle with exact stop and state semantics", () => {
    const controller = new AbortController()
    const submission = handle(controller)
    const start = new SubmitStartEvent(submission)

    expect(start.detail).toEqual({ formSubmission: submission })
    expect(Object.isFrozen(start)).toBe(true)
    expect(Object.isFrozen(start.detail)).toBe(true)
    expect(Object.isFrozen(submission)).toBe(true)
    expect(Object.isFrozen(submission.destination)).toBe(true)
    expect(submission).toMatchObject({
      destination: { frameId: "profile", kind: "frame" },
      formNodeKey: "id:profile-form",
      requestId: "request-1",
      state: "waiting",
      submitterNodeKey: "id:save",
    })
    expect(submission.signal).toBe(controller.signal)

    expect(submission.stop()).toBe(true)
    expect(submission.stop()).toBeUndefined()
    expect(controller.signal.aborted).toBe(true)
    expect(submission.state).toBe("stopping")

    finishFormSubmissionHandle(submission)
    expect(submission.state).toBe("stopped")
    expect(submission.stop()).toBeUndefined()
    expect(submission.state).toBe("stopped")
  })

  test("clones and freezes top-level response, error, and cancellation details", () => {
    const submission = handle()
    const fetchResponse = { redirected: true, status: 422 }
    const response = new SubmitEndEvent(submission, {
      fetchResponse,
      success: false,
    })
    fetchResponse.status = 200

    expect(response.detail).toEqual({
      fetchResponse: { redirected: true, status: 422 },
      formSubmission: submission,
      success: false,
    })
    expect(Object.isFrozen(response)).toBe(true)
    expect(Object.isFrozen(response.detail)).toBe(true)
    if (!("fetchResponse" in response.detail)) throw new Error("expected response detail")
    expect(Object.isFrozen(response.detail.fetchResponse)).toBe(true)

    const error = new RequestError("Form submission request failed", { method: "POST" })
    const failed = new SubmitEndEvent(submission, { error, success: false })
    expect(failed.detail).toMatchObject({ formSubmission: submission, success: false })
    if (!("error" in failed.detail)) throw new Error("expected error detail")
    expect(failed.detail.error).not.toBe(error)
    expect(failed.detail.error).toBeInstanceOf(RequestError)
    expect(failed.detail.error.context).toEqual({ method: "POST" })
    expect(Object.isFrozen(failed.detail.error)).toBe(true)
    expect(new SubmitEndEvent(submission).detail).toEqual({ formSubmission: submission })
  })

  test("uses stable listener snapshots for both notification events", () => {
    const lifecycle = new FormSubmissionLifecycle({ onObserverError: () => undefined })
    const submission = handle()
    const calls: string[] = []
    const late = () => {
      calls.push("late")
      return undefined
    }
    let removeSecond: () => void = () => undefined
    lifecycle.subscribe("submit-start", () => {
      calls.push("first")
      removeSecond()
      lifecycle.subscribe("submit-start", late)
    })
    removeSecond = lifecycle.subscribe("submit-start", () => {
      calls.push("second")
    })

    lifecycle[FORM_SUBMISSION_LIFECYCLE_START_DISPATCH](new SubmitStartEvent(submission))
    expect(calls).toEqual(["first", "second"])
    calls.length = 0
    lifecycle[FORM_SUBMISSION_LIFECYCLE_START_DISPATCH](new SubmitStartEvent(submission))
    expect(calls).toEqual(["first", "late"])

    lifecycle.subscribe("submit-end", () => {
      calls.push("end")
    })
    lifecycle[FORM_SUBMISSION_LIFECYCLE_END_DISPATCH](new SubmitEndEvent(submission))
    expect(calls).toEqual(["first", "late", "end"])
  })

  test("isolates and redacts every observer failure without stopping later listeners", async () => {
    const reported: AggregateError[] = []
    const lifecycle = new FormSubmissionLifecycle({
      onObserverError(error) {
        reported.push(error)
        return undefined
      },
    })
    const calls: string[] = []
    lifecycle.subscribe("submit-start", () => {
      throw new Error("secret form value")
    })
    lifecycle.subscribe("submit-start", (() => false) as never)
    lifecycle.subscribe("submit-start", (() =>
      Promise.reject(new Error("secret rejection"))) as never)
    lifecycle.subscribe("submit-start", () => {
      calls.push("last")
    })

    lifecycle[FORM_SUBMISSION_LIFECYCLE_START_DISPATCH](new SubmitStartEvent(handle()))
    await Promise.resolve()

    expect(calls).toEqual(["last"])
    expect(reported).toHaveLength(1)
    expect(reported[0]?.errors).toHaveLength(3)
    expect(reported[0]?.errors.every((error) => error instanceof StateError)).toBe(true)
    expect(String(reported[0])).not.toContain("secret")
  })

  test("reads lifecycle options once and rejects invalid, hostile, and asynchronous observers", () => {
    const lifecycle = new FormSubmissionLifecycle()
    let reads = 0
    expect(
      formSubmissionLifecycleOption(
        {
          get submissionLifecycle() {
            reads += 1
            return lifecycle
          },
        },
        "Owner",
      ),
    ).toBe(lifecycle)
    expect(reads).toBe(1)
    expect(formSubmissionLifecycleOption({}, "Owner")).toBeUndefined()
    expect(() => formSubmissionLifecycleOption({ submissionLifecycle: null }, "Owner")).toThrow(
      PropsError,
    )

    const revoked = Proxy.revocable({}, {})
    revoked.revoke()
    const optionError = capturedError(() => formSubmissionLifecycleOption(revoked.proxy, "Owner"))
    expect(optionError).toBeInstanceOf(PropsError)
    expect(optionError.message).toBe("Owner options could not be read")

    expect(() => new FormSubmissionLifecycle({ onObserverError: null as never })).toThrow(
      PropsError,
    )
    expect(() => lifecycle.subscribe("other" as never, () => undefined)).toThrow(StateError)
    expect(() => lifecycle.subscribe("submit-start", null as never)).toThrow(StateError)
  })
})
