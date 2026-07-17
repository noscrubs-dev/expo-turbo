import { describe, expect, test } from "bun:test"
import { z } from "zod"

import type { FetchAdapter, TurboRequest, TurboResponse } from "../adapters"
import { createStreamActionRegistry, defineStreamAction } from "./custom-stream-actions"
import { DocumentRequestLoader } from "./document-loader"
import { FrameMissingError, ParseError, RequestError, StateError } from "./errors"
import { FormSubmissionCommitError, FormSubmissionController } from "./form-submission-controller"
import type { FormSubmissionProposal } from "./form-submission-proposal"
import { FormControlRegistry } from "./forms"
import { EXPO_TURBO_MIME_TYPE, FrameRequestLoader } from "./frame-loader"
import { parseExpoTurboDocument } from "./parser"
import { TURBO_STREAM_MIME_TYPE } from "./protocol-request"
import { DocumentSession } from "./session"
import { attributeValue, isElement } from "./tree"

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
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
        <DemoForm id="document-form" action="/submit-document"><DemoInput id="document-field" /></DemoForm>
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
      const loading = loader.load("frame-a", "/frame-get", getOwner)
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
    const secondA = secondController.submit(proposal(formA, "a-2"))
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
    const second = controller.submit(proposal(moving, "moving-b"))
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
        nested = controller.submit(proposal(controls, "nested-wins"))
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
      const loadingA = loader.load("frame-a", "/frame-a-next", owner)
      const requestA = transport.pending[0]
      const loadingB = loader.load("frame-b", "/frame-b-next", owner)
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
      const loadingFrame = frameLoader.load("frame-a", "/next-frame", owner)
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
    const oldLoading = loader.load("frame-a", "/old-origin", oldOwner)
    const oldRequest = transport.pending[0]
    if (!oldRequest) throw new Error("old origin Frame request was not captured")
    let newestLoading: ReturnType<FrameRequestLoader["load"]> | undefined
    oldRequest.request.signal?.addEventListener(
      "abort",
      () => {
        newestLoading = loader.load("frame-a", "/newest-origin", newOwner)
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
  })

  test("keeps parse failures mutation-free, releases ownership, and remains reusable", async () => {
    const session = fixture()
    let attempt = 0
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
    await expect(
      controller.submit(proposal(registry(session, "document-form"), "malformed")),
    ).rejects.toBeInstanceOf(ParseError)
    expect(session.revision).toBe(revision)
    expect(
      await controller.submit(proposal(registry(session, "document-form"), "retry")),
    ).toMatchObject({ application: "document", status: "applied" })
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
