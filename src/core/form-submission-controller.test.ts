import { describe, expect, test } from "bun:test"
import { z } from "zod"

import type { FetchAdapter, TurboRequest, TurboResponse } from "../adapters"
import { createStreamActionRegistry, defineStreamAction } from "./custom-stream-actions"
import { DocumentRequestLoader } from "./document-loader"
import { DocumentSnapshotCache } from "./document-snapshot-cache"
import { FrameMissingError, ParseError, RequestError, StateError } from "./errors"
import { FormSubmissionCommitError, FormSubmissionController } from "./form-submission-controller"
import type { FormSubmissionProposal } from "./form-submission-proposal"
import { DocumentFormControls, FormControlRegistry } from "./forms"
import { EXPO_TURBO_MIME_TYPE, FrameRequestLoader } from "./frame-loader"
import { parseExpoTurboDocument } from "./parser"
import { TURBO_STREAM_MIME_TYPE } from "./protocol-request"
import { DocumentSession } from "./session"
import { attributeValue, isElement } from "./tree"

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

interface PendingRequest {
  readonly request: TurboRequest
  readonly response: ReturnType<typeof deferred<TurboResponse>>
}

function pendingFetch(): { adapter: FetchAdapter; pending: PendingRequest[] } {
  const pending: PendingRequest[] = []
  return {
    adapter: {
      fetch(request) {
        const response = deferred<TurboResponse>()
        pending.push({ request, response })
        return response.promise
      },
    },
    pending,
  }
}

function response(
  request: TurboRequest,
  body: string,
  options: Partial<TurboResponse> = {},
): TurboResponse {
  return {
    headers: { "Content-Type": `${EXPO_TURBO_MIME_TYPE}; charset=utf-8` },
    redirected: false,
    status: 200,
    text: async () => body,
    url: request.url,
    ...options,
  }
}

function fixture(): DocumentSession {
  return new DocumentSession(
    parseExpoTurboDocument(
      `<Gallery>
        <DemoForm id="document-form" action="/submit-document"><DemoInput id="document-field" /><DemoButton id="document-submitter" data-turbo-submits-with="Submitting…" /></DemoForm>
        <Status id="status" />
        <DemoForm id="moving-form" action="/submit-moving" data-turbo-frame="frame-a" />
        <turbo-frame id="frame-a" src="/frame-a">
          <DemoForm id="form-a" action="/submit-a"><DemoInput id="field-a" /></DemoForm>
        </turbo-frame>
        <turbo-frame id="frame-b" src="/frame-b">
          <DemoForm id="form-b" action="/submit-b"><DemoInput id="field-b" /></DemoForm>
        </turbo-frame>
      </Gallery>`,
      { url: "https://example.test/current" },
    ),
  )
}

function registry(session: DocumentSession, formId: string): FormControlRegistry {
  const form = session.tree.getElementById(formId)
  if (!form) throw new Error(`missing form fixture ${formId}`)
  return new FormControlRegistry(session, form.key)
}

function proposal(
  controls: FormControlRegistry,
  requestId: string,
): (signal: AbortSignal) => ReturnType<FormControlRegistry["submissionProposal"]> {
  return (signal) => controls.submissionProposal({ protocol: { requestId }, signal })
}

function requestIds(prefix: string) {
  let value = 0
  return { next: () => `${prefix}-${++value}` }
}

function populatedSnapshotCache(session: DocumentSession): DocumentSnapshotCache {
  const cache = new DocumentSnapshotCache()
  const currentUrl = session.tree.document.url
  if (!currentUrl) throw new Error("snapshot fixture requires a document URL")
  cache.put(currentUrl, session.tree)
  const otherUrl = "https://example.test/other"
  cache.put(otherUrl, parseExpoTurboDocument("<Other />", { url: otherUrl }))
  return cache
}

describe("FormSubmissionController", () => {
  test("shares the document lane with GET requests in both directions", async () => {
    {
      const session = fixture()
      const transport = pendingFetch()
      const loader = new DocumentRequestLoader(session, transport.adapter, requestIds("document"))
      const controller = new FormSubmissionController(session, transport.adapter)
      const revision = session.revision
      const getOwner = Object.freeze({})
      const loading = loader.load("/next", getOwner)
      const getRequest = transport.pending[0]
      if (!getRequest) throw new Error("document GET was not captured")

      const controls = registry(session, "document-form")
      let admitted: FormSubmissionProposal | undefined
      const submitting = controller.submit((signal) => {
        admitted = controls.submissionProposal({ protocol: { requestId: "form-1" }, signal })
        return admitted
      })
      const formRequest = transport.pending[1]
      if (!formRequest || !admitted) throw new Error("document form request was not captured")
      expect(formRequest.request).toBe(admitted.plan.request)
      expect(session.recentRequestIds.has("document-1")).toBe(true)
      expect(session.recentRequestIds.has("form-1")).toBe(true)
      expect(getRequest.request.signal?.aborted).toBe(true)
      expect(formRequest.request.signal?.aborted).toBe(false)
      loader.cancel(getOwner)
      expect(formRequest.request.signal?.aborted).toBe(false)

      formRequest.response.resolve(response(formRequest.request, "<Candidate />"))
      const result = await submitting
      expect(result).toMatchObject({
        application: "document",
        destination: { kind: "document" },
        requestId: "form-1",
        status: "applied",
      })
      expect(Object.isFrozen(result)).toBe(true)
      expect(session.revision).toBeGreaterThan(revision)
      expect(session.tree.document.children.filter(isElement)[0]?.tagName).toBe("Candidate")

      getRequest.response.resolve(response(getRequest.request, "<Gallery><Late /></Gallery>"))
      expect(await loading).toMatchObject({ status: "canceled" })
      expect(session.tree.document.children.filter(isElement)[0]?.tagName).toBe("Candidate")
    }

    {
      const session = fixture()
      const transport = pendingFetch()
      const loader = new DocumentRequestLoader(session, transport.adapter, requestIds("document"))
      const controller = new FormSubmissionController(session, transport.adapter)
      const submitting = controller.submit(
        proposal(registry(session, "document-form"), "form-before-get"),
      )
      const formRequest = transport.pending[0]
      if (!formRequest) throw new Error("document form request was not captured")

      const loading = loader.load("/new-document")
      const getRequest = transport.pending[1]
      if (!getRequest) throw new Error("document GET was not captured")
      expect(formRequest.request.signal?.aborted).toBe(true)
      expect(await submitting).toEqual({
        destination: { kind: "document" },
        effectiveMethod: "GET",
        requestId: "form-before-get",
        requestedUrl: "https://example.test/submit-document",
        sourceMethod: "GET",
        status: "canceled",
      })

      getRequest.response.resolve(
        response(getRequest.request, '<Gallery><Committed id="committed" /></Gallery>'),
      )
      expect(await loading).toMatchObject({ status: "committed" })
      expect(session.tree.getElementById("committed")?.tagName).toBe("Committed")
    }
  })

  test("shares each exact Frame lane with GET requests in both directions", async () => {
    {
      const session = fixture()
      const frame = session.tree.getElementById("frame-a")
      const originalChildren = frame?.children
      const transport = pendingFetch()
      const loader = new FrameRequestLoader(session, transport.adapter, requestIds("frame"))
      const controller = new FormSubmissionController(session, transport.adapter)
      const getOwner = Object.freeze({})
      const loading = loader.load("frame-a", "/frame-get", { owner: getOwner })
      const getRequest = transport.pending[0]
      if (!getRequest) throw new Error("Frame GET was not captured")

      const submitting = controller.submit(proposal(registry(session, "form-a"), "form-frame"))
      const formRequest = transport.pending[1]
      if (!formRequest) throw new Error("Frame form request was not captured")
      expect(getRequest.request.signal?.aborted).toBe(true)
      expect(formRequest.request.headers["Turbo-Frame"]).toBe("frame-a")
      loader.cancel("frame-a", getOwner)
      expect(formRequest.request.signal?.aborted).toBe(false)

      formRequest.response.resolve(
        response(formRequest.request, '<turbo-frame id="frame-a"><Candidate /></turbo-frame>'),
      )
      expect(await submitting).toMatchObject({
        application: "frame",
        destination: { frameId: "frame-a", kind: "frame" },
        status: "applied",
      })
      expect(session.tree.getElementById("frame-a")).toBe(frame)
      expect(frame?.children).not.toBe(originalChildren)
      expect(frame?.children.filter(isElement)[0]?.tagName).toBe("Candidate")

      getRequest.response.resolve(
        response(getRequest.request, '<turbo-frame id="frame-a"><Late /></turbo-frame>'),
      )
      expect(await loading).toMatchObject({ status: "canceled" })
      expect(frame?.children.filter(isElement)[0]?.tagName).toBe("Candidate")
    }

    {
      const session = fixture()
      const transport = pendingFetch()
      const loader = new FrameRequestLoader(session, transport.adapter, requestIds("frame"))
      const controller = new FormSubmissionController(session, transport.adapter)
      const submitting = controller.submit(
        proposal(registry(session, "form-a"), "form-before-frame-get"),
      )
      const formRequest = transport.pending[0]
      if (!formRequest) throw new Error("Frame form request was not captured")

      const loading = loader.load("frame-a", "/frame-new")
      const getRequest = transport.pending[1]
      if (!getRequest) throw new Error("Frame GET was not captured")
      expect(formRequest.request.signal?.aborted).toBe(true)
      expect(await submitting).toMatchObject({ status: "canceled" })

      getRequest.response.resolve(
        response(getRequest.request, '<turbo-frame id="frame-a"><Committed /></turbo-frame>'),
      )
      expect(await loading).toMatchObject({ status: "completed" })
      expect(session.tree.getElementById("frame-a")?.children.filter(isElement)[0]?.tagName).toBe(
        "Committed",
      )
    }
  })

  test("supersedes the same destination while different Frames remain concurrent", async () => {
    const session = fixture()
    const transport = pendingFetch()
    const firstController = new FormSubmissionController(session, transport.adapter)
    const secondController = new FormSubmissionController(session, transport.adapter)
    const formA = registry(session, "form-a")
    const formB = registry(session, "form-b")

    const firstA = firstController.submit(proposal(formA, "a-1"))
    const requestA1 = transport.pending[0]
    const submissionB = secondController.submit(proposal(formB, "b-1"))
    const requestB = transport.pending[1]
    const secondA = secondController.submit(proposal(formA, "a-2"), {
      duplicateBehavior: "supersede",
    })
    const requestA2 = transport.pending[2]
    if (!requestA1 || !requestB || !requestA2) throw new Error("form requests were not captured")

    expect(requestA1.request.signal?.aborted).toBe(true)
    expect(requestB.request.signal?.aborted).toBe(false)
    expect(requestA2.request.signal?.aborted).toBe(false)
    expect(await firstA).toMatchObject({ status: "canceled" })

    requestA2.response.resolve(
      response(requestA2.request, '<turbo-frame id="frame-a"><A /></turbo-frame>'),
    )
    requestB.response.resolve(
      response(requestB.request, '<turbo-frame id="frame-b"><B /></turbo-frame>'),
    )
    expect(await secondA).toMatchObject({ requestId: "a-2", status: "applied" })
    expect(await submissionB).toMatchObject({ requestId: "b-1", status: "applied" })
  })

  test("prevents an exact-form duplicate before destination ownership or fetch", async () => {
    const session = fixture()
    session.setAttribute("id:document-form", "method", "post")
    const transport = pendingFetch()
    const firstController = new FormSubmissionController(session, transport.adapter)
    const secondController = new FormSubmissionController(session, transport.adapter)
    const formControls = new DocumentFormControls(session, {
      submissionController: firstController,
    }).controlsFor("id:document-form")
    const duplicateControls = registry(session, "document-form")
    const firstSubmitter = formControls.register("id:document-submitter", {
      kind: "submitter",
      name: "commit",
      value: "original",
    })
    const duplicateSubmitter = duplicateControls.register("id:document-submitter", {
      kind: "submitter",
      name: "commit",
      value: "original",
    })

    const first = formControls.submit({
      protocol: { requestId: "first" },
      submitter: firstSubmitter.selection,
    })
    const request = transport.pending[0]
    if (!request) throw new Error("first form request was not captured")
    expect(formControls.submissionState).toMatchObject({
      busy: true,
      requestId: "first",
      status: "submitting",
    })
    expect(formControls.controlSubmissionState("id:document-submitter")).toMatchObject({
      pending: true,
      submitsWith: "Submitting…",
    })
    expect(request.request.body?.value).toBe("commit=original")

    const duplicate = secondController.submit((signal) =>
      duplicateControls.submissionProposal({
        protocol: { requestId: "duplicate" },
        signal,
        submitter: duplicateSubmitter.selection,
      }),
    )
    expect(transport.pending).toHaveLength(1)
    expect(await duplicate).toMatchObject({ requestId: "duplicate", status: "canceled" })
    expect(request.request.signal?.aborted).toBe(false)
    expect(formControls.submissionState.requestId).toBe("first")

    request.response.resolve(response(request.request, "", { status: 204 }))
    expect(await first).toMatchObject({ application: "empty", status: "empty" })
    expect(formControls.submissionState).toMatchObject({ busy: false, status: "idle" })
    expect(formControls.controlSubmissionState("id:document-submitter").pending).toBe(false)
  })

  test("publishes applied, empty, and active cancellation as shared terminal outcomes after busy clears", async () => {
    {
      const session = fixture()
      session.setAttribute("id:document-form", "method", "post")
      const transport = pendingFetch()
      const controller = new FormSubmissionController(session, transport.adapter)
      const submittingControls = registry(session, "document-form")
      const observingControls = registry(session, "document-form")
      const observations: Array<{ busy: boolean; status: string }> = []
      observingControls.subscribeSubmissionTerminal(() => {
        observations.push({
          busy: submittingControls.submissionState.busy,
          status: observingControls.submissionTerminalState.status,
        })
      })

      const submitting = controller.submit(proposal(submittingControls, "terminal-applied"))
      const request = transport.pending[0]
      if (!request) throw new Error("applied terminal request was not captured")
      request.response.resolve(
        response(
          request.request,
          '<turbo-stream action="update" target="status"><template><Applied /></template></turbo-stream>',
          { headers: { "Content-Type": TURBO_STREAM_MIME_TYPE } },
        ),
      )

      expect(await submitting).toMatchObject({ application: "stream", status: "applied" })
      expect(submittingControls.submissionTerminalState).toMatchObject({
        application: "stream",
        classification: "success",
        effectiveMethod: "POST",
        requestId: "terminal-applied",
        responseStatus: 200,
        status: "applied",
      })
      expect(observingControls.submissionTerminalState).toBe(
        submittingControls.submissionTerminalState,
      )
      expect(observations).toEqual([{ busy: false, status: "applied" }])
    }

    {
      const session = fixture()
      const transport = pendingFetch()
      const controller = new FormSubmissionController(session, transport.adapter)
      const submittingControls = registry(session, "document-form")
      const observingControls = registry(session, "document-form")
      const observations: Array<{ busy: boolean; status: string }> = []
      observingControls.subscribeSubmissionTerminal(() => {
        observations.push({
          busy: submittingControls.submissionState.busy,
          status: observingControls.submissionTerminalState.status,
        })
      })

      const submitting = controller.submit(proposal(submittingControls, "terminal-empty"))
      const request = transport.pending[0]
      if (!request) throw new Error("empty terminal request was not captured")
      request.response.resolve(response(request.request, "", { status: 204 }))

      expect(await submitting).toMatchObject({ status: "empty" })
      expect(submittingControls.submissionTerminalState).toMatchObject({
        classification: "success",
        effectiveMethod: "GET",
        requestId: "terminal-empty",
        responseStatus: 204,
        status: "empty",
      })
      expect(observingControls.submissionTerminalState).toBe(
        submittingControls.submissionTerminalState,
      )
      expect(observations).toEqual([{ busy: false, status: "empty" }])
    }

    {
      const session = fixture()
      const transport = pendingFetch()
      const controller = new FormSubmissionController(session, transport.adapter)
      const submittingControls = registry(session, "document-form")
      const observingControls = registry(session, "document-form")
      const observations: Array<{ busy: boolean; status: string }> = []
      observingControls.subscribeSubmissionTerminal(() => {
        observations.push({
          busy: submittingControls.submissionState.busy,
          status: observingControls.submissionTerminalState.status,
        })
      })

      const submitting = controller.submit(proposal(submittingControls, "terminal-canceled"))
      const request = transport.pending[0]
      if (!request) throw new Error("canceled terminal request was not captured")
      submittingControls.cancelSubmission()

      expect(request.request.signal?.aborted).toBe(true)
      expect(await submitting).toMatchObject({ status: "canceled" })
      expect(submittingControls.submissionTerminalState).toMatchObject({
        effectiveMethod: "GET",
        requestId: "terminal-canceled",
        status: "canceled",
      })
      expect(observingControls.submissionTerminalState).toBe(
        submittingControls.submissionTerminalState,
      )
      expect(observations).toEqual([{ busy: false, status: "canceled" }])
    }
  })

  test("keeps the prior terminal outcome when confirmation is denied before submission starts", async () => {
    const session = fixture()
    const transport = pendingFetch()
    const controller = new FormSubmissionController(session, transport.adapter, {
      confirmation: { confirm: () => false },
    })
    const submittingControls = registry(session, "document-form")
    const observingControls = registry(session, "document-form")

    const baseline = controller.submit(proposal(submittingControls, "terminal-before-denial"))
    const request = transport.pending[0]
    if (!request) throw new Error("baseline terminal request was not captured")
    request.response.resolve(response(request.request, "", { status: 204 }))
    await baseline
    const priorTerminal = submittingControls.submissionTerminalState
    expect(priorTerminal).toMatchObject({
      requestId: "terminal-before-denial",
      status: "empty",
    })

    session.setAttribute("id:document-form", "data-turbo-confirm", "Continue?")
    expect(
      await controller.submit(proposal(observingControls, "denied-before-start")),
    ).toMatchObject({ requestId: "denied-before-start", status: "canceled" })

    expect(transport.pending).toHaveLength(1)
    expect(submittingControls.submissionTerminalState).toBe(priorTerminal)
    expect(observingControls.submissionTerminalState).toBe(priorTerminal)
  })

  test("classifies transport failures as safe for GET and unsafe for non-GET without retaining causes", async () => {
    for (const scenario of [
      { effectiveMethod: "GET", retryDisposition: "safe" },
      { effectiveMethod: "POST", retryDisposition: "unsafe" },
    ] as const) {
      const session = fixture()
      if (scenario.effectiveMethod === "POST") {
        session.setAttribute("id:document-form", "method", "post")
      }
      const submittingControls = registry(session, "document-form")
      const observingControls = registry(session, "document-form")
      const controller = new FormSubmissionController(session, {
        async fetch() {
          throw new Error(`transport secret-token-${scenario.effectiveMethod}`)
        },
      })

      await expect(
        controller.submit(
          proposal(submittingControls, `terminal-failure-${scenario.effectiveMethod}`),
        ),
      ).rejects.toBeInstanceOf(RequestError)

      const terminal = submittingControls.submissionTerminalState
      expect(terminal).toMatchObject({
        effectiveMethod: scenario.effectiveMethod,
        error: {
          code: "request",
          context: {},
          message: "Form submission request failed",
          name: "RequestError",
        },
        requestId: `terminal-failure-${scenario.effectiveMethod}`,
        retryDisposition: scenario.retryDisposition,
        status: "failed",
      })
      expect(observingControls.submissionTerminalState).toBe(terminal)
      expect(submittingControls.submissionState.busy).toBe(false)
      if (terminal.status !== "failed") throw new Error("expected failed terminal state")
      expect("cause" in terminal.error).toBe(false)
      expect(JSON.stringify(terminal)).not.toContain("secret-token")
      expect(Object.isFrozen(terminal.error)).toBe(true)
      expect(Object.isFrozen(terminal.error.context)).toBe(true)
    }
  })

  test("redacts response payload identifiers from terminal parse failures", async () => {
    const session = fixture()
    const controls = registry(session, "document-form")
    const controller = new FormSubmissionController(session, {
      fetch: async (request) =>
        response(
          request,
          '<Gallery><Secret id="customer-secret-42"/><Duplicate id="customer-secret-42"/></Gallery>',
        ),
    })

    await expect(
      controller.submit(proposal(controls, "terminal-redacted-parse")),
    ).rejects.toMatchObject({ code: "parse" })

    const terminal = controls.submissionTerminalState
    expect(terminal).toMatchObject({
      error: {
        code: "parse",
        message: "Form response XML is invalid",
        name: "ParseError",
      },
      requestId: "terminal-redacted-parse",
      retryDisposition: "safe",
      status: "failed",
    })
    expect(JSON.stringify(terminal)).not.toContain("customer-secret-42")
    if (terminal.status !== "failed") throw new Error("expected failed terminal state")
    expect("target" in terminal.error.context).toBe(false)
  })

  test("publishes a redacted committed-error terminal outcome after Stream commit finalization fails", async () => {
    const session = fixture()
    session.setAttribute("id:document-form", "method", "post")
    session.subscribe("id:frame-b", () => {
      throw new Error("committed observer secret-token")
    })
    const submittingControls = registry(session, "document-form")
    const observingControls = registry(session, "document-form")
    const controller = new FormSubmissionController(session, {
      fetch: async (request) =>
        response(
          request,
          '<turbo-stream action="update" target="frame-b"><template><Committed /></template></turbo-stream>',
          { headers: { "Content-Type": TURBO_STREAM_MIME_TYPE } },
        ),
    })

    await expect(
      controller.submit(proposal(submittingControls, "terminal-committed-error")),
    ).rejects.toBeInstanceOf(FormSubmissionCommitError)

    const terminal = submittingControls.submissionTerminalState
    expect(terminal).toMatchObject({
      application: "stream",
      classification: "success",
      effectiveMethod: "POST",
      error: {
        code: "request",
        context: { responseStatus: 200 },
        message: "Form submission committed but finalization failed",
        name: "FormSubmissionCommitError",
      },
      requestId: "terminal-committed-error",
      responseStatus: 200,
      retryDisposition: "committed",
      status: "committed-error",
    })
    expect(observingControls.submissionTerminalState).toBe(terminal)
    expect(submittingControls.submissionState.busy).toBe(false)
    if (terminal.status !== "committed-error") {
      throw new Error("expected committed-error terminal state")
    }
    expect("cause" in terminal.error).toBe(false)
    expect(JSON.stringify(terminal)).not.toContain("secret-token")
  })

  test("records valid 422 and 500 Stream responses as applied terminal outcomes", async () => {
    for (const scenario of [
      { classification: "client-error", status: 422 },
      { classification: "server-error", status: 500 },
    ] as const) {
      const session = fixture()
      session.setAttribute("id:document-form", "method", "post")
      const submittingControls = registry(session, "document-form")
      const observingControls = registry(session, "document-form")
      const controller = new FormSubmissionController(session, {
        fetch: async (request) =>
          response(
            request,
            `<turbo-stream action="update" target="status"><template><Handled id="handled-${scenario.status}" /></template></turbo-stream>`,
            {
              headers: { "Content-Type": TURBO_STREAM_MIME_TYPE },
              status: scenario.status,
            },
          ),
      })

      expect(
        await controller.submit(
          proposal(submittingControls, `terminal-applied-${scenario.status}`),
        ),
      ).toMatchObject({
        application: "stream",
        classification: scenario.classification,
        responseStatus: scenario.status,
        status: "applied",
      })
      const terminal = submittingControls.submissionTerminalState
      expect(terminal).toMatchObject({
        application: "stream",
        classification: scenario.classification,
        effectiveMethod: "POST",
        requestId: `terminal-applied-${scenario.status}`,
        responseStatus: scenario.status,
        status: "applied",
      })
      expect(observingControls.submissionTerminalState).toBe(terminal)
      expect("error" in terminal).toBe(false)
      expect("retryDisposition" in terminal).toBe(false)
    }
  })

  test("keeps a superseded stale cancellation inert after the newer terminal outcome", async () => {
    const session = fixture()
    const transport = pendingFetch()
    const controller = new FormSubmissionController(session, transport.adapter)
    const submittingControls = registry(session, "document-form")
    const observingControls = registry(session, "document-form")

    const stale = controller.submit(proposal(submittingControls, "terminal-stale"))
    const staleRequest = transport.pending[0]
    if (!staleRequest) throw new Error("stale terminal request was not captured")
    const current = controller.submit(proposal(observingControls, "terminal-current"), {
      duplicateBehavior: "supersede",
    })
    const currentRequest = transport.pending[1]
    if (!currentRequest) throw new Error("current terminal request was not captured")

    expect(staleRequest.request.signal?.aborted).toBe(true)
    expect(await stale).toMatchObject({ requestId: "terminal-stale", status: "canceled" })
    expect(submittingControls.submissionTerminalState.status).toBe("none")

    currentRequest.response.resolve(response(currentRequest.request, "", { status: 204 }))
    expect(await current).toMatchObject({ requestId: "terminal-current", status: "empty" })
    const currentTerminal = submittingControls.submissionTerminalState
    expect(currentTerminal).toMatchObject({
      requestId: "terminal-current",
      status: "empty",
    })

    staleRequest.response.resolve(response(staleRequest.request, "", { status: 204 }))
    await Promise.resolve()
    expect(submittingControls.submissionTerminalState).toBe(currentTerminal)
    expect(observingControls.submissionTerminalState).toBe(currentTerminal)
  })

  test("resolves confirmation metadata by submitter-first attribute presence", async () => {
    const cases = [
      { expected: "Form confirmation", form: "Form confirmation" },
      { expected: "", form: "Form confirmation", submitter: "" },
      {
        expected: "  Submitter confirmation  ",
        form: "Form confirmation",
        submitter: "  Submitter confirmation  ",
      },
    ] as const

    for (const scenario of cases) {
      const session = fixture()
      session.setAttribute("id:document-form", "data-turbo-confirm", scenario.form)
      if ("submitter" in scenario) {
        session.setAttribute("id:document-submitter", "data-turbo-confirm", scenario.submitter)
      }
      const transport = pendingFetch()
      const messages: string[] = []
      let confirmationSignal: AbortSignal | undefined
      const controller = new FormSubmissionController(session, transport.adapter, {
        confirmation: {
          confirm(message, signal) {
            messages.push(message)
            confirmationSignal = signal
            return false
          },
        },
      })
      const controls = registry(session, "document-form")
      const submitter = controls.register("id:document-submitter", {
        kind: "submitter",
        name: "commit",
        value: "save",
      })

      const result = await controller.submit((signal) =>
        controls.submissionProposal({
          protocol: { requestId: `confirmation-${JSON.stringify(scenario.expected)}` },
          signal,
          submitter: submitter.selection,
        }),
      )

      expect(messages).toEqual([scenario.expected])
      expect(confirmationSignal?.aborted).toBe(true)
      expect(result).toMatchObject({ status: "canceled" })
      expect(transport.pending).toHaveLength(0)
      expect(controls.submissionState).toMatchObject({ busy: false, status: "idle" })
    }
  })

  test("captures the immutable request before async confirmation and publishes activity only after acceptance", async () => {
    const session = fixture()
    session.setAttribute("id:document-form", "method", "post")
    session.setAttribute("id:document-form", "data-turbo-confirm", "Send original values?")
    const transport = pendingFetch()
    const answer = deferred<boolean>()
    const messages: string[] = []
    const controller = new FormSubmissionController(session, transport.adapter, {
      confirmation: {
        confirm(message) {
          messages.push(message)
          return answer.promise
        },
      },
    })
    const controls = registry(session, "document-form")
    const field = controls.register("id:document-field", {
      kind: "value",
      name: "profile[name]",
      value: "before",
    })
    const submitter = controls.register("id:document-submitter", {
      kind: "submitter",
      name: "commit",
      value: "save",
    })

    const submitting = controller.submit((signal) =>
      controls.submissionProposal({
        protocol: { requestId: "confirmed-request" },
        signal,
        submitter: submitter.selection,
      }),
    )
    expect(messages).toEqual(["Send original values?"])
    expect(transport.pending).toHaveLength(0)
    expect(controls.submissionState).toMatchObject({ busy: false, status: "idle" })
    expect(controls.controlSubmissionState("id:document-submitter").pending).toBe(false)

    field.update({ kind: "value", name: "profile[name]", value: "after" })
    session.setAttribute("id:document-form", "data-turbo-confirm", "Changed message")
    answer.resolve(true)
    await new Promise((resolve) => setTimeout(resolve, 0))

    const request = transport.pending[0]
    if (!request) throw new Error("confirmed form request was not captured")
    expect(request.request.body?.value).toBe("profile%5Bname%5D=before&commit=save")
    expect(controls.submissionState).toMatchObject({
      busy: true,
      requestId: "confirmed-request",
      status: "submitting",
    })
    expect(controls.controlSubmissionState("id:document-submitter")).toMatchObject({
      pending: true,
      submitsWith: "Submitting…",
    })

    request.response.resolve(response(request.request, "", { status: 204 }))
    expect(await submitting).toMatchObject({ application: "empty", status: "empty" })
    expect(controls.submissionState).toMatchObject({ busy: false, status: "idle" })
  })

  test("cancels a pending confirmation promptly even when the adapter ignores abort", async () => {
    const session = fixture()
    session.setAttribute("id:document-form", "data-turbo-confirm", "Continue?")
    const transport = pendingFetch()
    const answer = deferred<boolean>()
    let confirmationSignal: AbortSignal | undefined
    const controller = new FormSubmissionController(session, transport.adapter, {
      confirmation: {
        confirm(_message, signal) {
          confirmationSignal = signal
          return answer.promise
        },
      },
    })
    const controls = new FormControlRegistry(session, "id:document-form", {
      submissionController: controller,
    })

    const submitting = controls.submit({ protocol: { requestId: "cancel-confirmation" } })
    expect(controls.submissionState).toMatchObject({ busy: false, status: "idle" })
    controls.cancelSubmission()

    expect(await submitting).toMatchObject({
      requestId: "cancel-confirmation",
      status: "canceled",
    })
    expect(confirmationSignal?.aborted).toBe(true)
    expect(transport.pending).toHaveLength(0)
    answer.resolve(true)
    await Promise.resolve()
    expect(transport.pending).toHaveLength(0)
  })

  test("cancels pending confirmation on exact form or submitter removal and replacement", async () => {
    const cases = [
      { kind: "remove", name: "form removal", target: "document-form" },
      { kind: "replace", name: "form replacement", target: "document-form" },
      { kind: "remove", name: "submitter removal", target: "document-submitter" },
      { kind: "replace", name: "submitter replacement", target: "document-submitter" },
    ] as const

    for (const scenario of cases) {
      const session = fixture()
      session.setAttribute("id:document-form", "data-turbo-confirm", "Continue?")
      const transport = pendingFetch()
      const answer = deferred<boolean>()
      let confirmationSignal: AbortSignal | undefined
      const controller = new FormSubmissionController(session, transport.adapter, {
        confirmation: {
          confirm(_message, signal) {
            confirmationSignal = signal
            return answer.promise
          },
        },
      })
      const controls = registry(session, "document-form")
      const submitter = controls.register("id:document-submitter", {
        kind: "submitter",
        name: "commit",
        value: "save",
      })
      const requestId = scenario.name.replaceAll(" ", "-")
      const submitting = controller.submit((signal) =>
        controls.submissionProposal({
          protocol: { requestId },
          signal,
          submitter: submitter.selection,
        }),
      )
      const target = session.tree.getElementById(scenario.target)
      if (!target) throw new Error(`${scenario.name} target is missing`)

      session.mutate((tree) => {
        if (scenario.kind === "remove") return tree.removeNode(target)
        const source = parseExpoTurboDocument(
          scenario.target === "document-form"
            ? '<DemoForm id="document-form"><DemoButton id="document-submitter" /></DemoForm>'
            : '<DemoButton id="document-submitter" />',
        ).getElementById(scenario.target)
        if (!source) throw new Error(`${scenario.name} source is missing`)
        return tree.replaceNodeWithClones(target, [source])
      })

      expect(confirmationSignal?.aborted).toBe(true)
      expect(await submitting).toMatchObject({ requestId, status: "canceled" })
      expect(transport.pending).toHaveLength(0)
      if (scenario.target === "document-form") answer.resolve(true)
      else answer.reject(new Error("late confirmation secret-token"))
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(transport.pending).toHaveLength(0)

      if (scenario.kind === "replace") {
        session.removeAttribute("id:document-form", "data-turbo-confirm")
        const replacementControls = registry(session, "document-form")
        const replacement = controller.submit(
          proposal(replacementControls, `${requestId}-replacement`),
        )
        const request = transport.pending[0]
        if (!request) throw new Error(`${scenario.name} request was not captured`)
        request.response.resolve(response(request.request, "", { status: 204 }))
        expect(await replacement).toMatchObject({
          requestId: `${requestId}-replacement`,
          status: "empty",
        })
      }
    }
  })

  test("does not claim destination ownership until confirmation accepts", async () => {
    const session = fixture()
    session.setAttribute("id:document-form", "data-turbo-confirm", "Replace visit?")
    const transport = pendingFetch()
    const answer = deferred<boolean>()
    const loader = new DocumentRequestLoader(session, transport.adapter, requestIds("document"))
    const controller = new FormSubmissionController(session, transport.adapter, {
      confirmation: { confirm: () => answer.promise },
    })
    const loading = loader.load("/incumbent")
    const incumbent = transport.pending[0]
    if (!incumbent) throw new Error("incumbent document request was not captured")

    const submitting = controller.submit(
      proposal(registry(session, "document-form"), "confirmed-owner"),
    )
    expect(transport.pending).toHaveLength(1)
    expect(incumbent.request.signal?.aborted).toBe(false)

    answer.resolve(true)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const confirmed = transport.pending[1]
    if (!confirmed) throw new Error("confirmed form request was not captured")
    expect(incumbent.request.signal?.aborted).toBe(true)
    incumbent.response.resolve(response(incumbent.request, "<Late />"))
    expect(await loading).toMatchObject({ status: "canceled" })

    confirmed.response.resolve(response(confirmed.request, "", { status: 204 }))
    expect(await submitting).toMatchObject({ requestId: "confirmed-owner", status: "empty" })
  })

  test("keeps one pending confirmation owner and lets explicit supersede replace it", async () => {
    const session = fixture()
    session.setAttribute("id:document-form", "data-turbo-confirm", "Continue?")
    const transport = pendingFetch()
    const confirmations: Array<{
      readonly answer: ReturnType<typeof deferred<boolean>>
      readonly signal: AbortSignal
    }> = []
    const controller = new FormSubmissionController(session, transport.adapter, {
      confirmation: {
        confirm(_message, signal) {
          const answer = deferred<boolean>()
          confirmations.push({ answer, signal })
          return answer.promise
        },
      },
    })
    const controls = registry(session, "document-form")

    const first = controller.submit(proposal(controls, "first-confirmation"))
    expect(confirmations).toHaveLength(1)
    const duplicate = controller.submit(proposal(controls, "duplicate-confirmation"))
    expect(await duplicate).toMatchObject({
      requestId: "duplicate-confirmation",
      status: "canceled",
    })
    expect(confirmations).toHaveLength(1)
    expect(confirmations[0]?.signal.aborted).toBe(false)

    const second = controller.submit(proposal(controls, "second-confirmation"), {
      duplicateBehavior: "supersede",
    })
    expect(confirmations).toHaveLength(2)
    expect(confirmations[0]?.signal.aborted).toBe(true)
    expect(await first).toMatchObject({ requestId: "first-confirmation", status: "canceled" })
    confirmations[0]?.answer.resolve(true)
    await Promise.resolve()
    expect(transport.pending).toHaveLength(0)

    confirmations[1]?.answer.resolve(true)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const request = transport.pending[0]
    if (!request) throw new Error("superseding confirmed request was not captured")
    expect(request.request.headers["X-Turbo-Request-Id"]).toBe("second-confirmation")
    request.response.resolve(response(request.request, "", { status: 204 }))
    expect(await second).toMatchObject({ requestId: "second-confirmation", status: "empty" })
  })

  test("clears an explicitly superseded request while its replacement awaits confirmation", async () => {
    const session = fixture()
    const transport = pendingFetch()
    const answer = deferred<boolean>()
    const controller = new FormSubmissionController(session, transport.adapter, {
      confirmation: { confirm: () => answer.promise },
    })
    const controls = registry(session, "document-form")
    const first = controller.submit(proposal(controls, "active-before-confirmation"))
    const firstRequest = transport.pending[0]
    if (!firstRequest) throw new Error("active form request was not captured")
    expect(controls.submissionState).toMatchObject({
      busy: true,
      requestId: "active-before-confirmation",
    })

    session.setAttribute("id:document-form", "data-turbo-confirm", "Replace request?")
    const second = controller.submit(proposal(controls, "replacement-confirmation"), {
      duplicateBehavior: "supersede",
    })
    expect(firstRequest.request.signal?.aborted).toBe(true)
    expect(await first).toMatchObject({ status: "canceled" })
    expect(controls.submissionState).toMatchObject({ busy: false, status: "idle" })
    expect(transport.pending).toHaveLength(1)

    answer.resolve(false)
    expect(await second).toMatchObject({
      requestId: "replacement-confirmation",
      status: "canceled",
    })
    expect(transport.pending).toHaveLength(1)
  })

  test("fails confirmation configuration and adapter errors without fetching", async () => {
    {
      const session = fixture()
      const transport = pendingFetch()
      const controls = registry(session, "document-form")
      const controller = new FormSubmissionController(session, transport.adapter)
      const incumbent = controller.submit(proposal(controls, "incumbent-before-config-error"))
      const incumbentRequest = transport.pending[0]
      if (!incumbentRequest) throw new Error("incumbent request was not captured")
      session.setAttribute("id:document-form", "data-turbo-confirm", "Needs adapter")

      await expect(
        controller.submit(proposal(controls, "missing-confirmation-adapter"), {
          duplicateBehavior: "supersede",
        }),
      ).rejects.toMatchObject({
        message: "Form submission confirmation requires a configured adapter",
      })
      expect(incumbentRequest.request.signal?.aborted).toBe(false)
      expect(controls.submissionState.requestId).toBe("incumbent-before-config-error")
      incumbentRequest.response.resolve(response(incumbentRequest.request, "", { status: 204 }))
      await incumbent
    }

    for (const scenario of [
      {
        confirm: () => {
          throw new Error("sync confirmation failure with secret-token")
        },
      },
      {
        confirm: () => Promise.reject(new Error("async confirmation failure with secret-token")),
      },
      {
        confirm: () => {
          throw new RequestError(
            "host-authored request failure with secret-token",
            {},
            { cause: new Error("nested secret-token") },
          )
        },
      },
      {
        confirm: () => "yes" as never,
        message: "Form submission confirmation must return a boolean",
      },
      {
        confirm: () => Promise.resolve("yes" as never),
        message: "Form submission confirmation must return a boolean",
      },
    ]) {
      const session = fixture()
      session.setAttribute("id:document-form", "data-turbo-confirm", "Continue?")
      const transport = pendingFetch()
      const controls = registry(session, "document-form")
      const controller = new FormSubmissionController(session, transport.adapter, {
        confirmation: { confirm: scenario.confirm },
      })

      try {
        await controller.submit(proposal(controls, "confirmation-error"))
        throw new Error("expected confirmation failure")
      } catch (error) {
        expect(error).toBeInstanceOf(RequestError)
        if (!(error instanceof RequestError)) throw error
        if (scenario.message) expect(error.message).toBe(scenario.message)
        expect(error.cause).toBeUndefined()
        expect(String(error)).not.toContain("secret-token")
      }
      expect(transport.pending).toHaveLength(0)
      expect(controls.submissionState).toMatchObject({ busy: false, status: "idle" })
    }
  })

  test("clears form activity before applying a response", async () => {
    const session = fixture()
    session.setAttribute("id:document-form", "method", "post")
    const transport = pendingFetch()
    const controls = registry(session, "document-form")
    const controller = new FormSubmissionController(session, transport.adapter)
    const submitting = controller.submit(proposal(controls, "cleanup-before-apply"))
    const request = transport.pending[0]
    if (!request) throw new Error("form request was not captured")
    expect(controls.submissionState.busy).toBe(true)

    const observations: boolean[] = []
    session.subscribe("id:status", () => observations.push(controls.submissionState.busy))
    request.response.resolve(
      response(
        request.request,
        '<turbo-stream action="update" target="status"><template><Done /></template></turbo-stream>',
        { headers: { "Content-Type": TURBO_STREAM_MIME_TYPE } },
      ),
    )
    expect(await submitting).toMatchObject({ application: "stream", status: "applied" })
    expect(observations).toEqual([false])
    expect(controls.submissionState.busy).toBe(false)
  })

  test("cancels the exact active form and restores its activity state", async () => {
    const session = fixture()
    const transport = pendingFetch()
    const controller = new FormSubmissionController(session, transport.adapter)
    const controls = new FormControlRegistry(session, "id:document-form", {
      submissionController: controller,
    })

    const submitting = controls.submit({ protocol: { requestId: "explicit-cancel" } })
    const request = transport.pending[0]
    if (!request) throw new Error("form request was not captured")
    expect(controls.submissionState).toMatchObject({ busy: true, status: "submitting" })

    controls.cancelSubmission()
    expect(request.request.signal?.aborted).toBe(true)
    expect(controls.submissionState).toMatchObject({ busy: false, status: "idle" })
    expect(await submitting).toMatchObject({
      requestId: "explicit-cancel",
      status: "canceled",
    })
  })

  test("clears exact form activity after a current transport failure", async () => {
    const session = fixture()
    const controls = registry(session, "document-form")
    const submitter = controls.register("id:document-submitter", {
      kind: "submitter",
      name: "commit",
      value: "save",
    })
    const controller = new FormSubmissionController(session, {
      async fetch() {
        throw new Error("offline fixture")
      },
    })

    const submitting = controller.submit((signal) =>
      controls.submissionProposal({
        protocol: { requestId: "transport-failure" },
        signal,
        submitter: submitter.selection,
      }),
    )
    expect(controls.submissionState).toMatchObject({ busy: true, status: "submitting" })
    expect(controls.controlSubmissionState("id:document-submitter").pending).toBe(true)

    await expect(submitting).rejects.toBeInstanceOf(RequestError)
    expect(controls.submissionState).toMatchObject({ busy: false, status: "idle" })
    expect(controls.controlSubmissionState("id:document-submitter").pending).toBe(false)
  })

  test("uses exact form identity to cancel its old request after moving destinations", async () => {
    const session = fixture()
    const transport = pendingFetch()
    const controller = new FormSubmissionController(session, transport.adapter)
    const moving = registry(session, "moving-form")

    const first = controller.submit(proposal(moving, "moving-a"))
    const requestA = transport.pending[0]
    if (!requestA) throw new Error("first moving form request was not captured")
    expect(requestA.request.headers["Turbo-Frame"]).toBe("frame-a")

    session.setAttribute("id:moving-form", "data-turbo-frame", "frame-b")
    const second = controller.submit(proposal(moving, "moving-b"), {
      duplicateBehavior: "supersede",
    })
    const requestB = transport.pending[1]
    if (!requestB) throw new Error("second moving form request was not captured")
    expect(requestA.request.signal?.aborted).toBe(true)
    expect(requestB.request.headers["Turbo-Frame"]).toBe("frame-b")
    expect(await first).toMatchObject({ status: "canceled" })

    requestB.response.resolve(
      response(requestB.request, '<turbo-frame id="frame-b"><Moved /></turbo-frame>'),
    )
    expect(await second).toMatchObject({
      application: "frame",
      destination: { frameId: "frame-b", kind: "frame" },
      requestId: "moving-b",
      status: "applied",
    })
  })

  test("keeps a reentrant third exact-form supersede authoritative before ownership", async () => {
    const session = fixture()
    const transport = pendingFetch()
    const controller = new FormSubmissionController(session, transport.adapter)
    const controls = registry(session, "document-form")

    const first = controller.submit(proposal(controls, "first"))
    const firstRequest = transport.pending[0]
    if (!firstRequest?.request.signal) throw new Error("first form signal was not captured")

    let third: ReturnType<FormSubmissionController["submit"]> | undefined
    firstRequest.request.signal.addEventListener(
      "abort",
      () => {
        third = controller.submit(proposal(controls, "third"), {
          duplicateBehavior: "supersede",
        })
      },
      { once: true },
    )
    const second = controller.submit(proposal(controls, "second"), {
      duplicateBehavior: "supersede",
    })

    expect(await first).toMatchObject({ requestId: "first", status: "canceled" })
    expect(await second).toMatchObject({ requestId: "second", status: "canceled" })
    expect(transport.pending).toHaveLength(2)
    const thirdRequest = transport.pending[1]
    if (!thirdRequest || !third) throw new Error("reentrant third request was not captured")
    expect(thirdRequest.request.headers["X-Turbo-Request-Id"]).toBe("third")
    expect(thirdRequest.request.signal?.aborted).toBe(false)

    thirdRequest.response.resolve(response(thirdRequest.request, "<Newest />"))
    expect(await third).toMatchObject({ requestId: "third", status: "applied" })
  })

  test("lets reentrant abort work supersede an outer claimant before fetch", async () => {
    const session = fixture()
    const transport = pendingFetch()
    const loader = new DocumentRequestLoader(session, transport.adapter, requestIds("document"))
    const controller = new FormSubmissionController(session, transport.adapter)
    const controls = registry(session, "document-form")
    const loading = loader.load("/before-reentrant")
    const getRequest = transport.pending[0]
    if (!getRequest?.request.signal) throw new Error("document GET signal was not captured")

    let nested: ReturnType<FormSubmissionController["submit"]> | undefined
    getRequest.request.signal.addEventListener(
      "abort",
      () => {
        nested = controller.submit(proposal(controls, "nested-wins"), {
          duplicateBehavior: "supersede",
        })
      },
      { once: true },
    )
    const outer = controller.submit(proposal(controls, "outer-loses"))
    expect(await outer).toMatchObject({ requestId: "outer-loses", status: "canceled" })
    expect(transport.pending).toHaveLength(2)
    const nestedRequest = transport.pending[1]
    if (!nestedRequest || !nested) throw new Error("nested form request was not captured")
    expect(nestedRequest.request.headers["X-Turbo-Request-Id"]).toBe("nested-wins")

    nestedRequest.response.resolve(response(nestedRequest.request, "<Newest />"))
    expect(await nested).toMatchObject({ requestId: "nested-wins", status: "applied" })
    getRequest.response.resolve(response(getRequest.request, "<Gallery><Late /></Gallery>"))
    expect(await loading).toMatchObject({ status: "canceled" })
  })

  test("rejects invalid proposals before they can cancel admitted work", async () => {
    const session = fixture()
    const transport = pendingFetch()
    const controller = new FormSubmissionController(session, transport.adapter)
    const controls = registry(session, "document-form")
    const incumbent = controller.submit(proposal(controls, "incumbent"))
    const incumbentRequest = transport.pending[0]
    if (!incumbentRequest) throw new Error("incumbent request was not captured")

    const foreignSignalProposal = controls.submissionProposal({
      protocol: { requestId: "wrong-signal" },
      signal: new AbortController().signal,
    })
    await expect(controller.submit(() => foreignSignalProposal)).rejects.toBeInstanceOf(
      RequestError,
    )
    await expect(
      controller.submit(
        () =>
          Object.freeze({
            destination: foreignSignalProposal.destination,
            plan: foreignSignalProposal.plan,
          }) as never,
      ),
    ).rejects.toBeInstanceOf(StateError)
    expect(transport.pending).toHaveLength(1)
    expect(incumbentRequest.request.signal?.aborted).toBe(false)

    incumbentRequest.response.resolve(response(incumbentRequest.request, "<StillOwned />"))
    expect(await incumbent).toMatchObject({ requestId: "incumbent", status: "applied" })
  })

  test("invalid GET admission cannot cancel a form request", async () => {
    {
      const session = fixture()
      const transport = pendingFetch()
      const controller = new FormSubmissionController(session, transport.adapter)
      const submitting = controller.submit(
        proposal(registry(session, "document-form"), "valid-form"),
      )
      const formRequest = transport.pending[0]
      if (!formRequest) throw new Error("form request was not captured")
      const loader = new DocumentRequestLoader(session, transport.adapter, { next: () => "" })

      await expect(loader.load("/invalid-request-id")).rejects.toBeInstanceOf(RequestError)
      expect(transport.pending).toHaveLength(1)
      expect(formRequest.request.signal?.aborted).toBe(false)

      formRequest.response.resolve(response(formRequest.request, "<Valid />"))
      expect(await submitting).toMatchObject({ status: "applied" })
    }

    {
      const session = fixture()
      const transport = pendingFetch()
      const controller = new FormSubmissionController(session, transport.adapter)
      const submitting = controller.submit(proposal(registry(session, "form-a"), "valid-frame"))
      const formRequest = transport.pending[0]
      if (!formRequest) throw new Error("Frame form request was not captured")
      const loader = new FrameRequestLoader(session, transport.adapter, { next: () => "" })

      await expect(loader.load("frame-a", "/invalid-request-id")).rejects.toBeInstanceOf(
        RequestError,
      )
      expect(transport.pending).toHaveLength(1)
      expect(formRequest.request.signal?.aborted).toBe(false)

      formRequest.response.resolve(
        response(formRequest.request, '<turbo-frame id="frame-a"><ValidFrame /></turbo-frame>'),
      )
      expect(await submitting).toMatchObject({ status: "applied" })
    }
  })

  test("cancels candidates whose exact destination becomes stale while transport is pending", async () => {
    {
      const session = fixture()
      const transport = pendingFetch()
      const submitting = new FormSubmissionController(session, transport.adapter).submit(
        proposal(registry(session, "document-form"), "stale-document"),
      )
      const pending = transport.pending[0]
      if (!pending) throw new Error("document form request was not captured")

      session.replaceTree(
        parseExpoTurboDocument("<Gallery><Replacement /></Gallery>", {
          url: "https://example.test/replacement",
        }),
      )
      pending.response.resolve(response(pending.request, "", { headers: {}, status: 204 }))
      expect(await submitting).toMatchObject({ requestId: "stale-document", status: "canceled" })
    }

    {
      const session = fixture()
      const body = deferred<string>()
      let captured: TurboRequest | undefined
      const submitting = new FormSubmissionController(session, {
        async fetch(request) {
          captured = request
          return response(request, "", { text: () => body.promise })
        },
      }).submit(proposal(registry(session, "form-a"), "stale-frame"))
      await Promise.resolve()
      await Promise.resolve()
      if (!captured) throw new Error("Frame form request was not captured")

      const frame = session.tree.getElementById("frame-a")
      const replacement = parseExpoTurboDocument(
        '<turbo-frame id="frame-a"><Replacement /></turbo-frame>',
      ).getElementById("frame-a")
      if (!frame || !replacement) throw new Error("Frame replacement fixture is missing")
      session.mutate((tree) => tree.replaceNodeWithClones(frame, [replacement]))
      body.resolve("<Late />")
      expect(await submitting).toMatchObject({ requestId: "stale-frame", status: "canceled" })
    }

    {
      const session = fixture()
      const originalTree = session.tree
      const transport = pendingFetch()
      const submitting = new FormSubmissionController(session, transport.adapter).submit(
        proposal(registry(session, "form-a"), "restored-frame"),
      )
      const pending = transport.pending[0]
      if (!pending) throw new Error("Frame form request was not captured")

      session.replaceTree(
        parseExpoTurboDocument("<Gallery><Temporary /></Gallery>", {
          url: "https://example.test/temporary",
        }),
      )
      session.replaceTree(originalTree)
      pending.response.resolve(response(pending.request, "<Late />"))
      expect(await submitting).toMatchObject({ requestId: "restored-frame", status: "canceled" })
    }
  })

  test("keeps ownership isolated by document session", async () => {
    const firstSession = fixture()
    const secondSession = fixture()
    const transport = pendingFetch()
    const first = new FormSubmissionController(firstSession, transport.adapter).submit(
      proposal(registry(firstSession, "document-form"), "session-1"),
    )
    const firstRequest = transport.pending[0]
    const second = new FormSubmissionController(secondSession, transport.adapter).submit(
      proposal(registry(secondSession, "document-form"), "session-2"),
    )
    const secondRequest = transport.pending[1]
    if (!firstRequest || !secondRequest) throw new Error("session requests were not captured")

    expect(firstRequest.request.signal?.aborted).toBe(false)
    expect(secondRequest.request.signal?.aborted).toBe(false)
    secondRequest.response.resolve(response(secondRequest.request, "<Second />"))
    firstRequest.response.resolve(response(firstRequest.request, "<First />"))
    expect(await first).toMatchObject({ requestId: "session-1", status: "applied" })
    expect(await second).toMatchObject({ requestId: "session-2", status: "applied" })
  })

  test("keeps the document lane distinct from a Frame named document", async () => {
    const session = new DocumentSession(
      parseExpoTurboDocument(
        `<Gallery>
          <DemoForm id="top-form" action="/top" />
          <turbo-frame id="document"><DemoForm id="frame-form" action="/frame" /></turbo-frame>
        </Gallery>`,
        { url: "https://example.test/current" },
      ),
    )
    const transport = pendingFetch()
    const controller = new FormSubmissionController(session, transport.adapter)
    const top = controller.submit(proposal(registry(session, "top-form"), "top"))
    const topRequest = transport.pending[0]
    const frame = controller.submit(proposal(registry(session, "frame-form"), "frame"))
    const frameRequest = transport.pending[1]
    if (!topRequest || !frameRequest)
      throw new Error("document and Frame requests were not captured")

    expect(topRequest.request.signal?.aborted).toBe(false)
    expect(frameRequest.request.signal?.aborted).toBe(false)
    expect(frameRequest.request.headers["Turbo-Frame"]).toBe("document")
    frameRequest.response.resolve(
      response(frameRequest.request, '<turbo-frame id="document"><FrameCandidate /></turbo-frame>'),
    )
    topRequest.response.resolve(response(topRequest.request, "<DocumentCandidate />"))
    expect(await top).toMatchObject({ destination: { kind: "document" }, status: "applied" })
    expect(await frame).toMatchObject({
      destination: { frameId: "document", kind: "frame" },
      status: "applied",
    })
  })

  test("does not treat reusable GET owner tokens as cross-destination lanes", async () => {
    {
      const session = fixture()
      const transport = pendingFetch()
      const loader = new FrameRequestLoader(session, transport.adapter, requestIds("frame"))
      const owner = Object.freeze({})
      const loadingA = loader.load("frame-a", "/frame-a-next", { owner })
      const requestA = transport.pending[0]
      const loadingB = loader.load("frame-b", "/frame-b-next", { owner })
      const requestB = transport.pending[1]
      if (!requestA || !requestB) throw new Error("Frame GET requests were not captured")

      expect(requestA.request.signal?.aborted).toBe(false)
      expect(requestB.request.signal?.aborted).toBe(false)
      requestA.response.resolve(
        response(requestA.request, '<turbo-frame id="frame-a"><NextA /></turbo-frame>'),
      )
      requestB.response.resolve(
        response(requestB.request, '<turbo-frame id="frame-b"><NextB /></turbo-frame>'),
      )
      expect(await loadingA).toMatchObject({ status: "completed" })
      expect(await loadingB).toMatchObject({ status: "completed" })
    }

    {
      const session = fixture()
      const transport = pendingFetch()
      const documentLoader = new DocumentRequestLoader(
        session,
        transport.adapter,
        requestIds("document"),
      )
      const frameLoader = new FrameRequestLoader(session, transport.adapter, requestIds("frame"))
      const owner = Object.freeze({})
      const loadingDocument = documentLoader.load("/next-document", owner)
      const documentRequest = transport.pending[0]
      const loadingFrame = frameLoader.load("frame-a", "/next-frame", { owner })
      const frameRequest = transport.pending[1]
      if (!documentRequest || !frameRequest)
        throw new Error("document and Frame GET requests were not captured")

      expect(documentRequest.request.signal?.aborted).toBe(false)
      expect(frameRequest.request.signal?.aborted).toBe(false)
      frameRequest.response.resolve(
        response(frameRequest.request, '<turbo-frame id="frame-a"><NextFrame /></turbo-frame>'),
      )
      expect(await loadingFrame).toMatchObject({ status: "completed" })
      documentRequest.response.resolve(
        response(documentRequest.request, "<Gallery><NextDocument /></Gallery>"),
      )
      expect(await loadingDocument).toMatchObject({ status: "committed" })
    }
  })

  test("shares GET lanes across independently constructed loaders", async () => {
    {
      const session = fixture()
      const transport = pendingFetch()
      const firstLoader = new DocumentRequestLoader(
        session,
        transport.adapter,
        requestIds("first-document"),
      )
      const secondLoader = new DocumentRequestLoader(
        session,
        transport.adapter,
        requestIds("second-document"),
      )
      const first = firstLoader.load("/first")
      const firstRequest = transport.pending[0]
      const second = secondLoader.load("/second")
      const secondRequest = transport.pending[1]
      if (!firstRequest || !secondRequest)
        throw new Error("document GET requests were not captured")

      expect(firstRequest.request.signal?.aborted).toBe(true)
      secondRequest.response.resolve(
        response(secondRequest.request, '<Gallery><Second id="second" /></Gallery>'),
      )
      expect(await second).toMatchObject({ status: "committed" })
      firstRequest.response.resolve(
        response(firstRequest.request, '<Gallery><First id="first" /></Gallery>'),
      )
      expect(await first).toMatchObject({ status: "canceled" })
      expect(session.tree.getElementById("second")).toBeDefined()
      expect(session.tree.getElementById("first")).toBeUndefined()
    }

    {
      const session = fixture()
      const transport = pendingFetch()
      const firstLoader = new FrameRequestLoader(
        session,
        transport.adapter,
        requestIds("first-frame"),
      )
      const secondLoader = new FrameRequestLoader(
        session,
        transport.adapter,
        requestIds("second-frame"),
      )
      const first = firstLoader.load("frame-a", "/first")
      const firstRequest = transport.pending[0]
      const second = secondLoader.load("frame-a", "/second")
      const secondRequest = transport.pending[1]
      if (!firstRequest || !secondRequest) throw new Error("Frame GET requests were not captured")

      expect(firstRequest.request.signal?.aborted).toBe(true)
      secondRequest.response.resolve(
        response(secondRequest.request, '<turbo-frame id="frame-a"><Second /></turbo-frame>'),
      )
      expect(await second).toMatchObject({ status: "completed" })
      firstRequest.response.resolve(
        response(firstRequest.request, '<turbo-frame id="frame-a"><First /></turbo-frame>'),
      )
      expect(await first).toMatchObject({ status: "canceled" })
      expect(session.tree.getElementById("frame-a")?.children.filter(isElement)[0]?.tagName).toBe(
        "Second",
      )
    }
  })

  test("applies the document response matrix without a second fetch", async () => {
    for (const fixtureCase of [
      { classification: "client-error", name: "client", status: 422 },
      { classification: "server-error", name: "server", status: 500 },
    ] as const) {
      const session = fixture()
      let fetches = 0
      const currentUrl = session.tree.document.url
      const controller = new FormSubmissionController(session, {
        async fetch(request) {
          fetches += 1
          return response(request, `<Gallery><Error id="${fixtureCase.name}" /></Gallery>`, {
            status: fixtureCase.status,
          })
        },
      })

      expect(
        await controller.submit(proposal(registry(session, "document-form"), fixtureCase.name)),
      ).toMatchObject({
        application: "document",
        classification: fixtureCase.classification,
        responseStatus: fixtureCase.status,
        status: "applied",
      })
      expect(fetches).toBe(1)
      expect(session.tree.document.url).toBe(currentUrl)
      expect(session.tree.getElementById(fixtureCase.name)).toBeDefined()
    }

    {
      const session = fixture()
      session.setAttribute("id:document-form", "method", "post")
      let fetches = 0
      const controller = new FormSubmissionController(session, {
        async fetch(request) {
          fetches += 1
          return response(request, '<Gallery><Redirected id="redirected" /></Gallery>', {
            redirected: true,
            url: "https://example.test/canonical",
          })
        },
      })
      expect(
        await controller.submit(proposal(registry(session, "document-form"), "redirected")),
      ).toMatchObject({ application: "document", redirected: true, status: "applied" })
      expect(fetches).toBe(1)
      expect(session.tree.document.url).toBe("https://example.test/canonical")
      expect(session.tree.getElementById("redirected")).toBeDefined()
    }

    {
      const session = fixture()
      session.setAttribute("id:document-form", "method", "post")
      const currentUrl = session.tree.document.url
      const controller = new FormSubmissionController(session, {
        fetch: async (request) =>
          response(request, '<Gallery><RedirectedError id="redirected-error" /></Gallery>', {
            redirected: true,
            status: 422,
            url: "https://example.test/failed-canonical",
          }),
      })
      expect(
        await controller.submit(proposal(registry(session, "document-form"), "redirected-error")),
      ).toMatchObject({
        application: "document",
        classification: "client-error",
        redirected: true,
        status: "applied",
      })
      expect(session.tree.document.url).toBe(currentUrl)
      expect(session.tree.getElementById("redirected-error")).toBeDefined()
    }

    {
      const session = fixture()
      session.setAttribute("id:document-form", "method", "post")
      const revision = session.revision
      const controller = new FormSubmissionController(session, {
        fetch: async (request) => response(request, "not xml"),
      })
      await expect(
        controller.submit(proposal(registry(session, "document-form"), "must-redirect")),
      ).rejects.toMatchObject({
        code: "request",
        context: { method: "POST", responseStatus: 200 },
      })
      expect(session.revision).toBe(revision)
      expect(session.tree.getElementById("document-form")).toBeDefined()
    }

    {
      const session = fixture()
      session.setAttribute("id:document-form", "method", "post")
      const controller = new FormSubmissionController(session, {
        fetch: async (request) =>
          response(request, '<Gallery><Created id="created" /></Gallery>', { status: 201 }),
      })
      expect(
        await controller.submit(proposal(registry(session, "document-form"), "created")),
      ).toMatchObject({ application: "document", responseStatus: 201, status: "applied" })
      expect(session.tree.getElementById("created")).toBeDefined()
    }

    {
      const session = fixture()
      const controller = new FormSubmissionController(session, {
        fetch: async (request) =>
          response(
            request,
            `<Gallery>
              <Target id="document-target"><Old /></Target>
              <turbo-stream action="update" target="document-target">
                <template><EmbeddedResult id="document-stream-result" /></template>
              </turbo-stream>
            </Gallery>`,
          ),
      })
      expect(
        await controller.submit(
          proposal(registry(session, "document-form"), "document-embedded-stream"),
        ),
      ).toMatchObject({
        application: "document",
        status: "applied",
        streams: { actions: [{ action: "update", status: "applied" }] },
      })
      expect(session.tree.getElementById("document-stream-result")).toBeDefined()
    }
  })

  test("invalidates document snapshots only for applied unsafe success and authoritative errors", async () => {
    {
      const session = fixture()
      session.setAttribute("id:document-form", "method", "post")
      const cache = populatedSnapshotCache(session)
      const result = await new FormSubmissionController(
        session,
        {
          fetch: async (request) =>
            response(request, '<Gallery><UnsafeSuccess id="unsafe-success" /></Gallery>', {
              redirected: true,
              url: "https://example.test/unsafe-success",
            }),
        },
        { snapshotCache: cache },
      ).submit(proposal(registry(session, "document-form"), "unsafe-success"))

      expect(result).toMatchObject({ application: "document", status: "applied" })
      expect(cache.size).toBe(0)
      expect(session.tree.getElementById("unsafe-success")).toBeDefined()
    }

    {
      const session = fixture()
      session.setAttribute("id:document-form", "method", "post")
      const cache = populatedSnapshotCache(session)
      const submitting = new FormSubmissionController(
        session,
        {
          fetch: async (request) =>
            response(request, "<broken>", {
              redirected: true,
              url: "https://example.test/unsafe-invalid",
            }),
        },
        { snapshotCache: cache },
      ).submit(proposal(registry(session, "document-form"), "unsafe-invalid"))

      await expect(submitting).rejects.toBeInstanceOf(ParseError)
      expect(cache.size).toBe(0)
    }

    for (const fixtureCase of [
      { classification: "client-error", name: "client-error", status: 422 },
      { classification: "server-error", name: "server-error", status: 500 },
    ] as const) {
      const session = fixture()
      const cache = populatedSnapshotCache(session)
      const result = await new FormSubmissionController(
        session,
        {
          fetch: async (request) =>
            response(request, `<Gallery><Failure id="${fixtureCase.name}" /></Gallery>`, {
              status: fixtureCase.status,
            }),
        },
        { snapshotCache: cache },
      ).submit(proposal(registry(session, "document-form"), fixtureCase.name))

      expect(result).toMatchObject({
        application: "document",
        classification: fixtureCase.classification,
        status: "applied",
      })
      expect(cache.size).toBe(0)
      expect(session.tree.getElementById(fixtureCase.name)).toBeDefined()
    }

    {
      const session = fixture()
      const cache = populatedSnapshotCache(session)
      session.subscribe("id:document-form", () => {
        throw new Error("authoritative error finalization failed")
      })
      const submitting = new FormSubmissionController(
        session,
        {
          fetch: async (request) =>
            response(request, '<Gallery><Failure id="committed-error" /></Gallery>', {
              status: 422,
            }),
        },
        { snapshotCache: cache },
      ).submit(proposal(registry(session, "document-form"), "committed-error"))

      await expect(submitting).rejects.toBeInstanceOf(FormSubmissionCommitError)
      expect(cache.size).toBe(0)
      expect(session.tree.getElementById("committed-error")).toBeDefined()
    }

    for (const fixtureCase of [
      {
        body: "unused",
        headers: {},
        name: "empty",
        options: { status: 204 },
      },
      {
        body: "not xml",
        headers: { "Content-Type": "text/plain" },
        name: "wrong-mime",
        options: {},
      },
      {
        body: "<broken>",
        headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
        name: "invalid-error-xml",
        options: { status: 422 },
      },
    ] as const) {
      const session = fixture()
      session.setAttribute("id:document-form", "method", "post")
      const cache = populatedSnapshotCache(session)
      const submitting = new FormSubmissionController(
        session,
        {
          fetch: async (request) =>
            response(request, fixtureCase.body, {
              headers: fixtureCase.headers,
              ...fixtureCase.options,
            }),
        },
        { snapshotCache: cache },
      ).submit(proposal(registry(session, "document-form"), fixtureCase.name))

      if (fixtureCase.name === "empty") {
        expect(await submitting).toMatchObject({ application: "empty", status: "empty" })
      } else if (fixtureCase.name === "wrong-mime") {
        await expect(submitting).rejects.toMatchObject({ code: "content_type" })
      } else {
        await expect(submitting).rejects.toBeInstanceOf(ParseError)
      }
      expect(cache.size).toBe(2)
    }

    {
      const session = fixture()
      session.setAttribute("id:document-form", "method", "post")
      const cache = populatedSnapshotCache(session)
      const submitting = new FormSubmissionController(
        session,
        {
          fetch: async (request) =>
            response(request, "unused", {
              redirected: true,
              text: async () => {
                throw new Error("document body failed")
              },
              url: "https://example.test/body-failed",
            }),
        },
        { snapshotCache: cache },
      ).submit(proposal(registry(session, "document-form"), "body-failed"))

      await expect(submitting).rejects.toMatchObject({ code: "request" })
      expect(cache.size).toBe(2)
    }

    {
      const session = fixture()
      session.setAttribute("id:document-form", "method", "post")
      const cache = populatedSnapshotCache(session)
      const result = await new FormSubmissionController(
        session,
        {
          fetch: async (request) =>
            response(
              request,
              '<turbo-stream action="remove" target="missing"><template /></turbo-stream>',
              { headers: { "Content-Type": TURBO_STREAM_MIME_TYPE } },
            ),
        },
        { snapshotCache: cache },
      ).submit(proposal(registry(session, "document-form"), "stream"))

      expect(result).toMatchObject({ application: "stream", status: "applied" })
      expect(cache.size).toBe(2)
    }
  })

  test("invalidates Frame snapshots before body and strict Frame admission", async () => {
    for (const fixtureCase of [
      {
        body: '<turbo-frame id="missing"><Result /></turbo-frame>',
        headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
        method: "post",
        name: "unsafe-missing",
        options: {},
      },
      {
        body: "not xml",
        headers: { "Content-Type": "text/plain" },
        method: undefined,
        name: "safe-error-wrong-mime",
        options: { status: 422 },
      },
      {
        body: "unused",
        headers: {},
        method: "post",
        name: "unsafe-empty",
        options: { status: 204 },
      },
      {
        body: "<broken>",
        headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
        method: "post",
        name: "unsafe-malformed",
        options: {},
      },
    ] as const) {
      const session = fixture()
      if (fixtureCase.method) session.setAttribute("id:form-a", "method", fixtureCase.method)
      const cache = populatedSnapshotCache(session)
      const submitting = new FormSubmissionController(
        session,
        {
          fetch: async (request) =>
            response(request, fixtureCase.body, {
              headers: fixtureCase.headers,
              ...fixtureCase.options,
            }),
        },
        { snapshotCache: cache },
      ).submit(proposal(registry(session, "form-a"), fixtureCase.name))

      if (fixtureCase.name === "unsafe-empty") {
        expect(await submitting).toMatchObject({ application: "empty", status: "empty" })
      } else if (fixtureCase.name === "unsafe-missing") {
        await expect(submitting).rejects.toBeInstanceOf(FrameMissingError)
      } else if (fixtureCase.name === "unsafe-malformed") {
        await expect(submitting).rejects.toBeInstanceOf(ParseError)
      } else {
        await expect(submitting).rejects.toMatchObject({ code: "content_type" })
      }
      expect(cache.size).toBe(0)
    }

    {
      const session = fixture()
      session.setAttribute("id:form-a", "method", "post")
      const cache = populatedSnapshotCache(session)
      const submitting = new FormSubmissionController(
        session,
        {
          fetch: async (request) =>
            response(request, "unused", {
              text: async () => {
                expect(cache.size).toBe(0)
                throw new Error("Frame body failed")
              },
            }),
        },
        { snapshotCache: cache },
      ).submit(proposal(registry(session, "form-a"), "body-failed"))

      await expect(submitting).rejects.toMatchObject({ code: "request" })
      expect(cache.size).toBe(0)
    }

    for (const fixtureCase of [
      { method: "post", name: "unsafe-success", status: 200 },
      { method: undefined, name: "safe-error", status: 422 },
    ] as const) {
      const session = fixture()
      if (fixtureCase.method) session.setAttribute("id:form-a", "method", fixtureCase.method)
      const cache = populatedSnapshotCache(session)
      const result = await new FormSubmissionController(
        session,
        {
          fetch: async (request) =>
            response(
              request,
              `<turbo-frame id="frame-a"><Result id="${fixtureCase.name}" /></turbo-frame>`,
              { status: fixtureCase.status },
            ),
        },
        { snapshotCache: cache },
      ).submit(proposal(registry(session, "form-a"), fixtureCase.name))

      expect(result).toMatchObject({ application: "frame", status: "applied" })
      expect(cache.size).toBe(0)
      expect(session.tree.getElementById(fixtureCase.name)).toBeDefined()
    }

    for (const fixtureCase of [
      {
        body: '<turbo-frame id="frame-a"><Safe id="safe-frame" /></turbo-frame>',
        headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
        name: "safe-success",
      },
      {
        body: '<turbo-stream action="remove" target="missing"><template /></turbo-stream>',
        headers: { "Content-Type": TURBO_STREAM_MIME_TYPE },
        name: "unsafe-stream",
      },
    ] as const) {
      const session = fixture()
      if (fixtureCase.name === "unsafe-stream") {
        session.setAttribute("id:form-a", "method", "post")
      }
      const cache = populatedSnapshotCache(session)
      const result = await new FormSubmissionController(
        session,
        {
          fetch: async (request) =>
            response(request, fixtureCase.body, { headers: fixtureCase.headers }),
        },
        { snapshotCache: cache },
      ).submit(proposal(registry(session, "form-a"), fixtureCase.name))

      expect(result).toMatchObject({ status: "applied" })
      expect(cache.size).toBe(2)
    }

    {
      const session = fixture()
      session.setAttribute("id:form-a", "method", "post")
      const cache = populatedSnapshotCache(session)
      const transport = pendingFetch()
      const controller = new FormSubmissionController(session, transport.adapter, {
        snapshotCache: cache,
      })
      const stale = controller.submit(proposal(registry(session, "form-a"), "stale-unsafe"))
      const staleRequest = transport.pending[0]
      if (!staleRequest) throw new Error("stale Frame form request was not captured")

      session.removeAttribute("id:form-a", "method")
      const current = controller.submit(proposal(registry(session, "form-a"), "current-safe"), {
        duplicateBehavior: "supersede",
      })
      const currentRequest = transport.pending[1]
      if (!currentRequest) throw new Error("current Frame form request was not captured")

      expect(await stale).toMatchObject({ status: "canceled" })
      currentRequest.response.resolve(
        response(
          currentRequest.request,
          '<turbo-frame id="frame-a"><Current id="current-safe" /></turbo-frame>',
        ),
      )
      expect(await current).toMatchObject({ application: "frame", status: "applied" })
      staleRequest.response.resolve(
        response(staleRequest.request, "not xml", {
          headers: { "Content-Type": "text/plain" },
        }),
      )
      await Promise.resolve()
      expect(cache.size).toBe(2)
      expect(session.tree.getElementById("current-safe")).toBeDefined()
    }
  })

  test("keeps ordinary empty responses inert and applies redirected empty Frame sources", async () => {
    for (const fixtureCase of [
      { body: "unused", reads: 0, status: 204 },
      { body: " \n ", reads: 1, status: 201 },
    ] as const) {
      const session = fixture()
      session.setAttribute("id:document-form", "method", "post")
      const tree = session.tree
      const revision = session.revision
      let reads = 0
      const controller = new FormSubmissionController(session, {
        fetch: async (request) =>
          response(request, fixtureCase.body, {
            headers: {},
            status: fixtureCase.status,
            text: async () => {
              reads += 1
              return fixtureCase.body
            },
          }),
      })

      const result = await controller.submit(
        proposal(registry(session, "document-form"), `empty-${fixtureCase.status}`),
      )
      expect(result).toMatchObject({ application: "empty", status: "empty" })
      expect(Object.isFrozen(result)).toBe(true)
      expect(reads).toBe(fixtureCase.reads)
      expect(session.tree).toBe(tree)
      expect(session.revision).toBe(revision)
    }

    for (const fixtureCase of [
      { body: "unused", status: 204 },
      { body: " \n ", status: 201 },
    ] as const) {
      const session = fixture()
      session.setAttribute("id:form-a", "method", "post")
      session.setAttribute("id:form-a", "data-turbo-frame", "frame-b")
      const frame = session.tree.getElementById("frame-b")
      if (!frame) throw new Error("Frame fixture is missing")
      const children = frame.children
      const finalUrl = `https://example.test/redirected-empty-${fixtureCase.status}`
      const result = await new FormSubmissionController(session, {
        fetch: async (request) =>
          response(request, fixtureCase.body, {
            headers: {},
            redirected: true,
            status: fixtureCase.status,
            url: finalUrl,
          }),
      }).submit(proposal(registry(session, "form-a"), `redirected-empty-${fixtureCase.status}`))

      expect(result).toMatchObject({
        application: "frame",
        applicationDestination: { frameId: "frame-b", kind: "frame" },
        frame: {
          finalUrl,
          frameId: "frame-b",
          streams: { actions: [], interrupted: false },
        },
        responseStatus: fixtureCase.status,
        status: "applied",
      })
      expect(frame.children).toBe(children)
      expect(attributeValue(frame, "src")).toBe(finalUrl)
    }
  })

  test("applies matching Frame success and error XML with exact src ownership", async () => {
    for (const fixtureCase of [
      {
        expectedSrc: "https://example.test/submit-a",
        name: "success",
        options: {},
        status: 200,
      },
      { expectedSrc: "/frame-a", name: "client", options: {}, status: 422 },
      { expectedSrc: "/frame-a", name: "server", options: {}, status: 500 },
      {
        expectedSrc: "https://example.test/redirected-frame",
        name: "redirected-error",
        options: { redirected: true, url: "https://example.test/redirected-frame" },
        status: 422,
      },
    ] as const) {
      const session = fixture()
      session.setAttribute("id:form-a", "method", "post")
      const frame = session.tree.getElementById("frame-a")
      if (!frame) throw new Error("Frame fixture is missing")
      const controller = new FormSubmissionController(session, {
        fetch: async (request) =>
          response(
            request,
            `<turbo-frame id="frame-a"><Result id="${fixtureCase.name}" /></turbo-frame>`,
            { ...fixtureCase.options, status: fixtureCase.status },
          ),
      })

      expect(
        await controller.submit(proposal(registry(session, "form-a"), fixtureCase.name)),
      ).toMatchObject({
        application: "frame",
        responseStatus: fixtureCase.status,
        status: "applied",
      })
      expect(session.tree.getElementById("frame-a")).toBe(frame)
      expect(session.tree.getElementById(fixtureCase.name)).toBeDefined()
      expect(attributeValue(frame, "src")).toBe(fixtureCase.expectedSrc)
    }

    {
      const session = fixture()
      session.setAttribute("id:form-a", "method", "post")
      const frame = session.tree.getElementById("frame-a")
      if (!frame) throw new Error("Frame fixture is missing")
      const children = frame.children
      const src = attributeValue(frame, "src")
      const revision = session.revision
      const result = await new FormSubmissionController(session, {
        fetch: async (request) => response(request, "unused", { headers: {}, status: 204 }),
      }).submit(proposal(registry(session, "form-a"), "empty-frame"))
      expect(result).toMatchObject({ application: "empty", status: "empty" })
      expect(frame.children).toBe(children)
      expect(attributeValue(frame, "src")).toBe(src)
      expect(session.revision).toBe(revision)
    }
  })

  test("applies cross-target Frame success to its destination and failures to the origin", async () => {
    {
      const session = fixture()
      session.setAttribute("id:form-a", "method", "post")
      session.setAttribute("id:form-a", "data-turbo-frame", "frame-b")
      const origin = session.tree.getElementById("frame-a")
      const originChildren = origin?.children
      const destination = session.tree.getElementById("frame-b")
      const result = await new FormSubmissionController(session, {
        fetch: async (request) =>
          response(
            request,
            '<turbo-frame id="frame-b"><Success id="named-target-success" /></turbo-frame>',
          ),
      }).submit(proposal(registry(session, "form-a"), "named-target-success"))

      expect(result).toMatchObject({
        application: "frame",
        applicationDestination: { frameId: "frame-b", kind: "frame" },
        destination: { frameId: "frame-b", kind: "frame" },
        frame: { frameId: "frame-b" },
        status: "applied",
      })
      expect(session.tree.getElementById("frame-b")).toBe(destination)
      expect(session.tree.getElementById("named-target-success")).toBeDefined()
      expect(origin?.children).toBe(originChildren)
    }

    {
      const session = fixture()
      session.setAttribute("id:form-a", "method", "post")
      session.setAttribute("id:form-a", "data-turbo-frame", "frame-b")
      const origin = session.tree.getElementById("frame-a")
      const destination = session.tree.getElementById("frame-b")
      const destinationChildren = destination?.children
      let requestedFrame: string | undefined
      const result = await new FormSubmissionController(session, {
        fetch: async (request) => {
          requestedFrame = request.headers["Turbo-Frame"]
          return response(
            request,
            '<turbo-frame id="frame-a"><Validation id="named-target-error" /></turbo-frame>',
            { status: 422 },
          )
        },
      }).submit(proposal(registry(session, "form-a"), "named-target-error"))

      expect(requestedFrame).toBe("frame-b")
      expect(result).toMatchObject({
        application: "frame",
        applicationDestination: { frameId: "frame-a", kind: "frame" },
        destination: { frameId: "frame-b", kind: "frame" },
        frame: { frameId: "frame-a" },
        status: "applied",
      })
      expect(session.tree.getElementById("frame-a")).toBe(origin)
      expect(session.tree.getElementById("named-target-error")).toBeDefined()
      expect(destination?.children).toBe(destinationChildren)
    }

    {
      const session = new DocumentSession(
        parseExpoTurboDocument(
          `<Gallery>
            <turbo-frame id="outer">
              <turbo-frame id="inner">
                <DemoForm id="nested-form" action="/nested" method="post" data-turbo-frame="_parent" />
              </turbo-frame>
            </turbo-frame>
          </Gallery>`,
          { url: "https://example.test/current" },
        ),
      )
      const outer = session.tree.getElementById("outer")
      const outerChildren = outer?.children
      const inner = session.tree.getElementById("inner")
      let requestedFrame: string | undefined
      const result = await new FormSubmissionController(session, {
        fetch: async (request) => {
          requestedFrame = request.headers["Turbo-Frame"]
          return response(
            request,
            '<turbo-frame id="inner"><Validation id="parent-target-error" /></turbo-frame>',
            { status: 500 },
          )
        },
      }).submit(proposal(registry(session, "nested-form"), "parent-target-error"))

      expect(requestedFrame).toBe("outer")
      expect(result).toMatchObject({
        application: "frame",
        applicationDestination: { frameId: "inner", kind: "frame" },
        destination: { frameId: "outer", kind: "frame" },
        frame: { frameId: "inner" },
        status: "applied",
      })
      expect(session.tree.getElementById("inner")).toBe(inner)
      expect(session.tree.getElementById("parent-target-error")).toBeDefined()
      expect(outer?.children).toBe(outerChildren)
    }
  })

  test("cancels a cross-target error after newer origin-Frame lane activity", async () => {
    const session = fixture()
    session.setAttribute("id:form-a", "method", "post")
    session.setAttribute("id:form-a", "data-turbo-frame", "frame-b")
    const origin = session.tree.getElementById("frame-a")
    const originChildren = origin?.children
    const transport = pendingFetch()
    const controller = new FormSubmissionController(session, transport.adapter)
    const loader = new FrameRequestLoader(session, transport.adapter, requestIds("origin-newer"))

    const submitting = controller.submit(proposal(registry(session, "form-a"), "late-error"))
    const formRequest = transport.pending[0]
    if (!formRequest) throw new Error("cross-target form request was not captured")
    const loading = loader.load("frame-a", "/origin-check")
    const originRequest = transport.pending[1]
    if (!originRequest) throw new Error("origin Frame request was not captured")
    expect(formRequest.request.signal?.aborted).toBe(false)

    originRequest.response.resolve(
      response(originRequest.request, "unused", { headers: {}, status: 204 }),
    )
    expect(await loading).toMatchObject({ status: "empty" })

    formRequest.response.resolve(
      response(
        formRequest.request,
        '<turbo-frame id="frame-a"><Stale id="late-origin-error" /></turbo-frame>',
        { status: 422 },
      ),
    )
    const canceled = await submitting
    expect(canceled).toMatchObject({
      destination: { frameId: "frame-b", kind: "frame" },
      status: "canceled",
    })
    expect(Object.keys(canceled).sort()).toEqual([
      "destination",
      "effectiveMethod",
      "requestId",
      "requestedUrl",
      "sourceMethod",
      "status",
    ])
    expect(origin?.children).toBe(originChildren)
    expect(session.tree.getElementById("late-origin-error")).toBeUndefined()
  })

  test("lets reentrant origin-Frame work supersede a cross-target error transfer", async () => {
    const session = fixture()
    session.setAttribute("id:form-a", "method", "post")
    session.setAttribute("id:form-a", "data-turbo-frame", "frame-b")
    const transport = pendingFetch()
    const loader = new FrameRequestLoader(session, transport.adapter, requestIds("origin-transfer"))
    const oldOwner = Object.freeze({})
    const newOwner = Object.freeze({})
    const oldLoading = loader.load("frame-a", "/old-origin", { owner: oldOwner })
    const oldRequest = transport.pending[0]
    if (!oldRequest) throw new Error("old origin Frame request was not captured")
    let newestLoading: ReturnType<FrameRequestLoader["load"]> | undefined
    oldRequest.request.signal?.addEventListener(
      "abort",
      () => {
        newestLoading = loader.load("frame-a", "/newest-origin", { owner: newOwner })
      },
      { once: true },
    )

    const submitting = new FormSubmissionController(session, transport.adapter).submit(
      proposal(registry(session, "form-a"), "transferred-error"),
    )
    const formRequest = transport.pending[1]
    if (!formRequest) throw new Error("cross-target form request was not captured")
    formRequest.response.resolve(
      response(
        formRequest.request,
        '<turbo-frame id="frame-a"><Stale id="transferred-error" /></turbo-frame>',
        { status: 422 },
      ),
    )

    expect(await submitting).toMatchObject({ status: "canceled" })
    oldRequest.response.resolve(
      response(
        oldRequest.request,
        '<turbo-frame id="frame-a"><Old id="old-origin" /></turbo-frame>',
      ),
    )
    expect(await oldLoading).toMatchObject({ status: "canceled" })
    const newestRequest = transport.pending[2]
    if (!newestRequest || !newestLoading) {
      throw new Error("reentrant origin Frame request was not captured")
    }
    expect(newestRequest.request.signal?.aborted).toBe(false)
    expect(session.tree.getElementById("transferred-error")).toBeUndefined()

    newestRequest.response.resolve(
      response(
        newestRequest.request,
        '<turbo-frame id="frame-a"><Newer id="newest-origin" /></turbo-frame>',
      ),
    )
    expect(await newestLoading).toMatchObject({ status: "completed" })
    expect(session.tree.getElementById("newest-origin")).toBeDefined()
  })

  test("commits Frame content before consuming embedded Streams and rejects a missing match", async () => {
    const session = fixture()
    const frame = session.tree.getElementById("frame-a")
    const controller = new FormSubmissionController(session, {
      fetch: async (request) =>
        response(
          request,
          `<turbo-frame id="frame-a">
            <FrameResult id="frame-result" />
            <turbo-stream action="update" target="frame-b">
              <template><StreamResult id="stream-result" /></template>
            </turbo-stream>
          </turbo-frame>`,
        ),
    })
    const result = await controller.submit(proposal(registry(session, "form-a"), "embedded-stream"))
    expect(result).toMatchObject({
      application: "frame",
      frame: { streams: { actions: [{ action: "update", status: "applied" }] } },
      status: "applied",
    })
    expect(session.tree.getElementById("frame-a")).toBe(frame)
    expect(session.tree.getElementById("frame-result")).toBeDefined()
    expect(session.tree.getElementById("stream-result")).toBeDefined()

    const missing = fixture()
    const missingFrame = missing.tree.getElementById("frame-a")
    const revision = missing.revision
    await expect(
      new FormSubmissionController(missing, {
        fetch: async (request) =>
          response(request, '<turbo-frame id="other"><Wrong /></turbo-frame>'),
      }).submit(proposal(registry(missing, "form-a"), "missing-frame")),
    ).rejects.toBeInstanceOf(FrameMissingError)
    expect(missing.revision).toBe(revision)
    expect(missing.tree.getElementById("frame-a")).toBe(missingFrame)
  })

  test("dispatches negotiated Streams across response classifications and isolates actions", async () => {
    for (const fixtureCase of [
      { classification: "success", status: 200 },
      { classification: "client-error", status: 422 },
      { classification: "server-error", status: 500 },
    ] as const) {
      const session = fixture()
      session.setAttribute("id:document-form", "method", "post")
      const documentUrl = session.tree.document.url
      const frame = session.tree.getElementById("frame-b")
      if (!frame) throw new Error("Frame fixture is missing")
      const frameSrc = attributeValue(frame, "src")
      const controller = new FormSubmissionController(session, {
        fetch: async (request) =>
          response(
            request,
            `<turbo-stream action="unknown" target="frame-b"></turbo-stream>
             <turbo-stream action="update" target="frame-b"><template><Updated id="updated-${fixtureCase.status}" /></template></turbo-stream>`,
            {
              headers: { "Content-Type": TURBO_STREAM_MIME_TYPE },
              status: fixtureCase.status,
            },
          ),
      })

      const result = await controller.submit(
        proposal(registry(session, "document-form"), `stream-${fixtureCase.status}`),
      )
      expect(result).toMatchObject({
        application: "stream",
        classification: fixtureCase.classification,
        status: "applied",
        streams: {
          actions: [
            { action: "unknown", status: "error" },
            { action: "update", status: "applied" },
          ],
        },
      })
      expect(session.tree.getElementById(`updated-${fixtureCase.status}`)).toBeDefined()
      expect(session.tree.document.url).toBe(documentUrl)
      expect(attributeValue(frame, "src")).toBe(frameSrc)
    }

    {
      const session = fixture()
      session.setAttribute("id:form-a", "method", "post")
      const frame = session.tree.getElementById("frame-a")
      const frameSrc = frame && attributeValue(frame, "src")
      const result = await new FormSubmissionController(session, {
        fetch: async (request) =>
          response(
            request,
            '<turbo-stream action="update" target="frame-b"><template><Updated id="frame-stream-result" /></template></turbo-stream>',
            { headers: { "Content-Type": TURBO_STREAM_MIME_TYPE } },
          ),
      }).submit(proposal(registry(session, "form-a"), "frame-stream"))

      expect(result).toMatchObject({
        application: "stream",
        destination: { frameId: "frame-a", kind: "frame" },
        status: "applied",
      })
      expect(session.tree.getElementById("frame-stream-result")).toBeDefined()
      expect(frame && attributeValue(frame, "src")).toBe(frameSrc)
    }

    {
      const session = fixture()
      session.setAttribute("id:document-form", "method", "post")
      const refreshes: unknown[] = []
      const controller = new FormSubmissionController(
        session,
        {
          fetch: async (request) =>
            response(request, '<turbo-stream action="refresh" request-id="form-refresh"/>', {
              headers: { "Content-Type": TURBO_STREAM_MIME_TYPE },
            }),
        },
        { refresh: { request: (request) => refreshes.push(request) } },
      )

      const result = await controller.submit(
        proposal(registry(session, "document-form"), "form-refresh"),
      )

      expect(result).toMatchObject({
        application: "stream",
        streams: { actions: [{ action: "refresh", status: "applied" }] },
      })
      expect(session.recentRequestIds.has("form-refresh")).toBe(true)
      expect(refreshes).toEqual([
        { baseUrl: "https://example.test/current", requestId: "form-refresh" },
      ])
    }
  })

  test("keeps parse failures mutation-free, releases ownership, and remains reusable", async () => {
    const session = fixture()
    let attempt = 0
    const controls = registry(session, "document-form")
    const controller = new FormSubmissionController(session, {
      async fetch(request) {
        attempt += 1
        return response(
          request,
          attempt === 1 ? "<Gallery>" : '<Gallery><Recovered id="recovered" /></Gallery>',
        )
      },
    })
    const revision = session.revision
    await expect(controller.submit(proposal(controls, "malformed"))).rejects.toBeInstanceOf(
      ParseError,
    )
    expect(session.revision).toBe(revision)
    expect(controls.submissionState).toMatchObject({ busy: false, status: "idle" })
    expect(await controller.submit(proposal(controls, "retry"))).toMatchObject({
      application: "document",
      status: "applied",
    })
    expect(session.tree.getElementById("recovered")).toBeDefined()
  })

  test("reports committed finalization failures without downgrading them to cancellation", async () => {
    const session = fixture()
    session.subscribe("id:document-form", () => {
      throw new Error("observer details with secret-token")
    })
    const controller = new FormSubmissionController(session, {
      fetch: async (request) =>
        response(request, '<Gallery><Committed id="committed-with-error" /></Gallery>'),
    })

    try {
      await controller.submit(proposal(registry(session, "document-form"), "commit-error"))
      throw new Error("expected finalization failure")
    } catch (error) {
      expect(error).toBeInstanceOf(FormSubmissionCommitError)
      if (!(error instanceof FormSubmissionCommitError)) throw error
      expect(error.outcome).toMatchObject({
        application: "document",
        classification: "success",
        status: "applied",
      })
      expect(error.cause).toBeUndefined()
      expect(String(error)).not.toContain("secret-token")
    }
    expect(session.tree.getElementById("committed-with-error")).toBeDefined()

    const streamSession = fixture()
    streamSession.setAttribute("id:document-form", "method", "post")
    streamSession.subscribe("id:frame-b", () => {
      throw new Error("stream observer details with secret-token")
    })
    try {
      await new FormSubmissionController(streamSession, {
        fetch: async (request) =>
          response(
            request,
            '<turbo-stream action="update" target="frame-b"><template><Committed id="committed-stream" /></template></turbo-stream>',
            { headers: { "Content-Type": TURBO_STREAM_MIME_TYPE } },
          ),
      }).submit(proposal(registry(streamSession, "document-form"), "stream-commit-error"))
      throw new Error("expected Stream finalization failure")
    } catch (error) {
      expect(error).toBeInstanceOf(FormSubmissionCommitError)
      if (!(error instanceof FormSubmissionCommitError)) throw error
      expect(error.outcome).toMatchObject({
        application: "stream",
        classification: "success",
        status: "applied",
      })
      expect(error.cause).toBeUndefined()
      expect(String(error)).not.toContain("secret-token")
    }
    expect(streamSession.tree.getElementById("committed-stream")).toBeDefined()
  })

  test("redacts uncommitted host callback failures", async () => {
    const session = fixture()
    session.setAttribute("id:document-form", "method", "post")
    const revision = session.revision
    const controller = new FormSubmissionController(
      session,
      {
        fetch: async (request) =>
          response(request, '<turbo-stream action="unknown" target="frame-b" />', {
            headers: { "Content-Type": TURBO_STREAM_MIME_TYPE },
          }),
      },
      {
        onActionError() {
          throw new Error("host callback secret-token")
        },
      },
    )

    try {
      await controller.submit(proposal(registry(session, "document-form"), "callback-error"))
      throw new Error("expected callback failure")
    } catch (error) {
      expect(error).toBeInstanceOf(RequestError)
      if (!(error instanceof RequestError)) throw error
      expect(error).not.toBeInstanceOf(FormSubmissionCommitError)
      expect(error.cause).toBeUndefined()
      expect(String(error)).not.toContain("secret-token")
    }
    expect(session.revision).toBe(revision)
  })

  test("keeps reentrant newer document work authoritative after the form commit", async () => {
    const session = fixture()
    const transport = pendingFetch()
    const loader = new DocumentRequestLoader(session, transport.adapter, requestIds("reentrant"))
    const controller = new FormSubmissionController(session, transport.adapter)
    let loading: ReturnType<DocumentRequestLoader["load"]> | undefined
    session.subscribe("id:document-form", () => {
      loading = loader.load("/newer")
    })

    const submitting = controller.submit(proposal(registry(session, "document-form"), "older"))
    const formRequest = transport.pending[0]
    if (!formRequest) throw new Error("form request was not captured")
    formRequest.response.resolve(
      response(
        formRequest.request,
        `<Gallery>
          <Older id="older" />
          <Target id="stale-target" />
          <turbo-stream action="update" target="stale-target"><template><Stale id="stale-stream" /></template></turbo-stream>
        </Gallery>`,
      ),
    )
    expect(await submitting).toMatchObject({
      application: "document",
      status: "applied",
      streams: { actions: [], interrupted: true },
    })
    expect(session.tree.getElementById("stale-stream")).toBeUndefined()

    const newerRequest = transport.pending[1]
    if (!newerRequest || !loading) throw new Error("reentrant document request was not captured")
    expect(newerRequest.request.signal?.aborted).toBe(false)
    newerRequest.response.resolve(
      response(newerRequest.request, '<Gallery><Newer id="newer" /></Gallery>'),
    )
    expect(await loading).toMatchObject({ status: "committed" })
    expect(session.tree.getElementById("newer")).toBeDefined()
    expect(session.tree.getElementById("older")).toBeUndefined()
  })

  test("stops undispatched Stream work after synchronous destination supersession", async () => {
    {
      const session = fixture()
      session.setAttribute("id:document-form", "method", "post")
      const transport = pendingFetch()
      const loader = new DocumentRequestLoader(
        session,
        transport.adapter,
        requestIds("stream-newer"),
      )
      const controller = new FormSubmissionController(session, transport.adapter)
      let loading: ReturnType<DocumentRequestLoader["load"]> | undefined
      session.subscribe("id:frame-b", () => {
        loading ??= loader.load("/newer")
      })

      const submitting = controller.submit(
        proposal(registry(session, "document-form"), "staged-stream"),
      )
      const formRequest = transport.pending[0]
      if (!formRequest) throw new Error("form request was not captured")
      formRequest.response.resolve(
        response(
          formRequest.request,
          `<turbo-stream action="update" target="frame-b"><template><First id="first-stream" /></template></turbo-stream>
           <turbo-stream action="update" target="frame-a"><template><Stale id="second-stream" /></template></turbo-stream>`,
          { headers: { "Content-Type": TURBO_STREAM_MIME_TYPE } },
        ),
      )
      expect(await submitting).toMatchObject({
        application: "stream",
        streams: {
          actions: [{ action: "update", status: "applied" }],
          interrupted: true,
        },
      })
      expect(session.tree.getElementById("first-stream")).toBeDefined()
      expect(session.tree.getElementById("second-stream")).toBeUndefined()

      const newerRequest = transport.pending[1]
      if (!newerRequest || !loading) throw new Error("newer document request was not captured")
      newerRequest.response.resolve(
        response(newerRequest.request, '<Gallery><Newer id="stream-newer" /></Gallery>'),
      )
      expect(await loading).toMatchObject({ status: "committed" })
    }

    {
      const session = fixture()
      const transport = pendingFetch()
      const loader = new FrameRequestLoader(session, transport.adapter, requestIds("frame-newer"))
      const controller = new FormSubmissionController(session, transport.adapter)
      let loading: ReturnType<FrameRequestLoader["load"]> | undefined
      session.subscribe("id:frame-a", () => {
        loading ??= loader.load("frame-a", "/newer-frame")
      })

      const submitting = controller.submit(proposal(registry(session, "form-a"), "frame-staged"))
      const formRequest = transport.pending[0]
      if (!formRequest) throw new Error("Frame form request was not captured")
      formRequest.response.resolve(
        response(
          formRequest.request,
          `<turbo-frame id="frame-a">
            <FrameResult id="staged-frame-result" />
            <turbo-stream action="update" target="frame-b"><template><Stale id="stale-frame-stream" /></template></turbo-stream>
          </turbo-frame>`,
        ),
      )
      expect(await submitting).toMatchObject({
        application: "frame",
        frame: { streams: { actions: [], interrupted: true } },
        status: "applied",
      })
      expect(session.tree.getElementById("staged-frame-result")).toBeDefined()
      expect(session.tree.getElementById("stale-frame-stream")).toBeUndefined()

      const newerRequest = transport.pending[1]
      if (!newerRequest || !loading) throw new Error("newer Frame request was not captured")
      newerRequest.response.resolve(
        response(
          newerRequest.request,
          '<turbo-frame id="frame-a"><Newer id="frame-newer" /></turbo-frame>',
        ),
      )
      expect(await loading).toMatchObject({ status: "completed" })
    }

    {
      const session = fixture()
      session.setAttribute("id:document-form", "method", "post")
      const transport = pendingFetch()
      const loader = new DocumentRequestLoader(
        session,
        transport.adapter,
        requestIds("custom-newer"),
      )
      let loading: ReturnType<DocumentRequestLoader["load"]> | undefined
      const startNewer = defineStreamAction({
        action: "start-newer",
        handler: () => {
          loading ??= loader.load("/custom-newer")
        },
        schema: z.object({}),
      })
      const controller = new FormSubmissionController(session, transport.adapter, {
        customActions: createStreamActionRegistry(startNewer),
      })
      const submitting = controller.submit(
        proposal(registry(session, "document-form"), "custom-staged"),
      )
      const formRequest = transport.pending[0]
      if (!formRequest) throw new Error("custom-action form request was not captured")
      formRequest.response.resolve(
        response(
          formRequest.request,
          `<turbo-stream action="start-newer"></turbo-stream>
           <turbo-stream action="update" target="frame-b"><template><Stale id="custom-stale" /></template></turbo-stream>`,
          { headers: { "Content-Type": TURBO_STREAM_MIME_TYPE } },
        ),
      )
      expect(await submitting).toMatchObject({
        application: "stream",
        streams: {
          actions: [{ action: "start-newer", status: "applied" }],
          interrupted: true,
        },
      })
      expect(session.tree.getElementById("custom-stale")).toBeUndefined()

      const newerRequest = transport.pending[1]
      if (!newerRequest || !loading) throw new Error("custom newer request was not captured")
      newerRequest.response.resolve(
        response(newerRequest.request, '<Gallery><Newer id="custom-newer" /></Gallery>'),
      )
      expect(await loading).toMatchObject({ status: "committed" })
    }
  })
})
