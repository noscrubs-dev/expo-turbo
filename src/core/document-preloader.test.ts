import { describe, expect, test } from "bun:test"

import type { TurboRequest, TurboResponse } from "../adapters"
import { DocumentPrefetchCache } from "./document-prefetch-cache"
import { DocumentPreloader } from "./document-preloader"
import { DocumentSnapshotCache } from "./document-snapshot-cache"
import { ContentTypeError, ParseError, PropsError, RequestError, TargetError } from "./errors"
import { parseExpoTurboDocument } from "./parser"
import { EXPO_TURBO_MIME_TYPE } from "./protocol-request"
import { RequestLifecycle } from "./request-lifecycle"
import { DocumentSession } from "./session"
import { attributeValue } from "./tree"

function session(): DocumentSession {
  return new DocumentSession(
    parseExpoTurboDocument(
      '<Gallery data-turbo-root="/app"><Current id="current" data-label="active" /></Gallery>',
      { url: "https://example.test/app/current" },
    ),
  )
}

function response(xml: string, url: string, options: Partial<TurboResponse> = {}): TurboResponse {
  return {
    headers: { "Content-Type": `${EXPO_TURBO_MIME_TYPE}; charset=utf-8` },
    redirected: false,
    status: 200,
    text: async () => xml,
    url,
    ...options,
  }
}

function requestIds() {
  let count = 0
  return {
    get count() {
      return count
    },
    next() {
      count += 1
      return `preload-${count}`
    },
  }
}

function deferred<T>() {
  let resolve: ((value: T) => void) | undefined
  let reject: ((error: unknown) => void) | undefined
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle
    reject = fail
  })
  return {
    promise,
    reject(error: unknown) {
      if (!reject) throw new Error("deferred fixture was not initialized")
      reject(error)
    },
    resolve(value: T) {
      if (!resolve) throw new Error("deferred fixture was not initialized")
      resolve(value)
    },
  }
}

describe("document preloader", () => {
  test("emits one lifecycle for a physical preload and none for its cache hit", async () => {
    const cache = new DocumentSnapshotCache()
    const lifecycle = new RequestLifecycle()
    const contexts: unknown[] = []
    const requests: TurboRequest[] = []
    lifecycle.subscribe("before-fetch-request", (event) => {
      contexts.push(event.detail.context)
      event.detail.request.setHeader("X-Preload-Hook", "admitted")
    })
    const preloader = new DocumentPreloader(
      session(),
      {
        fetch: async (request) => {
          requests.push(request)
          return response('<Gallery><Preloaded id="preloaded" /></Gallery>', request.url)
        },
      },
      requestIds(),
      cache,
      { requestLifecycle: lifecycle },
    )

    expect(await preloader.preload("/app/lifecycle")).toMatchObject({ status: "cached" })
    expect(await preloader.preload("/app/lifecycle")).toEqual({
      status: "hit",
      url: "https://example.test/app/lifecycle",
    })
    expect(contexts).toEqual([{ kind: "document", purpose: "preload", requestId: "preload-1" }])
    expect(requests).toHaveLength(1)
    expect(requests[0]?.headers["X-Preload-Hook"]).toBe("admitted")
  })

  test("does not read or cache a lifecycle-prevented preload response", async () => {
    const cache = new DocumentSnapshotCache()
    const lifecycle = new RequestLifecycle()
    let reads = 0
    lifecycle.subscribe("before-fetch-response", (event) => event.preventDefault())
    const preloader = new DocumentPreloader(
      session(),
      {
        fetch: async (request) =>
          response('<Gallery><Ignored id="ignored" /></Gallery>', request.url, {
            text: async () => {
              reads += 1
              return '<Gallery><Ignored id="ignored" /></Gallery>'
            },
          }),
      },
      requestIds(),
      cache,
      { requestLifecycle: lifecycle },
    )

    expect(await preloader.preload("/app/prevented")).toEqual({
      requestId: "preload-1",
      responseStatus: 200,
      status: "prevented",
      url: "https://example.test/app/prevented",
    })
    expect(reads).toBe(0)
    expect(cache.size).toBe(0)
  })

  test("preloads a safe full document into the shared snapshot cache without owning navigation", async () => {
    const activeSession = session()
    const activeTree = activeSession.tree
    const cache = new DocumentSnapshotCache()
    const ids = requestIds()
    const requests: TurboRequest[] = []
    const preloader = new DocumentPreloader(
      activeSession,
      {
        async fetch(request) {
          requests.push(request)
          return response(
            '<Gallery><Loaded id="loaded" data-label="cached" /><DemoCard id="temporary" data-turbo-temporary="" /></Gallery>',
            request.url,
          )
        },
      },
      ids,
      cache,
      { capabilityHash: "sha256:capabilities" },
    )

    const report = await preloader.preload("./next?filter=active")

    expect(report).toEqual({
      requestId: "preload-1",
      responseStatus: 200,
      status: "cached",
      url: "https://example.test/app/next?filter=active",
    })
    expect(Object.isFrozen(report)).toBe(true)
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      headers: {
        Accept: EXPO_TURBO_MIME_TYPE,
        "X-Expo-Turbo-Capabilities": "sha256:capabilities",
        "X-Expo-Turbo-Protocol": "0.1",
        "X-Expo-Turbo-Runtime": "0.1.0",
        "X-Sec-Purpose": "prefetch",
        "X-Turbo-Request-Id": "preload-1",
      },
      method: "GET",
      url: "https://example.test/app/next?filter=active",
    })
    expect(Object.isFrozen(requests[0])).toBe(true)
    expect(Object.isFrozen(requests[0]?.headers)).toBe(true)
    expect(requests[0]?.signal?.aborted).toBe(false)
    expect(requests[0]).not.toHaveProperty("body")
    expect(activeSession.tree).toBe(activeTree)
    expect(activeSession.revision).toBe(0)
    expect(activeSession.recentRequestIds.has("preload-1")).toBe(false)
    expect(activeSession.tree.getElementById("loaded")).toBeUndefined()

    const cached = cache.get("https://example.test/app/next?filter=active")
    expect(cached?.getElementById("loaded")).toBeDefined()
    expect(cached?.getElementById("temporary")).toBeUndefined()
    const loaded = cached?.getElementById("loaded")
    if (!loaded) throw new Error("preload fixture was not cached")
    cached?.setAttribute(loaded, "data-label", "mutated")
    const retained = cache
      .get("https://example.test/app/next?filter=active")
      ?.getElementById("loaded")
    expect(retained ? attributeValue(retained, "data-label") : undefined).toBe("cached")

    const hit = await preloader.preload("/app/next?filter=active")
    expect(hit).toEqual({ status: "hit", url: "https://example.test/app/next?filter=active" })
    expect(Object.isFrozen(hit)).toBe(true)
    expect(ids.count).toBe(1)
    expect(requests).toHaveLength(1)
  })

  test("caches same-origin redirected preloads only under their original request URLs", async () => {
    for (const fixture of [
      {
        finalUrl: "https://example.test/app/redirected-final",
        redirected: true,
        source: "/app/redirected",
      },
      {
        finalUrl: "https://example.test/app/redirected-flagless-final",
        redirected: false,
        source: "/app/redirected-flagless",
      },
    ] as const) {
      const cache = new DocumentSnapshotCache()
      const ids = requestIds()
      const preloader = new DocumentPreloader(
        session(),
        {
          fetch: async () =>
            response('<Gallery><Preloaded id="preloaded" /></Gallery>', fixture.finalUrl, {
              redirected: fixture.redirected,
            }),
        },
        ids,
        cache,
      )
      const requestUrl = `https://example.test${fixture.source}`

      expect(await preloader.preload(fixture.source)).toEqual({
        requestId: "preload-1",
        responseStatus: 200,
        status: "cached",
        url: requestUrl,
      })
      expect(cache.has(requestUrl)).toBe(true)
      expect(cache.has(fixture.finalUrl)).toBe(false)
      expect(cache.get(requestUrl)?.document.url).toBe(requestUrl)
      expect(await preloader.preload(fixture.source)).toEqual({
        status: "hit",
        url: requestUrl,
      })
      expect(ids.count).toBe(1)
    }
  })

  test("reports a successful no-cache response without retaining a snapshot", async () => {
    const cache = new DocumentSnapshotCache()
    const preloader = new DocumentPreloader(
      session(),
      {
        fetch: async (request) =>
          response('<Gallery data-turbo-cache-control="no-cache"><Fresh /></Gallery>', request.url),
      },
      requestIds(),
      cache,
    )

    await expect(preloader.preload("/app/uncached")).resolves.toEqual({
      requestId: "preload-1",
      responseStatus: 200,
      status: "not-cacheable",
      url: "https://example.test/app/uncached",
    })
    expect(cache.has("https://example.test/app/uncached")).toBe(false)
  })

  test("rejects unsafe locations before allocating a request ID", async () => {
    const ids = requestIds()
    let fetches = 0
    const preloader = new DocumentPreloader(
      session(),
      {
        async fetch() {
          fetches += 1
          throw new Error("unsafe preload fetched")
        },
      },
      ids,
      new DocumentSnapshotCache(),
    )

    for (const source of [
      "",
      "/app/\tcontrol",
      "https://other.test/app/next",
      "/outside",
      "/app/export.csv",
      "/app/next#",
      "/app/next#anchor",
    ]) {
      await expect(preloader.preload(source)).rejects.toBeInstanceOf(TargetError)
    }
    expect(ids.count).toBe(0)
    expect(fetches).toBe(0)
  })

  test("deduplicates an in-flight URL and cancels every waiter without caching", async () => {
    const pending = deferred<TurboResponse>()
    const requests: TurboRequest[] = []
    const ids = requestIds()
    const cache = new DocumentSnapshotCache()
    const preloader = new DocumentPreloader(
      session(),
      {
        fetch(request) {
          requests.push(request)
          return pending.promise
        },
      },
      ids,
      cache,
    )

    const first = preloader.preload("/app/pending")
    const second = preloader.preload("./pending")
    expect(second).toBe(first)
    await Promise.resolve()
    expect(requests).toHaveLength(1)
    expect(ids.count).toBe(1)
    expect(preloader.cancel("/app/pending")).toBe(true)
    expect(requests[0]?.signal?.aborted).toBe(true)
    expect(preloader.cancel("/app/pending")).toBe(false)
    pending.resolve(response("<Gallery><Late /></Gallery>", "https://example.test/app/pending"))

    await expect(first).resolves.toEqual({
      requestId: "preload-1",
      status: "canceled",
      url: "https://example.test/app/pending",
    })
    await expect(second).resolves.toEqual({
      requestId: "preload-1",
      status: "canceled",
      url: "https://example.test/app/pending",
    })
    expect(cache.has("https://example.test/app/pending")).toBe(false)
  })

  test("publishes an active URL before invoking a reentrant fetch adapter", async () => {
    let reentered: Promise<unknown> | undefined
    let fetches = 0
    let preloader: DocumentPreloader
    preloader = new DocumentPreloader(
      session(),
      {
        fetch(request) {
          fetches += 1
          reentered = preloader.preload("./reentrant")
          return Promise.resolve(response("<Gallery><Loaded /></Gallery>", request.url))
        },
      },
      requestIds(),
      new DocumentSnapshotCache(),
    )

    const first = preloader.preload("/app/reentrant")
    await Promise.resolve()

    expect(reentered).toBe(first)
    expect(fetches).toBe(1)
    await expect(first).resolves.toMatchObject({
      requestId: "preload-1",
      status: "cached",
    })
  })

  test("publishes an active URL before invoking a reentrant request-ID adapter", async () => {
    let reentered: Promise<unknown> | undefined
    let ids = 0
    let fetches = 0
    let preloader: DocumentPreloader
    preloader = new DocumentPreloader(
      session(),
      {
        fetch(request) {
          fetches += 1
          return Promise.resolve(response("<Gallery><Loaded /></Gallery>", request.url))
        },
      },
      {
        next() {
          ids += 1
          reentered = preloader.preload("./request-id")
          return `preload-${ids}`
        },
      },
      new DocumentSnapshotCache(),
    )

    const first = preloader.preload("/app/request-id")
    await Promise.resolve()

    expect(reentered).toBe(first)
    expect(ids).toBe(1)
    expect(fetches).toBe(1)
    await expect(first).resolves.toMatchObject({
      requestId: "preload-1",
      status: "cached",
    })
  })

  test("cancels a reserved URL before allocating an ID or invoking fetch", async () => {
    const ids = requestIds()
    let fetches = 0
    const preloader = new DocumentPreloader(
      session(),
      {
        async fetch() {
          fetches += 1
          throw new Error("reserved preload fetched")
        },
      },
      ids,
      new DocumentSnapshotCache(),
    )

    const pending = preloader.preload("/app/reserved")
    expect(preloader.cancel("/app/reserved")).toBe(true)

    await expect(pending).resolves.toEqual({
      status: "canceled",
      url: "https://example.test/app/reserved",
    })
    expect(ids.count).toBe(0)
    expect(fetches).toBe(0)
  })

  test("releases a retained preload before allocating an ID or invoking fetch", async () => {
    const ids = requestIds()
    let fetches = 0
    const preloader = new DocumentPreloader(
      session(),
      {
        async fetch() {
          fetches += 1
          throw new Error("released preload fetched")
        },
      },
      ids,
      new DocumentSnapshotCache(),
    )

    const lease = preloader.retain("/app/released")
    lease.release()

    await expect(lease.promise).resolves.toEqual({
      status: "canceled",
      url: "https://example.test/app/released",
    })
    expect(ids.count).toBe(0)
    expect(fetches).toBe(0)
  })

  test("shares retained work until the final uncommitted lease releases", async () => {
    const pending = deferred<TurboResponse>()
    const requests: TurboRequest[] = []
    const cache = new DocumentSnapshotCache()
    const preloader = new DocumentPreloader(
      session(),
      {
        fetch(request) {
          requests.push(request)
          return pending.promise
        },
      },
      requestIds(),
      cache,
    )

    const first = preloader.retain("/app/shared-retain")
    const second = preloader.retain("./shared-retain")
    expect(second.promise).toBe(first.promise)
    await Promise.resolve()
    expect(requests).toHaveLength(1)

    first.release()
    expect(requests[0]?.signal?.aborted).toBe(false)
    second.release()
    expect(requests[0]?.signal?.aborted).toBe(true)
    pending.resolve(
      response("<Gallery><Late /></Gallery>", "https://example.test/app/shared-retain"),
    )

    await expect(first.promise).resolves.toEqual({
      requestId: "preload-1",
      status: "canceled",
      url: "https://example.test/app/shared-retain",
    })
    await expect(second.promise).resolves.toEqual({
      requestId: "preload-1",
      status: "canceled",
      url: "https://example.test/app/shared-retain",
    })
    expect(cache.has("https://example.test/app/shared-retain")).toBe(false)
  })

  test("promotes retained work through a commit or direct preload", async () => {
    const pending: Array<ReturnType<typeof deferred<TurboResponse>>> = []
    const requests: TurboRequest[] = []
    const preloader = new DocumentPreloader(
      session(),
      {
        fetch(request) {
          requests.push(request)
          const next = deferred<TurboResponse>()
          pending.push(next)
          return next.promise
        },
      },
      requestIds(),
      new DocumentSnapshotCache(),
    )

    const committed = preloader.retain("/app/committed-retain")
    await Promise.resolve()
    committed.commit()
    committed.release()
    expect(requests[0]?.signal?.aborted).toBe(false)
    pending[0]?.resolve(
      response("<Gallery><Committed /></Gallery>", "https://example.test/app/committed-retain"),
    )
    await expect(committed.promise).resolves.toMatchObject({ status: "cached" })

    const joined = preloader.retain("/app/direct-join")
    await Promise.resolve()
    const direct = preloader.preload("./direct-join")
    expect(direct).toBe(joined.promise)
    joined.release()
    expect(requests[1]?.signal?.aborted).toBe(false)
    pending[1]?.resolve(
      response("<Gallery><Direct /></Gallery>", "https://example.test/app/direct-join"),
    )
    await expect(joined.promise).resolves.toMatchObject({ status: "cached" })
  })

  test("hands a committed retained response to the one-shot prefetch cache", async () => {
    const pending = deferred<TurboResponse>()
    const snapshotCache = new DocumentSnapshotCache()
    const prefetchCache = new DocumentPrefetchCache()
    const preloader = new DocumentPreloader(
      session(),
      { fetch: () => pending.promise },
      requestIds(),
      snapshotCache,
      { prefetchCache },
    )

    const lease = preloader.retain("/app/next")
    await Promise.resolve()
    lease.commit()
    const prefetched = prefetchCache.take("https://example.test/app/next")
    expect(prefetched).toBeDefined()
    pending.resolve(
      response('<Gallery><Next id="next" /></Gallery>', "https://example.test/app/next"),
    )

    await expect(lease.promise).resolves.toMatchObject({ status: "cached" })
    expect(await prefetched?.promise).toEqual({
      body: '<Gallery><Next id="next" /></Gallery>',
      contentType: EXPO_TURBO_MIME_TYPE,
      redirected: false,
      requestId: "preload-1",
      responseStatus: 200,
      url: "https://example.test/app/next",
    })
    expect(snapshotCache.has("https://example.test/app/next")).toBe(false)
  })

  test("retains an authoritative error response for activation without treating it as a marker snapshot", async () => {
    const pending = deferred<TurboResponse>()
    const snapshotCache = new DocumentSnapshotCache()
    const prefetchCache = new DocumentPrefetchCache()
    const preloader = new DocumentPreloader(
      session(),
      { fetch: () => pending.promise },
      requestIds(),
      snapshotCache,
      { prefetchCache },
    )

    const lease = preloader.retain("/app/invalid")
    await Promise.resolve()
    lease.commit()
    const prefetched = prefetchCache.take("https://example.test/app/invalid")
    pending.resolve(
      response(
        '<Gallery><ValidationError id="validation-error" /></Gallery>',
        "https://example.test/app/invalid",
        { status: 422 },
      ),
    )

    await expect(lease.promise).rejects.toBeInstanceOf(RequestError)
    await expect(lease.activationPromise).resolves.toEqual({
      requestId: "preload-1",
      responseStatus: 422,
      status: "prefetched",
      url: "https://example.test/app/invalid",
    })
    expect(await prefetched?.promise).toEqual({
      body: '<Gallery><ValidationError id="validation-error" /></Gallery>',
      contentType: EXPO_TURBO_MIME_TYPE,
      redirected: false,
      requestId: "preload-1",
      responseStatus: 422,
      url: "https://example.test/app/invalid",
    })
    expect(snapshotCache.has("https://example.test/app/invalid")).toBe(false)
  })

  test("settles activation-facing leases for captured responses and rejects uncaptured failures", async () => {
    const captured = [
      response("<Gallery />", "https://example.test/app/status", { status: 503 }),
      response("<Gallery />", "https://example.test/app/mime", {
        headers: { "Content-Type": "application/json" },
      }),
      response(" \n ", "https://example.test/app/empty"),
      response("<Gallery>", "https://example.test/app/malformed"),
    ]

    for (const fixture of captured) {
      const preloader = new DocumentPreloader(
        session(),
        { fetch: async () => fixture },
        requestIds(),
        new DocumentSnapshotCache(),
        { prefetchCache: new DocumentPrefetchCache() },
      )
      const lease = preloader.retain(new URL(fixture.url).pathname)

      await expect(lease.promise).rejects.toBeInstanceOf(Error)
      await expect(lease.activationPromise).resolves.toEqual({
        requestId: "preload-1",
        responseStatus: fixture.status,
        status: "prefetched",
        url: fixture.url,
      })
    }

    const preloader = new DocumentPreloader(
      session(),
      {
        fetch: async () => response("<Gallery />", "https://other.test/app/cross-origin"),
      },
      requestIds(),
      new DocumentSnapshotCache(),
      { prefetchCache: new DocumentPrefetchCache() },
    )
    const lease = preloader.retain("/app/cross-origin")

    const outcomes = await Promise.allSettled([lease.promise, lease.activationPromise])
    expect(outcomes).toEqual([
      { reason: expect.any(TargetError), status: "rejected" },
      { reason: expect.any(TargetError), status: "rejected" },
    ])
  })

  test("does not let a released lease cancel a reentrant retry", async () => {
    const pending: Array<ReturnType<typeof deferred<TurboResponse>>> = []
    const requests: TurboRequest[] = []
    let retry: Promise<unknown> | undefined
    let preloader: DocumentPreloader
    preloader = new DocumentPreloader(
      session(),
      {
        fetch(request) {
          requests.push(request)
          const next = deferred<TurboResponse>()
          pending.push(next)
          if (pending.length === 1) {
            request.signal?.addEventListener("abort", () => {
              retry = preloader.preload("./retained-retry")
            })
          }
          return next.promise
        },
      },
      requestIds(),
      new DocumentSnapshotCache(),
    )

    const lease = preloader.retain("/app/retained-retry")
    await Promise.resolve()
    lease.release()
    await Promise.resolve()

    expect(requests).toHaveLength(2)
    expect(requests[1]?.signal?.aborted).toBe(false)
    lease.release()
    expect(requests[1]?.signal?.aborted).toBe(false)
    pending[0]?.resolve(
      response("<Gallery><Late /></Gallery>", "https://example.test/app/retained-retry"),
    )
    pending[1]?.resolve(
      response("<Gallery><Retried /></Gallery>", "https://example.test/app/retained-retry"),
    )

    await expect(lease.promise).resolves.toMatchObject({ status: "canceled" })
    await expect(retry).resolves.toMatchObject({ requestId: "preload-2", status: "cached" })
  })

  test("gives cancellation precedence over reentrant cache lookup and request-ID failures", async () => {
    const hitUrl = "https://example.test/app/cache-hit"
    const hitCache = new DocumentSnapshotCache()
    hitCache.put(hitUrl, parseExpoTurboDocument("<Gallery><Cached /></Gallery>", { url: hitUrl }))
    const originalHas = hitCache.has.bind(hitCache)
    let hitCancellation: boolean | undefined
    let hitPreloader: DocumentPreloader
    hitCache.has = (url) => {
      const present = originalHas(url)
      hitCancellation = hitPreloader.cancel(url)
      return present
    }
    hitPreloader = new DocumentPreloader(
      session(),
      { fetch: async () => Promise.reject(new Error("cache hit fetched")) },
      requestIds(),
      hitCache,
    )

    await expect(hitPreloader.preload("/app/cache-hit")).resolves.toEqual({
      status: "canceled",
      url: hitUrl,
    })
    expect(hitCancellation).toBe(true)

    const lookupCache = new DocumentSnapshotCache()
    let lookupCancellation: boolean | undefined
    let lookupPreloader: DocumentPreloader
    lookupCache.has = (url) => {
      lookupCancellation = lookupPreloader.cancel(url)
      throw new RequestError("private cache lookup secret")
    }
    lookupPreloader = new DocumentPreloader(
      session(),
      { fetch: async () => Promise.reject(new Error("cache lookup fetched")) },
      requestIds(),
      lookupCache,
    )

    await expect(lookupPreloader.preload("/app/cache-error")).resolves.toEqual({
      status: "canceled",
      url: "https://example.test/app/cache-error",
    })
    expect(lookupCancellation).toBe(true)

    let requestIdCancellation: boolean | undefined
    let requestIdPreloader: DocumentPreloader
    requestIdPreloader = new DocumentPreloader(
      session(),
      { fetch: async () => Promise.reject(new Error("request-ID cancellation fetched")) },
      {
        next() {
          requestIdCancellation = requestIdPreloader.cancel("/app/request-id-cancel")
          throw new RequestError("private request-ID cancellation secret")
        },
      },
      new DocumentSnapshotCache(),
    )

    await expect(requestIdPreloader.preload("/app/request-id-cancel")).resolves.toEqual({
      status: "canceled",
      url: "https://example.test/app/request-id-cancel",
    })
    expect(requestIdCancellation).toBe(true)
  })

  test("protects the final cache write before invoking a reentrant cache adapter", async () => {
    const cache = new DocumentSnapshotCache()
    const originalPut = cache.put.bind(cache)
    let cancelResult: boolean | undefined
    let signalDuringCommit: AbortSignal | undefined
    let preloader: DocumentPreloader
    cache.put = (url, tree) => {
      preloader.cancelAll()
      cancelResult = preloader.cancel(url)
      expect(signalDuringCommit?.aborted).toBe(false)
      originalPut(url, tree)
    }
    preloader = new DocumentPreloader(
      session(),
      {
        async fetch(request) {
          signalDuringCommit = request.signal
          return response('<Gallery><Committed id="committed" /></Gallery>', request.url)
        },
      },
      requestIds(),
      cache,
    )

    await expect(preloader.preload("/app/commit")).resolves.toEqual({
      requestId: "preload-1",
      responseStatus: 200,
      status: "cached",
      url: "https://example.test/app/commit",
    })
    expect(cancelResult).toBe(false)
    expect(signalDuringCommit?.aborted).toBe(false)
    expect(cache.get("https://example.test/app/commit")?.getElementById("committed")).toBeDefined()
  })

  test("cancels every active URL while allowing later retry", async () => {
    const pending: Array<ReturnType<typeof deferred<TurboResponse>>> = []
    const cache = new DocumentSnapshotCache()
    const preloader = new DocumentPreloader(
      session(),
      {
        fetch(request) {
          const next = deferred<TurboResponse>()
          pending.push(next)
          if (pending.length === 3) {
            next.resolve(response("<Gallery><Retried /></Gallery>", request.url))
          }
          return next.promise
        },
      },
      requestIds(),
      cache,
    )

    const first = preloader.preload("/app/one")
    const second = preloader.preload("/app/two")
    await Promise.resolve()
    preloader.cancelAll()
    await expect(first).resolves.toMatchObject({ status: "canceled" })
    await expect(second).resolves.toMatchObject({ status: "canceled" })
    pending[0]?.resolve(response("<Gallery><One /></Gallery>", "https://example.test/app/one"))
    pending[1]?.resolve(response("<Gallery><Two /></Gallery>", "https://example.test/app/two"))

    await expect(preloader.preload("/app/one")).resolves.toMatchObject({
      requestId: "preload-3",
      status: "cached",
    })
    expect(cache.has("https://example.test/app/one")).toBe(true)
  })

  test("keeps a newer shared snapshot when an older preload settles", async () => {
    const pending = deferred<TurboResponse>()
    const cache = new DocumentSnapshotCache()
    const preloader = new DocumentPreloader(
      session(),
      { fetch: () => pending.promise },
      requestIds(),
      cache,
    )

    const first = preloader.preload("/app/shared")
    await Promise.resolve()
    cache.put(
      "https://example.test/app/shared",
      parseExpoTurboDocument('<Gallery><Fresh id="fresh" /></Gallery>', {
        url: "https://example.test/app/shared",
      }),
    )
    const second = preloader.preload("./shared")
    expect(second).toBe(first)

    pending.resolve(
      response('<Gallery><Stale id="stale" /></Gallery>', "https://example.test/app/shared"),
    )
    await expect(first).resolves.toEqual({
      requestId: "preload-1",
      responseStatus: 200,
      status: "superseded",
      url: "https://example.test/app/shared",
    })
    expect(cache.get("https://example.test/app/shared")?.getElementById("fresh")).toBeDefined()
    expect(cache.get("https://example.test/app/shared")?.getElementById("stale")).toBeUndefined()
  })

  test("preserves fresh work started reentrantly by exact and all-request cancellation", async () => {
    const pending = deferred<TurboResponse>()
    const cache = new DocumentSnapshotCache()
    let exactRetry: Promise<unknown> | undefined
    let cancelAllRetry: Promise<unknown> | undefined
    let fetches = 0
    let preloader: DocumentPreloader
    preloader = new DocumentPreloader(
      session(),
      {
        fetch(request) {
          fetches += 1
          if (fetches === 1) {
            request.signal?.addEventListener(
              "abort",
              () => {
                exactRetry = preloader.preload("/app/exact")
              },
              { once: true },
            )
            return pending.promise
          }
          if (fetches === 3) {
            request.signal?.addEventListener(
              "abort",
              () => {
                cancelAllRetry = preloader.preload("/app/reentrant")
              },
              { once: true },
            )
            return pending.promise
          }
          return Promise.resolve(response('<Gallery><Fresh id="fresh" /></Gallery>', request.url))
        },
      },
      requestIds(),
      cache,
    )

    const exact = preloader.preload("/app/exact")
    await Promise.resolve()
    expect(preloader.cancel("/app/exact")).toBe(true)
    if (!exactRetry) throw new Error("exact cancellation did not start fresh work")
    await expect(exactRetry).resolves.toMatchObject({
      requestId: "preload-2",
      status: "cached",
    })

    const canceledByAll = preloader.preload("/app/all")
    await Promise.resolve()
    preloader.cancelAll()
    if (!cancelAllRetry) throw new Error("all-request cancellation did not preserve fresh work")
    await expect(cancelAllRetry).resolves.toMatchObject({
      requestId: "preload-4",
      status: "cached",
    })

    pending.resolve(
      response('<Gallery><Late id="late" /></Gallery>', "https://example.test/app/exact"),
    )
    await expect(exact).resolves.toMatchObject({ status: "canceled" })
    await expect(canceledByAll).resolves.toMatchObject({ status: "canceled" })
    const retained = cache.get("https://example.test/app/exact")
    expect(retained?.getElementById("fresh")).toBeDefined()
    expect(retained?.getElementById("late")).toBeUndefined()
    expect(cache.has("https://example.test/app/reentrant")).toBe(true)
  })

  test("cancels while the response body is pending and redacts a late failure", async () => {
    const bodyStarted = deferred<void>()
    const body = deferred<string>()
    const cache = new DocumentSnapshotCache()
    const preloader = new DocumentPreloader(
      session(),
      {
        fetch: async (request) =>
          response("", request.url, {
            text() {
              bodyStarted.resolve(undefined)
              return body.promise
            },
          }),
      },
      requestIds(),
      cache,
    )

    const pending = preloader.preload("/app/body")
    await bodyStarted.promise
    expect(preloader.cancel("/app/body")).toBe(true)

    await expect(pending).resolves.toEqual({
      requestId: "preload-1",
      status: "canceled",
      url: "https://example.test/app/body",
    })
    body.reject(new RequestError("private late body secret"))
    await Promise.resolve()
    expect(cache.has("https://example.test/app/body")).toBe(false)
  })

  test("rejects unsuccessful, unsafe final locations, empty, wrong-MIME, and malformed responses", async () => {
    const cases: Array<{
      expected:
        | typeof ContentTypeError
        | typeof ParseError
        | typeof RequestError
        | typeof TargetError
      response: (request: TurboRequest) => TurboResponse
      source: string
    }> = [
      {
        expected: RequestError,
        response: (request) => response("<Gallery />", request.url, { status: 503 }),
        source: "/app/status",
      },
      {
        expected: TargetError,
        response: () => response("<Gallery />", "https://other.test/app/cross-origin"),
        source: "/app/cross-origin",
      },
      {
        expected: ContentTypeError,
        response: (request) =>
          response("<Gallery />", request.url, {
            headers: { "Content-Type": "application/json" },
          }),
        source: "/app/mime",
      },
      {
        expected: RequestError,
        response: (request) => response(" \n ", request.url),
        source: "/app/empty",
      },
      {
        expected: ParseError,
        response: (request) => response("<Gallery>", request.url),
        source: "/app/malformed",
      },
    ]

    for (const fixture of cases) {
      const cache = new DocumentSnapshotCache()
      const preloader = new DocumentPreloader(
        session(),
        { fetch: async (request) => fixture.response(request) },
        requestIds(),
        cache,
      )
      await expect(preloader.preload(fixture.source)).rejects.toBeInstanceOf(fixture.expected)
      expect(cache.size).toBe(0)
    }
  })

  test("redacts plain and typed transport plus response-body failures and permits retry", async () => {
    let attempts = 0
    const preloader = new DocumentPreloader(
      session(),
      {
        async fetch(request) {
          attempts += 1
          if (attempts === 1) throw new Error("private transport secret")
          if (attempts === 2) throw new RequestError("private typed transport secret")
          if (attempts === 3) {
            return response("", request.url, {
              text: async () => {
                throw new Error("private body secret")
              },
            })
          }
          return response("<Gallery><Recovered /></Gallery>", request.url)
        },
      },
      requestIds(),
      new DocumentSnapshotCache(),
    )

    for (const expectedMessage of [
      "Document preload request failed",
      "Document preload request failed",
      "Document preload response body could not be read",
    ]) {
      try {
        await preloader.preload("/app/retry")
        throw new Error("preload failure fixture unexpectedly succeeded")
      } catch (error) {
        expect(error).toBeInstanceOf(RequestError)
        expect((error as Error).message).toBe(expectedMessage)
        expect((error as Error).message).not.toContain("secret")
        expect((error as Error & { cause?: unknown }).cause).toBeUndefined()
      }
    }

    await expect(preloader.preload("/app/retry")).resolves.toMatchObject({
      requestId: "preload-4",
      status: "cached",
    })
  })

  test("reads options and parser limits once before later requests", async () => {
    let capabilityReads = 0
    let limitsReads = 0
    let maxBytesReads = 0
    const limits = {
      get maxBytes() {
        maxBytesReads += 1
        return maxBytesReads === 1 ? 16 : 1_000
      },
    }
    const options = {
      get capabilityHash() {
        capabilityReads += 1
        return capabilityReads === 1 ? "sha256:first" : "changed\nmetadata"
      },
      get limits() {
        limitsReads += 1
        return limitsReads === 1 ? limits : { maxBytes: 1_000 }
      },
    }
    let request: TurboRequest | undefined
    const preloader = new DocumentPreloader(
      session(),
      {
        fetch: async (value) => {
          request = value
          return response("<Gallery><DemoText>large</DemoText></Gallery>", value.url)
        },
      },
      requestIds(),
      new DocumentSnapshotCache(),
      options,
    )

    expect(capabilityReads).toBe(1)
    expect(limitsReads).toBe(1)
    expect(maxBytesReads).toBe(1)
    await expect(preloader.preload("/app/limited-once")).rejects.toBeInstanceOf(ParseError)
    expect(request?.headers["X-Expo-Turbo-Capabilities"]).toBe("sha256:first")
    expect(capabilityReads).toBe(1)
    expect(limitsReads).toBe(1)
    expect(maxBytesReads).toBe(1)
  })

  test("rejects revoked configuration and every non-positive-integer parser limit", () => {
    const build = (options: unknown) =>
      new DocumentPreloader(
        session(),
        { fetch: async () => Promise.reject(new Error("unused")) },
        requestIds(),
        new DocumentSnapshotCache(),
        options as never,
      )
    const revokedOptions = Proxy.revocable({}, {})
    revokedOptions.revoke()
    const revokedLimits = Proxy.revocable({}, {})
    revokedLimits.revoke()

    for (const [options, expectedMessage] of [
      [revokedOptions.proxy, "Document preloader options could not be read"],
      [{ limits: revokedLimits.proxy }, "Document preloader parse limits could not be read"],
    ] as const) {
      try {
        build(options)
        throw new Error("revoked configuration fixture unexpectedly succeeded")
      } catch (error) {
        expect(error).toBeInstanceOf(PropsError)
        expect((error as Error).message).toBe(expectedMessage)
        expect((error as Error & { cause?: unknown }).cause).toBeUndefined()
      }
    }

    const limitKeys = [
      "maxAttributesPerElement",
      "maxBytes",
      "maxDepth",
      "maxNodes",
      "maxStreamActions",
      "maxTextBytes",
    ] as const
    for (const key of limitKeys) {
      expect(() => build({ limits: { [key]: Number.NaN } })).toThrow(PropsError)
    }

    let coercions = 0
    for (const value of [
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      0,
      -1,
      1.5,
      "16",
      16n,
      Symbol("private-limit"),
      {
        valueOf() {
          coercions += 1
          return 16
        },
      },
    ]) {
      try {
        build({ limits: { maxBytes: value } })
        throw new Error("invalid parser limit fixture unexpectedly succeeded")
      } catch (error) {
        expect(error).toBeInstanceOf(PropsError)
        expect((error as Error).message).toBe(
          "Document preloader parse limits must be positive integers",
        )
        expect((error as Error).message).not.toContain("private-limit")
        expect((error as Error & { cause?: unknown }).cause).toBeUndefined()
      }
    }
    expect(coercions).toBe(0)
  })

  test("redacts configuration and request-ID adapter failures", async () => {
    try {
      new DocumentPreloader(
        session(),
        { fetch: async () => Promise.reject(new Error("unused")) },
        requestIds(),
        new DocumentSnapshotCache(),
        {
          get capabilityHash(): string {
            throw new RequestError("private option secret")
          },
        },
      )
      throw new Error("configuration failure fixture unexpectedly succeeded")
    } catch (error) {
      expect(error).toBeInstanceOf(PropsError)
      expect((error as Error).message).toBe("Document preloader options could not be read")
      expect((error as Error).message).not.toContain("secret")
      expect((error as Error & { cause?: unknown }).cause).toBeUndefined()
    }

    const preloader = new DocumentPreloader(
      session(),
      { fetch: async () => Promise.reject(new Error("unused")) },
      {
        next() {
          throw new RequestError("private request-ID secret")
        },
      },
      new DocumentSnapshotCache(),
    )
    try {
      await preloader.preload("/app/request-id-error")
      throw new Error("request-ID failure fixture unexpectedly succeeded")
    } catch (error) {
      expect(error).toBeInstanceOf(RequestError)
      expect((error as Error).message).toBe("Document preload request ID could not be generated")
      expect((error as Error).message).not.toContain("secret")
      expect((error as Error & { cause?: unknown }).cause).toBeUndefined()
    }
  })

  test("reads response metadata once and redacts hostile getters", async () => {
    let urlReads = 0
    let attempts = 0
    const preloader = new DocumentPreloader(
      session(),
      {
        fetch: async (request) => {
          attempts += 1
          const result = response("<Gallery />", request.url)
          if (attempts === 1) {
            Object.defineProperty(result, "url", {
              get() {
                urlReads += 1
                return urlReads === 1 ? "" : request.url
              },
            })
          } else {
            Object.defineProperty(result, "redirected", {
              get() {
                throw new RequestError("private response metadata secret")
              },
            })
          }
          return result
        },
      },
      requestIds(),
      new DocumentSnapshotCache(),
    )

    for (const expectedMessage of [
      "Document preload response requires a final URL",
      "Document preload response metadata is invalid",
    ]) {
      try {
        await preloader.preload("/app/metadata")
        throw new Error("response metadata fixture unexpectedly succeeded")
      } catch (error) {
        expect(error).toBeInstanceOf(RequestError)
        expect((error as Error).message).toBe(expectedMessage)
        expect((error as Error).message).not.toContain("secret")
        expect((error as Error & { cause?: unknown }).cause).toBeUndefined()
      }
    }
    expect(urlReads).toBe(1)
  })

  test("redacts payload-derived parser messages and causes", async () => {
    let attempt = 0
    const payloads = [
      "<Gallery><private-secret></Gallery>",
      '<Gallery><Card id="private-secret" /><Card id="private-secret" /></Gallery>',
    ]
    const preloader = new DocumentPreloader(
      session(),
      {
        fetch: async (request) => response(payloads[attempt++] ?? "", request.url),
      },
      requestIds(),
      new DocumentSnapshotCache(),
    )

    for (const source of ["/app/malformed-secret", "/app/duplicate-secret"]) {
      try {
        await preloader.preload(source)
        throw new Error("malformed secret fixture unexpectedly succeeded")
      } catch (error) {
        expect(error).toBeInstanceOf(ParseError)
        expect((error as Error).message).toBe("Document preload XML could not be parsed")
        expect((error as Error).message).not.toContain("private-secret")
        expect(JSON.stringify((error as ParseError).context)).not.toContain("private-secret")
        expect((error as Error & { cause?: unknown }).cause).toBeUndefined()
      }
    }
  })

  test("applies configured parser limits before caching", async () => {
    const cache = new DocumentSnapshotCache()
    const preloader = new DocumentPreloader(
      session(),
      {
        fetch: async (request) =>
          response("<Gallery><DemoText>large</DemoText></Gallery>", request.url),
      },
      requestIds(),
      cache,
      { limits: { maxBytes: 16 } },
    )

    await expect(preloader.preload("/app/limited")).rejects.toBeInstanceOf(ParseError)
    expect(cache.size).toBe(0)
  })
})
