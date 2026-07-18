import { describe, expect, test } from "bun:test"

import type { TurboRequest, TurboResponse } from "../adapters"
import { DocumentRequestLoader } from "./document-loader"
import { ContentTypeError, ParseError, RequestError, StateError, TargetError } from "./errors"
import { FRAME_HISTORY_PLAN_OPTION } from "./frame-history"
import { EXPO_TURBO_MIME_TYPE, FrameCommitError, FrameRequestLoader } from "./frame-loader"
import { parseExpoTurboDocument } from "./parser"
import { DocumentSession } from "./session"
import { attributeValue, isElement } from "./tree"

function documentSession(): DocumentSession {
  return new DocumentSession(
    parseExpoTurboDocument(
      '<Gallery><turbo-frame id="details" src="/old"><Loading /></turbo-frame></Gallery>',
      { url: "https://example.test/page" },
    ),
  )
}

function response(xml: string, options: Partial<TurboResponse> = {}): TurboResponse {
  return {
    headers: { "Content-Type": `${EXPO_TURBO_MIME_TYPE}; charset=utf-8` },
    redirected: false,
    status: 200,
    text: async () => xml,
    url: "https://example.test/frame",
    ...options,
  }
}

describe("Frame request loader", () => {
  test("sends the protocol request contract and commits handled redirected responses", async () => {
    const requests: TurboRequest[] = []
    const session = documentSession()
    const loader = new FrameRequestLoader(
      session,
      {
        async fetch(request) {
          requests.push(request)
          return response('<turbo-frame id="details"><Loaded /></turbo-frame>', {
            redirected: true,
            status: 422,
            url: "https://example.test/final",
          })
        },
      },
      { next: () => "request-1" },
      { capabilityHash: "sha256:capabilities" },
    )

    const report = await loader.load("details", "/frame")
    const frame = session.tree.getElementById("details")
    if (!frame) throw new Error("fixture lost its active frame")

    expect(requests[0]).toMatchObject({
      headers: {
        Accept: EXPO_TURBO_MIME_TYPE,
        "Turbo-Frame": "details",
        "X-Expo-Turbo-Capabilities": "sha256:capabilities",
        "X-Turbo-Request-Id": "request-1",
      },
      method: "GET",
      url: "https://example.test/frame",
    })
    expect(report).toMatchObject({ responseStatus: 422, status: "completed" })
    expect(session.recentRequestIds.has("request-1")).toBe(true)
    expect(attributeValue(frame, "src")).toBe("https://example.test/final")
    expect(frame.children.filter(isElement)[0]?.tagName).toBe("Loaded")
  })

  test("rejects cross-origin requests and wrong response content types", async () => {
    const loader = new FrameRequestLoader(
      documentSession(),
      { fetch: async () => response("", { headers: { "content-type": "application/json" } }) },
      { next: () => "request-1" },
    )

    await expect(loader.load("details", "https://invalid.test/frame")).rejects.toBeInstanceOf(
      TargetError,
    )
    await expect(loader.load("details", "/frame")).rejects.toBeInstanceOf(ContentTypeError)
  })

  test("treats 204 as an empty successful frame response", async () => {
    const session = documentSession()
    const frame = session.tree.getElementById("details")
    const children = frame?.children
    const loader = new FrameRequestLoader(
      session,
      { fetch: async () => response("", { headers: {}, status: 204 }) },
      { next: () => "request-1" },
    )

    expect(await loader.load("details", "/frame")).toMatchObject({ status: "empty" })
    expect(frame?.children).toBe(children)
  })

  test("forwards embedded refresh Streams to the configured session coordinator", async () => {
    const session = documentSession()
    const refreshes: unknown[] = []
    const loader = new FrameRequestLoader(
      session,
      {
        fetch: async () =>
          response(
            '<turbo-frame id="details"><turbo-stream action="refresh" request-id="frame-origin"/></turbo-frame>',
          ),
      },
      { next: () => "frame-request" },
      { refresh: { request: (request) => refreshes.push(request) } },
    )

    const report = await loader.load("details", "/frame")

    expect(report.frame?.streams.actions).toEqual([
      {
        action: "refresh",
        appliedTargets: 0,
        index: 0,
        matchedTargets: 0,
        status: "applied",
      },
    ])
    expect(refreshes).toEqual([{ baseUrl: "https://example.test/page", requestId: "frame-origin" }])
  })

  test("supersedes an older request even when its adapter resolves late", async () => {
    const pending: Array<(response: TurboResponse) => void> = []
    const session = documentSession()
    let request = 0
    const loader = new FrameRequestLoader(
      session,
      {
        fetch: () =>
          new Promise<TurboResponse>((resolve) => {
            pending.push(resolve)
          }),
      },
      { next: () => `request-${++request}` },
    )

    const older = loader.load("details", "/older")
    const newer = loader.load("details", "/newer")
    pending[1]?.(response('<turbo-frame id="details"><Newer /></turbo-frame>'))
    expect(await newer).toMatchObject({ status: "completed" })
    pending[0]?.(response('<turbo-frame id="details"><Older /></turbo-frame>'))
    expect(await older).toMatchObject({ status: "canceled" })
    expect(session.tree.getElementById("details")?.children.filter(isElement)[0]?.tagName).toBe(
      "Newer",
    )
  })

  test("preserves newer work started reentrantly by explicit cancellation", async () => {
    const pending: Array<{
      request: TurboRequest
      resolve: (response: TurboResponse) => void
    }> = []
    const session = documentSession()
    const owner = Object.freeze({})
    let requestId = 0
    const loader = new FrameRequestLoader(
      session,
      {
        fetch: (request) =>
          new Promise<TurboResponse>((resolve) => {
            pending.push({ request, resolve })
          }),
      },
      { next: () => `request-${++requestId}` },
    )
    const older = loader.load("details", "/older", { owner })
    let newer: Promise<unknown> | undefined
    pending[0]?.request.signal?.addEventListener(
      "abort",
      () => {
        newer = loader.load("details", "/newer", { owner })
      },
      { once: true },
    )

    loader.cancel("details", owner)
    expect(pending).toHaveLength(2)
    expect(pending[1]?.request.signal?.aborted).toBe(false)
    pending[1]?.resolve(response('<turbo-frame id="details"><Newer /></turbo-frame>'))
    expect(await newer).toMatchObject({ status: "completed" })
    pending[0]?.resolve(response('<turbo-frame id="details"><Older /></turbo-frame>'))
    expect(await older).toMatchObject({ status: "canceled" })
    expect(session.tree.getElementById("details")?.children.filter(isElement)[0]?.tagName).toBe(
      "Newer",
    )
  })

  test("does not revive a Frame request when its old tree object is restored", async () => {
    let pending:
      | Readonly<{
          request: TurboRequest
          resolve: (response: TurboResponse) => void
        }>
      | undefined
    const session = documentSession()
    const originalTree = session.tree
    const originalFrame = session.tree.getElementById("details")
    const loader = new FrameRequestLoader(
      session,
      {
        fetch: (request) =>
          new Promise<TurboResponse>((resolve) => {
            pending = { request, resolve }
          }),
      },
      { next: () => "request-1" },
    )
    const loading = loader.load("details", "/pending")

    session.replaceTree(
      parseExpoTurboDocument('<Gallery><turbo-frame id="details" /></Gallery>', {
        url: "https://example.test/replacement",
      }),
    )
    session.replaceTree(originalTree)
    pending?.resolve(response('<turbo-frame id="details"><Late /></turbo-frame>'))

    expect(await loading).toMatchObject({ status: "canceled" })
    expect(session.tree).toBe(originalTree)
    expect(session.tree.getElementById("details")).toBe(originalFrame)
    expect(originalFrame?.children.filter(isElement)[0]?.tagName).toBe("Loading")
  })

  test("loads a matching frame through a recurse intermediary", async () => {
    const requests: TurboRequest[] = []
    const session = documentSession()
    let requestId = 0
    const loader = new FrameRequestLoader(
      session,
      {
        async fetch(request) {
          requests.push(request)
          if (requests.length === 1) {
            return response(
              '<Page><turbo-frame id="bridge" src="nested" recurse="other  details\ttarget" /></Page>',
              { status: 422, url: "https://example.test/redirected/index" },
            )
          }
          return response('<Page><turbo-frame id="details"><Recursive /></turbo-frame></Page>', {
            url: "https://example.test/redirected/nested",
          })
        },
      },
      { next: () => `request-${++requestId}` },
    )

    const report = await loader.load("details", "/initial")
    const frame = session.tree.getElementById("details")
    if (!frame) throw new Error("fixture lost its active frame")

    expect(requests.map((request) => request.url)).toEqual([
      "https://example.test/initial",
      "https://example.test/redirected/nested",
    ])
    expect(requests.map((request) => request.headers["Turbo-Frame"])).toEqual(["details", "bridge"])
    expect(report).toMatchObject({
      requestId: "request-1",
      requestIds: ["request-1", "request-2"],
      responseStatus: 422,
      status: "completed",
      url: "https://example.test/redirected/index",
    })
    expect(session.recentRequestIds.has("request-1")).toBe(true)
    expect(session.recentRequestIds.has("request-2")).toBe(true)
    expect(attributeValue(frame, "src")).toBe("https://example.test/redirected/index")
    expect(frame.children.filter(isElement)[0]?.tagName).toBe("Recursive")
  })

  test("rejects recurse URL loops and depth overflow without changing the active frame", async () => {
    const loopSession = documentSession()
    const loopFrame = loopSession.tree.getElementById("details")
    const loopChildren = loopFrame?.children
    const loopLoader = new FrameRequestLoader(
      loopSession,
      {
        fetch: async () =>
          response('<Page><turbo-frame id="loop" src="/frame" recurse="details" /></Page>'),
      },
      { next: () => "loop-request" },
    )

    await expect(loopLoader.load("details", "/frame")).rejects.toThrow("recurse URL loop")
    expect(loopFrame?.children).toBe(loopChildren)

    const depthSession = documentSession()
    const depthFrame = depthSession.tree.getElementById("details")
    const depthChildren = depthFrame?.children
    let request = 0
    const depthLoader = new FrameRequestLoader(
      depthSession,
      {
        fetch: async () => {
          request += 1
          return response(
            `<Page><turbo-frame id="bridge-${request}" src="/depth-${request}" recurse="details" /></Page>`,
            { url: `https://example.test/depth-response-${request}` },
          )
        },
      },
      { next: () => `depth-request-${request}` },
      { maxRecurseDepth: 1 },
    )

    await expect(depthLoader.load("details", "/depth-start")).rejects.toThrow("recurse depth 1")
    expect(request).toBe(2)
    expect(depthFrame?.children).toBe(depthChildren)
  })

  test("rejects a cross-origin redirect before parsing its frame", async () => {
    const loader = new FrameRequestLoader(
      documentSession(),
      {
        fetch: async () =>
          response('<turbo-frame id="details"><Unsafe /></turbo-frame>', {
            url: "https://invalid.test/frame",
          }),
      },
      { next: () => "request-1" },
    )

    await expect(loader.load("details", "/frame")).rejects.toBeInstanceOf(TargetError)
  })

  test("supersedes an in-flight recurse request without committing its late match", async () => {
    const pending: Array<{
      request: TurboRequest
      resolve: (response: TurboResponse) => void
    }> = []
    const session = documentSession()
    let requestId = 0
    const loader = new FrameRequestLoader(
      session,
      {
        fetch: (request) =>
          new Promise<TurboResponse>((resolve) => {
            pending.push({ request, resolve })
          }),
      },
      { next: () => `request-${++requestId}` },
    )

    const older = loader.load("details", "/older")
    pending[0]?.resolve(
      response('<Page><turbo-frame id="bridge" src="/older-nested" recurse="details" /></Page>'),
    )
    await Promise.resolve()
    await Promise.resolve()
    expect(pending).toHaveLength(2)

    const newer = loader.load("details", "/newer")
    expect(pending[1]?.request.signal?.aborted).toBe(true)
    pending[2]?.resolve(response('<turbo-frame id="details"><Newer /></turbo-frame>'))
    expect(await newer).toMatchObject({ status: "completed" })
    pending[1]?.resolve(response('<turbo-frame id="details"><Older /></turbo-frame>'))
    expect(await older).toMatchObject({
      requestIds: ["request-1", "request-2"],
      status: "canceled",
    })
    expect(session.tree.getElementById("details")?.children.filter(isElement)[0]?.tagName).toBe(
      "Newer",
    )
  })

  test("preflights recurse once and exposes one frozen final-ownership candidate", async () => {
    const requests: TurboRequest[] = []
    const session = new DocumentSession(
      parseExpoTurboDocument(
        '<Gallery><Outside id="outside" /><turbo-frame id="details" src="/old"><Old /></turbo-frame></Gallery>',
        { url: "https://example.test/page" },
      ),
    )
    const frame = session.tree.getElementById("details")
    const outside = session.tree.getElementById("outside")
    if (frame?.kind !== "frame" || !outside) throw new Error("invalid fixture")
    const owner = Object.freeze({})
    let requestId = 0
    let callbackCalls = 0
    const loader = new FrameRequestLoader(
      session,
      {
        async fetch(request) {
          requests.push(request)
          return requests.length === 1
            ? response('<Page><turbo-frame id="bridge" src="nested" recurse="details" /></Page>', {
                url: "https://example.test/redirected/index",
              })
            : response('<Page><turbo-frame id="details"><Loaded /></turbo-frame></Page>', {
                url: "https://example.test/redirected/nested",
              })
        },
      },
      { next: () => `request-${++requestId}` },
    )

    const report = await loader.load("details", "/initial", {
      beforeFrameCommit(candidate) {
        callbackCalls += 1
        expect(Object.isFrozen(candidate)).toBe(true)
        expect(Object.isFrozen(candidate.requestIds)).toBe(true)
        expect(candidate).toEqual({
          frameId: "details",
          redirected: true,
          requestId: "request-1",
          requestIds: ["request-1", "request-2"],
          requestedUrl: "https://example.test/initial",
          responseStatus: 200,
          url: "https://example.test/redirected/index",
        })
        expect(session.tree.getElementById("details")).toBe(frame)
        expect(session.tree.getElementById("outside")).toBe(outside)
        expect(attributeValue(frame, "src")).toBe("/old")
        expect(frame.children.filter(isElement)[0]?.tagName).toBe("Old")
        expect(loader.cancel("details", owner)).toBe(false)
        return undefined
      },
      owner,
    })

    expect(callbackCalls).toBe(1)
    expect(report).toMatchObject({ requestIds: ["request-1", "request-2"], status: "completed" })
    expect(session.tree.getElementById("details")).toBe(frame)
    expect(session.tree.getElementById("outside")).toBe(outside)
    expect(attributeValue(frame, "src")).toBe("https://example.test/redirected/index")
    expect(frame.children.filter(isElement)[0]?.tagName).toBe("Loaded")
  })

  test("rejects active-document ID collisions before the commit callback and remains retryable", async () => {
    const session = new DocumentSession(
      parseExpoTurboDocument(
        '<Gallery><Outside id="collision" /><turbo-frame id="details" src="/old"><Old /></turbo-frame></Gallery>',
        { url: "https://example.test/page" },
      ),
    )
    const frame = session.tree.getElementById("details")
    const children = frame?.children
    let fetches = 0
    let callbackCalls = 0
    const loader = new FrameRequestLoader(
      session,
      {
        fetch: async () => {
          fetches += 1
          return response(
            fetches === 1
              ? '<turbo-frame id="details"><Collision id="collision" /></turbo-frame>'
              : '<turbo-frame id="details"><Recovered id="recovered" /></turbo-frame>',
          )
        },
      },
      { next: () => `request-${fetches + 1}` },
    )

    await expect(
      loader.load("details", "/collision", {
        beforeFrameCommit() {
          callbackCalls += 1
          return undefined
        },
      }),
    ).rejects.toBeInstanceOf(ParseError)
    expect(callbackCalls).toBe(0)
    expect(session.revision).toBe(0)
    expect(frame?.children).toBe(children)
    expect(attributeValue(frame as never, "src")).toBe("/old")

    expect(await loader.load("details", "/recovered")).toMatchObject({ status: "completed" })
    expect(session.tree.getElementById("recovered")).toBeDefined()
  })

  test("blocks same-session request reentrancy during the Frame commit callback", async () => {
    const session = new DocumentSession(
      parseExpoTurboDocument(
        '<Gallery><turbo-frame id="details"><Old /></turbo-frame><turbo-frame id="peer"><Peer /></turbo-frame></Gallery>',
        { url: "https://example.test/page" },
      ),
    )
    const owner = Object.freeze({})
    const frameRequests: TurboRequest[] = []
    const documentRequests: TurboRequest[] = []
    let requestId = 0
    const loader = new FrameRequestLoader(
      session,
      {
        fetch: async (request) => {
          frameRequests.push(request)
          return response('<turbo-frame id="details"><Committed /></turbo-frame>')
        },
      },
      { next: () => `frame-${++requestId}` },
    )
    const documentLoader = new DocumentRequestLoader(
      session,
      {
        fetch: async (request) => {
          documentRequests.push(request)
          return response("<Gallery><Document /></Gallery>")
        },
      },
      { next: () => "document-1" },
    )
    const reentrant: Promise<unknown>[] = []

    const report = await loader.load("details", "/outer", {
      beforeFrameCommit() {
        reentrant.push(
          loader.load("details", "/same").then(
            () => undefined,
            (error) => error,
          ),
          loader.load("peer", "/peer").then(
            () => undefined,
            (error) => error,
          ),
          documentLoader.load("/document").then(
            () => undefined,
            (error) => error,
          ),
        )
        expect(loader.cancel("details", owner)).toBe(false)
        return undefined
      },
      owner,
    })

    expect(report).toMatchObject({ status: "completed" })
    expect(frameRequests).toHaveLength(1)
    expect(documentRequests).toHaveLength(0)
    expect(await Promise.all(reentrant)).toEqual([
      expect.any(StateError),
      expect.any(StateError),
      expect.any(StateError),
    ])
    expect(session.tree.getElementById("details")?.children.filter(isElement)[0]?.tagName).toBe(
      "Committed",
    )
  })

  test("redacts callback failures and rejects returned values before mutation", async () => {
    const callbacks: Array<(candidate: unknown) => undefined> = [
      (() => {
        throw new Error("secret callback payload")
      }) as never,
      (() => "secret scalar") as never,
      (async () => {
        throw new Error("secret asynchronous callback payload")
      }) as never,
    ]

    for (const beforeFrameCommit of callbacks) {
      const session = documentSession()
      const frame = session.tree.getElementById("details")
      const children = frame?.children
      const loader = new FrameRequestLoader(
        session,
        { fetch: async () => response('<turbo-frame id="details"><Blocked /></turbo-frame>') },
        { next: () => "request-1" },
      )

      let error: unknown
      try {
        await loader.load("details", "/blocked", { beforeFrameCommit })
      } catch (caught) {
        error = caught
      }
      expect(error).toBeInstanceOf(RequestError)
      expect((error as Error).message).not.toContain("secret")
      expect(session.revision).toBe(0)
      expect(frame?.children).toBe(children)
      expect(attributeValue(frame as never, "src")).toBe("/old")
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(await loader.load("details", "/retry")).toMatchObject({ status: "completed" })
    }
  })

  test("lets finalization start newer Frame work and interrupts stale embedded Streams", async () => {
    const pending: Array<{
      request: TurboRequest
      resolve: (response: TurboResponse) => void
    }> = []
    const session = new DocumentSession(
      parseExpoTurboDocument(
        '<Gallery><List id="list" /><turbo-frame id="details"><Old /></turbo-frame></Gallery>',
        { url: "https://example.test/page" },
      ),
    )
    let requestId = 0
    const loader = new FrameRequestLoader(
      session,
      {
        fetch: (request) =>
          new Promise<TurboResponse>((resolve) => pending.push({ request, resolve })),
      },
      { next: () => `request-${++requestId}` },
    )
    let newer: ReturnType<FrameRequestLoader["load"]> | undefined
    session.subscribe("id:details", () => {
      newer ??= loader.load("details", "/newer")
    })

    const older = loader.load("details", "/older")
    pending[0]?.resolve(
      response(
        '<turbo-frame id="details"><Older /><turbo-stream action="append" target="list"><template><Stale id="stale" /></template></turbo-stream></turbo-frame>',
      ),
    )

    expect(await older).toMatchObject({
      frame: { streams: { actions: [], interrupted: true } },
      status: "completed",
    })
    expect(session.tree.getElementById("stale")).toBeUndefined()
    expect(pending).toHaveLength(2)
    expect(pending[1]?.request.signal?.aborted).toBe(false)
    pending[1]?.resolve(response('<turbo-frame id="details"><Newer /></turbo-frame>'))
    expect(await newer).toMatchObject({ status: "completed" })
    expect(session.tree.getElementById("details")?.children.filter(isElement)[0]?.tagName).toBe(
      "Newer",
    )
  })

  test("reports committed Frame truth when synchronous finalization fails", async () => {
    const session = documentSession()
    const frame = session.tree.getElementById("details")
    const oldChild = frame?.children[0]
    if (!frame || !oldChild) throw new Error("invalid fixture")
    session.registerDisposal(oldChild.key, () => {
      throw new Error("secret disposal failure")
    })
    const loader = new FrameRequestLoader(
      session,
      {
        fetch: async () =>
          response('<turbo-frame id="details"><Committed id="committed" /></turbo-frame>', {
            redirected: true,
            status: 422,
            url: "https://example.test/final",
          }),
      },
      { next: () => "request-1" },
    )

    let error: unknown
    try {
      await loader.load("details", "/frame")
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(FrameCommitError)
    expect((error as FrameCommitError).outcome).toEqual({
      frameId: "details",
      redirected: true,
      requestId: "request-1",
      requestIds: ["request-1"],
      requestedUrl: "https://example.test/frame",
      responseStatus: 422,
      status: "completed",
      url: "https://example.test/final",
    })
    expect(session.tree.getElementById("committed")).toBeDefined()
    expect(attributeValue(frame, "src")).toBe("https://example.test/final")
  })

  test("never invokes the commit callback for empty or inadmissible responses", async () => {
    const fixtures: TurboResponse[] = [
      response("", { headers: {}, status: 204 }),
      response('<turbo-frame id="other" />'),
      response("<turbo-frame", { headers: { "Content-Type": EXPO_TURBO_MIME_TYPE } }),
      response('<turbo-frame id="details" />', {
        headers: { "Content-Type": "application/json" },
      }),
    ]

    for (const fixture of fixtures) {
      let callbackCalls = 0
      const loader = new FrameRequestLoader(
        documentSession(),
        { fetch: async () => fixture },
        { next: () => "request-1" },
      )
      const loading = loader.load("details", "/frame", {
        beforeFrameCommit() {
          callbackCalls += 1
          return undefined
        },
      })
      if (fixture.status === 204) expect(await loading).toMatchObject({ status: "empty" })
      else await expect(loading).rejects.toBeInstanceOf(Error)
      expect(callbackCalls).toBe(0)
    }
  })

  test("rejects invalid load options without disturbing admitted work", async () => {
    let pending:
      | Readonly<{ request: TurboRequest; resolve: (response: TurboResponse) => void }>
      | undefined
    const loader = new FrameRequestLoader(
      documentSession(),
      {
        fetch: (request) =>
          new Promise<TurboResponse>((resolve) => {
            pending = { request, resolve }
          }),
      },
      { next: () => "request-1" },
    )
    const admitted = loader.load("details", "/admitted")
    let accessorCalls = 0
    const accessorOptions = Object.defineProperty({}, "beforeFrameCommit", {
      get() {
        accessorCalls += 1
        throw new Error("secret option payload")
      },
    }) as never
    const proxyOptions = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("secret proxy payload")
        },
      },
    ) as never

    await expect(
      loader.load("details", "/invalid", { unexpected: true } as never),
    ).rejects.toBeInstanceOf(RequestError)
    await expect(loader.load("details", "/accessor", accessorOptions)).rejects.toMatchObject({
      message: "Frame load options must use data properties",
    })
    expect(accessorCalls).toBe(0)
    await expect(loader.load("details", "/proxy", proxyOptions)).rejects.toMatchObject({
      message: "Frame load options could not be read",
    })
    await expect(
      loader.load("details", "/forged-history", {
        [FRAME_HISTORY_PLAN_OPTION]: Object.freeze({}),
      } as never),
    ).rejects.toMatchObject({ message: "Frame history commit plan is invalid" })
    expect(pending?.request.signal?.aborted).toBe(false)
    pending?.resolve(response('<turbo-frame id="details"><Admitted /></turbo-frame>'))
    expect(await admitted).toMatchObject({ status: "completed" })
  })
})
