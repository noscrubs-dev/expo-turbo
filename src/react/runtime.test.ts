import { describe, expect, test } from "bun:test"
import type { ComponentType } from "react"
import { z } from "zod"

import type { TurboResponse } from "../adapters/index.js"
import { attributeValue, EXPO_TURBO_MIME_TYPE, isElement } from "../core/index.js"
import { createRegistry, defineComponent, defineComponentModule } from "../registry/index.js"
import { createExpoTurboRuntime } from "./runtime-factory.js"

const TestDocument = (() => null) as ComponentType
const TestForm = (() => null) as ComponentType
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
