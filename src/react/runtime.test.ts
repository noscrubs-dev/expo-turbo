import { describe, expect, test } from "bun:test"
import type { ComponentType } from "react"
import { z } from "zod"

import type { TurboResponse } from "../adapters/index.js"
import { EXPO_TURBO_MIME_TYPE, isElement } from "../core/index.js"
import { createRegistry, defineComponent, defineComponentModule } from "../registry/index.js"
import { createExpoTurboRuntime } from "./index.js"

const TestDocument = (() => null) as ComponentType
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
          return response("<TestDocument />", request.url)
        },
      },
      registry,
      url,
    })

    await runtime.load()

    expect(runtime.session.tree.document.children.find(isElement)?.tagName).toBe("TestDocument")
    expect(requests).toHaveLength(1)
    expect(requests[0]?.headers["X-Expo-Turbo-Capabilities"]).toBe(registry.capabilities.hash)

    runtime.dispose()
    runtime.dispose()

    expect(runtime.state.isDisposed).toBe(true)
    expect(runtime.scopes.isDisposed).toBe(true)
  })
})
