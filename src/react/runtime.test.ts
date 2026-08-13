import { describe, expect, test } from "bun:test"
import type { ComponentType } from "react"
import { z } from "zod"

import type { CableCallbacks, TurboResponse } from "../adapters/index.js"
import {
  attributeValue,
  DOCUMENT_REFRESH_DEBOUNCE_MS,
  EXPO_TURBO_MIME_TYPE,
  isElement,
} from "../core/index.js"
import { createRegistry, defineComponent, defineComponentModule } from "../registry/index.js"
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
  test("loads a document with the registry capabilities and owns disposal", async () => {
    const requests: Array<Readonly<{ headers: Readonly<Record<string, string>>; url: string }>> = []
    const url = "https://example.test/document"
    const runtime = createExpoTurboRuntime({
      fetch: {
        fetch: async (request) => {
          requests.push(request)
          return response('<TestDocument><TestForm id="form" /></TestDocument>', request.url)
        },
      },
      registry,
      url,
    })

    await runtime.load()

    expect(runtime.session.tree.document.children.find(isElement)?.tagName).toBe("TestDocument")
    expect(requests).toHaveLength(1)
    expect(requests[0]?.headers["X-Expo-Turbo-Capabilities"]).toBe(registry.capabilities.hash)
    expect(requests[0]?.headers["X-Expo-Turbo-Modules"]).toBe("v1;runtime-test=1")

    const formRequest = runtime.forms
      .controlsFor("id:form")
      .requestPlan({ protocol: { requestId: "form-1" } }).request
    expect(formRequest.headers["X-Expo-Turbo-Capabilities"]).toBeUndefined()
    expect(formRequest.headers["X-Expo-Turbo-Modules"]).toBe("v1;runtime-test=1")

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
    // the document. Reconnect recovery is tracked separately; when it lands,
    // this expectation flips to a second request for `documentUrl`.
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
    // host and impossible for it to catch. The bounded give-up report for a
    // failing reconnect recovery is covered deterministically in
    // cable-recovery-internal.test.ts rather than by waiting out real backoff.
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
