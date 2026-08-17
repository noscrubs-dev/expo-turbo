import { describe, expect, test } from "bun:test"
import type { ComponentType } from "react"
import { z } from "zod"

import type { CableCallbacks, TurboRequest, TurboResponse } from "../adapters/index.js"
import {
  ActionError,
  attributeValue,
  DOCUMENT_REFRESH_DEBOUNCE_MS,
  EXPO_TURBO_MIME_TYPE,
  isElement,
} from "../core/index.js"
import {
  createComponentActionRegistry,
  createRegistry,
  defineComponent,
  defineComponentAction,
  defineComponentActionModule,
  defineComponentModule,
} from "../registry/index.js"
import { createExpoTurboRuntime } from "./runtime-factory.js"

const TestDocument = (() => null) as ComponentType
const TestForm = (() => null) as ComponentType
const TestField = (() => null) as ComponentType
const registry = createRegistry(
  defineComponentModule({
    components: [
      defineComponent({
        attributes: {},
        children: "nodes",
        component: TestDocument,
        schema: z.object({}),
        tag: "TestDocument",
      }),
      defineComponent({
        attributes: {},
        children: "nodes",
        component: TestForm,
        formOwner: true,
        schema: z.object({}),
        tag: "TestForm",
      }),
      defineComponent({
        attributes: {},
        children: "none",
        component: TestField,
        schema: z.object({}),
        tag: "TestField",
      }),
    ],
    name: "runtime-test",
    version: "1",
  }),
)

function response(xml: string, url: string): TurboResponse {
  return {
    headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
    redirected: false,
    status: 200,
    text: async () => xml,
    url,
  }
}

describe("Expo Turbo runtime", () => {
  test("shares document and Frame preload responses with their live request loaders", async () => {
    const requests: TurboRequest[] = []
    const documentUrl = "https://example.test/document"
    const nextUrl = "https://example.test/next"
    const frameUrl = "https://example.test/frame"
    const runtime = createExpoTurboRuntime({
      fetch: {
        fetch: async (request) => {
          requests.push(request)
          if (request.url === frameUrl) {
            return response(
              '<turbo-frame id="details"><TestField id="loaded-frame" /></turbo-frame>',
              request.url,
            )
          }
          return response(
            request.url === nextUrl
              ? '<TestDocument><TestField id="loaded-document" /></TestDocument>'
              : '<TestDocument><turbo-frame id="details" /></TestDocument>',
            request.url,
          )
        },
      },
      registry,
      url: documentUrl,
    })

    await runtime.load()
    await expect(runtime.framePreloader.preload("details", frameUrl)).resolves.toMatchObject({
      status: "cached",
    })
    await expect(runtime.frames.get("details").visit(frameUrl)).resolves.toMatchObject({
      status: "completed",
    })
    expect(runtime.session.tree.getElementById("loaded-frame")).toBeDefined()

    const documentPreload = runtime.documentPreloader.retain(nextUrl)
    documentPreload.commit()
    await expect(documentPreload.promise).resolves.toMatchObject({ status: "cached" })
    await expect(runtime.controller.visit(nextUrl)).resolves.toMatchObject({ status: "committed" })
    expect(runtime.session.tree.getElementById("loaded-document")).toBeDefined()

    // Each preloader and live loader must share one cache. A separate cache
    // makes either destination appear twice here.
    expect(requests.map(({ url }) => url)).toEqual([documentUrl, frameUrl, nextUrl])
    expect(requests.filter(({ url }) => url === frameUrl)).toHaveLength(1)
    expect(requests.filter(({ url }) => url === nextUrl)).toHaveLength(1)
    const descriptor = `v=1; proto=0.1; rt=0.3.0; vocab=${registry.capabilities.hash}`
    expect(requests.slice(1).map(({ headers }) => headers["X-Expo-Turbo-Client"])).toEqual([
      descriptor,
      descriptor,
    ])
    expect(requests[1]?.headers["Turbo-Frame"]).toBe("details")
    expect(requests[2]?.headers["X-Sec-Purpose"]).toBe("prefetch")

    runtime.dispose()
  })

  test("builds optional component actions against the runtime state", async () => {
    const record = defineComponentAction({
      action: "record-runtime-value",
      handler: ({ params, state }) => {
        state.set("recorded", params.value)
        return params.value
      },
      schema: z.object({ value: z.string() }),
    })
    const actions = createComponentActionRegistry(
      defineComponentActionModule({
        actions: [record],
        name: "runtime-actions",
        version: "1.0.0",
      }),
    )
    const runtime = createExpoTurboRuntime({
      actions,
      fetch: { fetch: async (request) => response("<TestDocument />", request.url) },
      registry,
      url: "https://example.test/document",
    })

    await expect(
      runtime.actions?.executeDefinition(record, { value: "from-action" }),
    ).resolves.toBe("from-action")
    expect(runtime.state.get("recorded")).toBe("from-action")

    const unknown = defineComponentAction({
      action: "unknown-runtime-action",
      handler: () => undefined,
      schema: z.object({}),
    })
    await expect(runtime.actions?.executeDefinition(unknown, {})).rejects.toBeInstanceOf(
      ActionError,
    )
    runtime.dispose()
  })

  test("does not create a component action runner when actions are omitted", () => {
    const runtime = createExpoTurboRuntime({
      fetch: { fetch: async (request) => response("<TestDocument />", request.url) },
      registry,
      url: "https://example.test/document",
    })

    expect(runtime.actions).toBeUndefined()
    runtime.dispose()
  })

  test("loads a document with the registry capabilities and owns disposal", async () => {
    const requests: Array<Readonly<{ headers: Readonly<Record<string, string>>; url: string }>> = []
    const url = "https://example.test/document"
    const runtime = createExpoTurboRuntime({
      fetch: {
        fetch: async (request) => {
          requests.push(request)
          return response(
            request.url.endsWith("/frame")
              ? '<turbo-frame id="details"><TestField /></turbo-frame>'
              : '<TestDocument><TestForm id="form" /><turbo-frame id="details" /></TestDocument>',
            request.url,
          )
        },
      },
      registry,
      url,
    })

    await runtime.load()

    expect(runtime.session.tree.document.children.find(isElement)?.tagName).toBe("TestDocument")
    expect(requests).toHaveLength(1)
    const descriptor = `v=1; proto=0.1; rt=0.3.0; vocab=${registry.capabilities.hash}`
    expect(requests[0]?.headers["X-Expo-Turbo-Client"]).toBe(descriptor)
    expect(requests[0]?.headers["X-Expo-Turbo-Modules"]).toBeUndefined()

    const formRequest = runtime.forms
      .controlsFor("id:form")
      .requestPlan({ protocol: { requestId: "form-1" } }).request
    expect(formRequest.headers["X-Expo-Turbo-Client"]).toBe(descriptor)
    expect(formRequest.headers["X-Expo-Turbo-Modules"]).toBeUndefined()

    await runtime.frames.get("details").visit("/frame")
    expect(requests).toHaveLength(2)
    // Reverting the runtime Frame hand-off removes the vocabulary digest from this exact map.
    expect(requests[1]?.headers).toEqual({
      Accept: EXPO_TURBO_MIME_TYPE,
      "Turbo-Frame": "details",
      "X-Expo-Turbo-Client": descriptor,
      "X-Turbo-Request-Id": "expo-turbo-2",
    })

    runtime.dispose()
    runtime.dispose()

    expect(runtime.state.isDisposed).toBe(true)
    expect(runtime.scopes.isDisposed).toBe(true)
  })

  test("coordinates document history when a host adapter is provided", async () => {
    const writes: Array<Readonly<{ method: string; url: string }>> = []
    const runtime = createExpoTurboRuntime({
      fetch: {
        fetch: async (request) => response("<TestDocument />", request.url),
      },
      history: {
        write(method, entry) {
          writes.push({ method, url: entry.url })
        },
      },
      registry,
      url: "https://example.test/document",
    })

    await runtime.load()
    await runtime.controller.visit("https://example.test/next")

    expect(writes.map(({ method, url }) => ({ method, url }))).toEqual([
      { method: "replace", url: "https://example.test/document" },
      { method: "replace", url: "https://example.test/document" },
      { method: "push", url: "https://example.test/next" },
    ])
  })

  test("hands one host focus adapter to form validation", async () => {
    const focused: string[] = []
    const runtime = createExpoTurboRuntime({
      fetch: {
        fetch: async (request) =>
          response(
            '<TestDocument><TestForm id="form"><TestField id="field" /></TestForm></TestDocument>',
            request.url,
          ),
      },
      focus: {
        blur() {},
        focus: (nodeKey) => {
          focused.push(nodeKey)
        },
        getFocusedId: () => focused.at(-1),
      },
      registry,
      url: "https://example.test/document",
    })

    await runtime.load()
    const controls = runtime.forms.controlsFor("id:form")
    controls.register("id:field", {
      kind: "value",
      name: "field",
      validity: { message: "Field is required", valid: false },
      value: "",
    })

    expect(controls.reportValidity()).toMatchObject({
      firstInvalid: { nodeKey: "id:field" },
      valid: false,
    })
    // The host supplies focus exactly once, to the runtime. Reverting the
    // fan-out makes reportValidity() throw StateError("Invalid form submission
    // requires a configured focus adapter") instead of recording a focus.
    expect(focused).toEqual(["id:field"])

    runtime.dispose()
  })

  test("fails invalid form validation closed when no focus adapter is supplied", async () => {
    const runtime = createExpoTurboRuntime({
      fetch: {
        fetch: async (request) =>
          response(
            '<TestDocument><TestForm id="form"><TestField id="field" /></TestForm></TestDocument>',
            request.url,
          ),
      },
      registry,
      url: "https://example.test/document",
    })

    await runtime.load()
    const controls = runtime.forms.controlsFor("id:form")
    controls.register("id:field", {
      kind: "value",
      name: "field",
      validity: { message: "Field is required", valid: false },
      value: "",
    })

    // Asserts the absence of a second route: without the new `focus` option
    // there is no adapter anywhere in the runtime, so the test above can only
    // have observed the one it passed in.
    expect(() => controls.reportValidity()).toThrow(
      "Invalid form submission requires a configured focus adapter",
    )

    runtime.dispose()
  })

  test("does not yet refresh the document after a Cable reconnect", async () => {
    const documentUrl = "https://example.test/document"
    const requests: string[] = []
    const callbacks: CableCallbacks[] = []
    const runtime = createExpoTurboRuntime({
      cable: {
        subscribe(_identifier, handlers) {
          callbacks.push(handlers)
          return { unsubscribe() {} }
        },
      },
      fetch: {
        fetch: async (request) => {
          requests.push(request.url)
          return response(
            '<TestDocument><turbo-cable-stream-source id="live" channel="DemoChannel" /></TestDocument>',
            request.url,
          )
        },
      },
      registry,
      url: documentUrl,
    })

    await runtime.load()
    const source = runtime.session.tree.getElementById("live")
    if (!source) throw new Error("the Cable source fixture is missing")
    runtime.streamSources?.retain(source)

    callbacks[0]?.connected(false)
    callbacks[0]?.disconnected(true)
    callbacks[0]?.connected(true)
    await new Promise((resolve) => setTimeout(resolve, DOCUMENT_REFRESH_DEBOUNCE_MS + 200))

    // A deliberate, documented gap rather than an oversight: anything broadcast
    // while the socket was down stays missing until something else refreshes
    // the document. Recovery is tracked in
    // https://github.com/noscrubs-dev/expo-turbo/pull/418; when it lands, this
    // expectation flips to a second request for `documentUrl`.
    expect(requests).toEqual([documentUrl])

    runtime.dispose()
  })

  test("applies a Cable-delivered refresh Stream action", async () => {
    const documentUrl = "https://example.test/document"
    const requests: string[] = []
    const callbacks: CableCallbacks[] = []
    const runtime = createExpoTurboRuntime({
      cable: {
        subscribe(_identifier, handlers) {
          callbacks.push(handlers)
          return { unsubscribe() {} }
        },
      },
      fetch: {
        fetch: async (request) => {
          requests.push(request.url)
          return response(
            '<TestDocument><turbo-cable-stream-source id="live" channel="DemoChannel" /></TestDocument>',
            request.url,
          )
        },
      },
      registry,
      url: documentUrl,
    })

    await runtime.load()
    const source = runtime.session.tree.getElementById("live")
    if (!source) throw new Error("the Cable source fixture is missing")
    runtime.streamSources?.retain(source)
    callbacks[0]?.connected(false)

    await callbacks[0]?.received(
      '<turbo-stream action="refresh" target="ignored"><template></template></turbo-stream>',
    )
    await new Promise((resolve) => setTimeout(resolve, DOCUMENT_REFRESH_DEBOUNCE_MS + 150))

    // Without `streamOptions.refresh` the action is a silent no-op: no request,
    // no error, nothing for a host to notice.
    expect(requests).toEqual([documentUrl, documentUrl])

    runtime.dispose()
  })

  test("routes a failed background refresh to onBackgroundError", async () => {
    const reported: Error[] = []
    const callbacks: CableCallbacks[] = []
    let failRefresh = false
    const runtime = createExpoTurboRuntime({
      cable: {
        subscribe(_identifier, handlers) {
          callbacks.push(handlers)
          return { unsubscribe() {} }
        },
      },
      fetch: {
        fetch: async (request) => {
          if (failRefresh) throw new Error("refresh transport refused")
          return response(
            '<TestDocument><turbo-cable-stream-source id="live" channel="DemoChannel" /></TestDocument>',
            request.url,
          )
        },
      },
      onBackgroundError: (error) => reported.push(error),
      registry,
      url: "https://example.test/document",
    })

    await runtime.load()
    const source = runtime.session.tree.getElementById("live")
    if (!source) throw new Error("the Cable source fixture is missing")
    runtime.streamSources?.retain(source)
    callbacks[0]?.connected(false)

    failRefresh = true
    await callbacks[0]?.received(
      '<turbo-stream action="refresh" target="ignored"><template></template></turbo-stream>',
    )
    await new Promise((resolve) => setTimeout(resolve, DOCUMENT_REFRESH_DEBOUNCE_MS + 200))

    // Without an observer this is an uncaught microtask throw: invisible to the
    // host and impossible for it to catch.
    expect(reported).toHaveLength(1)
    expect(reported[0]).toBeInstanceOf(Error)

    runtime.dispose()
  })

  test("does not report a canceled initial visit as loaded", async () => {
    let resolveResponse: ((value: TurboResponse) => void) | undefined
    const pendingResponse = new Promise<TurboResponse>((resolve) => {
      resolveResponse = resolve
    })
    const runtime = createExpoTurboRuntime({
      fetch: {
        fetch: () => pendingResponse,
      },
      registry,
      url: "https://example.test/document",
    })

    const loading = runtime.load()
    runtime.controller.cancel()
    resolveResponse?.(response("<TestDocument />", "https://example.test/document"))

    await expect(loading).resolves.toMatchObject({ status: "canceled" })
    expect(runtime.session.treeGeneration).toBe(0)
    const placeholder = runtime.session.tree.document.children.find(isElement)
    expect(placeholder?.tagName).toBe("turbo-frame")
    if (!placeholder) throw new Error("missing runtime placeholder")
    expect(attributeValue(placeholder, "data-turbo-cache-control")).toBe("no-cache")
  })
})

describe("Expo Turbo runtime generated form links", () => {
  const DOCUMENT_URL = "https://example.test/document"

  interface SpiedTransport {
    readonly fetch: { fetch: (request: TurboRequest) => Promise<TurboResponse> }
    readonly requests: TurboRequest[]
  }

  /**
   * Records every request and answers unsafe methods with a redirect, which is
   * what Turbo requires of a document-level form response.
   */
  function spiedTransport(xml: string): SpiedTransport {
    const requests: TurboRequest[] = []
    return {
      fetch: {
        fetch: async (request: TurboRequest) => {
          requests.push(request)
          return {
            headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
            redirected: request.method !== "GET",
            status: 200,
            text: async () => xml,
            url: request.url,
          }
        },
      },
      requests,
    }
  }

  test("dispatches a generated form-link submission the host never wired up", async () => {
    const transport = spiedTransport(
      '<TestDocument><TestField id="destroy" data-turbo-method="post" /></TestDocument>',
    )
    const runtime = createExpoTurboRuntime({
      fetch: transport.fetch,
      registry,
      url: DOCUMENT_URL,
    })

    await runtime.load()
    expect(transport.requests.map((request) => request.method)).toEqual(["GET"])

    // Issue #428: reverting the runtime hand-off leaves `formLinks` undefined
    // here, and the renderer throws TargetError("Generated form links require
    // provider form-link submissions") on the first Rails delete button.
    await runtime.formLinks.submit("id:destroy", "/danger?field=A")

    expect(transport.requests).toHaveLength(2)
    const submission = transport.requests[1]
    expect(submission?.method).toBe("POST")
    // The query pairs become form entries, exactly as Turbo's temporary form does.
    expect(submission?.url).toBe("https://example.test/danger")
    expect(submission?.body?.value).toBe("field=A")
    // The registry digest reaches the link submission too, so the server sees
    // one client descriptor across documents, forms, and form links.
    expect(submission?.headers["X-Expo-Turbo-Client"]).toBe(
      `v=1; proto=0.1; rt=0.3.0; vocab=${registry.capabilities.hash}`,
    )

    runtime.dispose()
  })

  test("still refuses a generated form link whose tag the registry does not know", async () => {
    const transport = spiedTransport(
      '<TestDocument><UnregisteredLink id="destroy" data-turbo-method="post" /></TestDocument>',
    )
    const runtime = createExpoTurboRuntime({
      fetch: transport.fetch,
      registry,
      url: DOCUMENT_URL,
    })

    await runtime.load()

    // #427's guarantee has to survive the #428 wiring: a controller that exists
    // must still refuse vocabulary it cannot interpret rather than build a
    // request out of it.
    expect(runtime.formLinks.submissionInterception("id:destroy")).toEqual({
      intercept: false,
      reason: "unknown-vocabulary",
    })
    await expect(runtime.formLinks.submit("id:destroy", "/danger?field=A")).rejects.toThrow(
      "Expo Turbo generated form-link submission requires known vocabulary",
    )

    // The refusal is the whole point: nothing left the device.
    expect(transport.requests.map((request) => request.url)).toEqual([DOCUMENT_URL])

    runtime.dispose()
  })

  const LINK_DOCUMENT =
    '<TestDocument><TestField id="destroy" data-turbo-method="delete" /></TestDocument>'

  /** Holds every unsafe response open so a submission can be caught in flight. */
  function heldTransport(): SpiedTransport & { release: () => void } {
    const requests: TurboRequest[] = []
    let resolvePending: ((value: TurboResponse) => void) | undefined
    return {
      fetch: {
        fetch: async (request: TurboRequest) => {
          requests.push(request)
          if (request.method === "GET") {
            return {
              headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
              redirected: false,
              status: 200,
              text: async () => LINK_DOCUMENT,
              url: request.url,
            }
          }
          return new Promise<TurboResponse>((resolve) => {
            resolvePending = resolve
          })
        },
      },
      release: () =>
        resolvePending?.({
          headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
          redirected: true,
          status: 200,
          text: async () => "<TestDocument />",
          url: "https://example.test/after-delete",
        }),
      requests,
    }
  }

  test("aborts an in-flight generated form-link submission when the runtime is disposed", async () => {
    const transport = heldTransport()
    const runtime = createExpoTurboRuntime({
      fetch: transport.fetch,
      registry,
      url: DOCUMENT_URL,
    })

    await runtime.load()
    const urlBeforeDispose = runtime.session.tree.document.url

    const submitting = runtime.formLinks.submit("id:destroy", "/danger?field=A")
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(transport.requests).toHaveLength(2)
    expect(transport.requests[1]?.method).toBe("DELETE")
    expect(transport.requests[1]?.signal?.aborted).toBe(false)

    // `ExpoTurbo` calls this on unmount.
    runtime.dispose()

    // Without the runtime owning the controller's lifetime the signal stays
    // live here, the released response reports "applied", and the disposed
    // session's document URL moves to /after-delete.
    expect(transport.requests[1]?.signal?.aborted).toBe(true)

    transport.release()
    const report = await submitting

    expect(report.status).toBe("canceled")
    expect(report.status).not.toBe("applied")
    expect(runtime.session.tree.document.url).toBe(urlBeforeDispose)
  })

  test("refuses a generated form-link submission started after disposal", async () => {
    // A transport that answers, not one that holds: without the guard this test
    // must fail on its assertions rather than hang on a leaked request.
    const transport = spiedTransport(LINK_DOCUMENT)
    const runtime = createExpoTurboRuntime({
      fetch: transport.fetch,
      registry,
      url: DOCUMENT_URL,
    })

    await runtime.load()
    runtime.dispose()

    // The other half of the same hole: an activation that starts late would
    // commit into the disposed session just as surely as one already running.
    expect(() => runtime.formLinks.submit("id:destroy", "/danger?field=A")).toThrow(
      "Generated form links have been disposed",
    )
    expect(transport.requests.map((request) => request.url)).toEqual([DOCUMENT_URL])
  })

  test("disposes the form-link controller it built exactly once", async () => {
    const transport = heldTransport()
    const runtime = createExpoTurboRuntime({
      fetch: transport.fetch,
      registry,
      url: DOCUMENT_URL,
    })

    await runtime.load()
    const formLinks = runtime.formLinks
    const disposeOnce = formLinks.dispose.bind(formLinks)
    let disposals = 0
    formLinks.dispose = () => {
      disposals += 1
      disposeOnce()
    }

    runtime.dispose()
    runtime.dispose()

    // Not zero, or the request outlives the unmount. Not twice: #412 showed two
    // owners calling dispose() on one object, which is harmless only for as
    // long as both stay idempotent.
    expect(disposals).toBe(1)
    expect(formLinks.isDisposed).toBe(true)
  })

  test("disposes cleanly with no generated form-link submission in flight", async () => {
    const transport = heldTransport()
    const runtime = createExpoTurboRuntime({
      fetch: transport.fetch,
      registry,
      url: DOCUMENT_URL,
    })

    await runtime.load()
    expect(transport.requests).toHaveLength(1)

    expect(() => runtime.dispose()).not.toThrow()
    expect(() => runtime.dispose()).not.toThrow()

    expect(runtime.formLinks.isDisposed).toBe(true)
    expect(runtime.state.isDisposed).toBe(true)
    expect(runtime.scopes.isDisposed).toBe(true)
  })
})
