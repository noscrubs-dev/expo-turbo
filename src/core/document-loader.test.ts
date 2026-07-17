import { describe, expect, test } from "bun:test"

import type { TurboRequest, TurboResponse } from "../adapters"
import { DocumentCommitError, DocumentRequestLoader } from "./document-loader"
import { ContentTypeError, ParseError, RequestError, TargetError } from "./errors"
import { EXPO_TURBO_MIME_TYPE } from "./frame-loader"
import { parseExpoTurboDocument } from "./parser"
import { DocumentSession } from "./session"
import { attributeValue } from "./tree"

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
      const loader = new DocumentRequestLoader(
        session,
        { fetch: fixture.fetch },
        { next: () => `request-${fixture.name}` },
      )

      await expect(loader.load("/failure")).rejects.toBeInstanceOf(fixture.error)
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
        await loader.load("/committed")
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
    }
  })
})
