import { describe, expect, test } from "bun:test"

import type { TurboRequest, TurboResponse } from "../adapters"
import { RequestError } from "./errors"
import { CancellableEvent } from "./events"
import {
  fetchWithRequestLifecycle,
  RequestLifecycle,
  type RequestLifecycleAdmission,
  requestLifecycleDefaultHandlingPrevented,
} from "./request-lifecycle"

function request(url = "https://example.test/first", signal?: AbortSignal): TurboRequest {
  return Object.freeze({
    headers: Object.freeze({
      Accept: "application/vnd.expo-turbo+xml",
      "X-Turbo-Request-Id": "request-1",
    }),
    method: "GET",
    ...(signal ? { signal } : {}),
    url,
  })
}

function response(url = "https://example.test/result"): TurboResponse {
  return {
    headers: { "Content-Type": "application/vnd.expo-turbo+xml" },
    redirected: false,
    status: 200,
    text: async () => "<Page />",
    url,
  }
}

function deferred<T>() {
  let reject!: (error: unknown) => void
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle
    reject = fail
  })
  return { promise, reject, resolve }
}

function admission(overrides: Partial<RequestLifecycleAdmission> = {}): RequestLifecycleAdmission {
  return {
    admitUrl(url) {
      const parsed = new URL(url)
      if (
        parsed.origin !== "https://example.test" ||
        (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
        parsed.username ||
        parsed.password
      ) {
        throw new RequestError("Test lifecycle URL must stay same-origin")
      }
      return parsed.toString()
    },
    allowBody: false,
    allowedMethods: ["GET"],
    protectedHeaders: ["Accept", "X-Turbo-Request-Id"],
    ...overrides,
  }
}

describe("request lifecycle", () => {
  test("pauses only one request while another mutates and completes", async () => {
    const lifecycle = new RequestLifecycle()
    const fetched: TurboRequest[] = []
    let resumeFrame: () => void = () => undefined
    lifecycle.subscribe("before-fetch-request", (event) => {
      if (event.detail.context.kind === "frame") {
        event.pause()
        resumeFrame = () => event.resume()
        return
      }
      event.detail.request.setUrl("https://example.test/second")
      event.detail.request.setHeader("X-Trace", "document")
    })
    const fetchAdapter = {
      fetch: async (candidate: TurboRequest) => {
        fetched.push(candidate)
        return response(candidate.url)
      },
    }

    const frame = fetchWithRequestLifecycle({
      admission: admission(),
      context: {
        frameId: "details",
        kind: "frame",
        recurseDepth: 0,
        requestFrameId: "details",
        requestId: "request-1",
      },
      fetchAdapter,
      lifecycle,
      request: request(),
    })
    await Promise.resolve()
    const document = await fetchWithRequestLifecycle({
      admission: admission(),
      context: { kind: "document", purpose: "load", requestId: "request-1" },
      fetchAdapter,
      lifecycle,
      request: request(),
    })

    expect(document.status).toBe("response")
    expect(fetched).toHaveLength(1)
    expect(fetched[0]).toMatchObject({
      headers: { "X-Trace": "document" },
      url: "https://example.test/second",
    })

    resumeFrame()
    expect((await frame).status).toBe("response")
    expect(fetched).toHaveLength(2)
  })

  test("cancels before transport and prevents response handling", async () => {
    const canceledLifecycle = new RequestLifecycle()
    let fetches = 0
    canceledLifecycle.subscribe("before-fetch-request", (event) => event.preventDefault())

    const canceled = await fetchWithRequestLifecycle({
      admission: admission(),
      context: { kind: "document", purpose: "load", requestId: "request-1" },
      fetchAdapter: {
        fetch: async () => {
          fetches += 1
          return response()
        },
      },
      lifecycle: canceledLifecycle,
      request: request(),
    })

    expect(canceled.status).toBe("canceled")
    expect(fetches).toBe(0)

    const preventedLifecycle = new RequestLifecycle()
    preventedLifecycle.subscribe("before-fetch-response", (event) => event.preventDefault())
    const prevented = await fetchWithRequestLifecycle({
      admission: admission(),
      context: { kind: "document", purpose: "load", requestId: "request-1" },
      fetchAdapter: { fetch: async () => response() },
      lifecycle: preventedLifecycle,
      request: request(),
    })

    expect(prevented.status).toBe("prevented")
    if (prevented.status !== "prevented") throw new Error("expected prevented response")
    expect(Object.isFrozen(prevented.response)).toBe(true)
    expect(Object.isFrozen(prevented.response.headers)).toBe(true)
    expect(await prevented.response.text()).toBe("<Page />")
  })

  test("re-admits every mutation after listeners run", async () => {
    const attempts = [
      (lifecycle: RequestLifecycle) =>
        lifecycle.subscribe("before-fetch-request", (event) => {
          event.detail.request.setHeader("Accept", "application/json")
        }),
      (lifecycle: RequestLifecycle) =>
        lifecycle.subscribe("before-fetch-request", (event) => {
          event.detail.request.deleteHeader("X-Turbo-Request-Id")
        }),
      (lifecycle: RequestLifecycle) =>
        lifecycle.subscribe("before-fetch-request", (event) => {
          event.detail.request.setUrl("https://attacker.test/collect")
        }),
      (lifecycle: RequestLifecycle) =>
        lifecycle.subscribe("before-fetch-request", (event) => {
          event.detail.request.setMethod("POST")
        }),
      (lifecycle: RequestLifecycle) =>
        lifecycle.subscribe("before-fetch-request", (event) => {
          event.detail.request.setBody({ value: "secret=1" })
        }),
    ]

    for (const configure of attempts) {
      const lifecycle = new RequestLifecycle()
      configure(lifecycle)
      let fetches = 0
      await expect(
        fetchWithRequestLifecycle({
          admission: admission(),
          context: { kind: "document", purpose: "load", requestId: "request-1" },
          fetchAdapter: {
            fetch: async () => {
              fetches += 1
              return response()
            },
          },
          lifecycle,
          request: request(),
        }),
      ).rejects.toBeInstanceOf(RequestError)
      expect(fetches).toBe(0)
    }
  })

  test("dispatches redacted non-abort fetch errors and excludes aborted work", async () => {
    const lifecycle = new RequestLifecycle()
    const failures: RequestError[] = []
    lifecycle.subscribe("fetch-request-error", (event) => {
      expect(event).toBeInstanceOf(CancellableEvent)
      failures.push(event.detail.error)
    })

    await expect(
      fetchWithRequestLifecycle({
        admission: admission(),
        context: { kind: "document", purpose: "load", requestId: "request-1" },
        fetchAdapter: {
          fetch: async () => {
            throw new Error("secret transport detail")
          },
        },
        lifecycle,
        request: request(),
      }),
    ).rejects.toThrow("Fetch request failed")
    expect(failures).toHaveLength(1)
    expect(failures[0]?.message).toBe("Fetch request failed")
    expect(failures[0]?.cause).toBeUndefined()

    const controller = new AbortController()
    const aborted = fetchWithRequestLifecycle({
      admission: admission(),
      context: { kind: "document", purpose: "load", requestId: "request-1" },
      fetchAdapter: {
        fetch: async () => {
          controller.abort()
          throw new Error("aborted secret")
        },
      },
      lifecycle,
      request: request("https://example.test/abort", controller.signal),
    })

    expect((await aborted).status).toBe("canceled")
    expect(failures).toHaveLength(1)
  })

  test("lets fetch-error prevention suppress default handling without changing rejection", async () => {
    const lifecycle = new RequestLifecycle()
    lifecycle.subscribe("fetch-request-error", (event) => event.preventDefault())

    let rejected: unknown
    try {
      await fetchWithRequestLifecycle({
        admission: admission(),
        context: { kind: "document", purpose: "load", requestId: "request-1" },
        fetchAdapter: {
          fetch: async () => {
            throw new Error("secret transport detail")
          },
        },
        lifecycle,
        request: request(),
      })
    } catch (error) {
      rejected = error
    }

    expect(rejected).toBeInstanceOf(RequestError)
    expect((rejected as Error).message).toBe("Fetch request failed")
    expect(requestLifecycleDefaultHandlingPrevented(rejected)).toBe(true)
  })

  test("settles cancellation when transport and error listeners ignore abort", async () => {
    const lifecycle = new RequestLifecycle()
    const controller = new AbortController()
    const started = deferred<void>()
    const late = deferred<TurboResponse>()
    let failures = 0
    lifecycle.subscribe("fetch-request-error", () => {
      failures += 1
    })

    const pending = fetchWithRequestLifecycle({
      admission: admission(),
      context: { kind: "document", purpose: "load", requestId: "request-1" },
      fetchAdapter: {
        fetch: () => {
          started.resolve()
          return late.promise
        },
      },
      lifecycle,
      request: request("https://example.test/ignored-abort", controller.signal),
    })
    await started.promise
    controller.abort()

    expect(await pending).toEqual({
      request: expect.objectContaining({ url: "https://example.test/ignored-abort" }),
      status: "canceled",
    })
    late.reject(new Error("late secret"))
    await Promise.resolve()
    expect(failures).toBe(0)

    const errorController = new AbortController()
    const errorStarted = deferred<void>()
    const blockedErrors = new RequestLifecycle()
    blockedErrors.subscribe("fetch-request-error", () => {
      errorStarted.resolve()
      return new Promise(() => undefined)
    })
    const blocked = fetchWithRequestLifecycle({
      admission: admission(),
      context: { kind: "document", purpose: "load", requestId: "request-1" },
      fetchAdapter: {
        fetch: async () => {
          throw new Error("secret")
        },
      },
      lifecycle: blockedErrors,
      request: request("https://example.test/error-listener", errorController.signal),
    })
    await errorStarted.promise
    errorController.abort()
    expect((await blocked).status).toBe("canceled")
  })

  test("does not dispatch a pre-aborted request", async () => {
    const lifecycle = new RequestLifecycle()
    const controller = new AbortController()
    let events = 0
    let fetches = 0
    lifecycle.subscribe("before-fetch-request", () => {
      events += 1
    })
    controller.abort()

    expect(
      (
        await fetchWithRequestLifecycle({
          admission: admission(),
          context: { kind: "document", purpose: "load", requestId: "request-1" },
          fetchAdapter: {
            fetch: async () => {
              fetches += 1
              return response()
            },
          },
          lifecycle,
          request: request("https://example.test/pre-aborted", controller.signal),
        })
      ).status,
    ).toBe("canceled")
    expect(events).toBe(0)
    expect(fetches).toBe(0)
  })

  test("redacts listener failures and keeps listener snapshots stable", async () => {
    const lifecycle = new RequestLifecycle()
    const calls: string[] = []
    const late = () => calls.push("late")
    let removeSecond: () => void = () => undefined
    lifecycle.subscribe("before-fetch-request", () => {
      calls.push("first")
      removeSecond()
      lifecycle.subscribe("before-fetch-request", late)
    })
    removeSecond = lifecycle.subscribe("before-fetch-request", () => calls.push("second"))

    const options = {
      admission: admission(),
      context: { kind: "document", purpose: "load", requestId: "request-1" } as const,
      fetchAdapter: { fetch: async () => response() },
      lifecycle,
      request: request(),
    }
    await fetchWithRequestLifecycle(options)
    expect(calls).toEqual(["first", "second"])
    calls.length = 0
    await fetchWithRequestLifecycle(options)
    expect(calls).toEqual(["first", "late"])

    const failing = new RequestLifecycle()
    failing.subscribe("before-fetch-request", () => {
      throw new Error("secret listener failure")
    })
    await expect(fetchWithRequestLifecycle({ ...options, lifecycle: failing })).rejects.toThrow(
      "Before-fetch-request listener failed",
    )
  })
})
