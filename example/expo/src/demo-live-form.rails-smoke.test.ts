/// <reference types="bun" />

import { expect, mock, test } from "bun:test"
import type { FetchAdapter, TurboRequest, TurboResponse } from "expo-turbo/adapters"
import {
  attributeValue,
  DocumentFormControls,
  DocumentSession,
  EXPO_TURBO_MIME_TYPE,
  FormSubmissionController,
  FrameControllerRegistry,
  FrameRequestLoader,
  nodeTextContent,
  parseExpoTurboDocument,
} from "expo-turbo/core"
import { createElement } from "react"
import { act, create, type ReactTestRenderer } from "react-test-renderer"

interface PressableProps {
  readonly accessibilityLabel?: string
  readonly accessibilityRole?: string
  readonly onPress?: () => void
}

mock.module("react-native", () => ({
  AccessibilityInfo: { announceForAccessibility: () => undefined },
  Alert: { alert: () => undefined },
  AppState: { addEventListener: () => ({ remove: () => undefined }), currentState: "active" },
  FlatList: (props: Readonly<Record<string, unknown>>) => createElement("flat-list", props),
  Linking: { openURL: async () => undefined },
  Platform: { OS: "web" },
  Pressable: (props: PressableProps) => createElement("pressable", props),
  ScrollView: (props: Readonly<Record<string, unknown>>) => createElement("scroll-view", props),
  Text: (props: Readonly<Record<string, unknown>>) => createElement("native-text", props),
  TextInput: (props: Readonly<Record<string, unknown>>) => createElement("text-input", props),
  View: (props: Readonly<Record<string, unknown>>) => createElement("view", props),
}))

const { ExpoTurboProvider, ExpoTurboRoot } = await import("expo-turbo/react")
const { DemoFocusProvider, DemoFocusRegistry } = await import("./demo-focus")
const { DEMO_REGISTRY } = await import("./demo-registry")
const { DEMO_STYLE_ADAPTER } = await import("./demo-style-runtime")

const origin = process.env.EXPO_TURBO_DEMO_ORIGIN
const liveTest = origin ? test : test.skip
const FORM_PATH = "/api/expo_turbo/demo/form"
const FRAME_ID = "demo-form-frame"
const TURBO_STREAM_MIME_TYPE = "text/vnd.turbo-stream.html"

const globalWithAct = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean
}
globalWithAct.IS_REACT_ACT_ENVIRONMENT = true

interface PendingFetch {
  readonly request: TurboRequest
  readonly resolve: (response: TurboResponse) => void
}

async function fetchResponse(request: TurboRequest): Promise<TurboResponse> {
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
}

function createFetchAdapter(requests: TurboRequest[]): FetchAdapter {
  return Object.freeze({
    async fetch(request: TurboRequest): Promise<TurboResponse> {
      requests.push(request)
      return fetchResponse(request)
    },
  })
}

function createControlledFetchAdapter(pending: PendingFetch[]): FetchAdapter {
  return Object.freeze({
    fetch(request: TurboRequest): Promise<TurboResponse> {
      return new Promise<TurboResponse>((resolve) => {
        pending.push(Object.freeze({ request, resolve }))
      })
    },
  })
}

function takePending(pending: PendingFetch[], message: string): PendingFetch {
  const next = pending.shift()
  if (!next) throw new Error(message)
  return next
}

liveTest(
  "submits a real Rails Frame form through authoritative 422 XML, 204, and a canonical 303 GET",
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
    const invalidSubmitter = invalid.register("id:demo-form-submit", {
      kind: "submitter",
      name: "commit",
      value: "save",
    })

    await expect(
      invalid.submit({ protocol: { requestId: "rails-form-invalid" }, submitter: invalidSubmitter.selection }),
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
        value: "profile%5Bfirst_name%5D=invalid&commit=save",
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

    const textPlain = forms.controlsFor("id:demo-form")
    textPlain.register("id:demo-form-first-name", {
      kind: "value",
      name: "profile[first_name]",
      value: "invalid",
    })
    const textPlainSubmitter = textPlain.register("id:demo-form-text-plain", {
      kind: "submitter",
      name: "commit",
      value: "save",
    })

    await expect(
      textPlain.submit({
        protocol: { requestId: "rails-form-text-plain-invalid" },
        submitter: textPlainSubmitter.selection,
      }),
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
        contentType: "text/plain",
        value: "profile[first_name]=invalid\r\ncommit=save\r\n",
      },
      headers: {
        Accept: `${TURBO_STREAM_MIME_TYPE}, ${EXPO_TURBO_MIME_TYPE}`,
        "Turbo-Frame": FRAME_ID,
      },
      method: "POST",
      url: formUrl,
    })
    const textPlainError = session.tree.getElementById("demo-form-error")
    if (!textPlainError) throw new Error("Rails text/plain validation response did not include its error")
    expect(nodeTextContent(textPlainError)).toBe("This demo name is unavailable")

    const noContent = forms.controlsFor("id:demo-form")
    noContent.register("id:demo-form-first-name", {
      kind: "value",
      name: "profile[first_name]",
      value: "Ada",
    })
    const noContentSubmitter = noContent.register("id:demo-form-complete", {
      kind: "submitter",
      name: "commit",
      value: "no-content",
    })
    const frameBeforeNoContent = session.tree.getElementById(FRAME_ID)
    if (!frameBeforeNoContent) throw new Error("Rails no-content response has no active Frame")
    const childrenBeforeNoContent = frameBeforeNoContent.children
    const revisionBeforeNoContent = session.revision

    await expect(
      noContent.submit({
        protocol: { requestId: "rails-form-no-content" },
        submitter: noContentSubmitter.selection,
      }),
    ).resolves.toMatchObject({
      application: "empty",
      classification: "success",
      destination: { frameId: FRAME_ID, kind: "frame" },
      redirected: false,
      responseStatus: 204,
      responseUrl: formUrl,
      status: "empty",
    })
    expect(requests.shift()).toMatchObject({
      body: {
        contentType: "application/x-www-form-urlencoded;charset=UTF-8",
        value: "profile%5Bfirst_name%5D=Ada&commit=no-content",
      },
      headers: {
        Accept: `${TURBO_STREAM_MIME_TYPE}, ${EXPO_TURBO_MIME_TYPE}`,
        "Turbo-Frame": FRAME_ID,
      },
      method: "POST",
      url: formUrl,
    })
    expect(session.tree.getElementById(FRAME_ID)).toBe(frameBeforeNoContent)
    expect(frameBeforeNoContent.children).toBe(childrenBeforeNoContent)
    expect(session.revision).toBe(revisionBeforeNoContent)
    expect(noContent.isDisposed).toBe(false)

    const validSubmitter = noContent.register("id:demo-form-submit", {
      kind: "submitter",
      name: "commit",
      value: "save",
    })

    await expect(
      noContent.submit({ protocol: { requestId: "rails-form-valid" }, submitter: validSubmitter.selection }),
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
        value: "profile%5Bfirst_name%5D=Ada&commit=save",
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

liveTest("renders and submits the real Rails Frame form through the Expo provider", async () => {
  if (!origin) throw new Error("EXPO_TURBO_DEMO_ORIGIN is required for the Rails form smoke")

  const formUrl = new URL(FORM_PATH, new URL(origin).origin).toString()
  const pending: PendingFetch[] = []
  const fetch = createControlledFetchAdapter(pending)
  const session = new DocumentSession(
    parseExpoTurboDocument(
      `<Gallery id="rails-form-provider-smoke"><turbo-frame id="${FRAME_ID}" src="${formUrl}"><DemoText id="demo-form-loading">Loading</DemoText></turbo-frame></Gallery>`,
      { url: formUrl },
    ),
  )
  const frameLoader = new FrameRequestLoader(session, fetch, {
    next: () => "rails-form-provider-frame",
  })
  const frames = new FrameControllerRegistry(session, frameLoader)
  const focus = new DemoFocusRegistry()
  const formController = new FormSubmissionController(session, fetch, {
    frameControllers: frames,
  })
  const submit = formController.submit.bind(formController)
  let submission: Promise<unknown> | undefined
  formController.submit = (...args) => {
    const result = submit(...args)
    submission = result
    return result
  }
  const forms = new DocumentFormControls(session, {
    focus,
    formSemantics: DEMO_REGISTRY,
    submissionController: formController,
  })
  let renderer: ReactTestRenderer | undefined
  const submitter = (label: string) => {
    const rendered = renderer?.root.findByProps({ accessibilityLabel: label })
    if (!rendered?.props.onPress) throw new Error(`The ${label} submitter did not render`)
    return rendered.props as PressableProps
  }

  try {
    act(() => {
      renderer = create(
        createElement(
          DemoFocusProvider,
          { focus },
          createElement(
            ExpoTurboProvider,
            {
              forms,
              frames,
              registry: DEMO_REGISTRY,
              session,
              styles: DEMO_STYLE_ADAPTER,
            },
            createElement(ExpoTurboRoot),
          ),
        ),
        {
          createNodeMock: (element) =>
            element.type === "text-input"
              ? {
                  blur: () => undefined,
                  focus: () => undefined,
                }
              : {},
        },
      )
    })

    const initial = takePending(pending, "The mounted Frame did not request the Rails form")
    expect(initial.request).toMatchObject({
      headers: { Accept: EXPO_TURBO_MIME_TYPE, "Turbo-Frame": FRAME_ID },
      method: "GET",
      url: formUrl,
    })
    const initialResponse = await fetchResponse(initial.request)
    await act(async () => {
      initial.resolve(initialResponse)
      await Promise.resolve()
    })
    await frames.get(FRAME_ID).loaded
    expect(session.tree.getElementById("demo-form")?.kind).toBe("element")
    expect(renderer?.root.findByProps({ accessibilityLabel: "First name" }).props.value).toBe("")
    expect(submitter("Save first name").accessibilityRole).toBe("button")

    await act(async () => {
      renderer?.root.findByProps({ accessibilityLabel: "First name" }).props.onChangeText("Ada")
      await Promise.resolve()
    })
    const frameBeforeNoContent = session.tree.getElementById(FRAME_ID)
    if (!frameBeforeNoContent) throw new Error("The mounted Rails Frame is missing")
    const childrenBeforeNoContent = frameBeforeNoContent.children
    const revisionBeforeNoContent = session.revision
    submission = undefined
    act(() => {
      submitter("Complete without replacing Frame").onPress?.()
    })
    const noContentSubmission = submission
    if (!noContentSubmission) throw new Error("The no-content submitter did not create a submission")
    const noContent = takePending(pending, "The no-content submitter did not start a Rails request")
    expect(noContent.request).toMatchObject({
      body: {
        contentType: "application/x-www-form-urlencoded;charset=UTF-8",
        value: "profile%5Bfirst_name%5D=Ada&commit=no-content",
      },
      headers: {
        Accept: `${TURBO_STREAM_MIME_TYPE}, ${EXPO_TURBO_MIME_TYPE}`,
        "Turbo-Frame": FRAME_ID,
      },
      method: "POST",
      url: formUrl,
    })
    const noContentResponse = await fetchResponse(noContent.request)
    await act(async () => {
      noContent.resolve(noContentResponse)
      await Promise.resolve()
    })
    await noContentSubmission
    expect(session.tree.getElementById(FRAME_ID)).toBe(frameBeforeNoContent)
    expect(frameBeforeNoContent.children).toBe(childrenBeforeNoContent)
    expect(session.revision).toBe(revisionBeforeNoContent)
    expect(renderer?.root.findByProps({ accessibilityLabel: "Form ready" })).toBeDefined()
    expect(renderer?.root.findByProps({ accessibilityLabel: "First name" }).props.value).toBe("Ada")
    expect(pending).toHaveLength(0)

    await act(async () => {
      renderer?.root.findByProps({ accessibilityLabel: "First name" }).props.onChangeText("invalid")
      await Promise.resolve()
    })
    submission = undefined
    act(() => {
      submitter("Save first name").onPress?.()
    })
    const invalidSubmission = submission
    if (!invalidSubmission) throw new Error("The rendered submitter did not create a submission")
    const invalid = takePending(pending, "The rendered submitter did not start a Rails request")
    expect(invalid.request).toMatchObject({
      body: {
        contentType: "application/x-www-form-urlencoded;charset=UTF-8",
        value: "profile%5Bfirst_name%5D=invalid&commit=save",
      },
      headers: {
        Accept: `${TURBO_STREAM_MIME_TYPE}, ${EXPO_TURBO_MIME_TYPE}`,
        "Turbo-Frame": FRAME_ID,
      },
      method: "POST",
      url: formUrl,
    })
    const invalidResponse = await fetchResponse(invalid.request)
    await act(async () => {
      invalid.resolve(invalidResponse)
      await Promise.resolve()
    })
    await invalidSubmission
    expect(session.tree.getElementById("demo-form-error")).toBeDefined()
    expect(renderer?.root.findByProps({ accessibilityLabel: "Form ready" })).toBeDefined()
    expect(renderer?.root.findByProps({ accessibilityLabel: "First name" }).props.value).toBe(
      "invalid",
    )
    expect(JSON.stringify(renderer?.toJSON())).toContain("This demo name is unavailable")

    await act(async () => {
      renderer?.root.findByProps({ accessibilityLabel: "First name" }).props.onChangeText("Ada")
      await Promise.resolve()
    })
    submission = undefined
    act(() => {
      submitter("Save first name").onPress?.()
    })
    const validSubmission = submission
    if (!validSubmission) throw new Error("The replacement submitter did not create a submission")
    const valid = takePending(pending, "The replacement form did not start a Rails request")
    expect(valid.request).toMatchObject({
      body: {
        contentType: "application/x-www-form-urlencoded;charset=UTF-8",
        value: "profile%5Bfirst_name%5D=Ada&commit=save",
      },
      headers: {
        Accept: `${TURBO_STREAM_MIME_TYPE}, ${EXPO_TURBO_MIME_TYPE}`,
        "Turbo-Frame": FRAME_ID,
      },
      method: "POST",
      url: formUrl,
    })
    const validResponse = await fetchResponse(valid.request)
    await act(async () => {
      valid.resolve(validResponse)
      await Promise.resolve()
    })
    await validSubmission
    expect(pending).toHaveLength(0)
    expect(session.tree.getElementById("demo-form-error")).toBeUndefined()
    expect(renderer?.root.findByProps({ accessibilityLabel: "First name" }).props.value).toBe("")
  } finally {
    await act(async () => {
      renderer?.unmount()
      await Promise.resolve()
    })
    forms.dispose()
    frames.dispose()
    focus.dispose()
  }
})
