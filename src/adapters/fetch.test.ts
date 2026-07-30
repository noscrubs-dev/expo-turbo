import { afterEach, describe, expect, test } from "bun:test"

import { RequestError } from "../core/errors"
import { EXPO_TURBO_MIME_TYPE, TURBO_STREAM_MIME_TYPE } from "../core/protocol-request"
import { createDefaultFetchAdapter } from "./fetch"
import type { TurboRequest } from "./index"

const nativeFetch = globalThis.fetch
const nativeFormData = globalThis.FormData

afterEach(() => {
  globalThis.fetch = nativeFetch
  globalThis.FormData = nativeFormData
})

function response(status: number, body: string, url = "https://example.test/result"): Response {
  return {
    headers: new Headers({ "Content-Type": EXPO_TURBO_MIME_TYPE }),
    redirected: url !== "https://example.test/request",
    status,
    text: async () => body,
    url,
  } as Response
}

describe("createDefaultFetchAdapter", () => {
  test("sends credentials and protected protocol headers while returning XML error statuses", async () => {
    let input: RequestInfo | URL | undefined
    let init: RequestInit | undefined
    globalThis.fetch = (async (nextInput, nextInit) => {
      input = nextInput
      init = nextInit
      return response(422, "<Page><Text>Invalid</Text></Page>")
    }) as typeof fetch

    const adapter = createDefaultFetchAdapter({
      headers: {
        Accept: "text/plain",
        "X-App": "native",
      },
      onRequest(request) {
        expect(request).toEqual({
          headers: {
            accept: `${TURBO_STREAM_MIME_TYPE}, ${EXPO_TURBO_MIME_TYPE}`,
            "x-app": "native",
            "x-turbo-request-id": "request-1",
          },
          method: "POST",
          url: "https://example.test/request",
        })
        expect(Object.isFrozen(request)).toBe(true)
        return {
          Accept: "application/json",
          Authorization: "Bearer token",
        }
      },
    })
    const result = await adapter.fetch({
      body: {
        contentType: "application/x-www-form-urlencoded;charset=UTF-8",
        value: "name=Pat",
      },
      headers: {
        Accept: `${TURBO_STREAM_MIME_TYPE}, ${EXPO_TURBO_MIME_TYPE}`,
        "X-Turbo-Request-Id": "request-1",
      },
      method: "POST",
      url: "https://example.test/request",
    })

    expect(input).toBe("https://example.test/request")
    expect(init?.credentials).toBe("include")
    expect(init?.redirect).toBe("follow")
    expect(init?.method).toBe("POST")
    expect(init?.body).toBe("name=Pat")
    const headers = new Headers(init?.headers)
    expect(headers.get("Accept")).toBe(`${TURBO_STREAM_MIME_TYPE}, ${EXPO_TURBO_MIME_TYPE}`)
    expect(headers.get("Authorization")).toBe("Bearer token")
    expect(headers.get("Content-Type")).toBe("application/x-www-form-urlencoded;charset=UTF-8")
    expect(headers.get("X-App")).toBe("native")
    expect(headers.get("X-Turbo-Request-Id")).toBe("request-1")
    expect(result.status).toBe(422)
    expect(result.redirected).toBe(true)
    expect(await result.text()).toBe("<Page><Text>Invalid</Text></Page>")
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.headers)).toBe(true)
  })

  test("sets the default Accept header and leaves multipart boundaries to FormData", async () => {
    let init: RequestInit | undefined
    globalThis.fetch = (async (_input, nextInit) => {
      init = nextInit
      return response(500, "<Page><Text>Failed</Text></Page>")
    }) as typeof fetch

    const adapter = createDefaultFetchAdapter()
    const file = new Blob(["file body"], { type: "text/plain" })
    const result = await adapter.fetch({
      body: {
        value: {
          byteLength: 13,
          entries: [
            { name: "title", value: "Report" },
            { name: "attachment", value: { blob: file, filename: "report.txt" } },
          ],
          kind: "multipart",
        },
      },
      headers: {},
      method: "POST",
      url: "https://example.test/request",
    })

    const headers = new Headers(init?.headers)
    expect(headers.get("Accept")).toBe(EXPO_TURBO_MIME_TYPE)
    expect(headers.has("Content-Type")).toBe(false)
    expect(init?.body).toBeInstanceOf(FormData)
    const formData = init?.body as FormData
    expect(formData.get("title")).toBe("Report")
    expect(formData.get("attachment")).toBeInstanceOf(Blob)
    expect(result.status).toBe(500)
  })

  test("infers redirects when React Native omits response redirect metadata", async () => {
    globalThis.fetch = (async (_input, _init) => {
      const { redirected: _redirected, ...nativeResponse } = response(
        200,
        "<Page />",
        "https://example.test/final",
      )
      return nativeResponse as Response
    }) as typeof fetch

    const result = await createDefaultFetchAdapter().fetch({
      headers: {},
      method: "GET",
      url: "https://example.test/request",
    })

    expect(result.redirected).toBe(true)
  })

  test("maps URI-backed and in-memory files to React Native FormData", async () => {
    class ReactNativeFormData {
      readonly parts: [string, unknown][] = []

      append(name: string, value: unknown): void {
        this.parts.push([name, value])
      }

      getParts(): readonly [string, unknown][] {
        return this.parts
      }
    }
    globalThis.FormData = ReactNativeFormData as unknown as typeof FormData
    let body: unknown
    globalThis.fetch = (async (_input, init) => {
      body = init?.body
      return response(200, "<Page />", "https://example.test/request")
    }) as typeof fetch
    const adapter = createDefaultFetchAdapter()
    const request = (blob: Blob): TurboRequest => ({
      body: {
        value: {
          byteLength: blob.size,
          entries: [
            { name: "title", value: "Report" },
            { name: "attachment", value: { blob, filename: "report.txt" } },
          ],
          kind: "multipart",
        },
      },
      headers: {},
      method: "POST",
      url: "https://example.test/request",
    })
    const file = {
      size: 6,
      type: "text/plain",
      uri: "file:///cache/report.txt",
    } as Blob & Readonly<{ uri: string }>

    await adapter.fetch(request(file))

    expect(body).toBeInstanceOf(ReactNativeFormData)
    expect((body as ReactNativeFormData).parts).toEqual([
      ["title", "Report"],
      [
        "attachment",
        {
          name: "report.txt",
          type: "text/plain",
          uri: "file:///cache/report.txt",
        },
      ],
    ])
    const memoryBlob = new Blob(["repo"], { type: "text/plain" })
    await adapter.fetch(request(memoryBlob))
    expect((body as ReactNativeFormData).parts[1]).toEqual([
      "attachment",
      {
        name: "report.txt",
        type: memoryBlob.type,
        uri: `data:${memoryBlob.type};base64,cmVwbw==`,
      },
    ])
  })

  test("aborts a hung fetch at the configured timeout", async () => {
    let signal: AbortSignal | undefined
    globalThis.fetch = (async (_input, init) => {
      signal = init?.signal ?? undefined
      return await new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("native abort")), { once: true })
      })
    }) as typeof fetch

    const pending = createDefaultFetchAdapter({ timeoutMs: 5 }).fetch({
      headers: {},
      method: "GET",
      url: "https://example.test/request",
    })

    await expect(pending).rejects.toEqual(
      new RequestError("Default fetch request timed out", { method: "GET" }),
    )
    expect(signal?.aborted).toBe(true)
  })

  test("forwards owner aborts even when the native fetch does not settle", async () => {
    let signal: AbortSignal | undefined
    let notifyFetchStarted: (() => void) | undefined
    const fetchStarted = new Promise<void>((resolve) => {
      notifyFetchStarted = resolve
    })
    globalThis.fetch = (async (_input, init) => {
      signal = init?.signal ?? undefined
      notifyFetchStarted?.()
      return await new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("native abort")), { once: true })
      })
    }) as typeof fetch
    const owner = new AbortController()
    const request: TurboRequest = {
      headers: {},
      method: "GET",
      signal: owner.signal,
      url: "https://example.test/request",
    }

    const pending = createDefaultFetchAdapter().fetch(request)
    await fetchStarted
    owner.abort()

    await expect(pending).rejects.toEqual(
      new RequestError("Default fetch request was aborted", { method: "GET" }),
    )
    expect(signal?.aborted).toBe(true)
  })

  test("times out request preparation and prevents a late fetch", async () => {
    let fetchCalls = 0
    let releasePreparation: (() => void) | undefined
    globalThis.fetch = (async (_input, _init) => {
      fetchCalls += 1
      return response(200, "<Page />", "https://example.test/request")
    }) as typeof fetch
    const adapter = createDefaultFetchAdapter({
      onRequest: () =>
        new Promise((resolve) => {
          releasePreparation = () => resolve(undefined)
        }),
      timeoutMs: 5,
    })

    const pending = adapter.fetch({
      headers: {},
      method: "GET",
      url: "https://example.test/request",
    })

    await expect(pending).rejects.toEqual(
      new RequestError("Default fetch request timed out", { method: "GET" }),
    )
    releasePreparation?.()
    await Promise.resolve()
    await Promise.resolve()
    expect(fetchCalls).toBe(0)
  })

  test("aborts request preparation and prevents a late fetch", async () => {
    let fetchCalls = 0
    let releasePreparation: (() => void) | undefined
    globalThis.fetch = (async (_input, _init) => {
      fetchCalls += 1
      return response(200, "<Page />", "https://example.test/request")
    }) as typeof fetch
    const adapter = createDefaultFetchAdapter({
      onRequest: () =>
        new Promise((resolve) => {
          releasePreparation = () => resolve(undefined)
        }),
    })
    const owner = new AbortController()

    const pending = adapter.fetch({
      headers: {},
      method: "GET",
      signal: owner.signal,
      url: "https://example.test/request",
    })
    owner.abort()

    await expect(pending).rejects.toEqual(
      new RequestError("Default fetch request was aborted", { method: "GET" }),
    )
    releasePreparation?.()
    await Promise.resolve()
    await Promise.resolve()
    expect(fetchCalls).toBe(0)
  })

  test("times out a hung response body read", async () => {
    let signal: AbortSignal | undefined
    globalThis.fetch = (async (_input, init) => {
      signal = init?.signal ?? undefined
      return {
        ...response(200, ""),
        text: () =>
          new Promise<string>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(new Error("native abort")), {
              once: true,
            })
          }),
      } as Response
    }) as typeof fetch

    const result = await createDefaultFetchAdapter({ timeoutMs: 5 }).fetch({
      headers: {},
      method: "GET",
      url: "https://example.test/request",
    })

    await expect(result.text()).rejects.toEqual(
      new RequestError("Default fetch request timed out", { method: "GET" }),
    )
    expect(signal?.aborted).toBe(true)
  })

  test("validates setup and redacts request-hook failures", async () => {
    expect(() => createDefaultFetchAdapter({ timeoutMs: 0 })).toThrow(RequestError)
    expect(() => createDefaultFetchAdapter({ timeoutMs: Number.POSITIVE_INFINITY })).toThrow(
      RequestError,
    )

    const adapter = createDefaultFetchAdapter({
      onRequest() {
        throw new Error("private auth token")
      },
    })
    let error: unknown
    try {
      await adapter.fetch({
        headers: {},
        method: "GET",
        url: "https://example.test/private?token=secret",
      })
    } catch (caught) {
      error = caught
    }
    expect(error).toEqual(
      new RequestError("Default fetch request preparation failed", { method: "GET" }),
    )
    expect(String(error)).not.toContain("secret")
  })
})
