import { describe, expect, test } from "bun:test"

import type {
  FormConfirmationAdapter,
  RequestIdAdapter,
  TurboRequest,
  TurboResponse,
} from "../adapters"
import {
  DocumentHistory,
  type DocumentHistoryEntry,
  type DocumentHistoryWriteMethod,
} from "./document-history"
import { StateError, TargetError } from "./errors"
import {
  FormLinkSubmissionController,
  type FormLinkSubmissionControllerOptions,
} from "./form-link-submission"
import {
  FormSubmissionController,
  type FormSubmissionControllerOptions,
} from "./form-submission-controller"
import { parseExpoTurboDocument } from "./parser"
import { EXPO_TURBO_MIME_TYPE, TURBO_STREAM_MIME_TYPE } from "./protocol-request"
import { DocumentSession } from "./session"
import { isElement } from "./tree"

function session(xml: string): DocumentSession {
  return new DocumentSession(parseExpoTurboDocument(xml, { url: "https://example.test/current" }))
}

function emptyResponse(request: TurboRequest): TurboResponse {
  return {
    headers: {},
    redirected: false,
    status: 204,
    text: async () => "",
    url: request.url,
  }
}

function harness(
  document: DocumentSession,
  options: {
    confirmation?: FormConfirmationAdapter
    controller?: FormLinkSubmissionControllerOptions
    requestIds?: RequestIdAdapter
    response?: (request: TurboRequest) => TurboResponse | Promise<TurboResponse>
    submission?: FormSubmissionControllerOptions
  } = {},
) {
  const requests: TurboRequest[] = []
  let allocated = 0
  const requestIds =
    options.requestIds ??
    ({
      next: () => `link-${++allocated}`,
    } satisfies RequestIdAdapter)
  const submissions = new FormSubmissionController(
    document,
    {
      async fetch(request) {
        requests.push(request)
        return (await options.response?.(request)) ?? emptyResponse(request)
      },
    },
    {
      ...options.submission,
      ...(options.confirmation ? { confirmation: options.confirmation } : {}),
    },
  )
  return {
    allocated: () => allocated,
    links: new FormLinkSubmissionController(document, submissions, requestIds, options.controller),
    requests,
  }
}

function history(document: DocumentSession) {
  let identifier = 0
  const writes: Array<
    Readonly<{ entry: DocumentHistoryEntry; method: DocumentHistoryWriteMethod }>
  > = []
  const history = new DocumentHistory(
    { next: () => `link-history-${++identifier}` },
    {
      write(method, entry) {
        writes.push(Object.freeze({ entry, method }))
      },
    },
  )
  history.initialize({
    entry: {
      restorationIdentifier: "link-history-current",
      restorationIndex: 2,
      url: document.tree.document.url as string,
    },
    kind: "managed",
  })
  return { history, writes }
}

describe("FormLinkSubmissionController", () => {
  test("admits only generated-form metadata under the configured Turbo form mode", () => {
    const document = session(
      `<Gallery>
        <DemoLink id="plain" />
        <DemoLink id="method" data-turbo-method="" />
        <DemoLink id="stream" data-turbo-stream="false" />
        <Group data-turbo="false">
          <DemoLink id="disabled" data-turbo-method="post" />
        </Group>
        <Group data-turbo="true">
          <DemoLink id="opted-in" data-turbo-method="post" />
          <Group data-turbo="false">
            <DemoLink id="nearest-disabled" data-turbo-method="post" />
          </Group>
        </Group>
      </Gallery>`,
    )

    const on = harness(document).links
    expect(on.shouldInterceptSubmission("id:plain")).toBe(false)
    expect(on.shouldInterceptSubmission("id:method")).toBe(true)
    expect(on.shouldInterceptSubmission("id:stream")).toBe(true)
    expect(on.shouldInterceptSubmission("id:disabled")).toBe(false)

    const off = harness(document, { controller: { formMode: "off" } }).links
    expect(off.shouldInterceptSubmission("id:method")).toBe(false)

    const optin = harness(document, { controller: { formMode: "optin" } }).links
    expect(optin.shouldInterceptSubmission("id:method")).toBe(true)
    expect(optin.shouldInterceptSubmission("id:opted-in")).toBe(true)
    expect(optin.shouldInterceptSubmission("id:nearest-disabled")).toBe(false)
    expect(() => on.shouldInterceptSubmission("missing")).toThrow(TargetError)
  })

  test("preserves decoded query order and duplicates across direct unsafe verbs", async () => {
    const document = session('<Gallery><DemoLink id="link" data-turbo-method="put" /></Gallery>')
    const { links, requests } = harness(document, {
      controller: { capabilityHash: "sha256:generated-links" },
    })

    for (const method of ["put", "PaTcH", "DELETE"]) {
      document.setAttribute("id:link", "data-turbo-method", method)
      const result = await links.submit(
        "id:link",
        "/save?alpha=1&_method=post&alpha=2&_method=delete&word=two+words&word=%2B",
      )
      expect(result).toMatchObject({
        effectiveMethod: method.toUpperCase(),
        sourceMethod: method.toUpperCase(),
        status: "empty",
      })
    }

    expect(requests).toHaveLength(3)
    expect(requests.map((request) => request.method)).toEqual(["PUT", "PATCH", "DELETE"])
    for (const [index, request] of requests.entries()) {
      expect(request.url).toBe("https://example.test/save")
      expect(request.body).toEqual({
        contentType: "application/x-www-form-urlencoded;charset=UTF-8",
        value: "alpha=1&_method=post&alpha=2&_method=delete&word=two+words&word=%2B",
      })
      expect(request.headers).toMatchObject({
        Accept: `${TURBO_STREAM_MIME_TYPE}, ${EXPO_TURBO_MIME_TYPE}`,
        "X-Expo-Turbo-Capabilities": "sha256:generated-links",
        "X-Turbo-Request-Id": `link-${index + 1}`,
      })
    }
  })

  test("copies Stream presence and omits blank or invalid method values as browser GET", async () => {
    const document = session(
      '<Gallery><DemoLink id="link" data-turbo-method="" data-turbo-stream="false" /></Gallery>',
    )
    const { links, requests } = harness(document)

    await links.submit("id:link", "/search?tag=one&tag=two+words")
    document.setAttribute("id:link", "data-turbo-method", " TRACE ")
    document.removeAttribute("id:link", "data-turbo-stream")
    await links.submit("id:link", "/search?tag=three")

    expect(requests[0]).toMatchObject({
      headers: {
        Accept: `${TURBO_STREAM_MIME_TYPE}, ${EXPO_TURBO_MIME_TYPE}`,
        "X-Expo-Turbo-Protocol": "0.1",
        "X-Expo-Turbo-Runtime": "0.1.0",
        "X-Turbo-Request-Id": "link-1",
      },
      method: "GET",
      url: "https://example.test/search?tag=one&tag=two+words",
    })
    expect(requests[0]).not.toHaveProperty("body")
    expect(requests[1]).toMatchObject({
      headers: { Accept: EXPO_TURBO_MIME_TYPE },
      method: "GET",
      url: "https://example.test/search?tag=three",
    })
  })

  test("uses FrameController-style generated destinations without making the source an origin", () => {
    const document = session(
      `<Gallery>
        <turbo-frame id="source" target="destination">
          <DemoLink id="link" data-turbo-method="post" />
        </turbo-frame>
        <turbo-frame id="plain-source">
          <DemoLink id="plain-link" data-turbo-method="post" />
        </turbo-frame>
        <turbo-frame id="destination" />
      </Gallery>`,
    )
    const { links } = harness(document)

    const ordinary = links.submissionProposal("id:link", "/save")
    expect(ordinary.destination).toEqual({
      frameId: "destination",
      kind: "frame",
      requestedTarget: "destination",
    })
    expect(ordinary.plan.request.headers["Turbo-Frame"]).toBe("destination")
    expect(links.submissionProposal("id:plain-link", "/save").destination).toEqual({
      frameId: "plain-source",
      kind: "frame",
    })

    document.setAttribute("id:link", "data-turbo-frame", "_self")
    const self = links.submissionProposal("id:link", "/save")
    expect(self.destination).toEqual({
      frameId: "source",
      kind: "frame",
      requestedTarget: "_self",
    })
    expect(self.plan.request.headers["Turbo-Frame"]).toBe("source")

    document.setAttribute("id:link", "data-turbo-frame", "")
    expect(links.submissionProposal("id:link", "/save").destination).toEqual({
      frameId: "destination",
      kind: "frame",
      requestedTarget: "destination",
    })

    document.setAttribute("id:link", "data-turbo-frame", "_top")
    expect(links.submissionProposal("id:link", "/save").destination).toEqual({
      kind: "document",
      requestedTarget: "_top",
    })

    document.setAttribute("id:link", "data-turbo-frame", "destination")
    const named = links.submissionProposal("id:link", "/save")
    expect(named.destination).toEqual({
      frameId: "destination",
      kind: "frame",
      requestedTarget: "destination",
    })
    expect(named.plan.request.headers["Turbo-Frame"]).toBe("destination")
  })

  test("applies failed cross-target Frame XML to the destination rather than the source", async () => {
    const document = session(
      `<Gallery>
        <turbo-frame id="source">
          <DemoLink id="link" data-turbo-method="post" data-turbo-frame="destination" />
          <SourceState id="source-state" />
        </turbo-frame>
        <turbo-frame id="destination"><OldDestination /></turbo-frame>
      </Gallery>`,
    )
    const { links, requests } = harness(document, {
      response: (request) => ({
        headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
        redirected: false,
        status: 422,
        text: async () =>
          '<turbo-frame id="destination"><DestinationError id="error" /></turbo-frame>',
        url: request.url,
      }),
    })

    const result = await links.submit("id:link", "/save?value=invalid")

    expect(result).toMatchObject({
      application: "frame",
      applicationDestination: { frameId: "destination", kind: "frame" },
      classification: "client-error",
      status: "applied",
    })
    expect(requests[0]?.headers["Turbo-Frame"]).toBe("destination")
    expect(document.tree.getElementById("source-state")?.tagName).toBe("SourceState")
    expect(document.tree.getElementById("error")?.tagName).toBe("DestinationError")
    expect(
      document.tree.getElementById("destination")?.children.filter(isElement)[0]?.tagName,
    ).toBe("DestinationError")
  })

  test("copies only nonempty confirmation metadata into the shared submission path", async () => {
    const messages: string[] = []
    const document = session(
      '<Gallery><DemoLink id="link" data-turbo-method="post" data-turbo-confirm="" /></Gallery>',
    )
    const { links, requests } = harness(document, {
      confirmation: {
        confirm(message) {
          messages.push(message)
          return true
        },
      },
    })

    await links.submit("id:link", "/save")
    expect(messages).toEqual([])

    document.setAttribute("id:link", "data-turbo-confirm", "Really submit?")
    await links.submit("id:link", "/save")
    expect(messages).toEqual(["Really submit?"])
    expect(requests).toHaveLength(2)
  })

  test("admits document actions while keeping restore and Frame actions fail-closed", async () => {
    let allocations = 0
    const requestIds = { next: () => `request-${++allocations}` }
    const document = session(
      `<Gallery>
        <DemoLink id="document-link" data-turbo-method="post" data-turbo-action="advance" />
        <DemoLink id="replace-link" data-turbo-method="post" data-turbo-action="replace" />
        <DemoLink id="restore-link" data-turbo-method="post" data-turbo-action="restore" />
        <DemoLink id="frame-link" data-turbo-method="post" data-turbo-frame="destination" data-turbo-action="Advance" />
        <turbo-frame id="destination" data-turbo-action="replace" />
      </Gallery>`,
    )
    const { links, requests } = harness(document, { requestIds })

    expect(await links.submit("id:document-link", "/save")).toMatchObject({ status: "empty" })
    await expect(links.submit("id:replace-link", "/save")).rejects.toThrow(/configured history/)
    await expect(links.submit("id:restore-link", "/save")).rejects.toThrow(/restoration support/)
    await expect(links.submit("id:frame-link", "/save")).rejects.toThrow(/history support/)
    expect(allocations).toBe(2)
    expect(requests).toHaveLength(1)

    document.setAttribute("id:destination", "data-turbo-action", "Replace")
    const result = await links.submit("id:frame-link", "/save")
    expect(result).toMatchObject({ status: "empty" })
    expect(allocations).toBe(3)
    expect(requests).toHaveLength(2)
  })

  test("routes generated document replace through shared form history", async () => {
    const document = session(
      '<Gallery><DemoLink id="link" data-turbo-method="post" data-turbo-action="replace" /></Gallery>',
    )
    const fixture = history(document)
    const { links } = harness(document, {
      response: (_request) => ({
        headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
        redirected: true,
        status: 200,
        text: async () => '<Gallery><Saved id="saved" /></Gallery>',
        url: "https://example.test/saved",
      }),
      submission: { history: fixture.history },
    })

    expect(await links.submit("id:link", "/save")).toMatchObject({
      application: "document",
      status: "applied",
    })
    expect(fixture.writes).toEqual([
      {
        entry: {
          restorationIdentifier: "link-history-1",
          restorationIndex: 2,
          url: "https://example.test/saved",
        },
        method: "replace",
      },
    ])
    expect(document.tree.getElementById("saved")).toBeDefined()
  })

  test("rejects dialog, missing generated metadata, and stale exact link ownership", async () => {
    let allocations = 0
    const document = session(
      `<Gallery>
        <DemoLink id="plain" />
        <DemoLink id="dialog" data-turbo-method="dialog" />
        <DemoLink id="stale" data-turbo-method="post" />
      </Gallery>`,
    )
    const requestIds: RequestIdAdapter = {
      next() {
        allocations += 1
        const stale = document.tree.getElementById("stale")
        const replacement = parseExpoTurboDocument(
          '<DemoLink id="stale" data-turbo-method="post" />',
        ).getElementById("stale")
        if (!stale || !replacement) throw new Error("stale-link fixture is missing")
        document.mutate((tree) => tree.replaceNodeWithClones(stale, [replacement]))
        return `request-${allocations}`
      },
    }
    const { links, requests } = harness(document, { requestIds })

    await expect(links.submit("id:plain", "/save")).rejects.toThrow(/method or Stream/)
    await expect(links.submit("id:dialog", "/save")).rejects.toThrow(/dialog/)
    expect(allocations).toBe(0)

    await expect(links.submit("id:stale", "/save")).rejects.toBeInstanceOf(StateError)
    expect(allocations).toBe(1)
    expect(requests).toHaveLength(0)
  })

  test("rewrites generated hidden charset sentinels and rejects policy bypasses before IDs", async () => {
    let allocations = 0
    const document = session(
      `<Gallery data-turbo-root="/current">
        <DemoLink id="charset" data-turbo-method="post" />
        <DemoLink id="opted-out" data-turbo-method="post" data-turbo="false" />
      </Gallery>`,
    )
    const { links, requests } = harness(document, {
      requestIds: { next: () => `request-${++allocations}` },
    })

    await expect(links.submit("id:opted-out", "/current/save")).rejects.toThrow(/not interceptable/)
    await expect(links.submit("id:charset", "/outside")).rejects.toThrow(/not visitable/)
    await expect(links.submit("id:charset", "/current/save#result")).rejects.toThrow(/fragments/)
    await expect(
      links.submit("id:charset", "https://user:secret@example.test/current/save"),
    ).rejects.toThrow(TargetError)
    await expect(links.submit("id:charset", "https://outside.test/current/save")).rejects.toThrow(
      /not visitable/,
    )
    await expect(links.submit("id:charset", "mailto:help@example.test")).rejects.toThrow(
      TargetError,
    )
    expect(allocations).toBe(0)
    expect(requests).toHaveLength(0)

    await links.submit(
      "id:charset",
      "/current/save?_charset_=ignored&_ChArSeT_=also-ignored&value=kept",
    )
    expect(requests[0]?.body?.value).toBe("_charset_=UTF-8&_ChArSeT_=UTF-8&value=kept")
    expect(allocations).toBe(1)
    expect(requests).toHaveLength(1)
  })
})
