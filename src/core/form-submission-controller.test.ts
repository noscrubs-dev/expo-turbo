import { describe, expect, test } from "bun:test"

import type { FetchAdapter, TurboRequest, TurboResponse } from "../adapters"
import { DocumentRequestLoader } from "./document-loader"
import { RequestError, StateError } from "./errors"
import { FormSubmissionController } from "./form-submission-controller"
import type { FormSubmissionProposal } from "./form-submission-proposal"
import { FormControlRegistry } from "./forms"
import { EXPO_TURBO_MIME_TYPE, FrameRequestLoader } from "./frame-loader"
import { parseExpoTurboDocument } from "./parser"
import { DocumentSession } from "./session"
import { isElement } from "./tree"

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
        destination: { kind: "document" },
        requestId: "form-1",
        status: "xml",
      })
      expect(Object.isFrozen(result)).toBe(true)
      expect(session.revision).toBe(revision)
      expect(session.tree.getElementById("document-form")).toBeDefined()

      getRequest.response.resolve(response(getRequest.request, "<Gallery><Late /></Gallery>"))
      expect(await loading).toMatchObject({ status: "canceled" })
      expect(session.tree.getElementById("document-form")).toBeDefined()
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
      expect(await submitting).toMatchObject({ status: "canceled" })

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
        destination: { frameId: "frame-a", kind: "frame" },
        status: "xml",
      })
      expect(frame?.children).toBe(originalChildren)

      getRequest.response.resolve(
        response(getRequest.request, '<turbo-frame id="frame-a"><Late /></turbo-frame>'),
      )
      expect(await loading).toMatchObject({ status: "canceled" })
      expect(frame?.children).toBe(originalChildren)
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

    requestA2.response.resolve(response(requestA2.request, "<A />"))
    requestB.response.resolve(response(requestB.request, "<B />"))
    expect(await secondA).toMatchObject({ requestId: "a-2", status: "xml" })
    expect(await submissionB).toMatchObject({ requestId: "b-1", status: "xml" })
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

    requestB.response.resolve(response(requestB.request, "<Moved />"))
    expect(await second).toMatchObject({
      destination: { frameId: "frame-b", kind: "frame" },
      requestId: "moving-b",
      status: "xml",
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
    expect(await nested).toMatchObject({ requestId: "nested-wins", status: "xml" })
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
    expect(await incumbent).toMatchObject({ requestId: "incumbent", status: "xml" })
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
      expect(await submitting).toMatchObject({ status: "xml" })
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

      formRequest.response.resolve(response(formRequest.request, "<ValidFrame />"))
      expect(await submitting).toMatchObject({ status: "xml" })
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
    expect(await first).toMatchObject({ requestId: "session-1", status: "xml" })
    expect(await second).toMatchObject({ requestId: "session-2", status: "xml" })
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
    frameRequest.response.resolve(response(frameRequest.request, "<FrameCandidate />"))
    topRequest.response.resolve(response(topRequest.request, "<DocumentCandidate />"))
    expect(await top).toMatchObject({ destination: { kind: "document" }, status: "xml" })
    expect(await frame).toMatchObject({
      destination: { frameId: "document", kind: "frame" },
      status: "xml",
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
})
