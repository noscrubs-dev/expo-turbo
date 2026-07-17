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
    )

    const report = await loader.load("details", "/frame")
    const frame = session.tree.getElementById("details")
    if (!frame) throw new Error("fixture lost its active frame")

    expect(requests[0]).toMatchObject({
      headers: {
        Accept: EXPO_TURBO_MIME_TYPE,
        "Turbo-Frame": "details",
        "X-Turbo-Request-Id": "request-1",
      },
      method: "GET",
      url: "https://example.test/frame",
    })
    expect(report).toMatchObject({ responseStatus: 422, status: "completed" })
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
})
