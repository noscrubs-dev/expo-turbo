import { describe, expect, test } from "bun:test"

import type { TurboRequest, TurboResponse } from "../adapters"
import { DocumentRequestLoader } from "./document-loader"
import {
  ContentTypeError,
  FrameMissingError,
  ParseError,
  PropsError,
  RequestError,
  StateError,
  TargetError,
} from "./errors"
import { FRAME_HISTORY_PLAN_OPTION } from "./frame-history"
import { FrameLifecycle } from "./frame-lifecycle"
import { EXPO_TURBO_MIME_TYPE, FrameCommitError, FrameRequestLoader } from "./frame-loader"
import { parseExpoTurboDocument } from "./parser"
import { RequestLifecycle } from "./request-lifecycle"
import { DocumentSession } from "./session"
import { StreamLifecycle } from "./stream-lifecycle"
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
  test("snapshots and validates the request lifecycle option", async () => {
    const lifecycle = new RequestLifecycle()
    let events = 0
    let reads = 0
    lifecycle.subscribe("before-fetch-request", () => {
      events += 1
    })
    const loader = new FrameRequestLoader(
      documentSession(),
      {
        fetch: async (request) =>
          response('<turbo-frame id="details"><Loaded /></turbo-frame>', { url: request.url }),
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
    expect(await loader.load("details", "/options")).toMatchObject({ status: "completed" })
    expect({ events, reads }).toEqual({ events: 1, reads: 1 })
    expect(
      () =>
        new FrameRequestLoader(
          documentSession(),
          { fetch: async () => Promise.reject(new Error("unused")) },
          { next: () => "unused" },
          { requestLifecycle: null } as never,
        ),
    ).toThrow(PropsError)
  })

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

  test("dispatches one typed Frame-missing event before the default error", async () => {
    const fixtures = [
      {
        redirected: false,
        source: "/missing-200",
        status: 200,
        url: "https://example.test/missing-200",
      },
      {
        redirected: true,
        source: "/missing-422",
        status: 422,
        url: "https://example.test/redirected-missing-422",
      },
    ] as const

    for (const fixture of fixtures) {
      const events: unknown[] = []
      const lifecycle = new FrameLifecycle()
      lifecycle.subscribe("frame-missing", (event) => {
        events.push({
          defaultPrevented: event.defaultPrevented,
          frameId: event.detail.frameId,
          response: event.detail.response,
          type: event.type,
        })
      })
      const loader = new FrameRequestLoader(
        documentSession(),
        {
          fetch: async () =>
            response("<Page><Missing /></Page>", {
              redirected: fixture.redirected,
              status: fixture.status,
              url: fixture.url,
            }),
        },
        { next: () => `request-${fixture.status}` },
        { frameLifecycle: lifecycle },
      )

      await expect(loader.load("details", fixture.source)).rejects.toBeInstanceOf(FrameMissingError)
      expect(events).toEqual([
        {
          defaultPrevented: false,
          frameId: "details",
          response: {
            redirected: fixture.redirected,
            status: fixture.status,
            url: fixture.url,
          },
          type: "frame-missing",
        },
      ])
    }
  })

  test("returns prevented without changing the active Frame", async () => {
    const session = documentSession()
    const frame = session.tree.getElementById("details")
    const children = frame?.children
    const lifecycle = new FrameLifecycle()
    lifecycle.subscribe("frame-missing", (event) => {
      event.preventDefault()
      return undefined
    })
    const loader = new FrameRequestLoader(
      session,
      { fetch: async () => response("<Page><Missing /></Page>") },
      { next: () => "request-prevented" },
      { frameLifecycle: lifecycle },
    )

    expect(await loader.load("details", "/frame")).toEqual({
      frameId: "details",
      requestId: "request-prevented",
      requestIds: ["request-prevented"],
      responseStatus: 200,
      status: "prevented",
      url: "https://example.test/frame",
    })
    expect(frame?.children).toBe(children)
    expect(attributeValue(frame as never, "src")).toBe("/old")
  })

  test("visits the buffered response after releasing Frame request ownership", async () => {
    const body = "<Page><Missing /></Page>"
    const visits: unknown[] = []
    let fetches = 0
    let ownershipReleased = false
    let loader!: FrameRequestLoader
    const lifecycle = new FrameLifecycle({
      visitResponse(request) {
        ownershipReleased = !loader.cancel("details")
        visits.push(request)
      },
    })
    lifecycle.subscribe("frame-missing", (event) => {
      event.detail.visit({ action: "replace" })
      event.preventDefault()
    })
    loader = new FrameRequestLoader(
      documentSession(),
      {
        fetch: async () => {
          fetches += 1
          return response(body, { url: "https://example.test/missing" })
        },
      },
      { next: () => "request-visit" },
      { frameLifecycle: lifecycle },
    )

    expect(await loader.load("details", "/missing")).toMatchObject({ status: "prevented" })
    expect({ fetches, ownershipReleased }).toEqual({ fetches: 1, ownershipReleased: true })
    expect(visits).toEqual([
      {
        action: "replace",
        body,
        frameId: "details",
        reason: "frame-missing",
        response: {
          redirected: false,
          status: 200,
          url: "https://example.test/missing",
        },
      },
    ])
  })

  test("uses the primary response when recurse lookup ends without a match", async () => {
    const primaryBody = '<Page><turbo-frame id="bridge" src="/nested" recurse="details" /></Page>'

    for (const terminal of ["missing", "empty"] as const) {
      const visits: unknown[] = []
      let events = 0
      let fetches = 0
      const lifecycle = new FrameLifecycle({
        visitResponse(request) {
          visits.push(request)
        },
      })
      lifecycle.subscribe("frame-missing", (event) => {
        events += 1
        event.detail.visit()
        event.preventDefault()
      })
      const loader = new FrameRequestLoader(
        documentSession(),
        {
          fetch: async () => {
            fetches += 1
            if (fetches === 1) {
              return response(primaryBody, {
                status: 422,
                url: "https://example.test/primary",
              })
            }
            return terminal === "empty"
              ? response("", {
                  headers: {},
                  status: 204,
                  url: "https://example.test/nested",
                })
              : response("<Page><StillMissing /></Page>", {
                  url: "https://example.test/nested",
                })
          },
        },
        { next: () => `request-${fetches + 1}` },
        { frameLifecycle: lifecycle },
      )

      expect(await loader.load("details", "/primary")).toMatchObject({
        requestIds: ["request-1", "request-2"],
        responseStatus: 422,
        status: "prevented",
        url: "https://example.test/primary",
      })
      expect({ events, fetches }).toEqual({ events: 1, fetches: 2 })
      expect(visits).toEqual([
        {
          action: "advance",
          body: primaryBody,
          frameId: "details",
          reason: "frame-missing",
          response: {
            redirected: false,
            status: 422,
            url: "https://example.test/primary",
          },
        },
      ])
    }
  })

  test("does not dispatch Frame-missing for direct or recursive matches", async () => {
    let events = 0
    const lifecycle = new FrameLifecycle()
    lifecycle.subscribe("frame-missing", () => {
      events += 1
    })

    const direct = new FrameRequestLoader(
      documentSession(),
      { fetch: async () => response('<turbo-frame id="details"><Direct /></turbo-frame>') },
      { next: () => "direct-request" },
      { frameLifecycle: lifecycle },
    )
    expect(await direct.load("details", "/direct")).toMatchObject({ status: "completed" })

    let fetches = 0
    const recursive = new FrameRequestLoader(
      documentSession(),
      {
        fetch: async () => {
          fetches += 1
          return fetches === 1
            ? response('<Page><turbo-frame id="bridge" src="/nested" recurse="details" /></Page>')
            : response('<Page><turbo-frame id="details"><Recursive /></turbo-frame></Page>')
        },
      },
      { next: () => `recursive-request-${fetches + 1}` },
      { frameLifecycle: lifecycle },
    )
    expect(await recursive.load("details", "/recursive")).toMatchObject({ status: "completed" })
    expect(events).toBe(0)
  })

  test("promotes exact root visit-control responses before matching Frame extraction", async () => {
    for (const status of [200, 422, 500]) {
      const session = documentSession()
      const frame = session.tree.getElementById("details")
      const children = frame?.children
      const visits: unknown[] = []
      let missingEvents = 0
      const body =
        '<Gallery data-turbo-visit-control="reload"><turbo-frame id="details"><Ignored /></turbo-frame></Gallery>'
      const lifecycle = new FrameLifecycle({
        visitResponse(request) {
          visits.push(request)
        },
      })
      lifecycle.subscribe("frame-missing", () => {
        missingEvents += 1
      })
      const loader = new FrameRequestLoader(
        session,
        {
          fetch: async () =>
            response(body, {
              redirected: true,
              status,
              url: `https://example.test/promoted-${status}`,
            }),
        },
        { next: () => `request-${status}` },
        { frameLifecycle: lifecycle },
      )

      expect(await loader.load("details", `/promoted-${status}`)).toEqual({
        frameId: "details",
        reason: "visit-control-reload",
        requestId: `request-${status}`,
        requestIds: [`request-${status}`],
        responseStatus: status,
        status: "promoted",
        url: `https://example.test/promoted-${status}`,
      })
      expect(frame?.children).toBe(children)
      expect(attributeValue(frame as never, "src")).toBe(`https://example.test/promoted-${status}`)
      expect(missingEvents).toBe(0)
      expect(visits).toEqual([
        {
          action: "advance",
          body,
          frameId: "details",
          reason: "visit-control-reload",
          response: {
            redirected: true,
            status,
            url: `https://example.test/promoted-${status}`,
          },
        },
      ])
    }
  })

  test("promotes recurse response bytes and metadata after releasing ownership", async () => {
    const primary = '<Gallery><turbo-frame id="bridge" src="/nested" recurse="details" /></Gallery>'
    const nested = '<Gallery data-turbo-visit-control="reload"><Nested /></Gallery>'
    const visits: unknown[] = []
    let fetches = 0
    let ownershipReleased = false
    let loader!: FrameRequestLoader
    const lifecycle = new FrameLifecycle({
      visitResponse(request) {
        ownershipReleased = !loader.cancel("details")
        visits.push(request)
      },
    })
    loader = new FrameRequestLoader(
      documentSession(),
      {
        fetch: async () => {
          fetches += 1
          return fetches === 1
            ? response(primary, { status: 422, url: "https://example.test/primary" })
            : response(nested, {
                redirected: true,
                status: 500,
                url: "https://example.test/nested-final",
              })
        },
      },
      { next: () => `request-${fetches + 1}` },
      { frameLifecycle: lifecycle },
    )

    expect(await loader.load("details", "/primary")).toEqual({
      frameId: "details",
      reason: "visit-control-reload",
      requestId: "request-1",
      requestIds: ["request-1", "request-2"],
      responseStatus: 500,
      status: "promoted",
      url: "https://example.test/nested-final",
    })
    expect({ fetches, ownershipReleased }).toEqual({ fetches: 2, ownershipReleased: true })
    expect(visits).toEqual([
      {
        action: "advance",
        body: nested,
        frameId: "details",
        reason: "visit-control-reload",
        response: {
          redirected: true,
          status: 500,
          url: "https://example.test/nested-final",
        },
      },
    ])
  })

  test("fails closed after releasing ownership when automatic promotion is unavailable", async () => {
    for (const frameLifecycle of [undefined, new FrameLifecycle()] as const) {
      const session = documentSession()
      const frame = session.tree.getElementById("details")
      const children = frame?.children
      const loader = new FrameRequestLoader(
        session,
        {
          fetch: async () =>
            response(
              '<Gallery data-turbo-visit-control="reload"><turbo-frame id="details"><Ignored /></turbo-frame></Gallery>',
              { url: "https://example.test/promoted" },
            ),
        },
        { next: () => "request-unavailable" },
        frameLifecycle ? { frameLifecycle } : {},
      )

      const error = await loader.load("details", "/promoted").catch((failure) => failure)
      expect(error).toBeInstanceOf(RequestError)
      expect(error.message).toBe("Frame visit-control response visit failed")
      expect(error.cause).toBeUndefined()
      expect(loader.cancel("details")).toBe(false)
      expect(frame?.children).toBe(children)
      expect(attributeValue(frame as never, "src")).toBe("https://example.test/promoted")
    }
  })

  test("awaits visit-control visitor failure without relabeling it canceled", async () => {
    let loader!: FrameRequestLoader
    const lifecycle = new FrameLifecycle({
      async visitResponse() {
        expect(loader.cancel("details")).toBe(false)
        await Promise.resolve()
        throw new Error("private visitor failure")
      },
    })
    loader = new FrameRequestLoader(
      documentSession(),
      {
        fetch: async () =>
          response('<Gallery data-turbo-visit-control="reload"><Ignored /></Gallery>'),
      },
      { next: () => "request-failure" },
      { frameLifecycle: lifecycle },
    )

    const error = await loader.load("details", "/promoted").catch((failure) => failure)
    expect(error).toBeInstanceOf(RequestError)
    expect(error.message).toBe("Frame visit-control response visit failed")
    expect(String(error)).not.toContain("private")
  })

  test("allows the automatic visitor to reenter the released Frame destination", async () => {
    let fetches = 0
    let newer: Promise<unknown> | undefined
    let loader!: FrameRequestLoader
    const lifecycle = new FrameLifecycle({
      visitResponse() {
        newer = loader.load("details", "/newer")
      },
    })
    const session = documentSession()
    loader = new FrameRequestLoader(
      session,
      {
        fetch: async (request) => {
          fetches += 1
          return request.url.endsWith("/newer")
            ? response('<turbo-frame id="details"><Newer /></turbo-frame>', { url: request.url })
            : response('<Gallery data-turbo-visit-control="reload"><Old /></Gallery>', {
                url: request.url,
              })
        },
      },
      { next: () => `request-${fetches + 1}` },
      { frameLifecycle: lifecycle },
    )

    expect(await loader.load("details", "/older")).toMatchObject({ status: "promoted" })
    expect(await newer).toMatchObject({ status: "completed" })
    expect(fetches).toBe(2)
    expect(session.tree.getElementById("details")?.children.filter(isElement)[0]?.tagName).toBe(
      "Newer",
    )
  })

  test("does not promote nested or non-exact visit-control metadata", async () => {
    for (const root of [
      '<Gallery data-turbo-visit-control="RELOAD">',
      '<Gallery data-turbo-visit-control=" reload ">',
      "<Gallery>",
    ]) {
      const body = `${root}<Nested data-turbo-visit-control="reload" /><turbo-frame id="details"><Loaded /></turbo-frame></Gallery>`
      let visits = 0
      const loader = new FrameRequestLoader(
        documentSession(),
        { fetch: async () => response(body) },
        { next: () => "request-exact" },
        {
          frameLifecycle: new FrameLifecycle({
            visitResponse() {
              visits += 1
            },
          }),
        },
      )

      expect(await loader.load("details", "/frame")).toMatchObject({ status: "completed" })
      expect(visits).toBe(0)
    }
  })

  test("lets reentrant newer Frame work cancel missing-response handling", async () => {
    const visits: unknown[] = []
    let newer: Promise<unknown> | undefined
    let loader!: FrameRequestLoader
    const lifecycle = new FrameLifecycle({
      visitResponse(request) {
        visits.push(request)
      },
    })
    lifecycle.subscribe("frame-missing", (event) => {
      event.detail.visit()
      event.preventDefault()
      newer = loader.load("details", "/newer")
    })
    loader = new FrameRequestLoader(
      documentSession(),
      {
        fetch: async (request) =>
          request.url.endsWith("/older")
            ? response("<Page><Missing /></Page>", { url: request.url })
            : response('<turbo-frame id="details"><Newer /></turbo-frame>', {
                url: request.url,
              }),
      },
      { next: () => "request-reentrant" },
      { frameLifecycle: lifecycle },
    )

    expect(await loader.load("details", "/older")).toMatchObject({ status: "canceled" })
    expect(await newer).toMatchObject({ status: "completed" })
    expect(visits).toEqual([])
  })

  test("does not dispatch Frame-missing for empty or inadmissible primary responses", async () => {
    const fixtures = [
      {
        error: undefined,
        response: response("", { headers: {}, status: 204 }),
        status: "empty",
      },
      {
        error: ContentTypeError,
        response: response("<Page />", { headers: { "Content-Type": "application/json" } }),
        status: undefined,
      },
      {
        error: ParseError,
        response: response("<turbo-frame"),
        status: undefined,
      },
    ] as const

    for (const fixture of fixtures) {
      let events = 0
      const lifecycle = new FrameLifecycle()
      lifecycle.subscribe("frame-missing", () => {
        events += 1
      })
      const loader = new FrameRequestLoader(
        documentSession(),
        { fetch: async () => fixture.response },
        { next: () => "request-primary" },
        { frameLifecycle: lifecycle },
      )
      const loading = loader.load("details", "/primary")

      if (fixture.status) expect(await loading).toMatchObject({ status: fixture.status })
      else if (fixture.error === ContentTypeError) {
        await expect(loading).rejects.toBeInstanceOf(ContentTypeError)
      } else {
        await expect(loading).rejects.toBeInstanceOf(ParseError)
      }
      expect(events).toBe(0)
    }
  })

  test("forwards embedded refresh Streams to the configured session coordinator", async () => {
    const session = documentSession()
    const refreshes: unknown[] = []
    const streamEvents: string[] = []
    const streamLifecycle = new StreamLifecycle()
    streamLifecycle.subscribe("before-stream-render", (event) => {
      streamEvents.push(`before:${event.detail.action}`)
      return undefined
    })
    streamLifecycle.subscribe("stream-action", (event) => {
      streamEvents.push(`action:${event.detail.report.status}`)
      return undefined
    })
    const loader = new FrameRequestLoader(
      session,
      {
        fetch: async () =>
          response(
            '<turbo-frame id="details"><turbo-stream action="refresh" request-id="frame-origin"/></turbo-frame>',
          ),
      },
      { next: () => "frame-request" },
      { refresh: { request: (request) => refreshes.push(request) }, streamLifecycle },
    )

    const report = await loader.load("details", "/frame")

    expect(report.status).toBe("completed")
    if (report.status === "promoted") throw new Error("Frame response was unexpectedly promoted")
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
    expect(streamEvents).toEqual(["before:refresh", "action:applied"])
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
    expect(await older).toMatchObject({ status: "canceled" })
    pending[1]?.(response('<turbo-frame id="details"><Newer /></turbo-frame>'))
    expect(await newer).toMatchObject({ status: "completed" })
    pending[0]?.(response('<turbo-frame id="details"><Older /></turbo-frame>'))
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
    const contexts: unknown[] = []
    const session = documentSession()
    const lifecycle = new RequestLifecycle()
    lifecycle.subscribe("before-fetch-request", (event) => {
      contexts.push(event.detail.context)
      event.detail.request.setHeader("X-Frame-Hook", "admitted")
    })
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
      { requestLifecycle: lifecycle },
    )

    const report = await loader.load("details", "/initial")
    const frame = session.tree.getElementById("details")
    if (!frame) throw new Error("fixture lost its active frame")

    expect(requests.map((request) => request.url)).toEqual([
      "https://example.test/initial",
      "https://example.test/redirected/nested",
    ])
    expect(requests.map((request) => request.headers["Turbo-Frame"])).toEqual(["details", "bridge"])
    expect(requests.map((request) => request.headers["X-Frame-Hook"])).toEqual([
      "admitted",
      "admitted",
    ])
    expect(contexts).toEqual([
      {
        frameId: "details",
        kind: "frame",
        recurseDepth: 0,
        requestFrameId: "details",
        requestId: "request-1",
      },
      {
        frameId: "details",
        kind: "frame",
        recurseDepth: 1,
        requestFrameId: "bridge",
        requestId: "request-2",
      },
    ])
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

  test("reports a prevented Frame response without reading or mutating it", async () => {
    const session = documentSession()
    const frame = session.tree.getElementById("details")
    const children = frame?.children
    const lifecycle = new RequestLifecycle()
    let reads = 0
    lifecycle.subscribe("before-fetch-response", (event) => event.preventDefault())
    const loader = new FrameRequestLoader(
      session,
      {
        fetch: async (request) =>
          response('<turbo-frame id="details"><Ignored /></turbo-frame>', {
            text: async () => {
              reads += 1
              return '<turbo-frame id="details"><Ignored /></turbo-frame>'
            },
            url: request.url,
          }),
      },
      { next: () => "request-prevented" },
      { requestLifecycle: lifecycle },
    )

    expect(await loader.load("details", "/prevented")).toEqual({
      frameId: "details",
      requestId: "request-prevented",
      requestIds: ["request-prevented"],
      responseStatus: 200,
      status: "prevented",
      url: "https://example.test/prevented",
    })
    expect(reads).toBe(0)
    expect(frame?.children).toBe(children)
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
    let markRecurseStarted!: () => void
    const recurseStarted = new Promise<void>((resolve) => {
      markRecurseStarted = resolve
    })
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
            if (pending.length === 2) markRecurseStarted()
          }),
      },
      { next: () => `request-${++requestId}` },
    )

    const older = loader.load("details", "/older")
    pending[0]?.resolve(
      response('<Page><turbo-frame id="bridge" src="/older-nested" recurse="details" /></Page>'),
    )
    await recurseStarted
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

  test("rejects before-frame-render wrappers that do not delegate without applying Frame work", async () => {
    const renderers: Array<(context: { renderDefault(): undefined }) => unknown> = [
      () => undefined,
      () => {
        throw new Error("private before-render failure")
      },
      (context) => {
        context.renderDefault()
        return "unexpected renderer result"
      },
      async (context) => {
        context.renderDefault()
      },
    ]

    for (const renderer of renderers) {
      const session = new DocumentSession(
        parseExpoTurboDocument(
          '<Gallery><Status id="status"><OldStatus /></Status><turbo-frame id="details" src="/old"><Old /></turbo-frame></Gallery>',
          { url: "https://example.test/page" },
        ),
      )
      const frame = session.tree.getElementById("details")
      if (frame?.kind !== "frame") throw new Error("Frame fixture is missing")
      const children = frame.children
      const lifecycle = new FrameLifecycle()
      lifecycle.subscribe("before-frame-render", (event) => {
        event.detail.render = renderer as never
        return undefined
      })
      const loader = new FrameRequestLoader(
        session,
        {
          fetch: async () =>
            response(
              '<turbo-frame id="details"><Committed id="committed" /><turbo-stream action="update" target="status"><template><UpdatedStatus id="updated-status" /></template></turbo-stream></turbo-frame>',
            ),
        },
        { next: () => "request-1" },
        { frameLifecycle: lifecycle },
      )

      await expect(loader.load("details", "/frame")).rejects.toMatchObject({
        code: "state",
      })
      expect(session.revision).toBe(0)
      expect(frame.children).toBe(children)
      expect(attributeValue(frame, "src")).toBe("/old")
      expect(session.tree.getElementById("committed")).toBeUndefined()
      expect(session.tree.getElementById("updated-status")).toBeUndefined()
    }
  })

  test("blocks same-Frame request reentrancy during before-frame-render", async () => {
    const session = documentSession()
    const lifecycle = new FrameLifecycle()
    const reentrant: Promise<unknown>[] = []
    let fetches = 0
    const loader = new FrameRequestLoader(
      session,
      {
        fetch: async () => {
          fetches += 1
          return response('<turbo-frame id="details"><Committed /></turbo-frame>')
        },
      },
      { next: () => `request-${fetches + 1}` },
      { frameLifecycle: lifecycle },
    )
    lifecycle.subscribe("before-frame-render", (event) => {
      event.detail.render = (context) => {
        reentrant.push(
          loader.load("details", "/reentrant").then(
            () => undefined,
            (error) => error,
          ),
        )
        return context.renderDefault()
      }
      return undefined
    })

    await expect(loader.load("details", "/outer")).resolves.toMatchObject({ status: "completed" })
    expect(fetches).toBe(1)
    expect(await Promise.all(reentrant)).toEqual([expect.any(StateError)])
    expect(session.tree.getElementById("details")?.children.filter(isElement)[0]?.tagName).toBe(
      "Committed",
    )
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

  test("never invokes the commit callback or before-frame-render for empty or inadmissible responses", async () => {
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
      let beforeRenderCalls = 0
      const lifecycle = new FrameLifecycle()
      lifecycle.subscribe("before-frame-render", () => {
        beforeRenderCalls += 1
        return undefined
      })
      const loader = new FrameRequestLoader(
        documentSession(),
        { fetch: async () => fixture },
        { next: () => "request-1" },
        { frameLifecycle: lifecycle },
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
      expect(beforeRenderCalls).toBe(0)
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
