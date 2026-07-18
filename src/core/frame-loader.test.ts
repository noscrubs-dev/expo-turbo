import { describe, expect, test } from "bun:test"

import type { TurboRequest, TurboResponse } from "../adapters"
import { ContentTypeError, TargetError } from "./errors"
import { EXPO_TURBO_MIME_TYPE, FrameRequestLoader } from "./frame-loader"
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
    const older = loader.load("details", "/older", owner)
    let newer: Promise<unknown> | undefined
    pending[0]?.request.signal?.addEventListener(
      "abort",
      () => {
        newer = loader.load("details", "/newer", owner)
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
})
