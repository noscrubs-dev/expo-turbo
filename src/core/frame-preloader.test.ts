import { describe, expect, test } from "bun:test"

import type { TurboRequest, TurboResponse } from "../adapters"
import { ContentTypeError, FrameMissingError, TargetError } from "./errors"
import { FramePreloadCache } from "./frame-preload-cache"
import { FramePreloader } from "./frame-preloader"
import { parseExpoTurboDocument } from "./parser"
import { EXPO_TURBO_MIME_TYPE } from "./protocol-request"
import { RequestLifecycle } from "./request-lifecycle"
import { DocumentSession } from "./session"

function session(): DocumentSession {
  return new DocumentSession(
    parseExpoTurboDocument(
      '<Gallery><turbo-frame id="details"><Current /></turbo-frame><turbo-frame id="other"><Other /></turbo-frame></Gallery>',
      { url: "https://example.test/page" },
    ),
  )
}

function response(xml: string, url: string, options: Partial<TurboResponse> = {}): TurboResponse {
  return {
    headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
    redirected: false,
    status: 200,
    text: async () => xml,
    url,
    ...options,
  }
}

describe("Frame preloader", () => {
  test("publishes one in-flight request before invoking reentrant host adapters", async () => {
    const active = session()
    const cache = new FramePreloadCache()
    let reentrant: Promise<unknown> | undefined
    let preloader!: FramePreloader
    preloader = new FramePreloader(
      active,
      {
        fetch: async (request) => response('<turbo-frame id="details" />', request.url),
      },
      {
        next() {
          reentrant = preloader.preload("details", "/shared")
          return "shared-frame-preload"
        },
      },
      cache,
    )

    const preload = preloader.preload("details", "/shared")
    await Promise.resolve()

    expect(reentrant).toBe(preload)
    await expect(preload).resolves.toMatchObject({ status: "cached" })
  })

  test("redacts hostile response metadata and permits a later retry", async () => {
    const active = session()
    const cache = new FramePreloadCache()
    let attempts = 0
    const preloader = new FramePreloader(
      active,
      {
        fetch: async (request) => {
          attempts += 1
          if (attempts === 1) {
            return Object.defineProperty(
              {
                headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
                redirected: false,
                text: async () => '<turbo-frame id="details" />',
                url: request.url,
              },
              "status",
              {
                get() {
                  throw new Error("private response metadata")
                },
              },
            ) as unknown as TurboResponse
          }
          return response('<turbo-frame id="details" />', request.url)
        },
      },
      { next: () => `metadata-${attempts + 1}` },
      cache,
    )

    await expect(preloader.preload("details", "/metadata")).rejects.toMatchObject({
      message: "Frame preload response metadata is invalid",
    })
    await expect(preloader.preload("details", "/metadata")).resolves.toMatchObject({
      status: "cached",
    })
  })

  test("runs one typed request lifecycle and does not read a prevented response", async () => {
    const active = session()
    const cache = new FramePreloadCache()
    const lifecycle = new RequestLifecycle()
    const contexts: unknown[] = []
    let bodyReads = 0
    lifecycle.subscribe("before-fetch-request", (event) => {
      contexts.push(event.detail.context)
    })
    lifecycle.subscribe("before-fetch-response", (event) => event.preventDefault())
    const preloader = new FramePreloader(
      active,
      {
        fetch: async (request) =>
          response('<turbo-frame id="details" />', request.url, {
            text: async () => {
              bodyReads += 1
              return '<turbo-frame id="details" />'
            },
          }),
      },
      { next: () => "lifecycle-preload" },
      cache,
      { requestLifecycle: lifecycle },
    )

    expect(await preloader.preload("details", "/lifecycle")).toEqual({
      frameId: "details",
      requestId: "lifecycle-preload",
      responseStatus: 200,
      status: "prevented",
      url: "https://example.test/lifecycle",
    })
    expect(contexts).toEqual([
      {
        frameId: "details",
        kind: "frame",
        purpose: "preload",
        requestId: "lifecycle-preload",
      },
    ])
    expect(bodyReads).toBe(0)
    expect(cache.size).toBe(0)
  })

  test("strictly admits one matching response without mutating the active tree", async () => {
    const active = session()
    const tree = active.tree
    const cache = new FramePreloadCache()
    const requests: TurboRequest[] = []
    const preloader = new FramePreloader(
      active,
      {
        async fetch(request) {
          requests.push(request)
          return response(
            '<Gallery><turbo-frame id="details"><Preloaded id="preloaded" /></turbo-frame></Gallery>',
            request.url,
          )
        },
      },
      { next: () => "frame-preload-1" },
      cache,
      { capabilityHash: "sha256:capabilities" },
    )

    expect(await preloader.preload("details", "/frame")).toEqual({
      frameId: "details",
      requestId: "frame-preload-1",
      responseStatus: 200,
      status: "cached",
      url: "https://example.test/frame",
    })
    expect(await preloader.preload("details", "/frame")).toEqual({
      frameId: "details",
      status: "hit",
      url: "https://example.test/frame",
    })
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      headers: {
        Accept: EXPO_TURBO_MIME_TYPE,
        "Turbo-Frame": "details",
        "X-Expo-Turbo-Capabilities": "sha256:capabilities",
        "X-Sec-Purpose": "prefetch",
        "X-Turbo-Request-Id": "frame-preload-1",
      },
      method: "GET",
      url: "https://example.test/frame",
    })
    expect(active.tree).toBe(tree)
    expect(active.revision).toBe(0)
    expect(active.tree.getElementById("preloaded")).toBeUndefined()
    expect(cache.has("details", "https://example.test/frame")).toBe(true)
    expect(cache.has("other", "https://example.test/frame")).toBe(false)
  })

  test("rejects unsafe destinations and non-matching responses", async () => {
    const active = session()
    const cache = new FramePreloadCache()
    const preloader = new FramePreloader(
      active,
      {
        fetch: async (request) => response('<turbo-frame id="other" />', request.url),
      },
      { next: () => "request" },
      cache,
    )

    await expect(preloader.preload("details", "https://invalid.test/frame")).rejects.toBeInstanceOf(
      TargetError,
    )
    await expect(preloader.preload("details", "/frame#target")).rejects.toBeInstanceOf(TargetError)
    await expect(preloader.preload("missing", "/frame")).rejects.toBeInstanceOf(FrameMissingError)
    await expect(preloader.preload("details", "/frame")).rejects.toBeInstanceOf(FrameMissingError)

    const wrongMime = new FramePreloader(
      active,
      {
        fetch: async (request) =>
          response('<turbo-frame id="details" />', request.url, {
            headers: { "Content-Type": "text/html" },
          }),
      },
      { next: () => "wrong-mime" },
      cache,
    )
    await expect(wrongMime.preload("details", "/wrong-mime")).rejects.toBeInstanceOf(
      ContentTypeError,
    )
  })
})
