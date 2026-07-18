import { describe, expect, test } from "bun:test"

import type { TurboRequest, TurboResponse } from "../adapters"
import {
  DocumentCommitError,
  DocumentRequestLoader,
  type DocumentTreeCommitCandidate,
} from "./document-loader"
import { ContentTypeError, ParseError, RequestError, StateError, TargetError } from "./errors"
import { EXPO_TURBO_MIME_TYPE } from "./frame-loader"
import { parseExpoTurboDocument } from "./parser"
import { DocumentSession } from "./session"
import { attributeValue, DocumentTree, type ProtocolDocument } from "./tree"

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
              text: () =>
                new Promise<string>((resolve) => {
                  olderBody = { resolve }
                }),
              url: request.url,
            })
          }
          return response('<Gallery><Newer id="newer" /></Gallery>', { url: request.url })
        },
      },
      { next: () => `request-${++requestId}` },
    )

    const older = loader.load("/older")
    await Promise.resolve()
    await Promise.resolve()
    if (!olderBody) throw new Error("fixture did not begin reading the older response")

    const newer = loader.load("/newer")
    expect(olderSignal?.aborted).toBe(true)
    olderBody.resolve('<Gallery><Older id="older" /></Gallery>')

    expect(await older).toMatchObject({ status: "canceled" })
    expect(await newer).toMatchObject({ status: "committed" })
    expect(session.tree.getElementById("older")).toBeUndefined()
    expect(session.tree.getElementById("newer")?.tagName).toBe("Newer")
  })

  test("reports an aborted response-body read as cancellation after supersession", async () => {
    let rejectOlderBody: ((error: Error) => void) | undefined
    const session = documentSession()
    let requestId = 0
    const loader = new DocumentRequestLoader(
      session,
      {
        async fetch(request) {
          if (request.url.endsWith("/older")) {
            return response("", {
              text: () =>
                new Promise<string>((_resolve, reject) => {
                  rejectOlderBody = reject
                }),
              url: request.url,
            })
          }
          return response('<Gallery><Newer id="newer" /></Gallery>', { url: request.url })
        },
      },
      { next: () => `request-${++requestId}` },
    )

    const older = loader.load("/older")
    await Promise.resolve()
    await Promise.resolve()
    if (!rejectOlderBody) throw new Error("fixture did not begin reading the older response")

    const newer = loader.load("/newer")
    rejectOlderBody(new Error("body read aborted"))

    expect(await older).toMatchObject({ status: "canceled" })
    expect(await newer).toMatchObject({ status: "committed" })
    expect(session.tree.getElementById("newer")?.tagName).toBe("Newer")
  })

  test("invalidates a response while its body is read when another owner replaces the document", async () => {
    let resolveBody: ((xml: string) => void) | undefined
    const session = documentSession()
    const loader = new DocumentRequestLoader(
      session,
      {
        fetch: async (request) =>
          response("", {
            text: () =>
              new Promise<string>((resolve) => {
                resolveBody = resolve
              }),
            url: request.url,
          }),
      },
      { next: () => "request-1" },
    )
    const load = loader.load("/pending")
    await Promise.resolve()
    await Promise.resolve()
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
