/// <reference types="bun" />

import { expect, test } from "bun:test"
import type { FetchAdapter, TurboRequest, TurboResponse } from "expo-turbo/adapters"
import {
  attributeValue,
  DocumentFormControls,
  DocumentSession,
  EXPO_TURBO_MIME_TYPE,
  FormSubmissionController,
  FrameRequestLoader,
  nodeTextContent,
  parseExpoTurboDocument,
} from "expo-turbo/core"

const origin = process.env.EXPO_TURBO_DEMO_ORIGIN
const liveTest = origin ? test : test.skip
const FORM_PATH = "/api/expo_turbo/demo/form"
const FRAME_ID = "demo-form-frame"
const TURBO_STREAM_MIME_TYPE = "text/vnd.turbo-stream.html"

function createFetchAdapter(requests: TurboRequest[]): FetchAdapter {
  return Object.freeze({
    async fetch(request: TurboRequest): Promise<TurboResponse> {
      requests.push(request)
      const headers = {
        ...request.headers,
        ...(request.body ? { "Content-Type": request.body.contentType } : {}),
      }
      const response = await globalThis.fetch(request.url, {
        ...(request.body ? { body: request.body.value } : {}),
        headers,
        method: request.method,
        ...(request.signal ? { signal: request.signal } : {}),
      } as RequestInit)
      const responseHeaders: Record<string, string> = {}
      response.headers.forEach((value, name) => {
        responseHeaders[name] = value
      })
      return Object.freeze({
        headers: Object.freeze(responseHeaders),
        redirected: response.redirected,
        status: response.status,
        text: () => response.text(),
        url: response.url,
      })
    },
  })
}

liveTest(
  "submits a real Rails Frame form through authoritative 422 XML and a canonical 303 GET",
  async () => {
    if (!origin) throw new Error("EXPO_TURBO_DEMO_ORIGIN is required for the Rails form smoke")

    const formUrl = new URL(FORM_PATH, new URL(origin).origin).toString()
    const requests: TurboRequest[] = []
    const fetch = createFetchAdapter(requests)
    const session = new DocumentSession(
      parseExpoTurboDocument(
        `<Gallery id="rails-form-smoke"><turbo-frame id="${FRAME_ID}" src="${formUrl}"><DemoText id="demo-form-loading">Loading</DemoText></turbo-frame></Gallery>`,
        { url: formUrl },
      ),
    )
    const frameLoader = new FrameRequestLoader(session, fetch, {
      next: () => "rails-form-smoke-frame",
    })

    await expect(frameLoader.load(FRAME_ID, formUrl)).resolves.toMatchObject({
      frameId: FRAME_ID,
      responseStatus: 200,
      status: "completed",
      url: formUrl,
    })
    expect(requests.shift()).toMatchObject({
      headers: { Accept: EXPO_TURBO_MIME_TYPE, "Turbo-Frame": FRAME_ID },
      method: "GET",
      url: formUrl,
    })
    expect(session.tree.getElementById("demo-form")?.kind).toBe("element")

    const controller = new FormSubmissionController(session, fetch)
    const forms = new DocumentFormControls(session, { submissionController: controller })
    const invalid = forms.controlsFor("id:demo-form")
    invalid.register("id:demo-form-first-name", {
      kind: "value",
      name: "profile[first_name]",
      value: "invalid",
    })

    await expect(
      invalid.submit({ protocol: { requestId: "rails-form-invalid" } }),
    ).resolves.toMatchObject({
      application: "frame",
      classification: "client-error",
      destination: { frameId: FRAME_ID, kind: "frame" },
      redirected: false,
      responseStatus: 422,
      responseUrl: formUrl,
      status: "applied",
    })
    expect(requests.shift()).toMatchObject({
      body: {
        contentType: "application/x-www-form-urlencoded;charset=UTF-8",
        value: "profile%5Bfirst_name%5D=invalid",
      },
      headers: {
        Accept: `${TURBO_STREAM_MIME_TYPE}, ${EXPO_TURBO_MIME_TYPE}`,
        "Turbo-Frame": FRAME_ID,
      },
      method: "POST",
      url: formUrl,
    })
    expect(invalid.isDisposed).toBe(true)
    const invalidFrame = session.tree.getElementById(FRAME_ID)
    expect(invalidFrame && attributeValue(invalidFrame, "src")).toBe(formUrl)
    const invalidError = session.tree.getElementById("demo-form-error")
    if (!invalidError)
      throw new Error("Rails validation response did not include its error element")
    expect(nodeTextContent(invalidError)).toBe("This demo name is unavailable")

    const valid = forms.controlsFor("id:demo-form")
    valid.register("id:demo-form-first-name", {
      kind: "value",
      name: "profile[first_name]",
      value: "Ada",
    })

    await expect(
      valid.submit({ protocol: { requestId: "rails-form-valid" } }),
    ).resolves.toMatchObject({
      application: "frame",
      classification: "success",
      destination: { frameId: FRAME_ID, kind: "frame" },
      redirected: true,
      responseStatus: 200,
      responseUrl: formUrl,
      status: "applied",
    })
    expect(requests.shift()).toMatchObject({
      body: {
        contentType: "application/x-www-form-urlencoded;charset=UTF-8",
        value: "profile%5Bfirst_name%5D=Ada",
      },
      headers: {
        Accept: `${TURBO_STREAM_MIME_TYPE}, ${EXPO_TURBO_MIME_TYPE}`,
        "Turbo-Frame": FRAME_ID,
      },
      method: "POST",
      url: formUrl,
    })
    expect(requests).toHaveLength(0)
    const validFrame = session.tree.getElementById(FRAME_ID)
    expect(validFrame && attributeValue(validFrame, "src")).toBe(formUrl)
    const validTitle = session.tree.getElementById("demo-form-title")
    if (!validTitle) throw new Error("Rails canonical response did not include its form title")
    expect(nodeTextContent(validTitle)).toBe("Rails Frame form")
    expect(session.tree.getElementById("demo-form-error")).toBeUndefined()
  },
)
