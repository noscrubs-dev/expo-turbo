import { describe, expect, test } from "bun:test"

import type { NavigationAdapter, TurboRequest, TurboResponse, VisitAction } from "../adapters"
import { FrameMissingError, TargetError } from "./errors"
import {
  consumeFrameAutofocus,
  notifyMountedFrameAutofocus,
  recordFrameAutofocusReport,
} from "./frame-autofocus-internal"
import { FrameControllerRegistry } from "./frame-controller-registry"
import { EXPO_TURBO_MIME_TYPE, FrameRequestLoader } from "./frame-loader"
import { activeFrameAutofocusCandidates } from "./frame-response-application"
import { applyFrameResponse } from "./frames"
import { parseExpoTurboDocument } from "./parser"
import { DocumentSession } from "./session"
import { dispatchTurboStreamFragment } from "./streams"
import { attributeValue, isElement } from "./tree"

interface Harness {
  readonly external: string[]
  readonly navigation: Array<{ action: VisitAction; url: string }>
  readonly registry: FrameControllerRegistry
  readonly requests: TurboRequest[]
  readonly session: DocumentSession
}

function harness(documentUrl = "https://example.test/document"): Harness {
  const external: string[] = []
  const navigation: Array<{ action: VisitAction; url: string }> = []
  const requests: TurboRequest[] = []
  const session = new DocumentSession(
    parseExpoTurboDocument(
      `<Gallery>
        <turbo-frame id="named" />
        <turbo-frame id="outer">
          <turbo-frame id="current" target="named" />
        </turbo-frame>
      </Gallery>`,
      { url: documentUrl },
    ),
  )
  const navigationAdapter: NavigationAdapter = {
    back() {},
    openExternal: (url) => {
      external.push(url)
    },
    visit: (url, action) => {
      navigation.push({ action, url })
    },
  }
  let requestId = 0
  const loader = new FrameRequestLoader(
    session,
    {
      async fetch(request): Promise<TurboResponse> {
        requests.push(request)
        const frameId = request.headers["Turbo-Frame"]
        if (!frameId) throw new Error("fixture request is missing its Frame header")
        return {
          headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
          redirected: false,
          status: 200,
          text: async () => `<turbo-frame id="${frameId}"><Loaded /></turbo-frame>`,
          url: request.url,
        }
      },
    },
    { next: () => `request-${++requestId}` },
  )
  return {
    external,
    navigation,
    registry: new FrameControllerRegistry(session, loader, undefined, navigationAdapter),
    requests,
    session,
  }
}

describe("Frame controller registry visits", () => {
  test("finds only the exact mounted connected Frame controller without creating one", async () => {
    const { registry, session } = harness()
    const original = session.tree.getElementById("named")
    if (original?.kind !== "frame") throw new Error("fixture Frame is missing")

    expect(registry.findMounted(original)).toBeUndefined()
    const controller = registry.get("named")
    expect(registry.findMounted(original)).toBeUndefined()
    await controller.connect()
    expect(registry.findMounted(original)).toBe(controller)

    dispatchTurboStreamFragment(
      session,
      '<turbo-stream action="replace" target="named"><template><turbo-frame id="named" /></template></turbo-stream>',
    )
    const replacement = session.tree.getElementById("named")
    if (replacement?.kind !== "frame") throw new Error("replacement Frame is missing")
    expect(registry.findMounted(original)).toBeUndefined()
    expect(registry.findMounted(replacement)).toBeUndefined()

    const replacementController = registry.get("named")
    await replacementController.connect()
    expect(registry.findMounted(replacement)).toBe(replacementController)
    registry.dispose()
  })

  test("keeps exact connected autofocus valid across unrelated Frame mutations", async () => {
    const { registry, session } = harness()
    const controller = registry.get("named")
    const frame = session.tree.getElementById("named")
    if (frame?.kind !== "frame") throw new Error("fixture Frame is missing")
    const report = recordFrameAutofocusReport(
      applyFrameResponse(
        session,
        "named",
        '<turbo-frame id="named"><Field id="field" autofocus="" /></turbo-frame>',
      ),
      session,
      frame,
      activeFrameAutofocusCandidates(session, frame),
    )

    expect(notifyMountedFrameAutofocus(registry, report)).toBe(false)
    await controller.connect()
    expect(notifyMountedFrameAutofocus(registry, report)).toBe(true)
    applyFrameResponse(
      session,
      "outer",
      '<turbo-frame id="outer"><Changed id="unrelated" /></turbo-frame>',
    )
    expect(consumeFrameAutofocus(controller, controller.state.revision)).toEqual(["id:field"])

    const stale = recordFrameAutofocusReport(
      applyFrameResponse(
        session,
        "named",
        '<turbo-frame id="named"><Field id="same" autofocus="" /></turbo-frame>',
      ),
      session,
      frame,
      activeFrameAutofocusCandidates(session, frame),
    )
    applyFrameResponse(
      session,
      "named",
      '<turbo-frame id="named"><Field id="same" /></turbo-frame>',
    )
    expect(notifyMountedFrameAutofocus(registry, stale)).toBe(false)
    expect(consumeFrameAutofocus(controller, controller.state.revision)).toBeUndefined()

    dispatchTurboStreamFragment(
      session,
      '<turbo-stream action="replace" target="named"><template><turbo-frame id="named" /></template></turbo-stream>',
    )
    expect(controller.state.connected).toBe(false)
    expect(notifyMountedFrameAutofocus(registry, report)).toBe(false)
  })

  test("uses target resolution and the existing controller loader for named Frame visits", async () => {
    const { registry, requests, session } = harness()

    const first = await registry.visit("/named", { frame: "current" })
    const second = await registry.visit("/named", { frame: "current" })
    if (second.kind !== "frame") throw new Error("fixture visit did not resolve to a Frame")

    expect(first).toMatchObject({
      frameId: "named",
      kind: "frame",
      target: { frameId: "named", kind: "frame", requestedTarget: "named" },
      url: "https://example.test/named",
    })
    expect(second.load).toMatchObject({ status: "completed" })
    expect(requests).toHaveLength(2)
    expect(requests.map((request) => request.headers["Turbo-Frame"])).toEqual(["named", "named"])
    expect(registry.get("named").state).toMatchObject({ connected: true, status: "completed" })
    expect(session.tree.getElementById("named")?.children.filter(isElement)[0]?.tagName).toBe(
      "Loaded",
    )
  })

  test("loads self and parent targets without a parallel request implementation", async () => {
    const { registry, requests, session } = harness()

    const self = await registry.visit("/self", {
      elementTarget: "_self",
      frame: "current",
    })
    const result = await registry.visit("/parent", {
      elementTarget: "_parent",
      frame: "current",
    })
    if (result.kind !== "frame") throw new Error("fixture visit did not resolve to a Frame")

    expect(self).toMatchObject({ frameId: "current", kind: "frame" })
    expect(result).toMatchObject({ frameId: "outer", kind: "frame" })
    expect(requests.map((request) => request.headers["Turbo-Frame"])).toEqual(["current", "outer"])
    expect(session.tree.getElementById("outer")?.children.filter(isElement)[0]?.tagName).toBe(
      "Loaded",
    )
  })

  test("rejects Frame-local visit actions before request ownership", async () => {
    const { registry, requests } = harness()

    await expect(
      registry.visit("/self", {
        action: "advance",
        frame: "current",
      }),
    ).rejects.toBeInstanceOf(TargetError)
    await expect(
      registry.visit("/named", {
        action: "replace",
        frame: "current",
      }),
    ).rejects.toBeInstanceOf(TargetError)

    expect(requests).toHaveLength(0)
  })

  test("inherits exact destination-Frame actions while an explicit null masks inheritance", async () => {
    const inherited = harness()
    inherited.session.setAttribute("id:named", "data-turbo-action", "replace")

    await expect(
      inherited.registry.visit("/named-inherited", { frame: "current" }),
    ).rejects.toBeInstanceOf(TargetError)
    expect(inherited.requests).toHaveLength(0)

    const masked = harness()
    masked.session.setAttribute("id:named", "data-turbo-action", "advance")
    await expect(
      masked.registry.visit("/named-masked", { action: null, frame: "current" }),
    ).resolves.toMatchObject({ frameId: "named", kind: "frame" })
    expect(masked.requests).toHaveLength(1)

    const invalid = harness()
    invalid.session.setAttribute("id:named", "data-turbo-action", "Advance")
    await expect(
      invalid.registry.visit("/named-invalid", { frame: "current" }),
    ).resolves.toMatchObject({ frameId: "named", kind: "frame" })
    expect(invalid.requests).toHaveLength(1)
  })

  test("does not inherit Frame actions for promoted or external visits", async () => {
    const { external, navigation, registry, requests, session } = harness()
    session.setAttribute("id:current", "data-turbo-action", "replace")
    session.setAttribute("id:named", "data-turbo-action", "restore")

    await expect(
      registry.visit("/top-without-inheritance", {
        elementTarget: "_top",
        frame: "current",
      }),
    ).resolves.toMatchObject({ action: "advance", kind: "top" })
    await expect(
      registry.visit("https://outside.test/no-inheritance", { frame: "current" }),
    ).resolves.toMatchObject({ kind: "external" })

    expect(navigation).toEqual([
      { action: "advance", url: "https://example.test/top-without-inheritance" },
    ])
    expect(external).toEqual(["https://outside.test/no-inheritance"])
    expect(requests).toHaveLength(0)
  })

  test("delegates top-level and external visits through the navigation adapter", async () => {
    const { external, navigation, registry, requests } = harness()

    expect(
      await registry.visit("/top", {
        action: "replace",
        elementTarget: "_top",
        frame: "current",
      }),
    ).toMatchObject({ action: "replace", kind: "top", url: "https://example.test/top" })
    expect(await registry.visit("https://outside.test/path", { frame: "current" })).toMatchObject({
      kind: "external",
      url: "https://outside.test/path",
    })
    expect(navigation).toEqual([{ action: "replace", url: "https://example.test/top" }])
    expect(external).toEqual(["https://outside.test/path"])
    expect(requests).toHaveLength(0)
  })

  test("routes only promoted same-origin visits through the shared document coordinator", async () => {
    const requests: TurboRequest[] = []
    const topLevel: Array<{ action: VisitAction | undefined; url: string }> = []
    const external: string[] = []
    const session = new DocumentSession(
      parseExpoTurboDocument(
        `<Gallery data-turbo-root="/app">
          <turbo-frame id="outer">
            <turbo-frame id="current" />
          </turbo-frame>
        </Gallery>`,
        { url: "https://example.test/app/document" },
      ),
    )
    const loader = new FrameRequestLoader(
      session,
      {
        fetch: async (request) => {
          requests.push(request)
          const frameId = request.headers["Turbo-Frame"]
          return {
            headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
            redirected: false,
            status: 200,
            text: async () => `<turbo-frame id="${frameId}" />`,
            url: request.url,
          }
        },
      },
      { next: () => `request-${requests.length + 1}` },
    )
    const registry = new FrameControllerRegistry(
      session,
      loader,
      undefined,
      {
        back() {},
        openExternal: (url) => {
          external.push(url)
        },
        visit() {
          throw new Error("fallback navigation must not own promoted visits")
        },
      },
      {
        visit: async (url, options) => {
          topLevel.push({ action: options?.action, url })
          return Object.freeze({
            action: options?.action ?? "advance",
            kind: "navigation",
            reason: "outside-root",
            status: "delegated",
            url,
          })
        },
      },
    )

    const rootExternalFrame = await registry.visit("/outside-frame", {
      frame: "current",
    })
    const extensionFrame = await registry.visit("/app/archive.pdf", {
      frame: "current",
    })
    const promoted = await registry.visit("/outside", {
      elementTarget: "_top",
      frame: "current",
    })
    await registry.visit("https://outside.test/path", {
      elementTarget: "_top",
      frame: "current",
    })
    await registry.visit("/outside-parent", {
      elementTarget: "_parent",
      frame: "current",
    })

    expect(rootExternalFrame).toMatchObject({ frameId: "current", kind: "frame" })
    expect(extensionFrame).toMatchObject({ frameId: "current", kind: "frame" })
    expect(promoted).toMatchObject({
      action: "advance",
      kind: "top",
      outcome: {
        action: "advance",
        kind: "navigation",
        reason: "outside-root",
        status: "delegated",
      },
    })
    expect(topLevel).toEqual([{ action: "advance", url: "https://example.test/outside" }])
    expect(requests.map((request) => request.url)).toEqual([
      "https://example.test/outside-frame",
      "https://example.test/app/archive.pdf",
      "https://example.test/outside-parent",
    ])
    expect(requests.map((request) => request.headers["Turbo-Frame"])).toEqual([
      "current",
      "current",
      "outer",
    ])
    expect(external).toEqual(["https://outside.test/path"])
  })

  test("awaits host navigation and preserves Frame ownership when the adapter rejects", async () => {
    const session = new DocumentSession(
      parseExpoTurboDocument('<Gallery><turbo-frame id="current" src="/valid" /></Gallery>', {
        url: "https://example.test/document",
      }),
    )
    const requests: TurboRequest[] = []
    const failure = new Error("Host navigation failed")
    let resolveRequest: ((response: TurboResponse) => void) | undefined
    const loader = new FrameRequestLoader(
      session,
      {
        fetch(request): Promise<TurboResponse> {
          requests.push(request)
          return new Promise((resolve) => {
            resolveRequest = resolve
          })
        },
      },
      { next: () => "request-1" },
    )
    const registry = new FrameControllerRegistry(session, loader, undefined, {
      back() {},
      async openExternal() {
        throw failure
      },
      async visit() {
        throw failure
      },
    })
    const controller = registry.get("current")
    const current = controller.connect()
    const started = controller.state

    await expect(registry.visit("https://outside.test/path", { frame: "current" })).rejects.toBe(
      failure,
    )
    await expect(registry.visit("/top", { elementTarget: "_top", frame: "current" })).rejects.toBe(
      failure,
    )
    expect(requests).toHaveLength(1)
    expect(requests[0]?.signal?.aborted).toBe(false)
    expect(controller.state).toBe(started)
    const frame = session.tree.getElementById("current")
    if (!frame) throw new Error("fixture Frame is missing")
    expect(attributeValue(frame, "src")).toBe("/valid")

    controller.cancel()
    resolveRequest?.({
      headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
      redirected: false,
      status: 200,
      text: async () => '<turbo-frame id="current"><Late /></turbo-frame>',
      url: "https://example.test/valid",
    })
    await current
    registry.dispose()
  })

  test("rejects unsafe, credential-bearing, malformed, and fragment visit URLs before dispatch", async () => {
    const sources = [
      "javascript:alert('secret-token')",
      "data:text/plain,secret-token",
      "file:///tmp/secret-token",
      "blob:https://example.test/secret-token",
      "mailto:secret-token@example.test",
      "tel:secret-token",
      "custom:secret-token",
      "https://user:secret-token@example.test/private",
      "https://user:secret-token@outside.test/private",
      "http://[secret-token",
      "/next#section",
      "/next#",
      "https://outside.test/next#section",
    ]

    for (const source of sources) {
      const { external, navigation, registry, requests } = harness()
      let error: unknown
      try {
        await registry.visit(source, { elementTarget: "_top", frame: "current" })
      } catch (reason) {
        error = reason
      }

      expect(error).toBeInstanceOf(TargetError)
      if (!(error instanceof TargetError)) throw new Error("fixture did not reject the visit")
      expect(error.cause).toBeUndefined()
      expect(error.message).not.toContain("secret-token")
      expect(JSON.stringify(error.context)).not.toContain("secret-token")
      expect(external).toHaveLength(0)
      expect(navigation).toHaveLength(0)
      expect(requests).toHaveLength(0)
      registry.dispose()
    }
  })

  test("rejects invalid active document URLs before dispatch", async () => {
    const documentUrls = [
      "file:///tmp/secret-token",
      "https://user:secret-token@example.test/document",
      "not a secret-token URL",
    ]

    for (const documentUrl of documentUrls) {
      const { external, navigation, registry, requests } = harness(documentUrl)
      let error: unknown
      try {
        await registry.visit("/next", { elementTarget: "_top", frame: "current" })
      } catch (reason) {
        error = reason
      }

      expect(error).toBeInstanceOf(TargetError)
      if (!(error instanceof TargetError))
        throw new Error("fixture did not reject the document URL")
      expect(error.cause).toBeUndefined()
      expect(error.message).not.toContain("secret-token")
      expect(JSON.stringify(error.context)).not.toContain("secret-token")
      expect(external).toHaveLength(0)
      expect(navigation).toHaveLength(0)
      expect(requests).toHaveLength(0)
      registry.dispose()
    }
  })

  test("keeps an active Frame request authoritative when a newer visit URL is rejected", async () => {
    const requests: TurboRequest[] = []
    let resolveRequest: ((response: TurboResponse) => void) | undefined
    const session = new DocumentSession(
      parseExpoTurboDocument(
        '<Gallery><turbo-frame id="frame" src="/valid"><Initial/></turbo-frame></Gallery>',
        { url: "https://example.test/document" },
      ),
    )
    const loader = new FrameRequestLoader(
      session,
      {
        fetch: (request) => {
          requests.push(request)
          return new Promise<TurboResponse>((resolve) => {
            resolveRequest = resolve
          })
        },
      },
      { next: () => `request-${requests.length + 1}` },
    )
    const registry = new FrameControllerRegistry(session, loader)
    const controller = registry.get("frame")
    const activeLoad = controller.connect()

    expect(requests).toHaveLength(1)
    expect(requests[0]?.signal?.aborted).toBe(false)
    expect(controller.state).toMatchObject({ source: "/valid", status: "loading" })

    await expect(
      registry.visit("https://user:secret-token@example.test/private", { frame: "frame" }),
    ).rejects.toBeInstanceOf(TargetError)

    expect(requests).toHaveLength(1)
    expect(requests[0]?.signal?.aborted).toBe(false)
    expect(controller.state).toMatchObject({ source: "/valid", status: "loading" })
    const frame = session.tree.getElementById("frame")
    if (!frame) throw new Error("fixture Frame is missing")
    expect(attributeValue(frame, "src")).toBe("/valid")

    registry.dispose()
    resolveRequest?.({
      headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
      redirected: false,
      status: 200,
      text: async () => '<turbo-frame id="frame"><Late/></turbo-frame>',
      url: "https://example.test/valid",
    })
    expect(await activeLoad).toMatchObject({ status: "canceled" })
  })

  test("fails loudly when a promoted visit has no navigation adapter", async () => {
    const { registry, session } = harness()
    const loader = new FrameRequestLoader(
      session,
      { fetch: async () => Promise.reject(new Error("fetch must not run")) },
      { next: () => "request-1" },
    )
    const withoutNavigation = new FrameControllerRegistry(session, loader)

    await expect(
      withoutNavigation.visit("/top", { elementTarget: "_top", frame: "current" }),
    ).rejects.toBeInstanceOf(TargetError)
    registry.dispose()
  })

  test("binds controllers and requests to the exact Frame node identity", async () => {
    const pending: Array<{
      request: TurboRequest
      resolve: (response: TurboResponse) => void
    }> = []
    const session = new DocumentSession(
      parseExpoTurboDocument(
        '<Gallery><turbo-frame id="frame" src="/old"><Initial/></turbo-frame></Gallery>',
        { url: "https://example.test/document" },
      ),
    )
    const loader = new FrameRequestLoader(
      session,
      {
        fetch: (request) =>
          new Promise<TurboResponse>((resolve) => pending.push({ request, resolve })),
      },
      { next: () => `request-${pending.length + 1}` },
    )
    const registry = new FrameControllerRegistry(session, loader)
    const original = registry.get("frame")
    const originalLoad = original.connect()

    expect(pending).toHaveLength(1)
    dispatchTurboStreamFragment(
      session,
      '<turbo-stream action="update" target="frame"><template><Updated/></template></turbo-stream>',
    )
    expect(registry.get("frame")).toBe(original)
    expect(pending[0]?.request.signal?.aborted).toBe(false)

    dispatchTurboStreamFragment(
      session,
      '<turbo-stream action="replace" target="frame"><template><turbo-frame id="frame" src="/new"><Replacement/></turbo-frame></template></turbo-stream>',
    )
    expect(pending[0]?.request.signal?.aborted).toBe(true)
    expect(original.state).toMatchObject({ connected: false, status: "canceled" })
    expect(() => original.reload()).toThrow(FrameMissingError)

    const replacement = registry.get("frame")
    expect(replacement).not.toBe(original)
    expect(replacement.state.source).toBe("/new")
    const replacementLoad = replacement.connect()
    expect(pending).toHaveLength(2)
    original.cancel()
    expect(pending[1]?.request.signal?.aborted).toBe(false)

    pending[0]?.resolve({
      headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
      redirected: false,
      status: 200,
      text: async () => '<turbo-frame id="frame"><Late/></turbo-frame>',
      url: "https://example.test/old",
    })
    expect(await originalLoad).toMatchObject({ status: "canceled" })
    expect(session.tree.getElementById("frame")?.children.filter(isElement)[0]?.tagName).toBe(
      "Replacement",
    )

    dispatchTurboStreamFragment(session, '<turbo-stream action="remove" target="frame"/>')
    expect(pending[1]?.request.signal?.aborted).toBe(true)
    expect(replacement.state).toMatchObject({ connected: false, status: "canceled" })
    expect(() => registry.get("frame")).toThrow(FrameMissingError)
    pending[1]?.resolve({
      headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
      redirected: false,
      status: 200,
      text: async () => '<turbo-frame id="frame"><LateReplacement/></turbo-frame>',
      url: "https://example.test/new",
    })
    expect(await replacementLoad).toMatchObject({ status: "canceled" })
    expect(session.tree.getElementById("frame")).toBeUndefined()

    registry.dispose()
    registry.dispose()
  })
})
