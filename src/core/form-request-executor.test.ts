import { describe, expect, test } from "bun:test"

import type { TurboRequest, TurboResponse } from "../adapters"
import { ContentTypeError, ExpoTurboError, PropsError, RequestError } from "./errors"
import {
  type BuildFormRequestOptions,
  buildFormRequest,
  type FormRequestPlan,
} from "./form-request"
import { FormRequestExecutor } from "./form-request-executor"
import { EXPO_TURBO_MIME_TYPE, TURBO_STREAM_MIME_TYPE } from "./protocol-request"
import { RecentRequestIds } from "./recent-request-ids"
import { RequestLifecycle } from "./request-lifecycle"

function deferred<T>() {
  let reject!: (reason?: unknown) => void
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

function response(body: string, options: Partial<TurboResponse> = {}): TurboResponse {
  return {
    headers: { "Content-Type": `${EXPO_TURBO_MIME_TYPE}; charset=utf-8` },
    redirected: false,
    status: 200,
    text: async () => body,
    url: "https://example.test/result",
    ...options,
  }
}

function planFactory(requestId: string, overrides: Partial<BuildFormRequestOptions> = {}) {
  return (signal: AbortSignal) =>
    buildFormRequest({
      documentUrl: "https://example.test/current",
      entries: [],
      form: {},
      protocol: { requestId },
      signal,
      ...overrides,
    })
}

describe("FormRequestExecutor", () => {
  test("snapshots and validates the request lifecycle option", async () => {
    const lifecycle = new RequestLifecycle()
    let events = 0
    let reads = 0
    lifecycle.subscribe("before-fetch-request", () => {
      events += 1
    })
    const executor = new FormRequestExecutor(
      {
        fetch: async (request) => response("", { headers: {}, status: 204, url: request.url }),
      },
      {
        get requestLifecycle() {
          reads += 1
          return lifecycle
        },
      },
    )

    expect(reads).toBe(1)
    expect(await executor.execute(planFactory("request-options"))).toMatchObject({
      status: "empty",
    })
    expect({ events, reads }).toEqual({ events: 1, reads: 1 })
    expect(
      () =>
        new FormRequestExecutor({ fetch: async () => Promise.reject(new Error("unused")) }, {
          requestLifecycle: null,
        } as never),
    ).toThrow(PropsError)
  })

  test("re-admits lifecycle URL, method, header, and body mutation before transport", async () => {
    const lifecycle = new RequestLifecycle()
    const recentRequestIds = new RecentRequestIds()
    let fetched: TurboRequest | undefined
    lifecycle.subscribe("before-fetch-request", (event) => {
      expect(event.detail.context).toEqual({
        kind: "form",
        requestId: "request-mutated",
      })
      expect(recentRequestIds.has("request-mutated")).toBe(false)
      event.detail.request.setUrl("https://example.test/mutated")
      event.detail.request.setMethod("PUT")
      event.detail.request.setHeader("accept", `${TURBO_STREAM_MIME_TYPE}, ${EXPO_TURBO_MIME_TYPE}`)
      event.detail.request.setHeader("X-Form-Hook", "mutated")
      event.detail.request.setBody({
        contentType: "application/x-www-form-urlencoded;charset=UTF-8",
        value: "name=updated",
      })
    })
    const executor = new FormRequestExecutor(
      {
        fetch: async (request) => {
          fetched = request
          expect(recentRequestIds.has("request-mutated")).toBe(true)
          return response("", { headers: {}, status: 204, url: request.url })
        },
      },
      { recentRequestIds, requestLifecycle: lifecycle },
    )

    const result = await executor.execute(planFactory("request-mutated"))

    expect(fetched).toMatchObject({
      body: {
        contentType: "application/x-www-form-urlencoded;charset=UTF-8",
        value: "name=updated",
      },
      headers: { "X-Form-Hook": "mutated" },
      method: "PUT",
      url: "https://example.test/mutated",
    })
    expect(Object.isFrozen(fetched)).toBe(true)
    expect(result).toMatchObject({
      effectiveMethod: "GET",
      requestedUrl: "https://example.test/mutated",
      status: "empty",
      transportMethod: "PUT",
    })
  })

  test("reports a prevented lifecycle response without reading its body", async () => {
    const lifecycle = new RequestLifecycle()
    let reads = 0
    lifecycle.subscribe("before-fetch-response", (event) => {
      expect(event.detail.context).toEqual({
        kind: "form",
        requestId: "request-prevented",
      })
      expect(event.detail.response.status).toBe(200)
      event.preventDefault()
    })
    const executor = new FormRequestExecutor(
      {
        fetch: async (request) =>
          response("<Ignored />", {
            text: async () => {
              reads += 1
              return "<Ignored />"
            },
            url: request.url,
          }),
      },
      { requestLifecycle: lifecycle },
    )

    expect(await executor.execute(planFactory("request-prevented"))).toEqual({
      effectiveMethod: "GET",
      redirected: false,
      requestId: "request-prevented",
      requestedUrl: "https://example.test/current",
      responseStatus: 200,
      sourceMethod: "GET",
      status: "prevented",
      transportMethod: "GET",
      url: "https://example.test/current",
    })
    expect(reads).toBe(0)
  })

  test("keeps an unchanged large planner-admitted body neutral when lifecycle is enabled", async () => {
    const executor = new FormRequestExecutor(
      {
        fetch: async (request) => response("", { headers: {}, status: 204, url: request.url }),
      },
      { requestLifecycle: new RequestLifecycle() },
    )

    expect(
      await executor.execute(
        planFactory("request-large-unchanged", {
          entries: [{ name: "value", value: "x".repeat(1_048_576) }],
          form: { method: "POST" },
        }),
      ),
    ).toMatchObject({ status: "empty", transportMethod: "POST" })
  })

  test("forwards the exact immutable request and buffers a frozen XML candidate", async () => {
    let built: ReturnType<typeof buildFormRequest> | undefined
    let fetched: TurboRequest | undefined
    let reads = 0
    const recentRequestIds = new RecentRequestIds()
    const executor = new FormRequestExecutor(
      {
        async fetch(request) {
          fetched = request
          return response("<FormResult />", {
            redirected: true,
            status: 422,
            text: async () => {
              reads += 1
              return "<FormResult />"
            },
            url: "https://example.test/final",
          })
        },
      },
      { recentRequestIds },
    )

    const result = await executor.execute((signal) => {
      built = buildFormRequest({
        documentUrl: "https://example.test/current",
        entries: [{ name: "note", value: "hello" }],
        form: { action: "/orders?keep=1", method: "PATCH" },
        protocol: { frameId: "order-form", requestId: "request-patch" },
        signal,
      })
      return built
    })

    expect(fetched).toBe(built?.request)
    expect(recentRequestIds.has("request-patch")).toBe(true)
    expect(fetched).toMatchObject({
      body: {
        contentType: "application/x-www-form-urlencoded;charset=UTF-8",
        value: "note=hello&_method=patch",
      },
      method: "POST",
      url: "https://example.test/orders?keep=1",
    })
    expect(result).toEqual({
      body: "<FormResult />",
      classification: "client-error",
      contentType: EXPO_TURBO_MIME_TYPE,
      effectiveMethod: "PATCH",
      redirected: true,
      requestId: "request-patch",
      requestedUrl: "https://example.test/orders?keep=1",
      responseStatus: 422,
      sourceMethod: "PATCH",
      status: "xml",
      transportMethod: "POST",
      url: "https://example.test/final",
    })
    expect(reads).toBe(1)
    expect(Object.isFrozen(result)).toBe(true)
    expect(result).not.toHaveProperty("headers")
  })

  test("classifies XML and Stream candidates without applying their bodies", async () => {
    const fixtures = [
      { classification: "success", mime: EXPO_TURBO_MIME_TYPE, status: 200, type: "xml" },
      { classification: "success", mime: EXPO_TURBO_MIME_TYPE, status: 201, type: "xml" },
      {
        classification: "client-error",
        mime: EXPO_TURBO_MIME_TYPE,
        status: 422,
        type: "xml",
      },
      {
        classification: "server-error",
        mime: EXPO_TURBO_MIME_TYPE,
        status: 500,
        type: "xml",
      },
      { classification: "success", mime: TURBO_STREAM_MIME_TYPE, status: 200, type: "stream" },
      {
        classification: "client-error",
        mime: TURBO_STREAM_MIME_TYPE,
        status: 409,
        type: "stream",
      },
    ] as const

    for (const fixture of fixtures) {
      const executor = new FormRequestExecutor({
        fetch: async (request) =>
          response("<candidate />", {
            headers: { "content-type": `${fixture.mime}; charset=UTF-8` },
            status: fixture.status,
            url: request.url,
          }),
      })

      expect(
        await executor.execute(
          planFactory(
            `request-${fixture.status}-${fixture.type}`,
            fixture.type === "stream" ? { form: { streamAttributePresent: true } } : {},
          ),
        ),
      ).toMatchObject({
        body: "<candidate />",
        classification: fixture.classification,
        contentType: fixture.mime,
        responseStatus: fixture.status,
        status: fixture.type,
      })
    }
  })

  test("admits Stream responses only when the form request negotiated them", async () => {
    const executor = new FormRequestExecutor({
      fetch: async (request) =>
        response('<turbo-stream action="remove" target="old" />', {
          headers: { "Content-Type": TURBO_STREAM_MIME_TYPE },
          url: request.url,
        }),
    })

    await expect(executor.execute(planFactory("request-plain-get"))).rejects.toBeInstanceOf(
      ContentTypeError,
    )
    expect(
      await executor.execute(
        planFactory("request-opted-get", { form: { streamAttributePresent: true } }),
      ),
    ).toMatchObject({ status: "stream" })
    expect(
      await executor.execute(planFactory("request-unsafe", { form: { method: "POST" } })),
    ).toMatchObject({ status: "stream" })
  })

  test("reports 204 and blank 201 as empty without inventing response application", async () => {
    let reads = 0
    const executor = new FormRequestExecutor({
      fetch: async (request) =>
        request.url.endsWith("/no-content")
          ? response("unused", {
              headers: {},
              status: 204,
              text: async () => {
                reads += 1
                return "unused"
              },
              url: request.url,
            })
          : response("  \n", {
              headers: {},
              status: 201,
              text: async () => {
                reads += 1
                return "  \n"
              },
              url: request.url,
            }),
    })

    expect(
      await executor.execute(
        planFactory("request-204", { form: { action: "/no-content", method: "POST" } }),
      ),
    ).toMatchObject({ classification: "success", responseStatus: 204, status: "empty" })
    expect(reads).toBe(0)
    expect(
      await executor.execute(
        planFactory("request-201", { form: { action: "/created", method: "POST" } }),
      ),
    ).toMatchObject({ classification: "success", responseStatus: 201, status: "empty" })
    expect(reads).toBe(1)
  })

  test("requires supported MIME for every nonempty response, including 201", async () => {
    for (const fixture of [
      { headers: {}, status: 200 },
      { headers: { "Content-Type": "application/json" }, status: 200 },
      { headers: { "Content-Type": "text/html" }, status: 422 },
      { headers: {}, status: 201 },
    ]) {
      let reads = 0
      const executor = new FormRequestExecutor({
        fetch: async (request) =>
          response("not protocol XML", {
            ...fixture,
            text: async () => {
              reads += 1
              return "not protocol XML"
            },
            url: request.url,
          }),
      })

      await expect(
        executor.execute(planFactory(`request-mime-${fixture.status}`)),
      ).rejects.toBeInstanceOf(ContentTypeError)
      expect(reads).toBe(fixture.status === 201 ? 1 : 0)
    }
  })

  test("validates the final same-origin URL before reading the response body", async () => {
    for (const url of [
      "",
      "https://outside.test/result",
      "https://user:secret@example.test/result",
      "data:text/plain,result",
      "http://[",
    ]) {
      let reads = 0
      const executor = new FormRequestExecutor({
        fetch: async () =>
          response("<Result />", {
            text: async () => {
              reads += 1
              return "<Result />"
            },
            url,
          }),
      })

      try {
        await executor.execute(planFactory("request-final-url"))
        throw new Error("fixture unexpectedly succeeded")
      } catch (error) {
        expect(error).toBeInstanceOf(ExpoTurboError)
        expect(["request", "target"]).toContain((error as ExpoTurboError).code)
      }
      expect(reads).toBe(0)
    }
  })

  test("derives redirect metadata from a changed normalized final URL", async () => {
    const executor = new FormRequestExecutor({
      fetch: async () =>
        response("<Result />", {
          redirected: false,
          url: "https://example.test/final",
        }),
    })

    expect(await executor.execute(planFactory("request-redirect"))).toMatchObject({
      redirected: true,
      requestedUrl: "https://example.test/current",
      url: "https://example.test/final",
    })
  })

  test("rejects raw redirects and current transport failures, then remains reusable", async () => {
    let attempts = 0
    const executor = new FormRequestExecutor({
      async fetch(request) {
        attempts += 1
        if (attempts === 1) throw new Error("network details must stay private")
        if (attempts === 2) return response("redirect", { status: 303, url: request.url })
        if (attempts === 3) {
          return response("unused", {
            status: 500,
            text: async () => {
              throw new Error("body details must stay private")
            },
            url: request.url,
          })
        }
        return response("<Recovered />", { url: request.url })
      },
    })

    for (const id of ["request-network", "request-redirect", "request-body"]) {
      try {
        await executor.execute(planFactory(id, { form: { method: "DELETE" } }))
        throw new Error("fixture unexpectedly succeeded")
      } catch (error) {
        expect(error).toBeInstanceOf(RequestError)
        expect((error as RequestError).context.method).toBe("POST")
        expect((error as Error).message).not.toContain("details")
      }
    }
    expect(await executor.execute(planFactory("request-retry"))).toMatchObject({
      status: "xml",
    })
  })

  test("explicit cancellation aborts transport and reports a frozen canceled result", async () => {
    let request: TurboRequest | undefined
    const executor = new FormRequestExecutor({
      fetch: (value) => {
        request = value
        return new Promise((_resolve, reject) => {
          value.signal?.addEventListener("abort", () => reject(new Error("aborted")))
        })
      },
    })

    const execution = executor.execute(planFactory("request-cancel"))
    expect(request?.signal?.aborted).toBe(false)
    executor.cancel()

    const result = await execution
    expect(request?.signal?.aborted).toBe(true)
    expect(result).toEqual({
      effectiveMethod: "GET",
      requestId: "request-cancel",
      requestedUrl: "https://example.test/current",
      sourceMethod: "GET",
      status: "canceled",
      transportMethod: "GET",
      url: "https://example.test/current",
    })
    expect(Object.isFrozen(result)).toBe(true)
    executor.cancel()
  })

  test("a newer admitted plan suppresses a late response from the same executor lane", async () => {
    const firstResponse = deferred<TurboResponse>()
    const requests: TurboRequest[] = []
    const executor = new FormRequestExecutor({
      async fetch(request) {
        requests.push(request)
        if (requests.length === 1) return firstResponse.promise
        return response("<Second />", { url: request.url })
      },
    })

    const first = executor.execute(planFactory("request-first", { form: { action: "/first" } }))
    const second = executor.execute(planFactory("request-second", { form: { action: "/second" } }))
    expect(requests[0]?.signal?.aborted).toBe(true)
    expect(await second).toMatchObject({ requestId: "request-second", status: "xml" })

    firstResponse.resolve(response("<Late />", { url: "https://example.test/first" }))
    expect(await first).toMatchObject({ requestId: "request-first", status: "canceled" })
  })

  test("keeps reentrant newer work authoritative during supersession and explicit cancel", async () => {
    for (const trigger of ["supersede", "cancel"] as const) {
      const pending: Array<{
        request: TurboRequest
        response: ReturnType<typeof deferred<TurboResponse>>
      }> = []
      const executor = new FormRequestExecutor({
        fetch(request) {
          const next = deferred<TurboResponse>()
          pending.push({ request, response: next })
          return next.promise
        },
      })
      const first = executor.execute(planFactory(`${trigger}-first`))
      let nested: Promise<unknown> | undefined
      pending[0]?.request.signal?.addEventListener(
        "abort",
        () => {
          nested = executor.execute(planFactory(`${trigger}-nested`))
        },
        { once: true },
      )

      const outer =
        trigger === "supersede" ? executor.execute(planFactory("supersede-outer")) : undefined
      if (trigger === "cancel") executor.cancel()

      expect(pending).toHaveLength(2)
      expect(pending[1]?.request.headers["X-Turbo-Request-Id"]).toBe(`${trigger}-nested`)
      expect(pending[1]?.request.signal?.aborted).toBe(false)
      if (outer) expect(await outer).toMatchObject({ status: "canceled" })
      pending[1]?.response.resolve(response("<Nested />"))
      expect(await nested).toMatchObject({ requestId: `${trigger}-nested`, status: "xml" })
      pending[0]?.response.resolve(response("<First />"))
      expect(await first).toMatchObject({ requestId: `${trigger}-first`, status: "canceled" })
    }
  })

  test("cancellation during body buffering suppresses a late body resolve or rejection", async () => {
    for (const rejectBody of [false, true]) {
      const body = deferred<string>()
      const started = deferred<void>()
      let attempts = 0
      const executor = new FormRequestExecutor({
        async fetch(request) {
          attempts += 1
          if (attempts > 1) return response("<Second />", { url: request.url })
          return response("unused", {
            text: async () => {
              started.resolve()
              return body.promise
            },
            url: request.url,
          })
        },
      })

      const first = executor.execute(planFactory(`request-body-${rejectBody}`))
      await started.promise
      const second = executor.execute(planFactory(`request-new-${rejectBody}`))
      if (rejectBody) body.reject(new Error("late body failure"))
      else body.resolve("<Late />")

      expect(await first).toMatchObject({ status: "canceled" })
      expect(await second).toMatchObject({ status: "xml" })
    }
  })

  test("invalid newer planning does not cancel an active valid request", async () => {
    const firstResponse = deferred<TurboResponse>()
    let activeRequest: TurboRequest | undefined
    let fetches = 0
    const executor = new FormRequestExecutor({
      async fetch(request) {
        fetches += 1
        activeRequest = request
        return firstResponse.promise
      },
    })

    const first = executor.execute(planFactory("request-active"))
    await expect(
      executor.execute(() => {
        throw new Error("stale form")
      }),
    ).rejects.toBeInstanceOf(RequestError)
    expect(activeRequest?.signal?.aborted).toBe(false)

    await expect(
      executor.execute(() =>
        buildFormRequest({
          documentUrl: "https://example.test/current",
          entries: [],
          form: {},
          protocol: { requestId: "request-wrong-signal" },
          signal: new AbortController().signal,
        }),
      ),
    ).rejects.toBeInstanceOf(RequestError)
    expect(activeRequest?.signal?.aborted).toBe(false)
    expect(fetches).toBe(1)

    firstResponse.resolve(response("<Active />", { url: "https://example.test/current" }))
    expect(await first).toMatchObject({ requestId: "request-active", status: "xml" })
  })

  test("rejects frozen structural plan forgeries before fetch", async () => {
    let fetches = 0
    const executor = new FormRequestExecutor({
      fetch: async () => {
        fetches += 1
        return response("<Unsafe />")
      },
    })

    await expect(
      executor.execute((signal) => {
        const issued = buildFormRequest({
          documentUrl: "https://example.test/current",
          entries: [],
          form: {},
          protocol: { requestId: "request-forged" },
          signal,
        })
        return Object.freeze({
          ...issued,
          request: Object.freeze({
            ...issued.request,
            url: "https://attacker.invalid/collect",
          }),
        }) as FormRequestPlan
      }),
    ).rejects.toBeInstanceOf(RequestError)
    expect(fetches).toBe(0)
  })

  test("cancel settles even when fetch or body buffering ignores the abort signal", async () => {
    const fetchExecutor = new FormRequestExecutor({
      fetch: () => new Promise<TurboResponse>(() => {}),
    })
    const fetching = fetchExecutor.execute(planFactory("request-stuck-fetch"))
    fetchExecutor.cancel()
    expect(await fetching).toMatchObject({ status: "canceled" })

    const bodyStarted = deferred<void>()
    const bodyExecutor = new FormRequestExecutor({
      fetch: async (request) =>
        response("unused", {
          text: () => {
            bodyStarted.resolve()
            return new Promise<string>(() => {})
          },
          url: request.url,
        }),
    })
    const buffering = bodyExecutor.execute(planFactory("request-stuck-body"))
    await bodyStarted.promise
    bodyExecutor.cancel()
    expect(await buffering).toMatchObject({ status: "canceled" })
  })
})
