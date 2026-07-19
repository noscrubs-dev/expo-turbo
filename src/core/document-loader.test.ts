import { describe, expect, test } from "bun:test"

import type { TurboRequest, TurboResponse } from "../adapters"
import {
  DocumentCommitError,
  type DocumentLoadOptions,
  DocumentRequestLoader,
  DocumentSnapshotRestoreCommitError,
  type DocumentTreeCommitCandidate,
} from "./document-loader"
import { DOCUMENT_LOAD_REQUEST_DISPATCHED } from "./document-loader-lifecycle-internal"
import { DocumentSnapshotCache } from "./document-snapshot-cache"
import {
  ContentTypeError,
  ParseError,
  PropsError,
  RequestError,
  StateError,
  TargetError,
} from "./errors"
import { EXPO_TURBO_MIME_TYPE } from "./frame-loader"
import { parseExpoTurboDocument } from "./parser"
import { RequestLifecycle } from "./request-lifecycle"
import { DocumentSession } from "./session"
import { attributeValue, DocumentTree, type ProtocolDocument } from "./tree"

type InternalDocumentLoadOptions = DocumentLoadOptions &
  Readonly<{ [DOCUMENT_LOAD_REQUEST_DISPATCHED]?: () => undefined }>

function documentSession(): DocumentSession {
  return new DocumentSession(
    parseExpoTurboDocument(
      '<Gallery><Old id="old" /><turbo-frame id="frame" src="old-frame" /></Gallery>',
      { url: "https://example.test/current/index" },
    ),
  )
}

function response(xml: string, options: Partial<TurboResponse> = {}): TurboResponse {
  return {
    headers: { "Content-Type": `${EXPO_TURBO_MIME_TYPE}; charset=utf-8` },
    redirected: false,
    status: 200,
    text: async () => xml,
    url: "https://example.test/response",
    ...options,
  }
}

describe("Document request loader", () => {
  test("snapshots and validates the request lifecycle option", async () => {
    const lifecycle = new RequestLifecycle()
    let events = 0
    let reads = 0
    lifecycle.subscribe("before-fetch-request", () => {
      events += 1
    })
    const loader = new DocumentRequestLoader(
      documentSession(),
      {
        fetch: async (request) =>
          response('<Gallery><Loaded id="loaded" /></Gallery>', { url: request.url }),
      },
      { next: () => "request-options" },
      {
        get requestLifecycle() {
          reads += 1
          return lifecycle
        },
      },
    )

    expect(reads).toBe(1)
    expect(await loader.load("/options")).toMatchObject({ status: "committed" })
    expect({ events, reads }).toEqual({ events: 1, reads: 1 })
    expect(
      () =>
        new DocumentRequestLoader(
          documentSession(),
          { fetch: async () => Promise.reject(new Error("unused")) },
          { next: () => "unused" },
          { requestLifecycle: null } as never,
        ),
    ).toThrow(PropsError)
  })

  test("runs one request-local lifecycle around the admitted document GET", async () => {
    const session = documentSession()
    const lifecycle = new RequestLifecycle()
    let fetched: TurboRequest | undefined
    lifecycle.subscribe("before-fetch-request", (event) => {
      expect(event.detail.context).toEqual({
        kind: "document",
        purpose: "load",
        requestId: "request-lifecycle",
      })
      expect(session.recentRequestIds.has("request-lifecycle")).toBe(false)
      event.detail.request.setUrl("https://example.test/hooked")
      event.detail.request.setHeader("X-Document-Hook", "admitted")
    })
    const loader = new DocumentRequestLoader(
      session,
      {
        fetch: async (request) => {
          fetched = request
          expect(session.recentRequestIds.has("request-lifecycle")).toBe(true)
          return response('<Gallery><Hooked id="hooked" /></Gallery>', { url: request.url })
        },
      },
      { next: () => "request-lifecycle" },
      { requestLifecycle: lifecycle },
    )

    expect(await loader.load("/original")).toMatchObject({
      requestedUrl: "https://example.test/hooked",
      status: "committed",
      url: "https://example.test/hooked",
    })
    expect(fetched).toMatchObject({
      headers: { "X-Document-Hook": "admitted" },
      method: "GET",
      url: "https://example.test/hooked",
    })
    expect(session.tree.getElementById("hooked")).toBeDefined()
  })

  test("reports prevented document handling without reading or committing the response", async () => {
    const session = documentSession()
    const previousTree = session.tree
    const lifecycle = new RequestLifecycle()
    let reads = 0
    lifecycle.subscribe("before-fetch-response", (event) => {
      expect(event.detail.response.status).toBe(200)
      event.preventDefault()
    })
    const loader = new DocumentRequestLoader(
      session,
      {
        fetch: async (request) =>
          response('<Gallery><Ignored id="ignored" /></Gallery>', {
            text: async () => {
              reads += 1
              return '<Gallery><Ignored id="ignored" /></Gallery>'
            },
            url: request.url,
          }),
      },
      { next: () => "request-prevented" },
      { requestLifecycle: lifecycle },
    )

    expect(await loader.load("/prevented")).toEqual({
      redirected: false,
      requestId: "request-prevented",
      requestedUrl: "https://example.test/prevented",
      responseStatus: 200,
      status: "prevented",
      url: "https://example.test/prevented",
    })
    expect(reads).toBe(0)
    expect(session.tree).toBe(previousTree)
  })

  test("sends document headers and parses before committing the redirected final URL", async () => {
    const requests: TurboRequest[] = []
    const session = documentSession()
    const previousTree = session.tree
    const loader = new DocumentRequestLoader(
      session,
      {
        async fetch(request) {
          requests.push(request)
          return response(
            '<Gallery><turbo-frame id="frame" src="relative-frame"><Loaded id="loaded" /></turbo-frame></Gallery>',
            {
              redirected: true,
              url: "https://example.test/final/path",
            },
          )
        },
      },
      { next: () => "request-1" },
      { capabilityHash: "sha256:capabilities" },
    )

    const report = await loader.load("../next")

    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      headers: {
        Accept: EXPO_TURBO_MIME_TYPE,
        "X-Expo-Turbo-Capabilities": "sha256:capabilities",
        "X-Expo-Turbo-Protocol": "0.1",
        "X-Expo-Turbo-Runtime": "0.1.0",
        "X-Turbo-Request-Id": "request-1",
      },
      method: "GET",
      url: "https://example.test/next",
    })
    expect(requests[0]?.headers).not.toHaveProperty("Turbo-Frame")
    expect(requests[0]).not.toHaveProperty("body")
    expect(session.recentRequestIds.has("request-1")).toBe(true)
    expect(report).toEqual({
      classification: "success",
      redirected: true,
      requestId: "request-1",
      requestedUrl: "https://example.test/next",
      responseStatus: 200,
      status: "committed",
      url: "https://example.test/final/path",
    })
    expect(session.tree).not.toBe(previousTree)
    expect(session.revision).toBe(1)
    expect(session.tree.document.url).toBe("https://example.test/final/path")
    const frame = session.tree.getElementById("frame")
    if (!frame) throw new Error("fixture lost its redirected Frame")
    expect(new URL(attributeValue(frame, "src") ?? "", session.tree.document.url).toString()).toBe(
      "https://example.test/final/relative-frame",
    )
  })

  test("acknowledges exact request ownership before bookkeeping and fetch", async () => {
    const order: string[] = []
    const session = documentSession()
    const loader = new DocumentRequestLoader(
      session,
      {
        fetch: async () => {
          order.push("fetch")
          return response('<Gallery><Started id="started" /></Gallery>')
        },
      },
      { next: () => "request-started" },
    )

    const report = await loader.load("/started", undefined, {
      onRequestStart() {
        order.push("start")
        expect(session.recentRequestIds.has("request-started")).toBe(false)
      },
    })

    expect(report).toMatchObject({ status: "committed" })
    expect(order).toEqual(["start", "fetch"])
    expect(session.recentRequestIds.has("request-started")).toBe(true)
  })

  test("acknowledges request ownership and dispatch before a paused request lifecycle", async () => {
    const order: string[] = []
    const session = documentSession()
    const lifecycle = new RequestLifecycle()
    let resume: () => void = () => {
      throw new Error("before-fetch-request did not pause")
    }
    lifecycle.subscribe("before-fetch-request", (event) => {
      order.push("before-fetch-request")
      event.pause()
      resume = () => event.resume()
    })
    let fetches = 0
    const loader = new DocumentRequestLoader(
      session,
      {
        fetch: async () => {
          fetches += 1
          return response('<Gallery><Late id="late" /></Gallery>')
        },
      },
      { next: () => "request-paused" },
      { requestLifecycle: lifecycle },
    )

    const loading = loader.load("/paused", undefined, {
      [DOCUMENT_LOAD_REQUEST_DISPATCHED]() {
        order.push("dispatched")
        expect(session.recentRequestIds.has("request-paused")).toBe(false)
      },
      onRequestStart() {
        order.push("start")
        expect(session.recentRequestIds.has("request-paused")).toBe(false)
      },
    } as InternalDocumentLoadOptions)

    expect(order).toEqual(["start", "before-fetch-request", "dispatched"])
    expect(fetches).toBe(0)
    expect(session.recentRequestIds.has("request-paused")).toBe(false)

    expect(loader.cancel()).toBe(true)
    expect(await loading).toMatchObject({ status: "canceled" })
    expect(fetches).toBe(0)
    expect(session.recentRequestIds.has("request-paused")).toBe(false)
    resume()
  })

  test("publishes request dispatch after lifecycle mutation and before fetch bookkeeping", async () => {
    const order: string[] = []
    const session = documentSession()
    const lifecycle = new RequestLifecycle()
    lifecycle.subscribe("before-fetch-request", (event) => {
      order.push("before-fetch-request")
      event.detail.request.setUrl("https://example.test/admitted")
    })
    const loader = new DocumentRequestLoader(
      session,
      {
        fetch: async (request) => {
          order.push("fetch")
          expect(request.url).toBe("https://example.test/admitted")
          expect(session.recentRequestIds.has("request-ready")).toBe(true)
          return response('<Gallery><Ready id="ready" /></Gallery>', { url: request.url })
        },
      },
      { next: () => "request-ready" },
      { requestLifecycle: lifecycle },
    )

    expect(
      await loader.load("/original", undefined, {
        [DOCUMENT_LOAD_REQUEST_DISPATCHED]() {
          order.push("dispatched")
          expect(session.recentRequestIds.has("request-ready")).toBe(false)
        },
        onRequestStart() {
          order.push("start")
        },
      } as InternalDocumentLoadOptions),
    ).toMatchObject({
      requestedUrl: "https://example.test/admitted",
      status: "committed",
    })
    expect(order).toEqual(["start", "before-fetch-request", "dispatched", "fetch"])
  })

  test("restores a cached tree under document ownership and retargets its exact URL", () => {
    const order: string[] = []
    const session = documentSession()
    const cache = new DocumentSnapshotCache()
    cache.put(
      "https://example.test/restored#stored",
      parseExpoTurboDocument(
        '<Gallery data-turbo-cache-control="no-preview"><Restored id="restored" /></Gallery>',
        { url: "https://example.test/restored#stored" },
      ),
    )
    const loader = new DocumentRequestLoader(
      session,
      { fetch: async () => response("") },
      { next: () => "unused" },
    )

    const report = loader.restoreSnapshot(
      cache,
      "https://example.test/restored#history",
      undefined,
      {
        beforeTreeCommit() {
          order.push("commit")
          expect(session.tree.getElementById("old")).toBeDefined()
        },
        onRestoreStart() {
          order.push("start")
        },
      },
    )

    expect(report).toEqual({ status: "committed", url: "https://example.test/restored#history" })
    expect(order).toEqual(["start", "commit"])
    expect(session.tree.getElementById("restored")).toBeDefined()
    expect(session.tree.document.url).toBe("https://example.test/restored#history")
  })

  test("selects only previewable snapshots and publishes provisional tree provenance", () => {
    const order: string[] = []
    const session = documentSession()
    const cache = new DocumentSnapshotCache()
    cache.put(
      "https://example.test/preview",
      parseExpoTurboDocument('<Gallery><Preview id="preview" /></Gallery>', {
        url: "https://example.test/preview",
      }),
    )
    cache.put(
      "https://example.test/no-preview",
      parseExpoTurboDocument(
        '<Gallery data-turbo-cache-control="no-preview"><Hidden id="hidden" /></Gallery>',
        { url: "https://example.test/no-preview" },
      ),
    )
    const loader = new DocumentRequestLoader(
      session,
      { fetch: async () => response("") },
      { next: () => "unused" },
    )

    expect(loader.previewSnapshot(cache, "https://example.test/no-preview")).toEqual({
      status: "miss",
      url: "https://example.test/no-preview",
    })
    expect(session.treeState).toEqual({ generation: 0, preview: false })
    const report = loader.previewSnapshot(cache, "https://example.test/preview", undefined, {
      beforeTreeCommit() {
        order.push("commit")
        expect(session.treeState.preview).toBe(false)
      },
      onPreviewStart() {
        order.push("start")
      },
    })

    expect(report).toEqual({ status: "committed", url: "https://example.test/preview" })
    expect(order).toEqual(["start", "commit"])
    expect(session.tree.getElementById("preview")).toBeDefined()
    expect(session.treeState).toEqual({ generation: 1, preview: true })
    session.replaceTree(
      parseExpoTurboDocument('<Gallery><Canonical id="canonical" /></Gallery>', {
        url: "https://example.test/preview",
      }),
    )
    expect(session.treeState).toEqual({ generation: 2, preview: false })
  })

  test("returns a frozen cache miss without claiming ownership or running callbacks", () => {
    const session = documentSession()
    const loader = new DocumentRequestLoader(
      session,
      { fetch: async () => response("") },
      { next: () => "unused" },
    )
    let callbacks = 0

    const report = loader.restoreSnapshot(
      new DocumentSnapshotCache(),
      "https://example.test/missing",
      undefined,
      {
        beforeTreeCommit() {
          callbacks += 1
        },
        onRestoreStart() {
          callbacks += 1
        },
      },
    )

    expect(report).toEqual({ status: "miss", url: "https://example.test/missing" })
    expect(Object.isFrozen(report)).toBe(true)
    expect(callbacks).toBe(0)
    expect(session.tree.getElementById("old")).toBeDefined()
    expect(() =>
      loader.restoreSnapshot(new DocumentSnapshotCache(), "https://other.test/missing"),
    ).toThrow(TargetError)
  })

  test("cached restoration supersedes an active document request", async () => {
    const session = documentSession()
    let pendingRequest: TurboRequest | undefined
    let resolvePending: ((value: TurboResponse) => void) | undefined
    const loader = new DocumentRequestLoader(
      session,
      {
        fetch: (request) =>
          new Promise<TurboResponse>((resolve) => {
            pendingRequest = request
            resolvePending = resolve
          }),
      },
      { next: () => "pending" },
    )
    const cache = new DocumentSnapshotCache()
    cache.put(
      "https://example.test/restored",
      parseExpoTurboDocument('<Gallery><Restored id="restored" /></Gallery>', {
        url: "https://example.test/restored",
      }),
    )

    const pending = loader.load("/pending")
    if (!pendingRequest || !resolvePending) throw new Error("pending request did not start")
    expect(loader.restoreSnapshot(cache, "https://example.test/restored")).toMatchObject({
      status: "committed",
    })
    expect(pendingRequest.signal?.aborted).toBe(true)

    resolvePending(
      response('<Gallery><Late id="late" /></Gallery>', {
        url: "https://example.test/pending",
      }),
    )
    expect(await pending).toMatchObject({ status: "canceled" })
    expect(session.tree.getElementById("restored")).toBeDefined()
    expect(session.tree.getElementById("late")).toBeUndefined()
  })

  test("skips cached-restore start when displaced abort work wins ownership", async () => {
    const session = documentSession()
    let oldestRequest: TurboRequest | undefined
    let resolveOldest: ((value: TurboResponse) => void) | undefined
    const oldestLoader = new DocumentRequestLoader(
      session,
      {
        fetch: (request) =>
          new Promise<TurboResponse>((resolve) => {
            oldestRequest = request
            resolveOldest = resolve
          }),
      },
      { next: () => "oldest" },
    )
    let newestRequest: TurboRequest | undefined
    let resolveNewest: ((value: TurboResponse) => void) | undefined
    const newestLoader = new DocumentRequestLoader(
      session,
      {
        fetch: (request) =>
          new Promise<TurboResponse>((resolve) => {
            newestRequest = request
            resolveNewest = resolve
          }),
      },
      { next: () => "newest" },
    )
    const restoringLoader = new DocumentRequestLoader(
      session,
      { fetch: async () => response("") },
      { next: () => "unused" },
    )
    const cache = new DocumentSnapshotCache()
    cache.put(
      "https://example.test/restored",
      parseExpoTurboDocument('<Gallery><Restored id="restored" /></Gallery>', {
        url: "https://example.test/restored",
      }),
    )
    let newest: Promise<unknown> | undefined
    let restoreStarts = 0

    const oldest = oldestLoader.load("/oldest")
    if (!oldestRequest || !resolveOldest) throw new Error("oldest request did not start")
    oldestRequest.signal?.addEventListener("abort", () => {
      newest = newestLoader.load("/newest")
    })
    const report = restoringLoader.restoreSnapshot(
      cache,
      "https://example.test/restored",
      undefined,
      {
        onRestoreStart() {
          restoreStarts += 1
        },
      },
    )

    expect(report).toEqual({ status: "canceled", url: "https://example.test/restored" })
    expect(restoreStarts).toBe(0)
    expect(newestRequest).toBeDefined()
    expect(session.tree.getElementById("old")).toBeDefined()
    expect(session.tree.getElementById("restored")).toBeUndefined()

    resolveOldest(
      response('<Gallery><Oldest id="oldest" /></Gallery>', {
        url: "https://example.test/oldest",
      }),
    )
    resolveNewest?.(
      response('<Gallery><Newest id="newest" /></Gallery>', {
        url: "https://example.test/newest",
      }),
    )
    expect(await oldest).toMatchObject({ status: "canceled" })
    await newest
    expect(session.tree.getElementById("newest")).toBeDefined()
  })

  test("reports committed cached truth when replacement finalization fails", () => {
    const session = documentSession()
    const cache = new DocumentSnapshotCache()
    cache.put(
      "https://example.test/restored",
      parseExpoTurboDocument('<Gallery><Restored id="restored" /></Gallery>', {
        url: "https://example.test/restored",
      }),
    )
    session.registerDisposal("id:old", () => {
      throw new Error("disposal failed")
    })
    const loader = new DocumentRequestLoader(
      session,
      { fetch: async () => response("") },
      { next: () => "unused" },
    )

    let error: unknown
    try {
      loader.restoreSnapshot(cache, "https://example.test/restored")
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(DocumentSnapshotRestoreCommitError)
    expect((error as DocumentSnapshotRestoreCommitError).outcome).toEqual({
      status: "committed",
      url: "https://example.test/restored",
    })
    expect(session.tree.getElementById("restored")).toBeDefined()
  })

  test("skips request-start acknowledgement when displaced abort work supersedes the new lease", async () => {
    const session = documentSession()
    let oldestRequest: TurboRequest | undefined
    let resolveOldest: ((response: TurboResponse) => void) | undefined
    const oldestLoader = new DocumentRequestLoader(
      session,
      {
        fetch: (request) =>
          new Promise<TurboResponse>((resolve) => {
            oldestRequest = request
            resolveOldest = resolve
          }),
      },
      { next: () => "request-oldest" },
    )
    let middleFetches = 0
    let middleStarts = 0
    const middleLoader = new DocumentRequestLoader(
      session,
      {
        fetch: async () => {
          middleFetches += 1
          return response('<Gallery><Middle id="middle" /></Gallery>')
        },
      },
      { next: () => "request-middle" },
    )
    let newestRequest: TurboRequest | undefined
    let resolveNewest: ((response: TurboResponse) => void) | undefined
    let newestStarts = 0
    const newestLoader = new DocumentRequestLoader(
      session,
      {
        fetch: (request) =>
          new Promise<TurboResponse>((resolve) => {
            newestRequest = request
            resolveNewest = resolve
          }),
      },
      { next: () => "request-newest" },
    )
    let newest: Promise<unknown> | undefined

    const oldest = oldestLoader.load("/oldest")
    if (!oldestRequest) throw new Error("oldest request did not start")
    oldestRequest.signal?.addEventListener("abort", () => {
      newest = newestLoader.load("/newest", undefined, {
        onRequestStart() {
          newestStarts += 1
        },
      })
    })
    const middle = middleLoader.load("/middle", undefined, {
      onRequestStart() {
        middleStarts += 1
      },
    })

    expect(await middle).toMatchObject({ status: "canceled" })
    expect(middleStarts).toBe(0)
    expect(middleFetches).toBe(0)
    expect(newestStarts).toBe(1)
    expect(newestRequest?.signal?.aborted).toBe(false)

    resolveOldest?.(
      response('<Gallery><Oldest id="oldest" /></Gallery>', {
        url: "https://example.test/oldest",
      }),
    )
    expect(await oldest).toMatchObject({ status: "canceled" })
    resolveNewest?.(
      response('<Gallery><Newest id="newest" /></Gallery>', {
        url: "https://example.test/newest",
      }),
    )
    expect(await newest).toMatchObject({ status: "committed" })
    expect(session.tree.getElementById("newest")).toBeDefined()
  })

  test("rejects invalid request-start callbacks before fetch and remains retryable", async () => {
    for (const onRequestStart of [
      () => {
        throw new Error("request-start callback failed with secret-token")
      },
      () => "invalid" as never,
      async () => undefined,
      async () => {
        throw new Error("async request-start callback failed with secret-token")
      },
    ]) {
      let fetches = 0
      const session = documentSession()
      const loader = new DocumentRequestLoader(
        session,
        {
          fetch: async () => {
            fetches += 1
            return response(`<Gallery><Result id="result-${fetches}" /></Gallery>`)
          },
        },
        { next: () => `request-${fetches + 1}` },
      )

      try {
        await loader.load("/invalid-start", undefined, { onRequestStart: onRequestStart as never })
        throw new Error("expected request-start callback to fail")
      } catch (error) {
        expect(error).toBeInstanceOf(RequestError)
        expect(String(error)).not.toContain("secret-token")
      }
      expect(fetches).toBe(0)
      expect(session.revision).toBe(0)

      expect(await loader.load("/retry")).toMatchObject({ status: "committed" })
      expect(fetches).toBe(1)
    }
  })

  test("commits success and authoritative HTTP error documents with distinct classifications", async () => {
    const fixtures = [
      { classification: "success", status: 200 },
      { classification: "success", status: 201 },
      { classification: "client-error", status: 422 },
      { classification: "server-error", status: 500 },
    ] as const

    for (const fixture of fixtures) {
      const session = documentSession()
      const loader = new DocumentRequestLoader(
        session,
        {
          fetch: async () =>
            response(`<Gallery><Result id="result-${fixture.status}" /></Gallery>`, {
              status: fixture.status,
              url: `https://example.test/status/${fixture.status}`,
            }),
        },
        { next: () => `request-${fixture.status}` },
      )

      expect(await loader.load(`/status/${fixture.status}`)).toMatchObject({
        classification: fixture.classification,
        responseStatus: fixture.status,
        status: "committed",
      })
      expect(session.tree.getElementById(`result-${fixture.status}`)?.tagName).toBe("Result")
      expect(session.tree.document.url).toBe(`https://example.test/status/${fixture.status}`)
    }
  })

  test("exposes a synchronous parsed candidate that can be discarded before tree replacement", async () => {
    const session = documentSession()
    const previousTree = session.tree
    const loader = new DocumentRequestLoader(
      session,
      {
        fetch: async () =>
          response('<Gallery data-turbo-root="/elsewhere"><Discarded id="discarded" /></Gallery>', {
            redirected: true,
            url: "https://example.test/final",
          }),
      },
      { next: () => "request-discard" },
    )
    let candidateStatus: string | undefined
    let rootLocation: string | undefined

    const report = await loader.load("/requested", undefined, {
      beforeCommit: (candidate) => {
        candidateStatus = candidate.status
        rootLocation = candidate.rootLocation
        expect("tree" in candidate).toBe(false)
        return "discard"
      },
    })

    expect(candidateStatus).toBe("committed")
    expect(rootLocation).toBe("https://example.test/elsewhere")
    expect(report).toEqual({
      candidateStatus: "committed",
      classification: "success",
      redirected: true,
      requestId: "request-discard",
      requestedUrl: "https://example.test/requested",
      responseStatus: 200,
      status: "discarded",
      url: "https://example.test/final",
    })
    expect(Object.isFrozen(report)).toBe(true)
    expect(session.tree).toBe(previousTree)
    expect(session.revision).toBe(0)
    expect(session.tree.getElementById("discarded")).toBeUndefined()
  })

  test("can discard a redirected empty response without changing the current document", async () => {
    const session = documentSession()
    const previousTree = session.tree
    const loader = new DocumentRequestLoader(
      session,
      {
        fetch: async () =>
          response("unused", {
            headers: {},
            redirected: true,
            status: 204,
            url: "https://example.test/final-empty",
          }),
      },
      { next: () => "request-empty-discard" },
    )

    const report = await loader.load("/requested-empty", undefined, {
      beforeCommit: (candidate) => {
        expect(candidate.status).toBe("empty")
        expect("tree" in candidate).toBe(false)
        return "discard"
      },
    })

    expect(report).toMatchObject({
      candidateStatus: "empty",
      redirected: true,
      status: "discarded",
      url: "https://example.test/final-empty",
    })
    expect(session.tree).toBe(previousTree)
    expect(session.revision).toBe(0)
  })

  test("fails closed on invalid commit admission and releases ownership for retry", async () => {
    for (const beforeCommit of [
      () => "invalid" as never,
      () => {
        throw new Error("unsafe admission failure")
      },
    ]) {
      let requests = 0
      const session = documentSession()
      const previousTree = session.tree
      const loader = new DocumentRequestLoader(
        session,
        {
          fetch: async (request) => {
            requests += 1
            return response(`<Gallery><Result id="result-${requests}" /></Gallery>`, {
              url: request.url,
            })
          },
        },
        { next: () => `request-${requests + 1}` },
      )

      await expect(loader.load("/first", undefined, { beforeCommit })).rejects.toBeInstanceOf(
        RequestError,
      )
      expect(session.tree).toBe(previousTree)
      expect(session.revision).toBe(0)

      expect(await loader.load("/retry")).toMatchObject({ status: "committed" })
      expect(session.tree.getElementById("result-2")?.tagName).toBe("Result")
    }
  })

  test("runs the exact frozen candidate under final ownership before tree replacement", async () => {
    const session = documentSession()
    const owner = Object.freeze({})
    const order: string[] = []
    let admitted: DocumentTreeCommitCandidate | undefined
    const loader = new DocumentRequestLoader(
      session,
      {
        fetch: async () =>
          response('<Gallery><Committed id="committed" /></Gallery>', {
            url: "https://example.test/committed",
          }),
      },
      { next: () => "request-commit" },
    )
    session.subscribe("id:old", () => order.push("listener"))

    const report = await loader.load("/committed", owner, {
      beforeCommit(candidate) {
        if (candidate.status !== "committed") throw new Error("expected a parsed commit candidate")
        admitted = candidate
        order.push("admission")
        return "commit"
      },
      beforeTreeCommit(candidate) {
        if (!admitted) throw new Error("commit candidate was not admitted")
        expect(candidate).toBe(admitted)
        expect(Object.isFrozen(candidate)).toBe(true)
        expect(candidate.status).toBe("committed")
        expect(session.tree.getElementById("old")).toBeDefined()
        expect(session.tree.getElementById("committed")).toBeUndefined()
        expect(loader.cancel(owner)).toBe(false)
        order.push("transaction")
      },
    })

    expect(report).toMatchObject({ status: "committed" })
    expect(order).toEqual(["admission", "transaction", "listener"])
    expect(session.tree.getElementById("old")).toBeUndefined()
    expect(session.tree.getElementById("committed")).toBeDefined()
  })

  test("blocks same-session request reentrancy during the final commit callback", async () => {
    const session = documentSession()
    let outerFetches = 0
    let peerFetches = 0
    let reentrantStarts = 0
    let requestId = 0
    const loader = new DocumentRequestLoader(
      session,
      {
        fetch: async () => {
          outerFetches += 1
          return response('<Gallery><Outer id="outer" /></Gallery>', {
            url: "https://example.test/outer",
          })
        },
      },
      { next: () => `outer-${++requestId}` },
    )
    const peer = new DocumentRequestLoader(
      session,
      {
        fetch: async () => {
          peerFetches += 1
          return response('<Gallery><Peer id="peer" /></Gallery>')
        },
      },
      { next: () => "peer-1" },
    )
    let sameLoader: Promise<unknown> | undefined
    let peerLoader: Promise<unknown> | undefined

    const outer = loader.load("/outer", undefined, {
      beforeTreeCommit() {
        sameLoader = loader.load("/same-loader", undefined, {
          onRequestStart() {
            reentrantStarts += 1
          },
        })
        peerLoader = peer.load("/peer-loader", undefined, {
          onRequestStart() {
            reentrantStarts += 1
          },
        })
      },
    })

    expect(await outer).toMatchObject({ status: "committed" })
    if (!sameLoader || !peerLoader) throw new Error("reentrant requests were not captured")
    await expect(sameLoader).rejects.toBeInstanceOf(StateError)
    await expect(peerLoader).rejects.toBeInstanceOf(StateError)
    expect(outerFetches).toBe(1)
    expect(peerFetches).toBe(0)
    expect(reentrantStarts).toBe(0)
    expect(session.tree.getElementById("outer")).toBeDefined()
    expect(session.tree.getElementById("peer")).toBeUndefined()
  })

  test("rejects invalid final commit callbacks without replacing the tree", async () => {
    const callbacks = [
      () => {
        throw new Error("host callback failed with secret-token")
      },
      () => "invalid" as never,
      async () => undefined,
      async () => {
        throw new Error("async callback failed with secret-token")
      },
    ]

    for (const beforeTreeCommit of callbacks) {
      let requests = 0
      const session = documentSession()
      const tree = session.tree
      const loader = new DocumentRequestLoader(
        session,
        {
          fetch: async (request) => {
            requests += 1
            return response(`<Gallery><Result id="result-${requests}" /></Gallery>`, {
              url: request.url,
            })
          },
        },
        { next: () => `request-${requests + 1}` },
      )

      try {
        await loader.load("/invalid-callback", undefined, {
          beforeTreeCommit: beforeTreeCommit as never,
        })
        throw new Error("expected commit callback admission to fail")
      } catch (error) {
        expect(error).toBeInstanceOf(RequestError)
        expect(String(error)).not.toContain("secret-token")
      }
      expect(session.tree).toBe(tree)
      expect(session.revision).toBe(0)

      expect(await loader.load("/retry")).toMatchObject({ status: "committed" })
      expect(session.tree.getElementById("result-2")).toBeDefined()
    }
  })

  test("does not enter the final commit callback after admission loses ownership", async () => {
    const session = documentSession()
    const owner = Object.freeze({})
    const loader = new DocumentRequestLoader(
      session,
      {
        fetch: async () => response('<Gallery><Canceled id="canceled" /></Gallery>'),
      },
      { next: () => "request-canceled" },
    )
    let callbackCalls = 0

    const report = await loader.load("/canceled", owner, {
      beforeCommit() {
        expect(loader.cancel(owner)).toBe(true)
        return "commit"
      },
      beforeTreeCommit() {
        callbackCalls += 1
      },
    })

    expect(report).toMatchObject({ status: "canceled" })
    expect(callbackCalls).toBe(0)
    expect(session.tree.getElementById("old")).toBeDefined()
    expect(session.tree.getElementById("canceled")).toBeUndefined()
  })

  test("does not enter the final commit callback after preparation changes tree generation", async () => {
    const session = documentSession()
    const replacement = parseExpoTurboDocument(
      '<Gallery><Replacement id="replacement" /></Gallery>',
      {
        url: "https://example.test/replacement",
      },
    )
    const loader = new DocumentRequestLoader(
      session,
      {
        fetch: async () => response('<Gallery><Stale id="stale" /></Gallery>'),
      },
      { next: () => "request-stale" },
    )
    let callbackCalls = 0

    const report = await loader.load("/stale", undefined, {
      beforeCommit() {
        session.replaceTree(replacement)
        return "commit"
      },
      beforeTreeCommit() {
        callbackCalls += 1
      },
    })

    expect(report).toMatchObject({ status: "canceled" })
    expect(callbackCalls).toBe(0)
    expect(session.tree).toBe(replacement)
    expect(session.tree.getElementById("stale")).toBeUndefined()
  })

  test("does not detach newer work started by tree replacement finalization", async () => {
    let pending:
      | Readonly<{
          request: TurboRequest
          resolve: (response: TurboResponse) => void
        }>
      | undefined
    const session = documentSession()
    const outer = new DocumentRequestLoader(
      session,
      {
        fetch: async () =>
          response('<Gallery><Outer id="outer" /></Gallery>', {
            url: "https://example.test/outer",
          }),
      },
      { next: () => "request-outer" },
    )
    const peer = new DocumentRequestLoader(
      session,
      {
        fetch: (request) =>
          new Promise<TurboResponse>((resolve) => {
            pending = { request, resolve }
          }),
      },
      { next: () => "request-newer" },
    )
    let newer: Promise<unknown> | undefined
    session.subscribe("id:old", () => {
      newer = peer.load("/newer")
    })

    expect(
      await outer.load("/outer", undefined, {
        beforeTreeCommit() {},
      }),
    ).toMatchObject({ status: "committed" })
    if (!newer || !pending) throw new Error("replacement listener did not start newer work")
    expect(pending.request.signal?.aborted).toBe(false)
    expect(session.tree.getElementById("outer")).toBeDefined()

    pending.resolve(
      response('<Gallery><Newer id="newer" /></Gallery>', {
        url: "https://example.test/newer",
      }),
    )
    expect(await newer).toMatchObject({ status: "committed" })
    expect(session.tree.getElementById("newer")).toBeDefined()
    expect(session.tree.getElementById("outer")).toBeUndefined()
  })

  test("does not enter the final commit callback for empty or discarded candidates", async () => {
    let callbackCalls = 0
    const rootlessDocument: ProtocolDocument = {
      children: [],
      key: "document",
      kind: "document",
      parent: null,
      url: "https://example.test/current/index",
    }
    const emptySession = new DocumentSession(new DocumentTree(rootlessDocument))
    const emptyTree = emptySession.tree
    const emptyLoader = new DocumentRequestLoader(
      emptySession,
      {
        fetch: async () =>
          response("unused", {
            headers: {},
            status: 204,
            url: "https://example.test/empty",
          }),
      },
      { next: () => "request-empty" },
    )

    expect(
      await emptyLoader.load("/empty", undefined, {
        beforeTreeCommit() {
          callbackCalls += 1
        },
      }),
    ).toMatchObject({ status: "empty" })

    const discardedSession = documentSession()
    const discardedLoader = new DocumentRequestLoader(
      discardedSession,
      {
        fetch: async () => response('<Gallery><Discarded id="discarded" /></Gallery>'),
      },
      { next: () => "request-discarded" },
    )
    expect(
      await discardedLoader.load("/discarded", undefined, {
        beforeCommit: () => "discard",
        beforeTreeCommit() {
          callbackCalls += 1
        },
      }),
    ).toMatchObject({ status: "discarded" })

    expect(callbackCalls).toBe(0)
    expect(emptySession.tree).toBe(emptyTree)
    expect(emptySession.tree.document.children).toHaveLength(0)
    expect(discardedSession.tree.getElementById("old")).toBeDefined()
  })

  test("releases ownership when final-callback candidate construction fails", async () => {
    let requests = 0
    let callbackCalls = 0
    const session = documentSession()
    const loader = new DocumentRequestLoader(
      session,
      {
        fetch: async () => {
          requests += 1
          return response(
            requests === 1
              ? '<Gallery data-turbo-root="https://user:secret-token@example.test/" />'
              : '<Gallery><Retry id="retry" /></Gallery>',
          )
        },
      },
      { next: () => `request-${requests + 1}` },
    )

    try {
      await loader.load("/invalid-root", undefined, {
        beforeTreeCommit() {
          callbackCalls += 1
        },
      })
      throw new Error("expected candidate construction to fail")
    } catch (error) {
      expect(error).toBeInstanceOf(TargetError)
      expect(String(error)).not.toContain("secret-token")
    }
    expect(callbackCalls).toBe(0)
    expect(session.tree.getElementById("old")).toBeDefined()

    expect(await loader.load("/retry")).toMatchObject({ status: "committed" })
    expect(session.tree.getElementById("retry")).toBeDefined()
  })

  test("treats 204 and an empty 201 as explicit native no-op outcomes", async () => {
    const session = documentSession()
    const tree = session.tree
    let reads = 0
    const loader = new DocumentRequestLoader(
      session,
      {
        fetch: async (request) =>
          request.url.endsWith("/empty")
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
      },
      { next: () => "request-empty" },
    )

    expect(await loader.load("/empty")).toMatchObject({
      classification: "success",
      responseStatus: 204,
      status: "empty",
    })
    expect(await loader.load("/created")).toMatchObject({
      classification: "success",
      responseStatus: 201,
      status: "empty",
    })
    expect(reads).toBe(1)
    expect(session.tree).toBe(tree)
    expect(session.revision).toBe(0)
    expect(session.tree.document.url).toBe("https://example.test/current/index")
  })

  test("supersedes an older request without letting its late response commit", async () => {
    const pending: Array<{
      request: TurboRequest
      resolve: (response: TurboResponse) => void
    }> = []
    const session = documentSession()
    let requestId = 0
    const loader = new DocumentRequestLoader(
      session,
      {
        fetch: (request) =>
          new Promise<TurboResponse>((resolve) => pending.push({ request, resolve })),
      },
      { next: () => `request-${++requestId}` },
    )

    const older = loader.load("/older")
    const newer = loader.load("/newer")
    expect(pending).toHaveLength(2)
    expect(pending[0]?.request.signal?.aborted).toBe(true)
    expect(pending[1]?.request.signal?.aborted).toBe(false)

    pending[0]?.resolve(
      response('<Gallery><Older id="older" /></Gallery>', {
        url: "https://example.test/older",
      }),
    )
    expect(await older).toMatchObject({ status: "canceled" })
    expect(session.tree.getElementById("old")?.tagName).toBe("Old")

    pending[1]?.resolve(
      response('<Gallery><Newer id="newer" /></Gallery>', {
        url: "https://example.test/newer",
      }),
    )
    expect(await newer).toMatchObject({ status: "committed" })
    expect(session.tree.getElementById("older")).toBeUndefined()
    expect(session.tree.getElementById("newer")?.tagName).toBe("Newer")
  })

  test("supersedes a request while its response body is still being read", async () => {
    let markOlderBodyStarted!: () => void
    const olderBodyStarted = new Promise<void>((resolve) => {
      markOlderBodyStarted = resolve
    })
    let olderBody:
      | Readonly<{
          resolve: (xml: string) => void
        }>
      | undefined
    let olderSignal: AbortSignal | undefined
    const session = documentSession()
    let requestId = 0
    const loader = new DocumentRequestLoader(
      session,
      {
        async fetch(request) {
          if (request.url.endsWith("/older")) {
            olderSignal = request.signal
            return response("", {
              text: () => {
                markOlderBodyStarted()
                return new Promise<string>((resolve) => {
                  olderBody = { resolve }
                })
              },
              url: request.url,
            })
          }
          return response('<Gallery><Newer id="newer" /></Gallery>', { url: request.url })
        },
      },
      { next: () => `request-${++requestId}` },
    )

    const older = loader.load("/older")
    await olderBodyStarted
    if (!olderBody) throw new Error("fixture did not begin reading the older response")

    const newer = loader.load("/newer")
    expect(olderSignal?.aborted).toBe(true)

    expect(await older).toMatchObject({ status: "canceled" })
    olderBody.resolve('<Gallery><Older id="older" /></Gallery>')
    expect(await newer).toMatchObject({ status: "committed" })
    expect(session.tree.getElementById("older")).toBeUndefined()
    expect(session.tree.getElementById("newer")?.tagName).toBe("Newer")
  })

  test("reports an aborted response-body read as cancellation after supersession", async () => {
    let markOlderBodyStarted!: () => void
    const olderBodyStarted = new Promise<void>((resolve) => {
      markOlderBodyStarted = resolve
    })
    let rejectOlderBody: ((error: Error) => void) | undefined
    const session = documentSession()
    let requestId = 0
    const loader = new DocumentRequestLoader(
      session,
      {
        async fetch(request) {
          if (request.url.endsWith("/older")) {
            return response("", {
              text: () => {
                markOlderBodyStarted()
                return new Promise<string>((_resolve, reject) => {
                  rejectOlderBody = reject
                })
              },
              url: request.url,
            })
          }
          return response('<Gallery><Newer id="newer" /></Gallery>', { url: request.url })
        },
      },
      { next: () => `request-${++requestId}` },
    )

    const older = loader.load("/older")
    await olderBodyStarted
    if (!rejectOlderBody) throw new Error("fixture did not begin reading the older response")

    const newer = loader.load("/newer")

    expect(await older).toMatchObject({ status: "canceled" })
    rejectOlderBody(new Error("body read aborted"))
    await Promise.resolve()
    expect(await newer).toMatchObject({ status: "committed" })
    expect(session.tree.getElementById("newer")?.tagName).toBe("Newer")
  })

  test("invalidates a response while its body is read when another owner replaces the document", async () => {
    let markBodyStarted!: () => void
    const bodyStarted = new Promise<void>((resolve) => {
      markBodyStarted = resolve
    })
    let resolveBody: ((xml: string) => void) | undefined
    const session = documentSession()
    const loader = new DocumentRequestLoader(
      session,
      {
        fetch: async (request) =>
          response("", {
            text: () => {
              markBodyStarted()
              return new Promise<string>((resolve) => {
                resolveBody = resolve
              })
            },
            url: request.url,
          }),
      },
      { next: () => "request-1" },
    )
    const load = loader.load("/pending")
    await bodyStarted
    if (!resolveBody) throw new Error("fixture did not begin reading the pending response")

    const replacement = parseExpoTurboDocument('<Gallery><Other id="other" /></Gallery>', {
      url: "https://example.test/other",
    })
    session.replaceTree(replacement)
    resolveBody('<Gallery><Late id="late" /></Gallery>')

    expect(await load).toMatchObject({ status: "canceled" })
    expect(session.tree).toBe(replacement)
    expect(session.tree.getElementById("late")).toBeUndefined()
  })

  test("invalidates a pending request when another owner replaces the document", async () => {
    let resolve: ((response: TurboResponse) => void) | undefined
    const session = documentSession()
    const loader = new DocumentRequestLoader(
      session,
      {
        fetch: () =>
          new Promise<TurboResponse>((next) => {
            resolve = next
          }),
      },
      { next: () => "request-1" },
    )
    const load = loader.load("/pending")
    const replacement = parseExpoTurboDocument('<Gallery><Other id="other" /></Gallery>', {
      url: "https://example.test/other",
    })

    session.replaceTree(replacement)
    resolve?.(
      response('<Gallery><Late id="late" /></Gallery>', {
        url: "https://example.test/pending",
      }),
    )

    expect(await load).toMatchObject({ status: "canceled" })
    expect(session.tree).toBe(replacement)
    expect(session.tree.getElementById("late")).toBeUndefined()
  })

  test("does not regain stale ownership when an earlier tree object is restored", async () => {
    let resolve: ((response: TurboResponse) => void) | undefined
    const session = documentSession()
    const original = session.tree
    const loader = new DocumentRequestLoader(
      session,
      {
        fetch: () =>
          new Promise<TurboResponse>((next) => {
            resolve = next
          }),
      },
      { next: () => "request-1" },
    )
    const load = loader.load("/pending")
    const replacement = parseExpoTurboDocument('<Gallery><Other id="other" /></Gallery>', {
      url: "https://example.test/other",
    })

    session.replaceTree(replacement)
    session.replaceTree(original)
    resolve?.(
      response('<Gallery><Late id="late" /></Gallery>', {
        url: "https://example.test/pending",
      }),
    )

    expect(await load).toMatchObject({ status: "canceled" })
    expect(session.tree).toBe(original)
    expect(session.treeGeneration).toBe(2)
    expect(session.tree.getElementById("late")).toBeUndefined()
  })

  test("uses owner-aware explicit cancellation without reporting a request failure", async () => {
    let pending:
      | Readonly<{
          request: TurboRequest
          resolve: (response: TurboResponse) => void
        }>
      | undefined
    const session = documentSession()
    const owner = Object.freeze({})
    const loader = new DocumentRequestLoader(
      session,
      {
        fetch: (request) =>
          new Promise<TurboResponse>((resolve) => {
            pending = { request, resolve }
          }),
      },
      { next: () => "request-1" },
    )
    const load = loader.load("/pending", owner)

    loader.cancel(Object.freeze({}))
    expect(pending?.request.signal?.aborted).toBe(false)
    loader.cancel(owner)
    expect(pending?.request.signal?.aborted).toBe(true)
    pending?.resolve(
      response('<Gallery><Late id="late" /></Gallery>', {
        url: "https://example.test/pending",
      }),
    )

    expect(await load).toEqual({
      requestId: "request-1",
      requestedUrl: "https://example.test/pending",
      status: "canceled",
      url: "https://example.test/pending",
    })
    expect(session.tree.getElementById("old")?.tagName).toBe("Old")
  })

  test("preserves newer work started reentrantly by explicit cancellation", async () => {
    const pending: Array<{
      request: TurboRequest
      resolve: (response: TurboResponse) => void
    }> = []
    const session = documentSession()
    const owner = Object.freeze({})
    let requestId = 0
    const loader = new DocumentRequestLoader(
      session,
      {
        fetch: (request) =>
          new Promise<TurboResponse>((resolve) => {
            pending.push({ request, resolve })
          }),
      },
      { next: () => `request-${++requestId}` },
    )
    const older = loader.load("/older", owner)
    let newer: Promise<unknown> | undefined
    pending[0]?.request.signal?.addEventListener(
      "abort",
      () => {
        newer = loader.load("/newer", owner)
      },
      { once: true },
    )

    loader.cancel(owner)
    expect(pending).toHaveLength(2)
    expect(pending[1]?.request.signal?.aborted).toBe(false)
    pending[1]?.resolve(
      response('<Gallery><Newer id="newer" /></Gallery>', {
        url: "https://example.test/newer",
      }),
    )
    expect(await newer).toMatchObject({ status: "committed" })
    pending[0]?.resolve(
      response('<Gallery><Older id="older" /></Gallery>', {
        url: "https://example.test/older",
      }),
    )
    expect(await older).toMatchObject({ status: "canceled" })
    expect(session.tree.getElementById("newer")).toBeDefined()
    expect(session.tree.getElementById("older")).toBeUndefined()
  })

  test("rejects transport, policy, MIME, and parse failures without changing the document", async () => {
    const fixtures: ReadonlyArray<{
      error: typeof ContentTypeError | typeof ParseError | typeof RequestError | typeof TargetError
      fetch: () => Promise<TurboResponse>
      name: string
    }> = [
      {
        error: ContentTypeError,
        fetch: async () =>
          response("{}", {
            headers: { "Content-Type": "application/json" },
          }),
        name: "wrong MIME",
      },
      {
        error: ContentTypeError,
        fetch: async () =>
          response("<Gallery />", {
            headers: {},
            status: 201,
          }),
        name: "non-empty 201 without XML MIME",
      },
      {
        error: ParseError,
        fetch: async () => response("<Gallery>"),
        name: "malformed XML",
      },
      {
        error: RequestError,
        fetch: async () => Promise.reject(new Error("network unavailable")),
        name: "network failure",
      },
      {
        error: RequestError,
        fetch: async () => response("", { headers: {}, status: 302 }),
        name: "unfollowed redirect",
      },
      {
        error: TargetError,
        fetch: async () =>
          response("<Gallery><Redirected /></Gallery>", {
            redirected: true,
            url: "https://outside.test/redirected",
          }),
        name: "cross-origin redirect",
      },
      {
        error: RequestError,
        fetch: async () => response("<Gallery><MissingUrl /></Gallery>", { url: "" }),
        name: "missing final URL",
      },
    ]

    for (const fixture of fixtures) {
      const session = documentSession()
      const tree = session.tree
      let callbackCalls = 0
      const loader = new DocumentRequestLoader(
        session,
        { fetch: fixture.fetch },
        { next: () => `request-${fixture.name}` },
      )

      await expect(
        loader.load("/failure", undefined, {
          beforeTreeCommit() {
            callbackCalls += 1
          },
        }),
      ).rejects.toBeInstanceOf(fixture.error)
      expect(callbackCalls, fixture.name).toBe(0)
      expect(session.tree, fixture.name).toBe(tree)
      expect(session.revision, fixture.name).toBe(0)
    }

    let requests = 0
    const session = documentSession()
    const loader = new DocumentRequestLoader(
      session,
      {
        fetch: async () => {
          requests += 1
          return response("<Gallery />")
        },
      },
      { next: () => "request-external" },
    )
    await expect(loader.load("https://outside.test/document")).rejects.toBeInstanceOf(TargetError)
    expect(requests).toBe(0)
  })

  test("rejects opaque, credential-bearing, and invalid URLs without retaining their input", async () => {
    const fixtures = [
      {
        documentUrl: "file:///app/current.xml",
        source: "data:text/plain,secret-token",
      },
      {
        documentUrl: "https://example.test/current",
        source: "https://user:secret-token@example.test/next",
      },
      {
        documentUrl: "https://example.test/current",
        source: "https://%secret-token",
      },
    ] as const

    for (const fixture of fixtures) {
      let requests = 0
      const session = new DocumentSession(
        parseExpoTurboDocument("<Gallery />", { url: fixture.documentUrl }),
      )
      const loader = new DocumentRequestLoader(
        session,
        {
          fetch: async () => {
            requests += 1
            return response("<Gallery />")
          },
        },
        { next: () => "request-1" },
      )

      try {
        await loader.load(fixture.source)
        throw new Error("expected URL admission to fail")
      } catch (error) {
        expect(error).toBeInstanceOf(TargetError)
        if (!(error instanceof TargetError)) throw error
        expect(error.cause).toBeUndefined()
        expect(String(error)).not.toContain("secret-token")
        expect(JSON.stringify(error.context)).not.toContain("secret-token")
      }
      expect(requests).toBe(0)
    }
  })

  test("wraps an owned response-body failure with redacted request context", async () => {
    const cause = new Error("fixture body failure")
    const session = documentSession()
    const tree = session.tree
    const loader = new DocumentRequestLoader(
      session,
      {
        fetch: async () =>
          response("", {
            status: 500,
            text: async () => Promise.reject(cause),
          }),
      },
      { next: () => "request-1" },
    )

    try {
      await loader.load("/failure")
      throw new Error("expected the document load to fail")
    } catch (error) {
      expect(error).toBeInstanceOf(RequestError)
      if (!(error instanceof RequestError)) throw error
      expect(error.context).toEqual({ method: "GET", responseStatus: 500 })
      expect(error.cause).toBeUndefined()
    }
    expect(session.tree).toBe(tree)
    expect(session.revision).toBe(0)
  })

  test("does not cancel a valid request when a newer source fails admission", async () => {
    let pending:
      | Readonly<{
          request: TurboRequest
          resolve: (response: TurboResponse) => void
        }>
      | undefined
    const session = documentSession()
    const loader = new DocumentRequestLoader(
      session,
      {
        fetch: (request) =>
          new Promise<TurboResponse>((resolve) => {
            pending = { request, resolve }
          }),
      },
      { next: () => "request-1" },
    )
    const valid = loader.load("/valid")

    await expect(loader.load("https://outside.test/invalid")).rejects.toBeInstanceOf(TargetError)
    expect(pending?.request.signal?.aborted).toBe(false)
    pending?.resolve(
      response('<Gallery><Valid id="valid" /></Gallery>', {
        url: "https://example.test/valid",
      }),
    )

    expect(await valid).toMatchObject({ status: "committed" })
    expect(session.tree.getElementById("valid")?.tagName).toBe("Valid")
  })

  test("applies configured parser limits before committing a response", async () => {
    const session = documentSession()
    const tree = session.tree
    const loader = new DocumentRequestLoader(
      session,
      {
        fetch: async () => response('<Gallery><Result id="result" /></Gallery>'),
      },
      { next: () => "request-1" },
      { limits: { maxBytes: 16 } },
    )

    await expect(loader.load("/limited")).rejects.toBeInstanceOf(ParseError)
    expect(session.tree).toBe(tree)
    expect(session.revision).toBe(0)
  })

  test("reports a safe committed outcome when session finalization fails", async () => {
    const fixtures = [
      { classification: "success", status: 200 },
      { classification: "client-error", status: 422 },
    ] as const

    for (const fixture of fixtures) {
      const session = documentSession()
      let commitCallbacks = 0
      session.registerDisposal("id:old", () => {
        throw new Error("fixture disposal failed with secret-token")
      })
      const loader = new DocumentRequestLoader(
        session,
        {
          fetch: async () =>
            response('<Gallery><Committed id="committed" /></Gallery>', {
              status: fixture.status,
              url: `https://example.test/committed/${fixture.status}`,
            }),
        },
        { next: () => "request-1" },
      )

      try {
        await loader.load("/committed", undefined, {
          beforeTreeCommit() {
            commitCallbacks += 1
          },
        })
        throw new Error("expected session finalization to fail")
      } catch (error) {
        expect(error).toBeInstanceOf(DocumentCommitError)
        if (!(error instanceof DocumentCommitError)) throw error
        expect(error.context).toEqual({ method: "GET", responseStatus: fixture.status })
        expect(error.outcome).toEqual({
          classification: fixture.classification,
          redirected: true,
          responseStatus: fixture.status,
          status: "committed",
        })
        expect(error.cause).toBeUndefined()
        expect(String(error)).not.toContain("secret-token")
      }
      expect(session.tree.getElementById("old")).toBeUndefined()
      expect(session.tree.getElementById("committed")?.tagName).toBe("Committed")
      expect(session.tree.document.url).toBe(`https://example.test/committed/${fixture.status}`)
      expect(commitCallbacks).toBe(1)
    }
  })
})
