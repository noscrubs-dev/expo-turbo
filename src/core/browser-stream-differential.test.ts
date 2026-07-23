import { afterAll, beforeAll, expect, test } from "bun:test"
import {
  type Element as HappyElement,
  type Event as HappyEvent,
  type Node as HappyNode,
  Window,
} from "happy-dom"
import type { ClockAdapter, TurboRequest } from "../adapters"
import {
  applyFrameResponse,
  buildFormRequest,
  ContentTypeError,
  DocumentHistory,
  DocumentRequestLoader,
  DocumentSession,
  DocumentSnapshotCache,
  DocumentVisitController,
  dispatchTurboStreamFragment,
  EXPO_TURBO_MIME_TYPE,
  FormControlRegistry,
  FormLinkSubmissionController,
  FormSubmissionController,
  FrameController,
  FrameLifecycle,
  FrameRequestLoader,
  isElement,
  type ProtocolElement,
  type ProtocolNode,
  parseExpoTurboDocument,
} from "."
import { TURBO_STREAM_MIME_TYPE } from "./protocol-request"

type TurboModule = typeof import("@hotwired/turbo")

const browser = new Window({ url: "https://example.test/demo" })
const originalGlobals = new Map<string, PropertyDescriptor | undefined>()
let turbo: TurboModule

interface NormalizedElement {
  readonly attributes: readonly (readonly [string, string])[]
  readonly children: readonly (NormalizedElement | string)[]
  readonly tag: string
}

function installBrowserGlobals(): void {
  const globals = {
    AbortController: browser.AbortController,
    CSS: browser.CSS,
    CustomEvent: browser.CustomEvent,
    DOMParser: browser.DOMParser,
    Document: browser.Document,
    Element: browser.Element,
    Event: browser.Event,
    EventTarget: browser.EventTarget,
    FormData: browser.FormData,
    HTMLAnchorElement: browser.HTMLAnchorElement,
    HTMLBodyElement: browser.HTMLBodyElement,
    HTMLButtonElement: browser.HTMLButtonElement,
    HTMLElement: browser.HTMLElement,
    HTMLFormElement: browser.HTMLFormElement,
    HTMLHeadElement: browser.HTMLHeadElement,
    HTMLIFrameElement: browser.HTMLIFrameElement,
    HTMLInputElement: browser.HTMLInputElement,
    HTMLOptionElement: browser.HTMLOptionElement,
    HTMLTemplateElement: browser.HTMLTemplateElement,
    HTMLTextAreaElement: browser.HTMLTextAreaElement,
    IntersectionObserver: browser.IntersectionObserver,
    MutationObserver: browser.MutationObserver,
    MouseEvent: browser.MouseEvent,
    Node: browser.Node,
    NodeFilter: browser.NodeFilter,
    Request: browser.Request,
    Response: browser.Response,
    ShadowRoot: browser.ShadowRoot,
    URL: browser.URL,
    URLSearchParams: browser.URLSearchParams,
    Window: browser.Window,
    addEventListener: browser.addEventListener.bind(browser),
    cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
    customElements: browser.customElements,
    document: browser.document,
    history: browser.history,
    location: browser.location,
    navigator: browser.navigator,
    removeEventListener: browser.removeEventListener.bind(browser),
    requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
    window: browser,
  } as const

  for (const [name, value] of Object.entries(globals)) {
    originalGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, value, writable: true })
  }
}

function restoreGlobals(): void {
  for (const [name, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else Reflect.deleteProperty(globalThis, name)
  }
}

function normalizeProtocolNode(node: ProtocolNode): NormalizedElement | string | undefined {
  if (node.kind === "text") return node.value
  if (node.kind === "comment") return undefined
  if (node.kind === "document") throw new Error("Expected an element or text node")

  return {
    attributes: node.attributes
      .filter((attribute) => attribute.name !== "xmlns" && attribute.prefix !== "xmlns")
      .map((attribute) => [attribute.name, attribute.value] as const)
      .sort(([left], [right]) => left.localeCompare(right)),
    children: node.children
      .map(normalizeProtocolNode)
      .filter((child): child is NormalizedElement | string => child !== undefined),
    tag: node.tagName,
  }
}

function normalizeBrowserNode(node: HappyNode): NormalizedElement | string | undefined {
  if (node.nodeType === browser.Node.TEXT_NODE) return node.textContent ?? ""
  if (node.nodeType === browser.Node.COMMENT_NODE) return undefined
  if (node.nodeType !== browser.Node.ELEMENT_NODE) {
    throw new Error("Expected an element or text node")
  }
  const element = node as HappyElement

  return {
    attributes: [...element.attributes]
      .map((attribute) => [attribute.name, attribute.value ?? ""] as const)
      .sort(([left], [right]) => left.localeCompare(right)),
    children: [...element.childNodes]
      .map(normalizeBrowserNode)
      .filter((child): child is NormalizedElement | string => child !== undefined),
    tag: element.localName,
  }
}

function activeProtocolRoot(session: DocumentSession): ProtocolElement {
  const root = session.tree.document.children.find(isElement)
  if (!root) throw new Error("Differential document has no root element")
  return root
}

const realClock: ClockAdapter = {
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
}

async function runDifferential(initialDocument: string, streamFragment: string) {
  const session = new DocumentSession(
    parseExpoTurboDocument(initialDocument, { url: "https://example.test/demo" }),
  )
  const rootId = activeProtocolRoot(session).attributes.find(
    (attribute) => attribute.name === "id",
  )?.value
  if (!rootId) throw new Error("Differential document root requires an id")

  browser.document.body.innerHTML = initialDocument
  await Promise.all([
    dispatchTurboStreamFragment(session, streamFragment),
    turbo.renderStreamMessage(streamFragment),
  ])
  await browser.happyDOM.waitUntilComplete()

  const browserRoot = browser.document.getElementById(rootId)
  if (!browserRoot) throw new Error(`Browser differential lost root ${rootId}`)
  return {
    browser: normalizeBrowserNode(browserRoot),
    expo: normalizeProtocolNode(activeProtocolRoot(session)),
  }
}

beforeAll(async () => {
  installBrowserGlobals()
  const imported = await import("@hotwired/turbo")
  turbo = (imported.default ?? imported) as TurboModule
  turbo.session.stop()
})

afterAll(async () => {
  turbo.session.stop()
  await browser.happyDOM.close()
  restoreGlobals()
})

test("matches upstream Turbo for ordered built-in Stream mutations", async () => {
  const result = await runDifferential(
    '<main id="root"><section id="messages"><div id="first">First</div><div id="remove-me">Remove</div></section><div id="status">Idle</div><div id="replace-me">Old</div></main>',
    [
      '<turbo-stream action="append" target="messages"><template><div id="second">Second</div></template></turbo-stream>',
      '<turbo-stream action="prepend" target="messages"><template><div id="zero">Zero</div></template></turbo-stream>',
      '<turbo-stream action="update" target="status"><template>Ready</template></turbo-stream>',
      '<turbo-stream action="before" target="second"><template><div id="between">Between</div></template></turbo-stream>',
      '<turbo-stream action="after" target="second"><template><div id="last">Last</div></template></turbo-stream>',
      '<turbo-stream action="remove" target="remove-me"></turbo-stream>',
      '<turbo-stream action="replace" target="replace-me"><template><div id="replace-me">New</div></template></turbo-stream>',
    ].join(""),
  )

  expect(result.expo).toEqual(result.browser)
})

test("matches upstream Turbo for ID collisions and selector targets", async () => {
  const result = await runDifferential(
    '<main id="root"><section id="messages"><div id="first" class="entry odd">Old first</div><div id="second" class="entry even">Old second</div><div id="third" class="entry odd">Old third</div></section></main>',
    [
      '<turbo-stream action="append" target="messages"><template><div id="first" class="entry odd">New first</div><div id="fourth" class="entry even" data-kind="tail">Fourth</div></template></turbo-stream>',
      '<turbo-stream action="update" targets="#messages > .entry:nth-child(odd)"><template><span>Odd</span></template></turbo-stream>',
      '<turbo-stream action="update" targets="#second + .odd, [data-kind=tail]"><template><em>Selected</em></template></turbo-stream>',
      '<turbo-stream action="before" targets="#messages > .even"><template><i class="marker">Before even</i></template></turbo-stream>',
    ].join(""),
  )

  expect(result.expo).toEqual(result.browser)
})

test("matches upstream Turbo target precedence over targets", async () => {
  const result = await runDifferential(
    '<main id="root"><div id="primary" class="all">Primary</div><div id="secondary" class="all">Secondary</div></main>',
    '<turbo-stream action="update" target="primary" targets=".all"><template>Updated</template></turbo-stream>',
  )

  expect(result.expo).toEqual(result.browser)
})

test("matches upstream Turbo absent-template action semantics", async () => {
  const result = await runDifferential(
    '<main id="root"><div id="append-target"><span>Keep</span></div><div id="update-target"><span>Clear</span></div><div id="replace-target">Remove</div><div id="before-target">Before</div><div id="after-target">After</div></main>',
    [
      '<turbo-stream action="append" target="append-target"></turbo-stream>',
      '<turbo-stream action="prepend" target="append-target"></turbo-stream>',
      '<turbo-stream action="update" target="update-target"></turbo-stream>',
      '<turbo-stream action="replace" target="replace-target"></turbo-stream>',
      '<turbo-stream action="before" target="before-target"></turbo-stream>',
      '<turbo-stream action="after" target="after-target"></turbo-stream>',
    ].join(""),
  )

  expect(result.expo).toEqual(result.browser)
})

test("matches upstream Turbo for replace and update morphs", async () => {
  const result = await runDifferential(
    '<main id="root"><section id="replace-target" class="before"><div id="stable"><span>Before</span></div><p id="removed">Remove</p></section><section id="update-target" class="owned"><div id="move">Move</div><div id="old">Old</div></section></main>',
    [
      '<turbo-stream action="replace" target="replace-target" method="morph"><template><section id="replace-target" class="after"><div id="stable"><strong>After</strong></div><p id="added">Added</p></section></template></turbo-stream>',
      '<turbo-stream action="update" target="update-target" method="morph"><template><div id="new">New</div><div id="move">Moved</div></template></turbo-stream>',
    ].join(""),
  )

  expect(result.expo).toEqual(result.browser)
})

test("matches upstream Turbo permanent-node preservation during a morph", async () => {
  const result = await runDifferential(
    '<main id="root"><section id="target"><div id="left"><article id="permanent" data-turbo-permanent=""><span id="client-owned">Client</span></article></div><div id="right"></div></section></main>',
    '<turbo-stream action="update" target="target" method="morph"><template><div id="left"></div><div id="right"><article id="permanent" data-turbo-permanent="" class="server"><span id="server-owned">Server</span></article></div></template></turbo-stream>',
  )

  expect(result.expo).toEqual(result.browser)
})

test("matches upstream Turbo anonymous child reconciliation during a morph", async () => {
  const result = await runDifferential(
    '<main id="root"><section id="target"><div class="row"><span>One</span></div><div class="row"><span>Two</span></div></section></main>',
    '<turbo-stream action="update" target="target" method="morph"><template><div class="row first"><span>One updated</span></div><div class="row second"><span>Two updated</span></div><hr /></template></turbo-stream>',
  )

  expect(result.expo).toEqual(result.browser)
})

test("matches upstream Turbo stable-ID child reordering during a morph", async () => {
  const result = await runDifferential(
    '<main id="root"><section id="target"><div class="row"><input id="one" value="before-one" /></div><div class="row"><input id="two" value="before-two" /></div></section></main>',
    '<turbo-stream action="update" target="target" method="morph"><template><div class="row second"><input id="two" value="after-two" /></div><div class="row first"><input id="one" value="after-one" /></div></template></turbo-stream>',
  )

  expect(result.expo).toEqual(result.browser)
})

test("matches upstream Turbo Frame extraction for an eager response", async () => {
  const initialDocument =
    '<main id="root"><turbo-frame id="details" src="/details"><p id="old">Old</p></turbo-frame></main>'
  const frameResponse =
    '<main><turbo-frame id="details"><p id="loaded">Loaded</p></turbo-frame><p id="outside">Outside</p></main>'
  const session = new DocumentSession(
    parseExpoTurboDocument(initialDocument, { url: "https://example.test/demo" }),
  )
  await applyFrameResponse(session, "details", frameResponse)

  const originalFetch = browser.fetch
  browser.fetch = async () =>
    new browser.Response(frameResponse, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
      status: 200,
    })
  turbo.start()
  try {
    browser.document.body.innerHTML = initialDocument
    await browser.happyDOM.waitUntilComplete()

    const browserFrame = browser.document.getElementById("details")
    const expoFrame = session.tree.getElementById("details")
    if (!browserFrame || !expoFrame) throw new Error("Frame differential lost its target")
    const browserResult = normalizeBrowserNode(browserFrame)
    const expoResult = normalizeProtocolNode(expoFrame)
    if (!browserResult || typeof browserResult === "string") {
      throw new Error("Browser Frame differential result is invalid")
    }
    if (!expoResult || typeof expoResult === "string") {
      throw new Error("Expo Frame differential result is invalid")
    }
    expect(expoResult.children).toEqual(browserResult.children)
    expect(browser.document.getElementById("outside")).toBeNull()
    expect(session.tree.getElementById("outside")).toBeUndefined()
  } finally {
    browser.fetch = originalFetch
    turbo.session.stop()
  }
})

test("matches upstream Turbo for ordinary Frame link navigation", async () => {
  const initialDocument =
    '<main id="root"><turbo-frame id="details" class="mounted" target="_self"><a id="frame-link" href="/frame/next">Next</a><p id="old">Old</p></turbo-frame></main>'
  const frameResponse =
    '<main><turbo-frame id="details" class="response" target="_top"><p id="loaded">Loaded</p></turbo-frame><p id="outside">Outside</p></main>'
  const session = new DocumentSession(
    parseExpoTurboDocument(initialDocument, { url: "https://example.test/demo" }),
  )
  let expoRequest: TurboRequest | undefined
  const loader = new FrameRequestLoader(
    session,
    {
      fetch: async (request) => {
        expoRequest = request
        return {
          headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
          redirected: false,
          status: 200,
          text: async () => frameResponse,
          url: "https://example.test/frame/next",
        }
      },
    },
    { next: () => "request-frame-link" },
  )
  const expoFrameBefore = session.tree.getElementById("details")
  if (!expoFrameBefore) throw new Error("Expo Frame differential target is missing")
  const expoResult = await loader.load("details", "/frame/next")

  let browserRequestUrl: string | undefined
  let browserRequestMethod: string | undefined
  let browserFrameHeader: string | null | undefined
  const originalFetch = browser.fetch
  browser.fetch = async (input, init) => {
    browserRequestUrl = String(input)
    browserRequestMethod = init?.method
    const requestHeaders = init?.headers as { get?: unknown } | undefined
    browserFrameHeader =
      typeof requestHeaders?.get === "function"
        ? (requestHeaders.get as (name: string) => string | null)("Turbo-Frame")
        : new browser.Headers(init?.headers).get("Turbo-Frame")
    const response = new browser.Response(frameResponse, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
      status: 200,
    })
    Object.defineProperty(response, "url", {
      configurable: true,
      value: "https://example.test/frame/next",
    })
    return response
  }
  turbo.start()
  try {
    browser.document.body.innerHTML = initialDocument
    const browserFrameBefore = browser.document.getElementById("details")
    const link = browser.document.getElementById("frame-link")
    if (!(browserFrameBefore instanceof browser.HTMLElement)) {
      throw new Error("Browser Frame differential target is missing")
    }
    if (!(link instanceof browser.HTMLAnchorElement)) {
      throw new Error("Browser Frame differential link is missing")
    }
    link.dispatchEvent(
      new browser.MouseEvent("click", {
        bubbles: true,
        button: 0,
        cancelable: true,
        composed: true,
      }),
    )
    await browser.happyDOM.waitUntilComplete()

    const browserFrameAfter = browser.document.getElementById("details")
    const expoFrameAfter = session.tree.getElementById("details")
    if (!browserFrameAfter || !expoFrameAfter) {
      throw new Error("Frame differential lost its target")
    }
    expect(expoResult.status).toBe("completed")
    expect(expoRequest?.url).toBe(browserRequestUrl)
    expect(expoRequest?.method).toBe(browserRequestMethod)
    expect(browserFrameHeader ?? undefined).toBe(expoRequest?.headers["Turbo-Frame"])
    expect(browserFrameAfter).toBe(browserFrameBefore)
    expect(expoFrameAfter.key).toBe(expoFrameBefore.key)
    const browserResult = normalizeBrowserNode(browserFrameAfter)
    if (!browserResult || typeof browserResult === "string") {
      throw new Error("Browser Frame differential result is invalid")
    }
    expect(normalizeProtocolNode(expoFrameAfter)).toEqual({
      ...browserResult,
      attributes: browserResult.attributes.filter(([name]) => name !== "complete"),
    })
    expect(browserFrameAfter.hasAttribute("complete")).toBe(true)
    expect(browser.document.getElementById("outside")).toBeNull()
    expect(session.tree.getElementById("outside")).toBeUndefined()
  } finally {
    browser.fetch = originalFetch
    turbo.session.stop()
  }
})

test("matches upstream Turbo redirected Frame source canonicalization", async () => {
  const initialDocument =
    '<main id="root"><turbo-frame id="details"><a id="frame-redirect-link" href="/frame/redirect">Redirect</a><p id="old">Old</p></turbo-frame></main>'
  const frameResponse =
    '<main><turbo-frame id="details"><p id="final">Final</p></turbo-frame></main>'
  const session = new DocumentSession(
    parseExpoTurboDocument(initialDocument, { url: "https://example.test/demo" }),
  )
  const loader = new FrameRequestLoader(
    session,
    {
      fetch: async () => ({
        headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
        redirected: true,
        status: 200,
        text: async () => frameResponse,
        url: "https://example.test/frame/final",
      }),
    },
    { next: () => "request-frame-redirect" },
  )
  const expoFrameBefore = session.tree.getElementById("details")
  if (!expoFrameBefore) throw new Error("Expo redirected Frame target is missing")
  const expoResult = await loader.load("details", "/frame/redirect")

  const originalFetch = browser.fetch
  browser.fetch = async () => {
    const response = new browser.Response(frameResponse, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
      status: 200,
    })
    Object.defineProperties(response, {
      redirected: { configurable: true, value: true },
      url: { configurable: true, value: "https://example.test/frame/final" },
    })
    return response
  }
  turbo.start()
  try {
    browser.document.body.innerHTML = initialDocument
    const browserFrameBefore = browser.document.getElementById("details")
    const link = browser.document.getElementById("frame-redirect-link")
    if (!(browserFrameBefore instanceof browser.HTMLElement)) {
      throw new Error("Browser redirected Frame target is missing")
    }
    if (!(link instanceof browser.HTMLAnchorElement)) {
      throw new Error("Browser redirected Frame link is missing")
    }
    link.dispatchEvent(
      new browser.MouseEvent("click", {
        bubbles: true,
        button: 0,
        cancelable: true,
        composed: true,
      }),
    )
    await browser.happyDOM.waitUntilComplete()

    const browserFrameAfter = browser.document.getElementById("details")
    const expoFrameAfter = session.tree.getElementById("details")
    if (!browserFrameAfter || !expoFrameAfter) {
      throw new Error("Redirected Frame differential lost its target")
    }
    expect(expoResult).toMatchObject({
      status: "completed",
      url: "https://example.test/frame/final",
    })
    expect(browserFrameAfter).toBe(browserFrameBefore)
    expect(expoFrameAfter.key).toBe(expoFrameBefore.key)
    expect(browserFrameAfter.getAttribute("src")).toBe("https://example.test/frame/final")
    expect(expoFrameAfter.attributes.find(({ name }) => name === "src")?.value).toBe(
      "https://example.test/frame/final",
    )
    expect(browser.document.getElementById("final")).not.toBeNull()
    expect(session.tree.getElementById("final")).toBeDefined()
  } finally {
    browser.fetch = originalFetch
    turbo.session.stop()
  }
})

test("matches upstream Turbo Frame recurse extraction", async () => {
  const initialDocument =
    '<main id="root"><turbo-frame id="details"><a id="frame-recurse-link" href="/frame/recurse">Recurse</a><p id="old">Old</p></turbo-frame></main>'
  const primaryResponse =
    '<main><turbo-frame id="bridge" src="/frame/nested" recurse="other details"></turbo-frame><p id="outside-primary">Outside</p></main>'
  const nestedResponse =
    '<main><turbo-frame id="bridge"><turbo-frame id="details"><p id="recursive">Recursive</p></turbo-frame></turbo-frame><p id="outside-nested">Outside</p></main>'
  const session = new DocumentSession(
    parseExpoTurboDocument(initialDocument, { url: "https://example.test/demo" }),
  )
  const expoRequests: TurboRequest[] = []
  let requestId = 0
  const loader = new FrameRequestLoader(
    session,
    {
      fetch: async (request) => {
        expoRequests.push(request)
        return {
          headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
          redirected: false,
          status: 200,
          text: async () => (expoRequests.length === 1 ? primaryResponse : nestedResponse),
          url: request.url,
        }
      },
    },
    { next: () => `request-frame-recurse-${++requestId}` },
  )
  const expoFrameBefore = session.tree.getElementById("details")
  if (!expoFrameBefore) throw new Error("Expo recurse Frame target is missing")
  const expoResult = await loader.load("details", "/frame/recurse")

  const browserRequests: Array<Readonly<{ frame: string | null; url: string }>> = []
  const originalFetch = browser.fetch
  browser.fetch = async (input, init) => {
    const url = String(input)
    const requestHeaders = init?.headers as { get?: unknown } | undefined
    const frame =
      typeof requestHeaders?.get === "function"
        ? (requestHeaders.get as (name: string) => string | null)("Turbo-Frame")
        : new browser.Headers(init?.headers).get("Turbo-Frame")
    browserRequests.push(Object.freeze({ frame, url }))
    const response = new browser.Response(
      url === "https://example.test/frame/recurse" ? primaryResponse : nestedResponse,
      {
        headers: { "Content-Type": "text/html; charset=utf-8" },
        status: 200,
      },
    )
    Object.defineProperty(response, "url", { configurable: true, value: url })
    return response
  }
  turbo.start()
  try {
    browser.document.body.innerHTML = initialDocument
    const browserFrameBefore = browser.document.getElementById("details")
    const link = browser.document.getElementById("frame-recurse-link")
    if (!(browserFrameBefore instanceof browser.HTMLElement)) {
      throw new Error("Browser recurse Frame target is missing")
    }
    if (!(link instanceof browser.HTMLAnchorElement)) {
      throw new Error("Browser recurse Frame link is missing")
    }
    link.dispatchEvent(
      new browser.MouseEvent("click", {
        bubbles: true,
        button: 0,
        cancelable: true,
        composed: true,
      }),
    )
    await browser.happyDOM.waitUntilComplete()

    const browserFrameAfter = browser.document.getElementById("details")
    const expoFrameAfter = session.tree.getElementById("details")
    if (!browserFrameAfter || !expoFrameAfter) {
      throw new Error("Frame recurse differential lost its target")
    }
    expect(expoResult).toMatchObject({
      requestIds: ["request-frame-recurse-1", "request-frame-recurse-2"],
      status: "completed",
      url: "https://example.test/frame/recurse",
    })
    expect(
      expoRequests.map(({ headers, url }) => ({
        frame: headers["Turbo-Frame"] ?? null,
        url,
      })),
    ).toEqual(browserRequests)
    expect(browserFrameAfter).toBe(browserFrameBefore)
    expect(expoFrameAfter.key).toBe(expoFrameBefore.key)
    const browserResult = normalizeBrowserNode(browserFrameAfter)
    if (!browserResult || typeof browserResult === "string") {
      throw new Error("Browser recurse Frame differential result is invalid")
    }
    expect(normalizeProtocolNode(expoFrameAfter)).toEqual({
      ...browserResult,
      attributes: browserResult.attributes.filter(([name]) => name !== "complete"),
    })
    expect(browser.document.getElementById("outside-primary")).toBeNull()
    expect(browser.document.getElementById("outside-nested")).toBeNull()
    expect(session.tree.getElementById("outside-primary")).toBeUndefined()
    expect(session.tree.getElementById("outside-nested")).toBeUndefined()
  } finally {
    browser.fetch = originalFetch
    turbo.session.stop()
  }
})

test("matches upstream Turbo empty and error Frame response outcomes", async () => {
  const fixtures = [
    {
      body: "",
      expectedId: "old",
      responseStatus: 204,
      status: "empty",
    },
    {
      body: '<main><turbo-frame id="details"><p id="validation">Validation</p></turbo-frame></main>',
      expectedId: "validation",
      responseStatus: 422,
      status: "completed",
    },
    {
      body: '<main><turbo-frame id="details"><p id="server-error">Server error</p></turbo-frame></main>',
      expectedId: "server-error",
      responseStatus: 500,
      status: "completed",
    },
  ] as const

  for (const fixture of fixtures) {
    const initialDocument =
      '<main id="root"><turbo-frame id="details" class="mounted"><a id="frame-outcome-link" href="/frame/outcome">Outcome</a><p id="old">Old</p></turbo-frame></main>'
    const session = new DocumentSession(
      parseExpoTurboDocument(initialDocument, { url: "https://example.test/demo" }),
    )
    const loader = new FrameRequestLoader(
      session,
      {
        fetch: async () => ({
          headers: fixture.responseStatus === 204 ? {} : { "Content-Type": EXPO_TURBO_MIME_TYPE },
          redirected: false,
          status: fixture.responseStatus,
          text: async () => fixture.body,
          url: "https://example.test/frame/outcome",
        }),
      },
      { next: () => `request-frame-${fixture.responseStatus}` },
    )
    const controller = new FrameController(session, "details", loader)
    const expoFrameBefore = session.tree.getElementById("details")
    if (!expoFrameBefore) throw new Error("Expo outcome Frame target is missing")
    const expoResult = await controller.visit("/frame/outcome")

    const originalFetch = browser.fetch
    browser.fetch = async () =>
      new browser.Response(fixture.responseStatus === 204 ? null : fixture.body, {
        headers:
          fixture.responseStatus === 204 ? {} : { "Content-Type": "text/html; charset=utf-8" },
        status: fixture.responseStatus,
      })
    turbo.start()
    try {
      browser.document.body.innerHTML = initialDocument
      const browserFrameBefore = browser.document.getElementById("details")
      const link = browser.document.getElementById("frame-outcome-link")
      if (!(browserFrameBefore instanceof browser.HTMLElement)) {
        throw new Error("Browser outcome Frame target is missing")
      }
      if (!(link instanceof browser.HTMLAnchorElement)) {
        throw new Error("Browser outcome Frame link is missing")
      }
      link.dispatchEvent(
        new browser.MouseEvent("click", {
          bubbles: true,
          button: 0,
          cancelable: true,
          composed: true,
        }),
      )
      await browser.happyDOM.waitUntilComplete()

      const browserFrameAfter = browser.document.getElementById("details")
      const expoFrameAfter = session.tree.getElementById("details")
      if (!browserFrameAfter || !expoFrameAfter) {
        throw new Error("Frame response-outcome differential lost its target")
      }
      expect(expoResult?.status).toBe(fixture.status)
      expect(controller.state).toMatchObject({
        complete: true,
        status: fixture.status,
      })
      expect(browserFrameAfter).toBe(browserFrameBefore)
      expect(expoFrameAfter.key).toBe(expoFrameBefore.key)
      expect(browserFrameAfter.getAttribute("src")).toBe("https://example.test/frame/outcome")
      expect(expoFrameAfter.attributes.find(({ name }) => name === "src")?.value).toBe(
        "https://example.test/frame/outcome",
      )
      expect(browser.document.getElementById(fixture.expectedId)).not.toBeNull()
      expect(session.tree.getElementById(fixture.expectedId)).toBeDefined()
    } finally {
      browser.fetch = originalFetch
      turbo.session.stop()
    }
  }
})

test("matches upstream Turbo prevented missing-Frame handling", async () => {
  const initialDocument =
    '<main id="root"><turbo-frame id="details"><a id="frame-missing-link" href="/frame/missing">Missing</a><p id="old">Old</p></turbo-frame></main>'
  const missingResponse = '<main><p id="outside">Outside</p></main>'
  const session = new DocumentSession(
    parseExpoTurboDocument(initialDocument, { url: "https://example.test/demo" }),
  )
  const expoEvents: unknown[] = []
  const lifecycle = new FrameLifecycle()
  lifecycle.subscribe("frame-missing", (event) => {
    expoEvents.push({
      frameId: event.detail.frameId,
      response: event.detail.response,
      type: event.type,
    })
    event.preventDefault()
  })
  const loader = new FrameRequestLoader(
    session,
    {
      fetch: async () => ({
        headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
        redirected: false,
        status: 200,
        text: async () => missingResponse,
        url: "https://example.test/frame/missing",
      }),
    },
    { next: () => "request-frame-missing" },
    { frameLifecycle: lifecycle },
  )
  const controller = new FrameController(session, "details", loader)
  const expoFrameBefore = session.tree.getElementById("details")
  if (!expoFrameBefore) throw new Error("Expo missing-Frame target is missing")
  const expoResult = await controller.visit("/frame/missing")

  const browserEvents: unknown[] = []
  let browserFrameListenerTarget: HappyElement | undefined
  const handleBrowserMissing = (received: HappyEvent) => {
    const event = received as unknown as CustomEvent<{
      response: Response
      visit(location: string): void
    }>
    browserEvents.push({
      frameId: (event.target as Element | null)?.id,
      response: {
        redirected: event.detail.response.redirected,
        status: event.detail.response.status,
        url: event.detail.response.url,
      },
      type: event.type.replace("turbo:", ""),
    })
    event.preventDefault()
  }
  const originalFetch = browser.fetch
  browser.fetch = async () => {
    const response = new browser.Response(missingResponse, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
      status: 200,
    })
    Object.defineProperty(response, "url", {
      configurable: true,
      value: "https://example.test/frame/missing",
    })
    return response
  }
  turbo.start()
  try {
    browser.document.body.innerHTML = initialDocument
    const browserFrameBefore = browser.document.getElementById("details")
    const link = browser.document.getElementById("frame-missing-link")
    if (!(browserFrameBefore instanceof browser.HTMLElement)) {
      throw new Error("Browser missing-Frame target is missing")
    }
    if (!(link instanceof browser.HTMLAnchorElement)) {
      throw new Error("Browser missing-Frame link is missing")
    }
    browserFrameBefore.addEventListener("turbo:frame-missing", handleBrowserMissing)
    browserFrameListenerTarget = browserFrameBefore
    link.dispatchEvent(
      new browser.MouseEvent("click", {
        bubbles: true,
        button: 0,
        cancelable: true,
        composed: true,
      }),
    )
    await browser.happyDOM.waitUntilComplete()

    const browserFrameAfter = browser.document.getElementById("details")
    const expoFrameAfter = session.tree.getElementById("details")
    if (!browserFrameAfter || !expoFrameAfter) {
      throw new Error("Missing-Frame differential lost its target")
    }
    expect(expoResult?.status).toBe("prevented")
    expect(expoEvents).toEqual(browserEvents)
    expect(browserFrameAfter).toBe(browserFrameBefore)
    expect(expoFrameAfter.key).toBe(expoFrameBefore.key)
    const browserResult = normalizeBrowserNode(browserFrameAfter)
    if (!browserResult || typeof browserResult === "string") {
      throw new Error("Browser missing-Frame differential result is invalid")
    }
    expect(normalizeProtocolNode(expoFrameAfter)).toEqual({
      ...browserResult,
      attributes: browserResult.attributes.filter(([name]) => name !== "complete"),
    })
    expect(browserFrameAfter.hasAttribute("complete")).toBe(true)
    expect(browser.document.getElementById("outside")).toBeNull()
    expect(session.tree.getElementById("outside")).toBeUndefined()
  } finally {
    browserFrameListenerTarget?.removeEventListener("turbo:frame-missing", handleBrowserMissing)
    browser.fetch = originalFetch
    turbo.session.stop()
  }
})

test("matches upstream Turbo Frame visit-control response promotion", async () => {
  const initialDocument =
    '<main id="root"><turbo-frame id="details"><a id="frame-promote-link" href="/frame/promoted">Promote</a><p id="old">Old</p></turbo-frame></main>'
  const expoResponse =
    '<main id="promoted-root" data-turbo-visit-control="reload"><p id="promoted">Promoted</p></main>'
  const browserResponse =
    '<html><head><meta name="turbo-visit-control" content="reload"></head><body><main id="promoted-root"><p id="promoted">Promoted</p></main></body></html>'
  const session = new DocumentSession(
    parseExpoTurboDocument(initialDocument, { url: "https://example.test/demo" }),
  )
  let expoRequest: TurboRequest | undefined
  const expoVisits: unknown[] = []
  const lifecycle = new FrameLifecycle({
    visitResponse(request) {
      expoVisits.push({
        action: request.action,
        body: request.body,
        frameId: request.frameId,
        reason: request.reason,
        response: request.response,
      })
    },
  })
  const loader = new FrameRequestLoader(
    session,
    {
      fetch: async (request) => {
        expoRequest = request
        return {
          headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
          redirected: false,
          status: 200,
          text: async () => expoResponse,
          url: "https://example.test/frame/promoted",
        }
      },
    },
    { next: () => "request-frame-promoted" },
    { frameLifecycle: lifecycle },
  )
  const controller = new FrameController(session, "details", loader)
  const expoResult = await controller.visit("/frame/promoted")

  let browserFetches = 0
  let browserRequestUrl: string | undefined
  let browserFrameHeader: string | null | undefined
  const browserVisits: unknown[] = []
  const originalFetch = browser.fetch
  const browserSession = turbo.session as typeof turbo.session & {
    visit(
      location: URL,
      options: { response: { redirected: boolean; responseHTML: string; statusCode: number } },
    ): void
  }
  const originalVisit = browserSession.visit
  Object.defineProperty(browserSession, "visit", {
    configurable: true,
    value: (
      location: URL,
      options: {
        response: { redirected: boolean; responseHTML: string; statusCode: number }
      },
    ) => {
      browserVisits.push({
        response: options.response,
        url: location.href,
      })
    },
    writable: true,
  })
  browser.fetch = async (input, init) => {
    browserFetches += 1
    browserRequestUrl = String(input)
    const requestHeaders = init?.headers as { get?: unknown } | undefined
    browserFrameHeader =
      typeof requestHeaders?.get === "function"
        ? (requestHeaders.get as (name: string) => string | null)("Turbo-Frame")
        : new browser.Headers(init?.headers).get("Turbo-Frame")
    const response = new browser.Response(browserResponse, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
      status: 200,
    })
    Object.defineProperty(response, "url", {
      configurable: true,
      value: "https://example.test/frame/promoted",
    })
    return response
  }
  turbo.start()
  try {
    browser.document.body.innerHTML = initialDocument
    await browser.happyDOM.waitUntilComplete()
    const browserFrameBefore = browser.document.getElementById("details")
    const link = browser.document.getElementById("frame-promote-link")
    if (!(browserFrameBefore instanceof browser.HTMLElement)) {
      throw new Error("Browser promoted Frame target is missing")
    }
    if (!(link instanceof browser.HTMLAnchorElement)) {
      throw new Error("Browser promoted Frame link is missing")
    }
    link.dispatchEvent(
      new browser.MouseEvent("click", {
        bubbles: true,
        button: 0,
        cancelable: true,
        composed: true,
      }),
    )
    await browser.happyDOM.waitUntilComplete()

    const browserFrameAfter = browser.document.getElementById("details")
    const expoFrameAfter = session.tree.getElementById("details")
    if (!browserFrameAfter || !expoFrameAfter) {
      throw new Error("Frame visit-control differential lost its mounted Frame")
    }
    expect(expoResult).toMatchObject({
      reason: "visit-control-reload",
      status: "promoted",
      url: "https://example.test/frame/promoted",
    })
    expect(browserFetches).toBe(1)
    expect(expoRequest?.url).toBe(browserRequestUrl)
    expect(browserFrameHeader ?? undefined).toBe(expoRequest?.headers["Turbo-Frame"])
    expect(expoVisits).toEqual([
      {
        action: "advance",
        body: expoResponse,
        frameId: "details",
        reason: "visit-control-reload",
        response: {
          redirected: false,
          status: 200,
          url: "https://example.test/frame/promoted",
        },
      },
    ])
    expect(browserVisits).toEqual([
      {
        response: {
          redirected: false,
          responseHTML: browserResponse,
          statusCode: 200,
        },
        url: "https://example.test/frame/promoted",
      },
    ])
    const browserFrameResult = normalizeBrowserNode(browserFrameAfter)
    if (!browserFrameResult || typeof browserFrameResult === "string") {
      throw new Error("Browser promoted Frame result is invalid")
    }
    expect(normalizeProtocolNode(expoFrameAfter)).toEqual({
      ...browserFrameResult,
      attributes: browserFrameResult.attributes.filter(([name]) => name !== "complete"),
    })
    expect(browserFrameAfter).toBe(browserFrameBefore)
    expect(browser.document.getElementById("promoted")).toBeNull()
    expect(session.tree.getElementById("promoted")).toBeUndefined()
  } finally {
    Object.defineProperty(browserSession, "visit", {
      configurable: true,
      value: originalVisit,
      writable: true,
    })
    browser.fetch = originalFetch
    turbo.session.stop()
  }
})

test("matches upstream Turbo GET form URL and submitter serialization", async () => {
  const initialDocument =
    '<main id="root"><turbo-frame id="details"><form id="search" action="/search?stale=1" method="get"><input name="query" value="a b" /><input name="empty" value="" /><input name="ignored" value="no" disabled="" /><button id="submit-search" name="commit" value="Search">Search</button></form></turbo-frame></main>'
  const frameResponse =
    '<main><turbo-frame id="details"><p id="search-result">Found</p></turbo-frame></main>'
  const expoRequest = buildFormRequest({
    documentUrl: "https://example.test/demo",
    entries: [
      { name: "query", value: "a b" },
      { name: "empty", value: "" },
      { name: "commit", value: "Search" },
    ],
    form: { action: "/search?stale=1", method: "get" },
    protocol: { frameId: "details", requestId: "request-1" },
    submitter: { name: "commit", value: "Search" },
  }).request
  let browserRequestUrl: string | undefined
  let browserRequestMethod: string | undefined
  let browserFrameHeader: string | null | undefined
  const originalFetch = browser.fetch
  browser.fetch = async (input, init) => {
    browserRequestUrl = String(input)
    browserRequestMethod = init?.method
    const requestHeaders = init?.headers as { get?: unknown } | undefined
    browserFrameHeader =
      typeof requestHeaders?.get === "function"
        ? (requestHeaders.get as (name: string) => string | null)("Turbo-Frame")
        : new browser.Headers(init?.headers).get("Turbo-Frame")
    return new browser.Response(frameResponse, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
      status: 200,
    })
  }
  turbo.start()
  try {
    browser.document.body.innerHTML = initialDocument
    const form = browser.document.getElementById("search")
    const submitter = browser.document.getElementById("submit-search")
    if (!(form instanceof browser.HTMLFormElement)) {
      throw new Error("Browser form differential form is missing")
    }
    if (!(submitter instanceof browser.HTMLButtonElement)) {
      throw new Error("Browser form differential submitter is missing")
    }
    form.requestSubmit(submitter)
    await browser.happyDOM.waitUntilComplete()

    expect(browserRequestUrl).toBe(expoRequest.url)
    expect(browserRequestMethod).toBe(expoRequest.method)
    expect(browserFrameHeader).toBe(expoRequest.headers["Turbo-Frame"])
    expect(browser.document.getElementById("search-result")).not.toBeNull()
  } finally {
    browser.fetch = originalFetch
    turbo.session.stop()
  }
})

test("matches upstream Turbo unsafe form method and URL-encoded body", async () => {
  const initialDocument =
    '<main id="root"><turbo-frame id="details"><form id="order" action="/orders?source=demo" method="post"><input name="order[items][]" value="shirt" /><input name="order[items][]" value="towels" /><input type="checkbox" name="notify" value="yes" checked="" /><input type="checkbox" name="ignored" value="no" /><button id="submit-order" name="commit" value="Save">Save</button></form></turbo-frame></main>'
  const frameResponse =
    '<main><turbo-frame id="details"><p id="validation-result">Review</p></turbo-frame></main>'
  const expoRequest = buildFormRequest({
    documentUrl: "https://example.test/demo",
    entries: [
      { name: "order[items][]", value: "shirt" },
      { name: "order[items][]", value: "towels" },
      { name: "notify", value: "yes" },
      { name: "commit", value: "Save" },
    ],
    form: { action: "/orders?source=demo", method: "post" },
    protocol: { frameId: "details", requestId: "request-2" },
    submitter: { name: "commit", value: "Save" },
  }).request
  const expoRequestBody = expoRequest.body?.value
  if (typeof expoRequestBody !== "string") {
    throw new Error("Expo unsafe form differential body is not URL encoded")
  }
  let browserRequestUrl: string | undefined
  let browserRequestMethod: string | undefined
  let browserRequestBody: string | undefined
  let browserFrameHeader: string | null | undefined
  const originalFetch = browser.fetch
  browser.fetch = async (input, init) => {
    browserRequestUrl = String(input)
    browserRequestMethod = init?.method
    browserRequestBody = typeof init?.body === "string" ? init.body : init?.body?.toString()
    const requestHeaders = init?.headers as { get?: unknown } | undefined
    browserFrameHeader =
      typeof requestHeaders?.get === "function"
        ? (requestHeaders.get as (name: string) => string | null)("Turbo-Frame")
        : new browser.Headers(init?.headers).get("Turbo-Frame")
    return new browser.Response(frameResponse, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
      status: 422,
    })
  }
  turbo.start()
  try {
    browser.document.body.innerHTML = initialDocument
    const form = browser.document.getElementById("order")
    const submitter = browser.document.getElementById("submit-order")
    if (!(form instanceof browser.HTMLFormElement)) {
      throw new Error("Browser unsafe form differential form is missing")
    }
    if (!(submitter instanceof browser.HTMLButtonElement)) {
      throw new Error("Browser unsafe form differential submitter is missing")
    }
    form.requestSubmit(submitter)
    await browser.happyDOM.waitUntilComplete()

    expect(browserRequestUrl).toBe(expoRequest.url)
    expect(browserRequestMethod).toBe(expoRequest.method)
    expect(browserRequestBody).toBe(expoRequestBody)
    expect(browserFrameHeader).toBe(expoRequest.headers["Turbo-Frame"])
    expect(browser.document.getElementById("validation-result")).not.toBeNull()
  } finally {
    browser.fetch = originalFetch
    turbo.session.stop()
  }
})

test("matches upstream Turbo generated-form link method and ordered query body", async () => {
  const initialDocument =
    '<main id="root"><a id="delete-link" href="/orders/7?tag=one&amp;tag=two+words&amp;_method=post&amp;empty=" data-turbo-method="delete">Delete</a><p id="old">Old</p></main>'
  const session = new DocumentSession(
    parseExpoTurboDocument(initialDocument, { url: "https://example.test/demo" }),
  )
  let expoRequest: TurboRequest | undefined
  const submissions = new FormSubmissionController(session, {
    fetch: async (request) => {
      expoRequest = request
      return {
        headers: {},
        redirected: false,
        status: 204,
        text: async () => "",
        url: request.url,
      }
    },
  })
  const links = new FormLinkSubmissionController(session, submissions, {
    next: () => "request-generated-link",
  })
  const expoResult = await links.submit(
    "id:delete-link",
    "/orders/7?tag=one&tag=two+words&_method=post&empty=",
  )
  let browserRequestUrl: string | undefined
  let browserRequestMethod: string | undefined
  let browserRequestBody: string | undefined
  let browserFrameHeader: string | null | undefined
  const originalFetch = browser.fetch
  browser.fetch = async (input, init) => {
    browserRequestUrl = String(input)
    browserRequestMethod = init?.method
    browserRequestBody = typeof init?.body === "string" ? init.body : init?.body?.toString()
    const requestHeaders = init?.headers as { get?: unknown } | undefined
    browserFrameHeader =
      typeof requestHeaders?.get === "function"
        ? (requestHeaders.get as (name: string) => string | null)("Turbo-Frame")
        : new browser.Headers(init?.headers).get("Turbo-Frame")
    return new browser.Response(null, { status: 204 })
  }
  turbo.start()
  try {
    browser.document.body.innerHTML = initialDocument
    const responseHandled = new Promise<void>((resolve) => {
      browser.document.addEventListener("turbo:before-fetch-response", () => resolve(), {
        once: true,
      })
    })
    const link = browser.document.getElementById("delete-link")
    if (!(link instanceof browser.HTMLAnchorElement)) {
      throw new Error("Browser generated-form differential link is missing")
    }
    link.dispatchEvent(
      new browser.MouseEvent("click", {
        bubbles: true,
        button: 0,
        cancelable: true,
        composed: true,
      }),
    )
    await responseHandled
    await Promise.resolve()

    expect(expoResult).toMatchObject({
      application: "empty",
      effectiveMethod: "DELETE",
      status: "empty",
    })
    expect(expoRequest?.url).toBe(browserRequestUrl)
    expect(expoRequest?.method).toBe(browserRequestMethod)
    expect(expoRequest?.body?.value).toBe(browserRequestBody)
    expect(expoRequest?.headers["Turbo-Frame"]).toBe(browserFrameHeader ?? undefined)
    expect(normalizeProtocolNode(activeProtocolRoot(session))).toEqual(
      normalizeBrowserNode(browser.document.getElementById("root") as HappyElement),
    )
  } finally {
    browser.fetch = originalFetch
    turbo.session.stop()
    await browser.happyDOM.abort()
  }
})

test("matches upstream Turbo generated-form Stream link response", async () => {
  const initialDocument =
    '<main id="root"><a id="stream-link" href="/updates?scope=profile" data-turbo-stream="">Update</a><p id="status">Old</p></main>'
  const streamResponse =
    '<turbo-stream action="update" target="status"><template>Updated</template></turbo-stream>'
  const session = new DocumentSession(
    parseExpoTurboDocument(initialDocument, { url: "https://example.test/demo" }),
  )
  let expoRequest: TurboRequest | undefined
  const submissions = new FormSubmissionController(session, {
    fetch: async (request) => {
      expoRequest = request
      return {
        headers: { "Content-Type": TURBO_STREAM_MIME_TYPE },
        redirected: false,
        status: 200,
        text: async () => streamResponse,
        url: request.url,
      }
    },
  })
  const links = new FormLinkSubmissionController(session, submissions, {
    next: () => "request-generated-stream-link",
  })
  const expoResult = await links.submit("id:stream-link", "/updates?scope=profile")
  let browserRequestUrl: string | undefined
  let browserRequestMethod: string | undefined
  const originalFetch = browser.fetch
  browser.fetch = async (input, init) => {
    browserRequestUrl = String(input)
    browserRequestMethod = init?.method
    return new browser.Response(streamResponse, {
      headers: { "Content-Type": TURBO_STREAM_MIME_TYPE },
      status: 200,
    })
  }
  turbo.start()
  try {
    browser.document.body.innerHTML = initialDocument
    const link = browser.document.getElementById("stream-link")
    if (!(link instanceof browser.HTMLAnchorElement)) {
      throw new Error("Browser generated-form Stream link is missing")
    }
    link.dispatchEvent(
      new browser.MouseEvent("click", {
        bubbles: true,
        button: 0,
        cancelable: true,
        composed: true,
      }),
    )
    await browser.happyDOM.waitUntilComplete()

    expect(expoResult).toMatchObject({
      application: "stream",
      effectiveMethod: "GET",
      status: "applied",
    })
    expect(expoRequest?.url).toBe(browserRequestUrl)
    expect(expoRequest?.method).toBe(browserRequestMethod)
    expect(normalizeProtocolNode(activeProtocolRoot(session))).toEqual(
      normalizeBrowserNode(browser.document.getElementById("root") as HappyElement),
    )
  } finally {
    browser.fetch = originalFetch
    turbo.session.stop()
  }
})

test("matches upstream Turbo generated-form link destination Frame response", async () => {
  const initialDocument =
    '<main id="root"><turbo-frame id="source"><a id="save-link" href="/save?value=invalid" data-turbo-method="post" data-turbo-frame="destination">Save</a><p id="source-state">Source</p></turbo-frame><turbo-frame id="destination" class="mounted"><p id="old-destination">Old</p></turbo-frame></main>'
  const frameResponse =
    '<main><turbo-frame id="destination" class="response"><p id="destination-error">Invalid value</p></turbo-frame><p id="outside">Outside</p></main>'
  const session = new DocumentSession(
    parseExpoTurboDocument(initialDocument, { url: "https://example.test/demo" }),
  )
  const expoFrameBefore = session.tree.getElementById("destination")
  if (!expoFrameBefore) throw new Error("Expo generated-form destination Frame is missing")
  let expoRequest: TurboRequest | undefined
  const submissions = new FormSubmissionController(session, {
    fetch: async (request) => {
      expoRequest = request
      return {
        headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
        redirected: false,
        status: 422,
        text: async () => frameResponse,
        url: request.url,
      }
    },
  })
  const links = new FormLinkSubmissionController(session, submissions, {
    next: () => "request-generated-frame-link",
  })
  const expoResult = await links.submit("id:save-link", "/save?value=invalid")
  let browserRequestUrl: string | undefined
  let browserRequestMethod: string | undefined
  let browserRequestBody: string | undefined
  let browserFrameHeader: string | null | undefined
  const originalFetch = browser.fetch
  browser.fetch = async (input, init) => {
    browserRequestUrl = String(input)
    browserRequestMethod = init?.method
    browserRequestBody = typeof init?.body === "string" ? init.body : init?.body?.toString()
    const requestHeaders = init?.headers as { get?: unknown } | undefined
    browserFrameHeader =
      typeof requestHeaders?.get === "function"
        ? (requestHeaders.get as (name: string) => string | null)("Turbo-Frame")
        : new browser.Headers(init?.headers).get("Turbo-Frame")
    return new browser.Response(frameResponse, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
      status: 422,
    })
  }
  turbo.start()
  try {
    browser.document.body.innerHTML = initialDocument
    const browserFrameBefore = browser.document.getElementById("destination")
    const link = browser.document.getElementById("save-link")
    if (!(browserFrameBefore instanceof browser.HTMLElement)) {
      throw new Error("Browser generated-form destination Frame is missing")
    }
    if (!(link instanceof browser.HTMLAnchorElement)) {
      throw new Error("Browser generated-form Frame link is missing")
    }
    link.dispatchEvent(
      new browser.MouseEvent("click", {
        bubbles: true,
        button: 0,
        cancelable: true,
        composed: true,
      }),
    )
    await browser.happyDOM.waitUntilComplete()

    expect(expoResult).toMatchObject({
      application: "frame",
      applicationDestination: { frameId: "destination", kind: "frame" },
      classification: "client-error",
      effectiveMethod: "POST",
      status: "applied",
    })
    expect(expoRequest?.url).toBe(browserRequestUrl)
    expect(expoRequest?.method).toBe(browserRequestMethod)
    expect(expoRequest?.body?.value).toBe(browserRequestBody)
    expect(expoRequest?.headers["Turbo-Frame"]).toBe(browserFrameHeader ?? undefined)
    const browserFrameAfter = browser.document.getElementById("destination")
    const expoFrameAfter = session.tree.getElementById("destination")
    if (!browserFrameAfter || !expoFrameAfter) {
      throw new Error("Generated-form differential lost its destination Frame")
    }
    expect(browserFrameAfter).toBe(browserFrameBefore)
    expect(expoFrameAfter.key).toBe(expoFrameBefore.key)
    const browserResult = normalizeBrowserNode(browserFrameAfter)
    if (!browserResult || typeof browserResult === "string") {
      throw new Error("Browser generated-form Frame result is invalid")
    }
    expect(normalizeProtocolNode(expoFrameAfter)).toEqual({
      ...browserResult,
      attributes: browserResult.attributes.filter(([name]) => name !== "complete"),
    })
    expect(browserFrameAfter.hasAttribute("complete")).toBe(true)
    expect(browser.document.getElementById("source-state")).not.toBeNull()
    expect(session.tree.getElementById("source-state")).not.toBeUndefined()
    expect(browser.document.getElementById("outside")).toBeNull()
    expect(session.tree.getElementById("outside")).toBeUndefined()
  } finally {
    browser.fetch = originalFetch
    turbo.session.stop()
  }
})

test("matches upstream Turbo prevented missing-Frame handling for a generated-form link", async () => {
  const initialDocument =
    '<main id="root"><a id="save-link" href="/save?value=missing" data-turbo-method="post" data-turbo-frame="destination">Save</a><turbo-frame id="destination"><p id="old-destination">Old</p></turbo-frame></main>'
  const missingResponse = '<main><p id="outside">Outside</p></main>'
  const responseUrl = "https://example.test/save"
  const session = new DocumentSession(
    parseExpoTurboDocument(initialDocument, { url: "https://example.test/demo" }),
  )
  const expoFrameBefore = session.tree.getElementById("destination")
  if (!expoFrameBefore) throw new Error("Expo generated-form missing Frame is missing")
  const expoEvents: unknown[] = []
  const lifecycle = new FrameLifecycle()
  lifecycle.subscribe("frame-missing", (event) => {
    expoEvents.push({
      frameId: event.detail.frameId,
      response: event.detail.response,
      type: event.type,
    })
    event.preventDefault()
  })
  let expoRequest: TurboRequest | undefined
  const submissions = new FormSubmissionController(
    session,
    {
      fetch: async (request) => {
        expoRequest = request
        return {
          headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
          redirected: false,
          status: 200,
          text: async () => missingResponse,
          url: responseUrl,
        }
      },
    },
    { frameLifecycle: lifecycle },
  )
  const links = new FormLinkSubmissionController(session, submissions, {
    next: () => "request-generated-frame-missing",
  })
  const expoResult = await links.submit("id:save-link", "/save?value=missing")

  const browserEvents: unknown[] = []
  let browserRequestUrl: string | undefined
  let browserRequestMethod: string | undefined
  let browserRequestBody: string | undefined
  let browserFrameHeader: string | null | undefined
  let browserFrameListenerTarget: HappyElement | undefined
  const handleBrowserMissing = (received: HappyEvent) => {
    const event = received as unknown as CustomEvent<{ response: Response }>
    browserEvents.push({
      frameId: (event.target as Element | null)?.id,
      response: {
        redirected: event.detail.response.redirected,
        status: event.detail.response.status,
        url: event.detail.response.url,
      },
      type: event.type.replace("turbo:", ""),
    })
    event.preventDefault()
  }
  const originalFetch = browser.fetch
  browser.fetch = async (input, init) => {
    browserRequestUrl = String(input)
    browserRequestMethod = init?.method
    browserRequestBody = typeof init?.body === "string" ? init.body : init?.body?.toString()
    const requestHeaders = init?.headers as { get?: unknown } | undefined
    browserFrameHeader =
      typeof requestHeaders?.get === "function"
        ? (requestHeaders.get as (name: string) => string | null)("Turbo-Frame")
        : new browser.Headers(init?.headers).get("Turbo-Frame")
    const response = new browser.Response(missingResponse, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
      status: 200,
    })
    Object.defineProperty(response, "url", {
      configurable: true,
      value: responseUrl,
    })
    return response
  }
  turbo.start()
  try {
    browser.document.body.innerHTML = initialDocument
    const browserFrameBefore = browser.document.getElementById("destination")
    const link = browser.document.getElementById("save-link")
    if (!(browserFrameBefore instanceof browser.HTMLElement)) {
      throw new Error("Browser generated-form missing Frame is missing")
    }
    if (!(link instanceof browser.HTMLAnchorElement)) {
      throw new Error("Browser generated-form missing Frame link is missing")
    }
    browserFrameBefore.addEventListener("turbo:frame-missing", handleBrowserMissing)
    browserFrameListenerTarget = browserFrameBefore
    link.dispatchEvent(
      new browser.MouseEvent("click", {
        bubbles: true,
        button: 0,
        cancelable: true,
        composed: true,
      }),
    )
    await browser.happyDOM.waitUntilComplete()

    expect(expoResult).toMatchObject({
      destination: { frameId: "destination", kind: "frame" },
      effectiveMethod: "POST",
      responseStatus: 200,
      status: "prevented",
    })
    expect(expoRequest?.url).toBe(browserRequestUrl)
    expect(expoRequest?.method).toBe(browserRequestMethod)
    expect(expoRequest?.body?.value).toBe(browserRequestBody)
    expect(expoRequest?.headers["Turbo-Frame"]).toBe(browserFrameHeader ?? undefined)
    expect(expoEvents).toEqual(browserEvents)
    const browserFrameAfter = browser.document.getElementById("destination")
    const expoFrameAfter = session.tree.getElementById("destination")
    if (!browserFrameAfter || !expoFrameAfter) {
      throw new Error("Generated-form missing differential lost its destination Frame")
    }
    expect(browserFrameAfter).toBe(browserFrameBefore)
    expect(expoFrameAfter.key).toBe(expoFrameBefore.key)
    const browserResult = normalizeBrowserNode(browserFrameAfter)
    if (!browserResult || typeof browserResult === "string") {
      throw new Error("Browser generated-form missing Frame result is invalid")
    }
    expect(normalizeProtocolNode(expoFrameAfter)).toEqual({
      ...browserResult,
      attributes: browserResult.attributes.filter(([name]) => name !== "complete"),
    })
    expect(browser.document.getElementById("outside")).toBeNull()
    expect(session.tree.getElementById("outside")).toBeUndefined()
  } finally {
    browserFrameListenerTarget?.removeEventListener("turbo:frame-missing", handleBrowserMissing)
    browser.fetch = originalFetch
    turbo.session.stop()
  }
})

test("matches upstream Turbo generated-form Frame visit-control response promotion", async () => {
  const initialDocument =
    '<main id="root"><a id="promote-link" href="/save?value=promoted" data-turbo-method="post" data-turbo-frame="destination">Save</a><turbo-frame id="destination"><p id="old-destination">Old</p></turbo-frame></main>'
  const expoResponse =
    '<main id="promoted-root" data-turbo-visit-control="reload"><p id="promoted">Promoted</p></main>'
  const browserResponse =
    '<html><head><meta name="turbo-visit-control" content="reload"></head><body><main id="promoted-root"><p id="promoted">Promoted</p></main></body></html>'
  const responseUrl = "https://example.test/save"
  const session = new DocumentSession(
    parseExpoTurboDocument(initialDocument, { url: "https://example.test/demo" }),
  )
  const expoFrameBefore = session.tree.getElementById("destination")
  if (!expoFrameBefore) throw new Error("Expo generated-form promoted Frame is missing")
  let expoRequest: TurboRequest | undefined
  const expoVisits: unknown[] = []
  const lifecycle = new FrameLifecycle({
    visitResponse(request) {
      expoVisits.push({
        action: request.action,
        body: request.body,
        frameId: request.frameId,
        reason: request.reason,
        response: request.response,
      })
    },
  })
  const submissions = new FormSubmissionController(
    session,
    {
      fetch: async (request) => {
        expoRequest = request
        return {
          headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
          redirected: false,
          status: 200,
          text: async () => expoResponse,
          url: responseUrl,
        }
      },
    },
    { frameLifecycle: lifecycle },
  )
  const links = new FormLinkSubmissionController(session, submissions, {
    next: () => "request-generated-frame-promoted",
  })
  const expoResult = await links.submit("id:promote-link", "/save?value=promoted")

  let browserFetches = 0
  let browserRequestUrl: string | undefined
  let browserRequestMethod: string | undefined
  let browserRequestBody: string | undefined
  let browserFrameHeader: string | null | undefined
  const browserVisits: unknown[] = []
  const originalFetch = browser.fetch
  const browserSession = turbo.session as typeof turbo.session & {
    visit(
      location: URL,
      options: { response: { redirected: boolean; responseHTML: string; statusCode: number } },
    ): void
  }
  const originalVisit = browserSession.visit
  Object.defineProperty(browserSession, "visit", {
    configurable: true,
    value: (
      location: URL,
      options: {
        response: { redirected: boolean; responseHTML: string; statusCode: number }
      },
    ) => {
      browserVisits.push({
        response: options.response,
        url: location.href,
      })
    },
    writable: true,
  })
  browser.fetch = async (input, init) => {
    browserFetches += 1
    browserRequestUrl = String(input)
    browserRequestMethod = init?.method
    browserRequestBody = typeof init?.body === "string" ? init.body : init?.body?.toString()
    const requestHeaders = init?.headers as { get?: unknown } | undefined
    browserFrameHeader =
      typeof requestHeaders?.get === "function"
        ? (requestHeaders.get as (name: string) => string | null)("Turbo-Frame")
        : new browser.Headers(init?.headers).get("Turbo-Frame")
    const response = new browser.Response(browserResponse, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
      status: 200,
    })
    Object.defineProperty(response, "url", {
      configurable: true,
      value: responseUrl,
    })
    return response
  }
  turbo.start()
  try {
    browser.document.body.innerHTML = initialDocument
    const browserFrameBefore = browser.document.getElementById("destination")
    const link = browser.document.getElementById("promote-link")
    if (!(browserFrameBefore instanceof browser.HTMLElement)) {
      throw new Error("Browser generated-form promoted Frame is missing")
    }
    if (!(link instanceof browser.HTMLAnchorElement)) {
      throw new Error("Browser generated-form promoted Frame link is missing")
    }
    link.dispatchEvent(
      new browser.MouseEvent("click", {
        bubbles: true,
        button: 0,
        cancelable: true,
        composed: true,
      }),
    )
    await browser.happyDOM.waitUntilComplete()

    const browserFrameAfter = browser.document.getElementById("destination")
    const expoFrameAfter = session.tree.getElementById("destination")
    if (!browserFrameAfter || !expoFrameAfter) {
      throw new Error("Generated-form visit-control differential lost its destination Frame")
    }
    expect(expoResult).toMatchObject({
      destination: { frameId: "destination", kind: "frame" },
      effectiveMethod: "POST",
      reason: "visit-control-reload",
      responseStatus: 200,
      status: "promoted",
    })
    expect(browserFetches).toBe(1)
    expect(expoRequest?.url).toBe(browserRequestUrl)
    expect(expoRequest?.method).toBe(browserRequestMethod)
    expect(expoRequest?.body?.value).toBe(browserRequestBody)
    expect(expoRequest?.headers["Turbo-Frame"]).toBe(browserFrameHeader ?? undefined)
    expect(expoVisits).toEqual([
      {
        action: "advance",
        body: expoResponse,
        frameId: "destination",
        reason: "visit-control-reload",
        response: {
          redirected: false,
          status: 200,
          url: responseUrl,
        },
      },
    ])
    expect(browserVisits).toEqual([
      {
        response: {
          redirected: false,
          responseHTML: browserResponse,
          statusCode: 200,
        },
        url: responseUrl,
      },
    ])
    expect(browserFrameAfter).toBe(browserFrameBefore)
    expect(expoFrameAfter.key).toBe(expoFrameBefore.key)
    const browserFrameResult = normalizeBrowserNode(browserFrameAfter)
    if (!browserFrameResult || typeof browserFrameResult === "string") {
      throw new Error("Browser generated-form promoted Frame result is invalid")
    }
    expect(normalizeProtocolNode(expoFrameAfter)).toEqual({
      ...browserFrameResult,
      attributes: browserFrameResult.attributes.filter(([name]) => name !== "complete"),
    })
    expect(browser.document.getElementById("promoted")).toBeNull()
    expect(session.tree.getElementById("promoted")).toBeUndefined()
  } finally {
    Object.defineProperty(browserSession, "visit", {
      configurable: true,
      value: originalVisit,
      writable: true,
    })
    browser.fetch = originalFetch
    turbo.session.stop()
  }
})

test("matches upstream Turbo for an empty generated-form Frame 204 response", async () => {
  const initialDocument =
    '<main id="root"><a id="save-link" href="/save?value=no-content" data-turbo-method="post" data-turbo-frame="destination">Save</a><turbo-frame id="destination" src="/old"><p id="old-destination">Old</p></turbo-frame></main>'
  const session = new DocumentSession(
    parseExpoTurboDocument(initialDocument, { url: "https://example.test/demo" }),
  )
  const expoFrameBefore = session.tree.getElementById("destination")
  if (!expoFrameBefore) throw new Error("Expo empty generated-form Frame is missing")
  let expoRequest: TurboRequest | undefined
  const submissions = new FormSubmissionController(session, {
    fetch: async (request) => {
      expoRequest = request
      return {
        headers: {},
        redirected: false,
        status: 204,
        text: async () => "",
        url: request.url,
      }
    },
  })
  const links = new FormLinkSubmissionController(session, submissions, {
    next: () => "request-generated-frame-204",
  })
  const expoResult = await links.submit("id:save-link", "/save?value=no-content")

  let browserRequestUrl: string | undefined
  let browserRequestMethod: string | undefined
  let browserRequestBody: string | undefined
  let browserFrameHeader: string | null | undefined
  const originalFetch = browser.fetch
  browser.fetch = async (input, init) => {
    browserRequestUrl = String(input)
    browserRequestMethod = init?.method
    browserRequestBody = typeof init?.body === "string" ? init.body : init?.body?.toString()
    const requestHeaders = init?.headers as { get?: unknown } | undefined
    browserFrameHeader =
      typeof requestHeaders?.get === "function"
        ? (requestHeaders.get as (name: string) => string | null)("Turbo-Frame")
        : new browser.Headers(init?.headers).get("Turbo-Frame")
    return new browser.Response(null, { status: 204 })
  }
  turbo.start()
  try {
    browser.document.body.innerHTML = initialDocument
    const browserFrameBefore = browser.document.getElementById("destination")
    const link = browser.document.getElementById("save-link")
    if (!(browserFrameBefore instanceof browser.HTMLElement)) {
      throw new Error("Browser empty generated-form Frame is missing")
    }
    if (!(link instanceof browser.HTMLAnchorElement)) {
      throw new Error("Browser empty generated-form Frame link is missing")
    }
    link.dispatchEvent(
      new browser.MouseEvent("click", {
        bubbles: true,
        button: 0,
        cancelable: true,
        composed: true,
      }),
    )
    await browser.happyDOM.waitUntilComplete()

    expect(expoResult).toMatchObject({
      application: "empty",
      destination: { frameId: "destination", kind: "frame" },
      effectiveMethod: "POST",
      responseStatus: 204,
      status: "empty",
    })
    expect(expoRequest?.url).toBe(browserRequestUrl)
    expect(expoRequest?.method).toBe(browserRequestMethod)
    expect(expoRequest?.body?.value).toBe(browserRequestBody)
    expect(expoRequest?.headers["Turbo-Frame"]).toBe(browserFrameHeader ?? undefined)
    const browserFrameAfter = browser.document.getElementById("destination")
    const expoFrameAfter = session.tree.getElementById("destination")
    if (!browserFrameAfter || !expoFrameAfter) {
      throw new Error("Empty generated-form differential lost its destination Frame")
    }
    expect(browserFrameAfter).toBe(browserFrameBefore)
    expect(expoFrameAfter.key).toBe(expoFrameBefore.key)
    expect(normalizeProtocolNode(expoFrameAfter)).toEqual(normalizeBrowserNode(browserFrameAfter))
    expect(browser.document.getElementById("old-destination")).not.toBeNull()
    expect(session.tree.getElementById("old-destination")).toBeDefined()
  } finally {
    browser.fetch = originalFetch
    turbo.session.stop()
  }
})

test("matches upstream Turbo redirected generated-form Frame success", async () => {
  const initialDocument =
    '<main id="root"><a id="save-link" href="/save?value=accepted" data-turbo-method="post" data-turbo-frame="destination">Save</a><turbo-frame id="destination" class="mounted" src="/old"><p id="old-destination">Old</p></turbo-frame></main>'
  const finalDocument =
    '<main><turbo-frame id="destination" class="response"><p id="saved">Saved</p></turbo-frame><p id="outside">Outside</p></main>'
  const finalUrl = "https://example.test/save/final"
  const session = new DocumentSession(
    parseExpoTurboDocument(initialDocument, { url: "https://example.test/demo" }),
  )
  const expoFrameBefore = session.tree.getElementById("destination")
  if (!expoFrameBefore) throw new Error("Expo redirected generated-form Frame is missing")
  let expoRequest: TurboRequest | undefined
  const submissions = new FormSubmissionController(session, {
    fetch: async (request) => {
      expoRequest = request
      return {
        headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
        redirected: true,
        status: 200,
        text: async () => finalDocument,
        url: finalUrl,
      }
    },
  })
  const links = new FormLinkSubmissionController(session, submissions, {
    next: () => "request-generated-frame-redirect",
  })
  const expoResult = await links.submit("id:save-link", "/save?value=accepted")
  let browserRequestUrl: string | undefined
  let browserRequestMethod: string | undefined
  let browserRequestBody: string | undefined
  let browserFrameHeader: string | null | undefined
  const originalFetch = browser.fetch
  browser.fetch = async (input, init) => {
    browserRequestUrl = String(input)
    browserRequestMethod = init?.method
    browserRequestBody = typeof init?.body === "string" ? init.body : init?.body?.toString()
    const requestHeaders = init?.headers as { get?: unknown } | undefined
    browserFrameHeader =
      typeof requestHeaders?.get === "function"
        ? (requestHeaders.get as (name: string) => string | null)("Turbo-Frame")
        : new browser.Headers(init?.headers).get("Turbo-Frame")
    const response = new browser.Response(finalDocument, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
      status: 200,
    })
    Object.defineProperties(response, {
      redirected: { configurable: true, value: true },
      url: { configurable: true, value: finalUrl },
    })
    return response
  }
  turbo.start()
  try {
    browser.document.body.innerHTML = initialDocument
    const browserFrameBefore = browser.document.getElementById("destination")
    const link = browser.document.getElementById("save-link")
    if (!(browserFrameBefore instanceof browser.HTMLElement)) {
      throw new Error("Browser redirected generated-form Frame is missing")
    }
    if (!(link instanceof browser.HTMLAnchorElement)) {
      throw new Error("Browser redirected generated-form link is missing")
    }
    link.dispatchEvent(
      new browser.MouseEvent("click", {
        bubbles: true,
        button: 0,
        cancelable: true,
        composed: true,
      }),
    )
    await browser.happyDOM.waitUntilComplete()

    const browserFrameAfter = browser.document.getElementById("destination")
    const expoFrameAfter = session.tree.getElementById("destination")
    if (!browserFrameAfter || !expoFrameAfter) {
      throw new Error("Redirected generated-form differential lost its Frame")
    }
    expect(expoResult).toMatchObject({
      application: "frame",
      effectiveMethod: "POST",
      responseStatus: 200,
      status: "applied",
    })
    expect(expoRequest?.url).toBe(browserRequestUrl)
    expect(expoRequest?.method).toBe(browserRequestMethod)
    expect(expoRequest?.body?.value).toBe(browserRequestBody)
    expect(expoRequest?.headers["Turbo-Frame"]).toBe(browserFrameHeader ?? undefined)
    expect(browserFrameAfter).toBe(browserFrameBefore)
    expect(expoFrameAfter.key).toBe(expoFrameBefore.key)
    const browserResult = normalizeBrowserNode(browserFrameAfter)
    if (!browserResult || typeof browserResult === "string") {
      throw new Error("Browser redirected generated-form Frame result is invalid")
    }
    expect(normalizeProtocolNode(expoFrameAfter)).toEqual({
      ...browserResult,
      attributes: browserResult.attributes.filter(([name]) => name !== "complete"),
    })
    expect(browser.document.getElementById("outside")).toBeNull()
    expect(session.tree.getElementById("outside")).toBeUndefined()
  } finally {
    browser.fetch = originalFetch
    turbo.session.stop()
  }
})

test("matches upstream Turbo for a redirected generated-form document response", async () => {
  const initialDocument =
    '<main id="root"><a id="search-link" href="/search?query=shirts&amp;scope=all" data-turbo-method="post">Search</a><p id="old">Old</p></main>'
  const nextDocument =
    '<main id="root"><a id="again" href="/demo">Search again</a><p id="result">Found shirts</p></main>'
  const finalUrl = "https://example.test/results"
  const session = new DocumentSession(
    parseExpoTurboDocument(initialDocument, { url: "https://example.test/demo" }),
  )
  let expoRequest: TurboRequest | undefined
  const submissions = new FormSubmissionController(session, {
    fetch: async (request) => {
      expoRequest = request
      return {
        headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
        redirected: true,
        status: 200,
        text: async () => nextDocument,
        url: finalUrl,
      }
    },
  })
  const links = new FormLinkSubmissionController(session, submissions, {
    next: () => "request-generated-document-redirect",
  })
  const expoResult = await links.submit("id:search-link", "/search?query=shirts&scope=all")

  let browserRequestUrl: string | undefined
  let browserRequestMethod: string | undefined
  let browserRequestBody: string | undefined
  let browserFrameHeader: string | null | undefined
  const originalFetch = browser.fetch
  browser.fetch = async (input, init) => {
    browserRequestUrl = String(input)
    browserRequestMethod = init?.method
    browserRequestBody = typeof init?.body === "string" ? init.body : init?.body?.toString()
    const requestHeaders = init?.headers as { get?: unknown } | undefined
    browserFrameHeader =
      typeof requestHeaders?.get === "function"
        ? (requestHeaders.get as (name: string) => string | null)("Turbo-Frame")
        : new browser.Headers(init?.headers).get("Turbo-Frame")
    const response = new browser.Response(`<html><body>${nextDocument}</body></html>`, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
      status: 200,
    })
    Object.defineProperties(response, {
      redirected: { configurable: true, value: true },
      url: { configurable: true, value: finalUrl },
    })
    return response
  }
  turbo.start()
  try {
    browser.document.body.innerHTML = initialDocument
    const link = browser.document.getElementById("search-link")
    if (!(link instanceof browser.HTMLAnchorElement)) {
      throw new Error("Browser redirected generated-form document link is missing")
    }
    link.dispatchEvent(
      new browser.MouseEvent("click", {
        bubbles: true,
        button: 0,
        cancelable: true,
        composed: true,
      }),
    )
    await browser.happyDOM.waitUntilComplete()

    expect(expoResult).toMatchObject({
      application: "document",
      destination: { kind: "document" },
      effectiveMethod: "POST",
      redirected: true,
      responseStatus: 200,
      status: "applied",
    })
    expect(expoRequest?.url).toBe(browserRequestUrl)
    expect(expoRequest?.method).toBe(browserRequestMethod)
    expect(expoRequest?.body?.value).toBe(browserRequestBody)
    expect(expoRequest?.headers["Turbo-Frame"]).toBe(browserFrameHeader ?? undefined)
    expect(session.tree.document.url).toBe(browser.location.href)
    expect(normalizeProtocolNode(activeProtocolRoot(session))).toEqual(
      normalizeBrowserNode(browser.document.getElementById("root") as HappyElement),
    )
  } finally {
    browser.fetch = originalFetch
    turbo.session.stop()
  }
})

for (const responseStatus of [422, 500] as const) {
  test(`matches upstream Turbo for an authoritative Frame form ${responseStatus} response`, async () => {
    const initialDocument =
      '<main id="root"><turbo-frame id="details" class="mounted"><form id="profile" action="/profile" method="post"><button id="submit-profile" type="submit">Save</button></form><p id="old">Old</p></turbo-frame></main>'
    const frameResponse =
      '<main><turbo-frame id="details" class="response"><form id="profile" action="/profile" method="post"><p id="validation">Name is required</p><button type="submit">Save</button></form></turbo-frame><p id="outside">Outside</p></main>'
    const session = new DocumentSession(
      parseExpoTurboDocument(initialDocument, { url: "https://example.test/demo" }),
    )
    const form = session.tree.getElementById("profile")
    if (!form) throw new Error("Expo Frame form differential form is missing")
    const controls = new FormControlRegistry(session, form.key)
    let expoRequest: TurboRequest | undefined
    const expoResult = await new FormSubmissionController(session, {
      fetch: async (request) => {
        expoRequest = request
        return {
          headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
          redirected: false,
          status: responseStatus,
          text: async () => frameResponse,
          url: "https://example.test/profile",
        }
      },
    }).submit((signal) =>
      controls.submissionProposal({
        protocol: { requestId: `request-frame-form-${responseStatus}` },
        signal,
      }),
    )

    let browserRequestUrl: string | undefined
    let browserRequestMethod: string | undefined
    let browserFrameHeader: string | null | undefined
    const originalFetch = browser.fetch
    browser.fetch = async (input, init) => {
      browserRequestUrl = String(input)
      browserRequestMethod = init?.method
      const requestHeaders = init?.headers as { get?: unknown } | undefined
      browserFrameHeader =
        typeof requestHeaders?.get === "function"
          ? (requestHeaders.get as (name: string) => string | null)("Turbo-Frame")
          : new browser.Headers(init?.headers).get("Turbo-Frame")
      const response = new browser.Response(frameResponse, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
        status: responseStatus,
      })
      Object.defineProperty(response, "url", {
        configurable: true,
        value: "https://example.test/profile",
      })
      return response
    }
    turbo.start()
    try {
      browser.document.body.innerHTML = initialDocument
      const browserFrameBefore = browser.document.getElementById("details")
      const browserForm = browser.document.getElementById("profile")
      const submitter = browser.document.getElementById("submit-profile")
      if (!(browserFrameBefore instanceof browser.HTMLElement)) {
        throw new Error("Browser Frame form differential target is missing")
      }
      if (!(browserForm instanceof browser.HTMLFormElement)) {
        throw new Error("Browser Frame form differential form is missing")
      }
      if (!(submitter instanceof browser.HTMLButtonElement)) {
        throw new Error("Browser Frame form differential submitter is missing")
      }
      browserForm.requestSubmit(submitter)
      await browser.happyDOM.waitUntilComplete()

      const browserFrameAfter = browser.document.getElementById("details")
      const expoFrameAfter = session.tree.getElementById("details")
      if (!browserFrameAfter || !expoFrameAfter) {
        throw new Error("Frame form differential lost its target")
      }
      expect(expoResult).toMatchObject({
        application: "frame",
        responseStatus,
        status: "applied",
      })
      expect(expoRequest?.url).toBe(browserRequestUrl)
      expect(expoRequest?.method).toBe(browserRequestMethod)
      expect(expoRequest?.headers["Turbo-Frame"]).toBe(browserFrameHeader ?? undefined)
      expect(browserFrameAfter).toBe(browserFrameBefore)
      const browserResult = normalizeBrowserNode(browserFrameAfter)
      if (!browserResult || typeof browserResult === "string") {
        throw new Error("Browser Frame form differential result is invalid")
      }
      expect(normalizeProtocolNode(expoFrameAfter)).toEqual({
        ...browserResult,
        attributes: browserResult.attributes.filter(([name]) => name !== "complete"),
      })
      expect(browser.document.getElementById("outside")).toBeNull()
      expect(session.tree.getElementById("outside")).toBeUndefined()
    } finally {
      browser.fetch = originalFetch
      turbo.session.stop()
    }
  })
}

test("matches upstream Turbo for a Frame form Stream response", async () => {
  const initialDocument =
    '<main id="root"><turbo-frame id="details"><form id="profile" action="/profile" method="post"><button id="submit-profile" type="submit">Save</button></form></turbo-frame><p id="status">Old</p></main>'
  const streamResponse =
    '<turbo-stream action="update" target="status"><template><span id="updated">Updated</span></template></turbo-stream>'
  const session = new DocumentSession(
    parseExpoTurboDocument(initialDocument, { url: "https://example.test/demo" }),
  )
  const form = session.tree.getElementById("profile")
  const expoFrameBefore = session.tree.getElementById("details")
  if (!form || !expoFrameBefore) throw new Error("Expo Stream Frame form fixture is missing")
  const controls = new FormControlRegistry(session, form.key)
  let expoRequest: TurboRequest | undefined
  const expoResult = await new FormSubmissionController(session, {
    fetch: async (request) => {
      expoRequest = request
      return {
        headers: { "Content-Type": TURBO_STREAM_MIME_TYPE },
        redirected: false,
        status: 200,
        text: async () => streamResponse,
        url: "https://example.test/profile",
      }
    },
  }).submit((signal) =>
    controls.submissionProposal({
      protocol: { requestId: "request-frame-form-stream" },
      signal,
    }),
  )

  let browserRequestUrl: string | undefined
  let browserRequestMethod: string | undefined
  let browserFrameHeader: string | null | undefined
  const originalFetch = browser.fetch
  browser.fetch = async (input, init) => {
    browserRequestUrl = String(input)
    browserRequestMethod = init?.method
    const requestHeaders = init?.headers as { get?: unknown } | undefined
    browserFrameHeader =
      typeof requestHeaders?.get === "function"
        ? (requestHeaders.get as (name: string) => string | null)("Turbo-Frame")
        : new browser.Headers(init?.headers).get("Turbo-Frame")
    const response = new browser.Response(streamResponse, {
      headers: { "Content-Type": `${TURBO_STREAM_MIME_TYPE}; charset=utf-8` },
      status: 200,
    })
    Object.defineProperty(response, "url", {
      configurable: true,
      value: "https://example.test/profile",
    })
    return response
  }
  turbo.start()
  try {
    browser.document.body.innerHTML = initialDocument
    const browserFrameBefore = browser.document.getElementById("details")
    const browserForm = browser.document.getElementById("profile")
    const submitter = browser.document.getElementById("submit-profile")
    if (!(browserFrameBefore instanceof browser.HTMLElement)) {
      throw new Error("Browser Stream Frame form target is missing")
    }
    if (!(browserForm instanceof browser.HTMLFormElement)) {
      throw new Error("Browser Stream Frame form is missing")
    }
    if (!(submitter instanceof browser.HTMLButtonElement)) {
      throw new Error("Browser Stream Frame form submitter is missing")
    }
    browserForm.requestSubmit(submitter)
    await browser.happyDOM.waitUntilComplete()

    expect(expoResult).toMatchObject({
      application: "stream",
      responseStatus: 200,
      status: "applied",
    })
    expect(expoRequest?.url).toBe(browserRequestUrl)
    expect(expoRequest?.method).toBe(browserRequestMethod)
    expect(expoRequest?.headers["Turbo-Frame"]).toBe(browserFrameHeader ?? undefined)
    expect(browser.document.getElementById("details")).toBe(browserFrameBefore)
    expect(session.tree.getElementById("details")).toBe(expoFrameBefore)
    expect(normalizeProtocolNode(session.tree.getElementById("status") as ProtocolElement)).toEqual(
      normalizeBrowserNode(browser.document.getElementById("status") as HappyElement),
    )
    expect(browser.document.getElementById("updated")).not.toBeNull()
    expect(session.tree.getElementById("updated")).toBeDefined()
  } finally {
    browser.fetch = originalFetch
    turbo.session.stop()
  }
})

test("matches upstream Turbo prevented missing-Frame handling for a Frame form", async () => {
  const initialDocument =
    '<main id="root"><turbo-frame id="details"><form id="profile" action="/profile" method="post"><button id="submit-profile" type="submit">Save</button></form><p id="old">Old</p></turbo-frame></main>'
  const missingResponse = '<main><p id="outside">Outside</p></main>'
  const session = new DocumentSession(
    parseExpoTurboDocument(initialDocument, { url: "https://example.test/demo" }),
  )
  const form = session.tree.getElementById("profile")
  const expoFrameBefore = session.tree.getElementById("details")
  if (!form || !expoFrameBefore) throw new Error("Expo missing Frame form fixture is missing")
  const controls = new FormControlRegistry(session, form.key)
  const expoEvents: unknown[] = []
  const lifecycle = new FrameLifecycle()
  lifecycle.subscribe("frame-missing", (event) => {
    expoEvents.push({
      frameId: event.detail.frameId,
      response: event.detail.response,
      type: event.type,
    })
    event.preventDefault()
  })
  let expoRequest: TurboRequest | undefined
  const expoResult = await new FormSubmissionController(
    session,
    {
      fetch: async (request) => {
        expoRequest = request
        return {
          headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
          redirected: false,
          status: 200,
          text: async () => missingResponse,
          url: "https://example.test/profile",
        }
      },
    },
    { frameLifecycle: lifecycle },
  ).submit((signal) =>
    controls.submissionProposal({
      protocol: { requestId: "request-frame-form-missing" },
      signal,
    }),
  )

  const browserEvents: unknown[] = []
  let browserRequestUrl: string | undefined
  let browserRequestMethod: string | undefined
  let browserFrameHeader: string | null | undefined
  let browserFrameListenerTarget: HappyElement | undefined
  const handleBrowserMissing = (received: HappyEvent) => {
    const event = received as unknown as CustomEvent<{ response: Response }>
    browserEvents.push({
      frameId: (event.target as Element | null)?.id,
      response: {
        redirected: event.detail.response.redirected,
        status: event.detail.response.status,
        url: event.detail.response.url,
      },
      type: event.type.replace("turbo:", ""),
    })
    event.preventDefault()
  }
  const originalFetch = browser.fetch
  browser.fetch = async (input, init) => {
    browserRequestUrl = String(input)
    browserRequestMethod = init?.method
    const requestHeaders = init?.headers as { get?: unknown } | undefined
    browserFrameHeader =
      typeof requestHeaders?.get === "function"
        ? (requestHeaders.get as (name: string) => string | null)("Turbo-Frame")
        : new browser.Headers(init?.headers).get("Turbo-Frame")
    const response = new browser.Response(missingResponse, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
      status: 200,
    })
    Object.defineProperty(response, "url", {
      configurable: true,
      value: "https://example.test/profile",
    })
    return response
  }
  turbo.start()
  try {
    browser.document.body.innerHTML = initialDocument
    const browserFrameBefore = browser.document.getElementById("details")
    const browserForm = browser.document.getElementById("profile")
    const submitter = browser.document.getElementById("submit-profile")
    if (!(browserFrameBefore instanceof browser.HTMLElement)) {
      throw new Error("Browser missing Frame form target is missing")
    }
    if (!(browserForm instanceof browser.HTMLFormElement)) {
      throw new Error("Browser missing Frame form is missing")
    }
    if (!(submitter instanceof browser.HTMLButtonElement)) {
      throw new Error("Browser missing Frame form submitter is missing")
    }
    browserFrameBefore.addEventListener("turbo:frame-missing", handleBrowserMissing)
    browserFrameListenerTarget = browserFrameBefore
    browserForm.requestSubmit(submitter)
    await browser.happyDOM.waitUntilComplete()

    expect(expoResult).toMatchObject({
      responseStatus: 200,
      status: "prevented",
    })
    expect(expoRequest?.url).toBe(browserRequestUrl)
    expect(expoRequest?.method).toBe(browserRequestMethod)
    expect(expoRequest?.headers["Turbo-Frame"]).toBe(browserFrameHeader ?? undefined)
    expect(expoEvents).toEqual(browserEvents)
    expect(browser.document.getElementById("details")).toBe(browserFrameBefore)
    expect(session.tree.getElementById("details")).toBe(expoFrameBefore)
    const browserResult = normalizeBrowserNode(browserFrameBefore)
    if (!browserResult || typeof browserResult === "string") {
      throw new Error("Browser missing Frame form differential result is invalid")
    }
    expect(normalizeProtocolNode(expoFrameBefore)).toEqual({
      ...browserResult,
      attributes: browserResult.attributes.filter(([name]) => name !== "complete"),
    })
    expect(browser.document.getElementById("outside")).toBeNull()
    expect(session.tree.getElementById("outside")).toBeUndefined()
  } finally {
    browserFrameListenerTarget?.removeEventListener("turbo:frame-missing", handleBrowserMissing)
    browser.fetch = originalFetch
    turbo.session.stop()
  }
})

test("matches upstream Turbo Frame form visit-control response promotion", async () => {
  const initialDocument =
    '<main id="root"><turbo-frame id="details"><form id="profile" action="/profile" method="post"><button id="submit-profile" type="submit">Save</button></form><p id="old">Old</p></turbo-frame></main>'
  const expoResponse =
    '<main id="promoted-root" data-turbo-visit-control="reload"><p id="promoted">Promoted</p></main>'
  const browserResponse =
    '<html><head><meta name="turbo-visit-control" content="reload"></head><body><main id="promoted-root"><p id="promoted">Promoted</p></main></body></html>'
  const session = new DocumentSession(
    parseExpoTurboDocument(initialDocument, { url: "https://example.test/demo" }),
  )
  const form = session.tree.getElementById("profile")
  const expoFrameBefore = session.tree.getElementById("details")
  if (!form || !expoFrameBefore) throw new Error("Expo promoted Frame form fixture is missing")
  const controls = new FormControlRegistry(session, form.key)
  let expoRequest: TurboRequest | undefined
  const expoVisits: unknown[] = []
  const lifecycle = new FrameLifecycle({
    visitResponse(request) {
      expoVisits.push({
        action: request.action,
        body: request.body,
        frameId: request.frameId,
        reason: request.reason,
        response: request.response,
      })
    },
  })
  const expoResult = await new FormSubmissionController(
    session,
    {
      fetch: async (request) => {
        expoRequest = request
        return {
          headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
          redirected: false,
          status: 200,
          text: async () => expoResponse,
          url: "https://example.test/profile",
        }
      },
    },
    { frameLifecycle: lifecycle },
  ).submit((signal) =>
    controls.submissionProposal({
      protocol: { requestId: "request-frame-form-promoted" },
      signal,
    }),
  )

  let browserFetches = 0
  let browserRequestUrl: string | undefined
  let browserRequestMethod: string | undefined
  let browserFrameHeader: string | null | undefined
  const browserVisits: unknown[] = []
  const originalFetch = browser.fetch
  const browserSession = turbo.session as typeof turbo.session & {
    visit(
      location: URL,
      options: { response: { redirected: boolean; responseHTML: string; statusCode: number } },
    ): void
  }
  const originalVisit = browserSession.visit
  Object.defineProperty(browserSession, "visit", {
    configurable: true,
    value: (
      location: URL,
      options: {
        response: { redirected: boolean; responseHTML: string; statusCode: number }
      },
    ) => {
      browserVisits.push({
        response: options.response,
        url: location.href,
      })
    },
    writable: true,
  })
  browser.fetch = async (input, init) => {
    browserFetches += 1
    browserRequestUrl = String(input)
    browserRequestMethod = init?.method
    const requestHeaders = init?.headers as { get?: unknown } | undefined
    browserFrameHeader =
      typeof requestHeaders?.get === "function"
        ? (requestHeaders.get as (name: string) => string | null)("Turbo-Frame")
        : new browser.Headers(init?.headers).get("Turbo-Frame")
    const response = new browser.Response(browserResponse, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
      status: 200,
    })
    Object.defineProperty(response, "url", {
      configurable: true,
      value: "https://example.test/profile",
    })
    return response
  }
  turbo.start()
  try {
    browser.document.body.innerHTML = initialDocument
    const browserFrameBefore = browser.document.getElementById("details")
    const browserForm = browser.document.getElementById("profile")
    const submitter = browser.document.getElementById("submit-profile")
    if (!(browserFrameBefore instanceof browser.HTMLElement)) {
      throw new Error("Browser promoted Frame form target is missing")
    }
    if (!(browserForm instanceof browser.HTMLFormElement)) {
      throw new Error("Browser promoted Frame form is missing")
    }
    if (!(submitter instanceof browser.HTMLButtonElement)) {
      throw new Error("Browser promoted Frame form submitter is missing")
    }
    browserForm.requestSubmit(submitter)
    await browser.happyDOM.waitUntilComplete()

    const browserFrameAfter = browser.document.getElementById("details")
    const expoFrameAfter = session.tree.getElementById("details")
    if (!browserFrameAfter || !expoFrameAfter) {
      throw new Error("Frame form visit-control differential lost its mounted Frame")
    }
    expect(expoResult).toMatchObject({
      reason: "visit-control-reload",
      responseStatus: 200,
      status: "promoted",
    })
    expect(browserFetches).toBe(1)
    expect(expoRequest?.url).toBe(browserRequestUrl)
    expect(expoRequest?.method).toBe(browserRequestMethod)
    expect(expoRequest?.headers["Turbo-Frame"]).toBe(browserFrameHeader ?? undefined)
    expect(expoVisits).toEqual([
      {
        action: "advance",
        body: expoResponse,
        frameId: "details",
        reason: "visit-control-reload",
        response: {
          redirected: false,
          status: 200,
          url: "https://example.test/profile",
        },
      },
    ])
    expect(browserVisits).toEqual([
      {
        response: {
          redirected: false,
          responseHTML: browserResponse,
          statusCode: 200,
        },
        url: "https://example.test/profile",
      },
    ])
    expect(browserFrameAfter).toBe(browserFrameBefore)
    expect(expoFrameAfter).toBe(expoFrameBefore)
    const browserFrameResult = normalizeBrowserNode(browserFrameAfter)
    if (!browserFrameResult || typeof browserFrameResult === "string") {
      throw new Error("Browser promoted Frame form result is invalid")
    }
    expect(normalizeProtocolNode(expoFrameAfter)).toEqual({
      ...browserFrameResult,
      attributes: browserFrameResult.attributes.filter(([name]) => name !== "complete"),
    })
    expect(browser.document.getElementById("promoted")).toBeNull()
    expect(session.tree.getElementById("promoted")).toBeUndefined()
  } finally {
    Object.defineProperty(browserSession, "visit", {
      configurable: true,
      value: originalVisit,
      writable: true,
    })
    browser.fetch = originalFetch
    turbo.session.stop()
  }
})

test("matches upstream Turbo for an empty Frame form 204 response", async () => {
  const initialDocument =
    '<main id="root"><turbo-frame id="details" src="/details"><form id="profile" action="/profile" method="post"><button id="submit-profile" type="submit">Save</button></form><p id="old">Old</p></turbo-frame></main>'
  const session = new DocumentSession(
    parseExpoTurboDocument(initialDocument, { url: "https://example.test/demo" }),
  )
  const form = session.tree.getElementById("profile")
  const expoFrameBefore = session.tree.getElementById("details")
  if (!form || !expoFrameBefore) throw new Error("Expo empty Frame form fixture is missing")
  const controls = new FormControlRegistry(session, form.key)
  let expoRequest: TurboRequest | undefined
  const expoResult = await new FormSubmissionController(session, {
    fetch: async (request) => {
      expoRequest = request
      return {
        headers: {},
        redirected: false,
        status: 204,
        text: async () => "",
        url: "https://example.test/profile",
      }
    },
  }).submit((signal) =>
    controls.submissionProposal({
      protocol: { requestId: "request-frame-form-204" },
      signal,
    }),
  )

  let browserRequestUrl: string | undefined
  let browserRequestMethod: string | undefined
  let browserFrameHeader: string | null | undefined
  const originalFetch = browser.fetch
  browser.fetch = async (input, init) => {
    browserRequestUrl = String(input)
    browserRequestMethod = init?.method
    const requestHeaders = init?.headers as { get?: unknown } | undefined
    browserFrameHeader =
      typeof requestHeaders?.get === "function"
        ? (requestHeaders.get as (name: string) => string | null)("Turbo-Frame")
        : new browser.Headers(init?.headers).get("Turbo-Frame")
    return new browser.Response(null, { status: 204 })
  }
  turbo.start()
  try {
    browser.document.body.innerHTML = initialDocument
    const browserFrameBefore = browser.document.getElementById("details")
    const browserForm = browser.document.getElementById("profile")
    const submitter = browser.document.getElementById("submit-profile")
    if (!(browserFrameBefore instanceof browser.HTMLElement)) {
      throw new Error("Browser empty Frame form target is missing")
    }
    if (!(browserForm instanceof browser.HTMLFormElement)) {
      throw new Error("Browser empty Frame form is missing")
    }
    if (!(submitter instanceof browser.HTMLButtonElement)) {
      throw new Error("Browser empty Frame form submitter is missing")
    }
    browserForm.requestSubmit(submitter)
    await browser.happyDOM.waitUntilComplete()

    expect(expoResult).toMatchObject({
      application: "empty",
      responseStatus: 204,
      status: "empty",
    })
    expect(expoRequest?.url).toBe(browserRequestUrl)
    expect(expoRequest?.method).toBe(browserRequestMethod)
    expect(expoRequest?.headers["Turbo-Frame"]).toBe(browserFrameHeader ?? undefined)
    expect(browser.document.getElementById("details")).toBe(browserFrameBefore)
    expect(session.tree.getElementById("details")).toBe(expoFrameBefore)
    expect(normalizeProtocolNode(expoFrameBefore)).toEqual(
      normalizeBrowserNode(browserFrameBefore as HappyElement),
    )
  } finally {
    browser.fetch = originalFetch
    turbo.session.stop()
  }
})

test("matches upstream Turbo for a redirected Frame form success", async () => {
  const initialDocument =
    '<main id="root"><turbo-frame id="details" src="/details"><form id="profile" action="/profile" method="post"><button id="submit-profile" type="submit">Save</button></form><p id="old">Old</p></turbo-frame></main>'
  const finalDocument =
    '<main><turbo-frame id="details"><p id="saved">Saved</p></turbo-frame><p id="outside">Outside</p></main>'
  const finalUrl = "https://example.test/profile/final"
  const session = new DocumentSession(
    parseExpoTurboDocument(initialDocument, { url: "https://example.test/demo" }),
  )
  const form = session.tree.getElementById("profile")
  if (!form) throw new Error("Expo redirected Frame form is missing")
  const controls = new FormControlRegistry(session, form.key)
  let expoRequest: TurboRequest | undefined
  const expoResult = await new FormSubmissionController(session, {
    fetch: async (request) => {
      expoRequest = request
      return {
        headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
        redirected: true,
        status: 200,
        text: async () => finalDocument,
        url: finalUrl,
      }
    },
  }).submit((signal) =>
    controls.submissionProposal({
      protocol: { requestId: "request-frame-form-redirect" },
      signal,
    }),
  )

  let browserRequestUrl: string | undefined
  let browserRequestMethod: string | undefined
  let browserFrameHeader: string | null | undefined
  const originalFetch = browser.fetch
  browser.fetch = async (input, init) => {
    browserRequestUrl = String(input)
    browserRequestMethod = init?.method
    const requestHeaders = init?.headers as { get?: unknown } | undefined
    browserFrameHeader =
      typeof requestHeaders?.get === "function"
        ? (requestHeaders.get as (name: string) => string | null)("Turbo-Frame")
        : new browser.Headers(init?.headers).get("Turbo-Frame")
    const response = new browser.Response(finalDocument, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
      status: 200,
    })
    Object.defineProperties(response, {
      redirected: { configurable: true, value: true },
      url: { configurable: true, value: finalUrl },
    })
    return response
  }
  turbo.start()
  try {
    browser.document.body.innerHTML = initialDocument
    const browserFrameBefore = browser.document.getElementById("details")
    const browserForm = browser.document.getElementById("profile")
    const submitter = browser.document.getElementById("submit-profile")
    if (!(browserFrameBefore instanceof browser.HTMLElement)) {
      throw new Error("Browser redirected Frame form target is missing")
    }
    if (!(browserForm instanceof browser.HTMLFormElement)) {
      throw new Error("Browser redirected Frame form is missing")
    }
    if (!(submitter instanceof browser.HTMLButtonElement)) {
      throw new Error("Browser redirected Frame form submitter is missing")
    }
    browserForm.requestSubmit(submitter)
    await browser.happyDOM.waitUntilComplete()

    const browserFrameAfter = browser.document.getElementById("details")
    const expoFrameAfter = session.tree.getElementById("details")
    if (!browserFrameAfter || !expoFrameAfter) {
      throw new Error("Redirected Frame form differential lost its target")
    }
    expect(expoResult).toMatchObject({
      application: "frame",
      responseStatus: 200,
      status: "applied",
    })
    expect(expoRequest?.url).toBe(browserRequestUrl)
    expect(expoRequest?.method).toBe(browserRequestMethod)
    expect(expoRequest?.headers["Turbo-Frame"]).toBe(browserFrameHeader ?? undefined)
    expect(browserFrameAfter).toBe(browserFrameBefore)
    const browserResult = normalizeBrowserNode(browserFrameAfter)
    if (!browserResult || typeof browserResult === "string") {
      throw new Error("Browser redirected Frame form result is invalid")
    }
    expect(normalizeProtocolNode(expoFrameAfter)).toEqual({
      ...browserResult,
      attributes: browserResult.attributes.filter(([name]) => name !== "complete"),
    })
    expect(browser.document.getElementById("outside")).toBeNull()
    expect(session.tree.getElementById("outside")).toBeUndefined()
  } finally {
    browser.fetch = originalFetch
    turbo.session.stop()
  }
})

test("matches upstream Turbo for a top-level GET form document response", async () => {
  const initialDocument =
    '<main id="root"><form id="search" action="/search" method="get"><button id="submit-search" type="submit">Search</button></form><p id="old">Old</p></main>'
  const nextDocument =
    '<main id="root"><form id="search" action="/search" method="get"><button type="submit">Search again</button></form><p id="result">Found</p></main>'
  const session = new DocumentSession(
    parseExpoTurboDocument(initialDocument, { url: "https://example.test/demo" }),
  )
  const form = session.tree.getElementById("search")
  if (!form) throw new Error("Expo document GET form is missing")
  const controls = new FormControlRegistry(session, form.key)
  let expoRequest: TurboRequest | undefined
  const expoResult = await new FormSubmissionController(session, {
    fetch: async (request) => {
      expoRequest = request
      return {
        headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
        redirected: false,
        status: 200,
        text: async () => nextDocument,
        url: "https://example.test/search",
      }
    },
  }).submit((signal) =>
    controls.submissionProposal({
      protocol: { requestId: "request-document-get-form" },
      signal,
    }),
  )

  let browserRequestUrl: string | undefined
  let browserRequestMethod: string | undefined
  let browserFrameHeader: string | null | undefined
  const originalFetch = browser.fetch
  browser.fetch = async (input, init) => {
    browserRequestUrl = String(input)
    browserRequestMethod = init?.method
    const requestHeaders = init?.headers as { get?: unknown } | undefined
    browserFrameHeader =
      typeof requestHeaders?.get === "function"
        ? (requestHeaders.get as (name: string) => string | null)("Turbo-Frame")
        : new browser.Headers(init?.headers).get("Turbo-Frame")
    const response = new browser.Response(`<html><body>${nextDocument}</body></html>`, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
      status: 200,
    })
    Object.defineProperty(response, "url", {
      configurable: true,
      value: "https://example.test/search",
    })
    return response
  }
  turbo.start()
  try {
    browser.document.body.innerHTML = initialDocument
    const browserForm = browser.document.getElementById("search")
    const submitter = browser.document.getElementById("submit-search")
    if (!(browserForm instanceof browser.HTMLFormElement)) {
      throw new Error("Browser document GET form is missing")
    }
    if (!(submitter instanceof browser.HTMLButtonElement)) {
      throw new Error("Browser document GET form submitter is missing")
    }
    browserForm.requestSubmit(submitter)
    await browser.happyDOM.waitUntilComplete()

    expect(expoResult).toMatchObject({
      application: "document",
      responseStatus: 200,
      status: "applied",
    })
    expect(expoRequest?.url).toBe(browserRequestUrl)
    expect(expoRequest?.method).toBe(browserRequestMethod)
    expect(expoRequest?.headers["Turbo-Frame"]).toBe(browserFrameHeader ?? undefined)
    expect(session.tree.document.url).toBe(browser.location.href)
    expect(normalizeProtocolNode(activeProtocolRoot(session))).toEqual(
      normalizeBrowserNode(browser.document.getElementById("root") as HappyElement),
    )
  } finally {
    browser.fetch = originalFetch
    turbo.session.stop()
  }
})

test("matches upstream Turbo for a redirected top-level POST form document response", async () => {
  const initialDocument =
    '<main id="root"><form id="search" action="/search" method="post"><input id="query" name="query" value="shirts" /><button id="submit-search" name="commit" value="Search" type="submit">Search</button></form><p id="old">Old</p></main>'
  const nextDocument =
    '<main id="root"><a id="again" href="/demo">Search again</a><p id="result">Found shirts</p></main>'
  const session = new DocumentSession(
    parseExpoTurboDocument(initialDocument, { url: "https://example.test/demo" }),
  )
  const form = session.tree.getElementById("search")
  if (!form) throw new Error("Expo document POST form is missing")
  const controls = new FormControlRegistry(session, form.key)
  controls.register("id:query", {
    kind: "value",
    name: "query",
    value: "shirts",
  })
  const submitter = controls.register("id:submit-search", {
    kind: "submitter",
    name: "commit",
    value: "Search",
  })
  let expoRequest: TurboRequest | undefined
  const expoResult = await new FormSubmissionController(session, {
    fetch: async (request) => {
      expoRequest = request
      return {
        headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
        redirected: true,
        status: 200,
        text: async () => nextDocument,
        url: "https://example.test/results",
      }
    },
  }).submit((signal) =>
    controls.submissionProposal({
      protocol: { requestId: "request-document-post-form" },
      signal,
      submitter: submitter.selection,
    }),
  )
  const expoRequestBody = expoRequest?.body?.value
  if (typeof expoRequestBody !== "string") {
    throw new Error("Expo document POST form body is not URL encoded")
  }

  let browserRequestUrl: string | undefined
  let browserRequestMethod: string | undefined
  let browserRequestBody: string | undefined
  let browserFrameHeader: string | null | undefined
  const originalFetch = browser.fetch
  browser.fetch = async (input, init) => {
    browserRequestUrl = String(input)
    browserRequestMethod = init?.method
    browserRequestBody = typeof init?.body === "string" ? init.body : init?.body?.toString()
    const requestHeaders = init?.headers as { get?: unknown } | undefined
    browserFrameHeader =
      typeof requestHeaders?.get === "function"
        ? (requestHeaders.get as (name: string) => string | null)("Turbo-Frame")
        : new browser.Headers(init?.headers).get("Turbo-Frame")
    const response = new browser.Response(`<html><body>${nextDocument}</body></html>`, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
      status: 200,
    })
    Object.defineProperties(response, {
      redirected: {
        configurable: true,
        value: true,
      },
      url: {
        configurable: true,
        value: "https://example.test/results",
      },
    })
    return response
  }
  turbo.start()
  try {
    browser.document.body.innerHTML = initialDocument
    const browserForm = browser.document.getElementById("search")
    const browserSubmitter = browser.document.getElementById("submit-search")
    if (!(browserForm instanceof browser.HTMLFormElement)) {
      throw new Error("Browser document POST form is missing")
    }
    if (!(browserSubmitter instanceof browser.HTMLButtonElement)) {
      throw new Error("Browser document POST form submitter is missing")
    }
    browserForm.requestSubmit(browserSubmitter)
    await browser.happyDOM.waitUntilComplete()

    expect(expoResult).toMatchObject({
      application: "document",
      redirected: true,
      responseStatus: 200,
      status: "applied",
    })
    expect(expoRequest?.url).toBe(browserRequestUrl)
    expect(expoRequest?.method).toBe(browserRequestMethod)
    if (typeof browserRequestBody !== "string") {
      throw new Error("Browser document POST form body is not URL encoded")
    }
    expect(expoRequestBody).toBe(browserRequestBody)
    expect(expoRequest?.headers["Turbo-Frame"]).toBe(browserFrameHeader ?? undefined)
    expect(session.tree.document.url).toBe(browser.location.href)
    expect(normalizeProtocolNode(activeProtocolRoot(session))).toEqual(
      normalizeBrowserNode(browser.document.getElementById("root") as HappyElement),
    )
  } finally {
    browser.fetch = originalFetch
    turbo.session.stop()
  }
})

test("matches upstream Turbo unsafe document form redirect safety", async () => {
  const initialDocument =
    '<main id="root"><form id="search" action="/search" method="post"><button id="submit-search" type="submit">Search</button></form><p id="old">Old</p></main>'
  const unsafeResponse =
    '<main id="root"><a href="/demo">Search again</a><p id="unsafe-result">Unsafe result</p></main>'
  const session = new DocumentSession(
    parseExpoTurboDocument(initialDocument, { url: "https://example.test/demo" }),
  )
  const form = session.tree.getElementById("search")
  if (!form) throw new Error("Expo unsafe document form is missing")
  const controls = new FormControlRegistry(session, form.key)
  let expoError: unknown
  try {
    await new FormSubmissionController(session, {
      fetch: async () => ({
        headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
        redirected: false,
        status: 200,
        text: async () => unsafeResponse,
        url: "https://example.test/search",
      }),
    }).submit((signal) =>
      controls.submissionProposal({
        protocol: { requestId: "request-document-unsafe-form" },
        signal,
      }),
    )
  } catch (error) {
    expoError = error
  }

  let browserError: unknown
  const originalFetch = browser.fetch
  const originalConsoleError = console.error
  browser.fetch = async () => {
    const response = new browser.Response(`<html><body>${unsafeResponse}</body></html>`, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
      status: 200,
    })
    Object.defineProperty(response, "url", {
      configurable: true,
      value: "https://example.test/search",
    })
    return response
  }
  console.error = (error) => {
    browserError = error
  }
  browser.history.replaceState({}, "", "/demo")
  const browserInitialUrl = browser.location.href
  turbo.start()
  try {
    browser.document.body.innerHTML = initialDocument
    const browserForm = browser.document.getElementById("search")
    const browserSubmitter = browser.document.getElementById("submit-search")
    if (!(browserForm instanceof browser.HTMLFormElement)) {
      throw new Error("Browser unsafe document form is missing")
    }
    if (!(browserSubmitter instanceof browser.HTMLButtonElement)) {
      throw new Error("Browser unsafe document form submitter is missing")
    }
    browserForm.requestSubmit(browserSubmitter)
    await browser.happyDOM.waitUntilComplete()

    expect(expoError).toBeInstanceOf(Error)
    expect((expoError as Error).message).toMatch(/must redirect/)
    expect(browserError).toBeInstanceOf(Error)
    expect((browserError as Error).message).toMatch(/must redirect/)
    expect(session.tree.document.url).toBe("https://example.test/demo")
    expect(browser.location.href).toBe(browserInitialUrl)
    expect(normalizeProtocolNode(activeProtocolRoot(session))).toEqual(
      normalizeBrowserNode(browser.document.getElementById("root") as HappyElement),
    )
    expect(session.tree.getElementById("unsafe-result")).toBeUndefined()
    expect(browser.document.getElementById("unsafe-result")).toBeNull()
  } finally {
    console.error = originalConsoleError
    browser.fetch = originalFetch
    turbo.session.stop()
  }
})

for (const responseStatus of [422, 500] as const) {
  test(`matches upstream Turbo for an authoritative document form ${responseStatus} response`, async () => {
    const initialDocument =
      '<main id="root"><form id="profile" action="/profile" method="post"><button id="submit-profile" type="submit">Save</button></form><p id="old">Old</p></main>'
    const errorDocument = `<main id="root"><form id="profile" action="/profile" method="post"><p id="form-error">Status ${responseStatus}</p><button type="submit">Save</button></form></main>`
    const session = new DocumentSession(
      parseExpoTurboDocument(initialDocument, { url: "https://example.test/demo" }),
    )
    const form = session.tree.getElementById("profile")
    if (!form) throw new Error("Expo document error form is missing")
    const controls = new FormControlRegistry(session, form.key)
    let expoRequest: TurboRequest | undefined
    const expoResult = await new FormSubmissionController(session, {
      fetch: async (request) => {
        expoRequest = request
        return {
          headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
          redirected: false,
          status: responseStatus,
          text: async () => errorDocument,
          url: "https://example.test/profile",
        }
      },
    }).submit((signal) =>
      controls.submissionProposal({
        protocol: { requestId: `request-document-form-${responseStatus}` },
        signal,
      }),
    )

    let browserRequestUrl: string | undefined
    let browserRequestMethod: string | undefined
    let browserFrameHeader: string | null | undefined
    const originalFetch = browser.fetch
    browser.fetch = async (input, init) => {
      browserRequestUrl = String(input)
      browserRequestMethod = init?.method
      const requestHeaders = init?.headers as { get?: unknown } | undefined
      browserFrameHeader =
        typeof requestHeaders?.get === "function"
          ? (requestHeaders.get as (name: string) => string | null)("Turbo-Frame")
          : new browser.Headers(init?.headers).get("Turbo-Frame")
      const response = new browser.Response(`<html><body>${errorDocument}</body></html>`, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
        status: responseStatus,
      })
      Object.defineProperty(response, "url", {
        configurable: true,
        value: "https://example.test/profile",
      })
      return response
    }
    browser.history.replaceState({}, "", "/demo")
    turbo.start()
    try {
      browser.document.body.innerHTML = initialDocument
      const browserForm = browser.document.getElementById("profile")
      const browserSubmitter = browser.document.getElementById("submit-profile")
      if (!(browserForm instanceof browser.HTMLFormElement)) {
        throw new Error("Browser document error form is missing")
      }
      if (!(browserSubmitter instanceof browser.HTMLButtonElement)) {
        throw new Error("Browser document error form submitter is missing")
      }
      browserForm.requestSubmit(browserSubmitter)
      await browser.happyDOM.waitUntilComplete()

      expect(expoResult).toMatchObject({
        application: "document",
        responseStatus,
        status: "applied",
      })
      expect(expoRequest?.url).toBe(browserRequestUrl)
      expect(expoRequest?.method).toBe(browserRequestMethod)
      expect(expoRequest?.headers["Turbo-Frame"]).toBe(browserFrameHeader ?? undefined)
      expect(session.tree.document.url).toBe(browser.location.href)
      expect(normalizeProtocolNode(activeProtocolRoot(session))).toEqual(
        normalizeBrowserNode(browser.document.getElementById("root") as HappyElement),
      )
    } finally {
      browser.fetch = originalFetch
      turbo.session.stop()
    }
  })
}

for (const responseStatus of [201, 204] as const) {
  test(`matches upstream Turbo for an empty document form ${responseStatus} response`, async () => {
    const initialDocument =
      '<main id="root"><form id="profile" action="/profile" method="post"><button id="submit-profile" type="submit">Save</button></form><p id="old">Old</p></main>'
    const session = new DocumentSession(
      parseExpoTurboDocument(initialDocument, { url: "https://example.test/demo" }),
    )
    const form = session.tree.getElementById("profile")
    if (!form) throw new Error("Expo empty document form is missing")
    const controls = new FormControlRegistry(session, form.key)
    let expoRequest: TurboRequest | undefined
    const expoResult = await new FormSubmissionController(session, {
      fetch: async (request) => {
        expoRequest = request
        return {
          headers: {},
          redirected: false,
          status: responseStatus,
          text: async () => " \n ",
          url: "https://example.test/profile",
        }
      },
    }).submit((signal) =>
      controls.submissionProposal({
        protocol: { requestId: `request-document-form-empty-${responseStatus}` },
        signal,
      }),
    )

    let browserRequestUrl: string | undefined
    let browserRequestMethod: string | undefined
    let browserFrameHeader: string | null | undefined
    const originalFetch = browser.fetch
    browser.fetch = async (input, init) => {
      browserRequestUrl = String(input)
      browserRequestMethod = init?.method
      const requestHeaders = init?.headers as { get?: unknown } | undefined
      browserFrameHeader =
        typeof requestHeaders?.get === "function"
          ? (requestHeaders.get as (name: string) => string | null)("Turbo-Frame")
          : new browser.Headers(init?.headers).get("Turbo-Frame")
      const response = new browser.Response(responseStatus === 204 ? null : " \n ", {
        headers: { "Content-Type": "text/html; charset=utf-8" },
        status: responseStatus,
      })
      Object.defineProperty(response, "url", {
        configurable: true,
        value: "https://example.test/profile",
      })
      return response
    }
    browser.history.replaceState({}, "", "/demo")
    turbo.start()
    try {
      browser.document.body.innerHTML = initialDocument
      const browserForm = browser.document.getElementById("profile")
      const browserSubmitter = browser.document.getElementById("submit-profile")
      if (!(browserForm instanceof browser.HTMLFormElement)) {
        throw new Error("Browser empty document form is missing")
      }
      if (!(browserSubmitter instanceof browser.HTMLButtonElement)) {
        throw new Error("Browser empty document form submitter is missing")
      }
      browserForm.requestSubmit(browserSubmitter)
      await browser.happyDOM.waitUntilComplete()

      expect(expoResult).toMatchObject(
        responseStatus === 201
          ? { application: "document", responseStatus, status: "applied" }
          : { application: "empty", responseStatus, status: "empty" },
      )
      expect(expoRequest?.url).toBe(browserRequestUrl)
      expect(expoRequest?.method).toBe(browserRequestMethod)
      expect(expoRequest?.headers["Turbo-Frame"]).toBe(browserFrameHeader ?? undefined)
      expect(session.tree.document.url).toBe(browser.location.href)
      if (responseStatus === 201) {
        expect(session.tree.document.children).toEqual([])
        expect(browser.document.body.innerHTML).toBe("")
      } else {
        expect(normalizeProtocolNode(activeProtocolRoot(session))).toEqual(
          normalizeBrowserNode(browser.document.getElementById("root") as HappyElement),
        )
      }
    } finally {
      browser.fetch = originalFetch
      turbo.session.stop()
    }
  })
}

test("matches upstream Turbo for a top-level form Stream response", async () => {
  const initialDocument =
    '<main id="root"><form id="profile" action="/profile" method="post"><button id="submit-profile" type="submit">Save</button></form><p id="status">Old</p></main>'
  const streamResponse =
    '<turbo-stream action="update" target="status"><template><span id="updated">Updated</span></template></turbo-stream>'
  const session = new DocumentSession(
    parseExpoTurboDocument(initialDocument, { url: "https://example.test/demo" }),
  )
  const form = session.tree.getElementById("profile")
  if (!form) throw new Error("Expo document Stream form is missing")
  const controls = new FormControlRegistry(session, form.key)
  let expoRequest: TurboRequest | undefined
  const expoResult = await new FormSubmissionController(session, {
    fetch: async (request) => {
      expoRequest = request
      return {
        headers: { "Content-Type": TURBO_STREAM_MIME_TYPE },
        redirected: false,
        status: 200,
        text: async () => streamResponse,
        url: "https://example.test/profile",
      }
    },
  }).submit((signal) =>
    controls.submissionProposal({
      protocol: { requestId: "request-document-form-stream" },
      signal,
    }),
  )

  let browserRequestUrl: string | undefined
  let browserRequestMethod: string | undefined
  let browserFrameHeader: string | null | undefined
  const originalFetch = browser.fetch
  browser.fetch = async (input, init) => {
    browserRequestUrl = String(input)
    browserRequestMethod = init?.method
    const requestHeaders = init?.headers as { get?: unknown } | undefined
    browserFrameHeader =
      typeof requestHeaders?.get === "function"
        ? (requestHeaders.get as (name: string) => string | null)("Turbo-Frame")
        : new browser.Headers(init?.headers).get("Turbo-Frame")
    const response = new browser.Response(streamResponse, {
      headers: { "Content-Type": TURBO_STREAM_MIME_TYPE },
      status: 200,
    })
    Object.defineProperty(response, "url", {
      configurable: true,
      value: "https://example.test/profile",
    })
    return response
  }
  browser.history.replaceState({}, "", "/demo")
  turbo.start()
  try {
    browser.document.body.innerHTML = initialDocument
    const browserForm = browser.document.getElementById("profile")
    const browserSubmitter = browser.document.getElementById("submit-profile")
    if (!(browserForm instanceof browser.HTMLFormElement)) {
      throw new Error("Browser document Stream form is missing")
    }
    if (!(browserSubmitter instanceof browser.HTMLButtonElement)) {
      throw new Error("Browser document Stream form submitter is missing")
    }
    browserForm.requestSubmit(browserSubmitter)
    await browser.happyDOM.waitUntilComplete()

    expect(expoResult).toMatchObject({
      application: "stream",
      responseStatus: 200,
      status: "applied",
    })
    expect(expoRequest?.url).toBe(browserRequestUrl)
    expect(expoRequest?.method).toBe(browserRequestMethod)
    expect(expoRequest?.headers["Turbo-Frame"]).toBe(browserFrameHeader ?? undefined)
    expect(session.tree.document.url).toBe(browser.location.href)
    expect(normalizeProtocolNode(activeProtocolRoot(session))).toEqual(
      normalizeBrowserNode(browser.document.getElementById("root") as HappyElement),
    )
  } finally {
    browser.fetch = originalFetch
    turbo.session.stop()
  }
})

test("matches upstream Turbo for an ordinary document link visit", async () => {
  const initialDocument =
    '<main id="root"><a id="next-link" href="/next">Next</a><p id="old">Old</p></main>'
  const nextDocument =
    '<main id="root"><a id="back-link" href="/demo">Back</a><p id="next">Next document</p></main>'
  const session = new DocumentSession(
    parseExpoTurboDocument(initialDocument, { url: "https://example.test/demo" }),
  )
  let expoRequest: TurboRequest | undefined
  const loader = new DocumentRequestLoader(
    session,
    {
      fetch: async (request) => {
        expoRequest = request
        return {
          headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
          redirected: false,
          status: 200,
          text: async () => nextDocument,
          url: "https://example.test/next",
        }
      },
    },
    { next: () => "request-visit" },
  )
  const visits = new DocumentVisitController(loader, realClock)
  const expoResult = await visits.visit("/next")
  let browserRequestUrl: string | undefined
  let browserRequestMethod: string | undefined
  const originalFetch = browser.fetch
  browser.fetch = async (input, init) => {
    browserRequestUrl = String(input)
    browserRequestMethod = init?.method
    return new browser.Response(`<html><body>${nextDocument}</body></html>`, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
      status: 200,
    })
  }
  turbo.start()
  try {
    browser.document.body.innerHTML = initialDocument
    const link = browser.document.getElementById("next-link")
    if (!(link instanceof browser.HTMLAnchorElement)) {
      throw new Error("Browser document differential link is missing")
    }
    link.dispatchEvent(
      new browser.MouseEvent("click", {
        bubbles: true,
        button: 0,
        cancelable: true,
        composed: true,
      }),
    )
    await browser.happyDOM.waitUntilComplete()

    expect(expoResult.status).toBe("committed")
    expect(expoRequest?.url).toBe(browserRequestUrl)
    expect(expoRequest?.method).toBe(browserRequestMethod)
    expect(normalizeProtocolNode(activeProtocolRoot(session))).toEqual(
      normalizeBrowserNode(browser.document.getElementById("root") as HappyElement),
    )
  } finally {
    browser.fetch = originalFetch
    turbo.session.stop()
  }
})

test("matches upstream Turbo for a redirected document link visit", async () => {
  const initialDocument =
    '<main id="root"><a id="redirect-link" href="/redirect">Redirect</a><p id="old">Old</p></main>'
  const finalDocument =
    '<main id="root"><a id="back-link" href="/demo">Back</a><p id="final">Final document</p></main>'
  const session = new DocumentSession(
    parseExpoTurboDocument(initialDocument, { url: "https://example.test/demo" }),
  )
  let expoRequest: TurboRequest | undefined
  const loader = new DocumentRequestLoader(
    session,
    {
      fetch: async (request) => {
        expoRequest = request
        return {
          headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
          redirected: true,
          status: 200,
          text: async () => finalDocument,
          url: "https://example.test/final",
        }
      },
    },
    { next: () => "request-redirect" },
  )
  const visits = new DocumentVisitController(loader, realClock)
  const expoResult = await visits.visit("/redirect")
  let browserRequestUrl: string | undefined
  const originalFetch = browser.fetch
  browser.fetch = async (input) => {
    browserRequestUrl = String(input)
    const response = new browser.Response(`<html><body>${finalDocument}</body></html>`, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
      status: 200,
    })
    Object.defineProperties(response, {
      redirected: { configurable: true, value: true },
      url: { configurable: true, value: "https://example.test/final" },
    })
    return response
  }
  turbo.start()
  try {
    browser.document.body.innerHTML = initialDocument
    const link = browser.document.getElementById("redirect-link")
    if (!(link instanceof browser.HTMLAnchorElement)) {
      throw new Error("Browser redirect differential link is missing")
    }
    link.dispatchEvent(
      new browser.MouseEvent("click", {
        bubbles: true,
        button: 0,
        cancelable: true,
        composed: true,
      }),
    )
    await browser.happyDOM.waitUntilComplete()

    expect(expoResult.status).toBe("committed")
    expect(expoRequest?.url).toBe(browserRequestUrl)
    expect(session.tree.document.url).toBe(browser.location.href)
    expect(normalizeProtocolNode(activeProtocolRoot(session))).toEqual(
      normalizeBrowserNode(browser.document.getElementById("root") as HappyElement),
    )
  } finally {
    browser.fetch = originalFetch
    turbo.session.stop()
  }
})

test("matches upstream Turbo advance, replace, and traversal history", async () => {
  const initialDocument =
    '<main id="root"><a id="advance-link" href="/next">Next</a><p id="initial">Initial</p></main>'
  const nextDocument =
    '<main id="root"><a id="replace-link" href="/final" data-turbo-action="replace">Final</a><p id="next">Next</p></main>'
  const finalDocument = '<main id="root"><p id="final">Final</p></main>'
  const session = new DocumentSession(
    parseExpoTurboDocument(initialDocument, { url: "https://example.test/demo" }),
  )
  const expoHistoryWrites: string[] = []
  const restorationIdentifiers = ["initial", "next", "final"]
  const history = new DocumentHistory(
    {
      next() {
        const identifier = restorationIdentifiers.shift()
        if (!identifier) throw new Error("History differential exhausted its identifiers")
        return identifier
      },
    },
    {
      write(method) {
        expoHistoryWrites.push(method)
        return undefined
      },
    },
  )
  const initialHistoryEntry = history.initialize({
    kind: "unmanaged",
    url: "https://example.test/demo",
  }).entry
  const loader = new DocumentRequestLoader(
    session,
    {
      fetch: async (request) => ({
        headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
        redirected: false,
        status: 200,
        text: async () =>
          request.url.endsWith("/next")
            ? nextDocument
            : request.url.endsWith("/final")
              ? finalDocument
              : initialDocument,
        url: request.url,
      }),
    },
    { next: () => "request-history" },
  )
  const snapshotCache = new DocumentSnapshotCache()
  const visits = new DocumentVisitController(loader, realClock, { history, snapshotCache })
  await visits.visit("/next", { action: "advance" })
  await visits.visit("/final", { action: "replace" })

  const originalFetch = browser.fetch
  ;(turbo.session as typeof turbo.session & { clearCache(): void }).clearCache()
  browser.history.replaceState({}, "", "/demo")
  ;(
    turbo.session as typeof turbo.session & {
      view: { lastRenderedLocation: URL }
    }
  ).view.lastRenderedLocation = new browser.URL(browser.location.href)
  const browserHistoryLength = browser.history.length
  const browserRequests: string[] = []
  browser.fetch = async (input) => {
    const url = String(input)
    browserRequests.push(url)
    const document = url.endsWith("/next")
      ? nextDocument
      : url.endsWith("/final")
        ? finalDocument
        : initialDocument
    return new browser.Response(`<html><body>${document}</body></html>`, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
      status: 200,
    })
  }
  browser.document.body.innerHTML = initialDocument
  turbo.start()
  try {
    const advanceLink = browser.document.getElementById("advance-link")
    if (!(advanceLink instanceof browser.HTMLAnchorElement)) {
      throw new Error("Browser advance history link is missing")
    }
    advanceLink.dispatchEvent(
      new browser.MouseEvent("click", {
        bubbles: true,
        button: 0,
        cancelable: true,
        composed: true,
      }),
    )
    await browser.happyDOM.waitUntilComplete()

    expect(browser.location.href).toBe("https://example.test/next")
    expect(browser.history.length).toBe(browserHistoryLength + 1)

    const replaceLink = browser.document.getElementById("replace-link")
    if (!(replaceLink instanceof browser.HTMLAnchorElement)) {
      throw new Error("Browser replace history link is missing")
    }
    replaceLink.dispatchEvent(
      new browser.MouseEvent("click", {
        bubbles: true,
        button: 0,
        cancelable: true,
        composed: true,
      }),
    )
    await browser.happyDOM.waitUntilComplete()

    const finalHistoryEntry = history.current
    if (!finalHistoryEntry) throw new Error("Expo history differential lost its current entry")
    const browserTurboState = (
      browser.history.state as Readonly<{ turbo?: Readonly<{ restorationIndex?: unknown }> }> | null
    )?.turbo
    expect(expoHistoryWrites).toEqual(["replace", "push", "replace"])
    expect(browser.location.href).toBe(finalHistoryEntry.url)
    expect(browser.history.length).toBe(browserHistoryLength + 1)
    expect(browserTurboState?.restorationIndex).toBe(finalHistoryEntry.restorationIndex)
    expect(normalizeProtocolNode(activeProtocolRoot(session))).toEqual(
      normalizeBrowserNode(browser.document.getElementById("root") as HappyElement),
    )

    snapshotCache.clear()
    ;(turbo.session as typeof turbo.session & { clearCache(): void }).clearCache()
    browser.history.back()
    await browser.happyDOM.waitUntilComplete()
    const restored = await visits.restoreTraversal(initialHistoryEntry)
    const restoredBrowserTurboState = (
      browser.history.state as Readonly<{ turbo?: Readonly<{ restorationIndex?: unknown }> }> | null
    )?.turbo

    expect(restored).toMatchObject({
      direction: "back",
      source: "network",
    })
    expect(browser.location.href).toBe(initialHistoryEntry.url)
    expect(restoredBrowserTurboState?.restorationIndex).toBe(initialHistoryEntry.restorationIndex)
    expect(browserRequests).toHaveLength(3)
    expect(normalizeProtocolNode(activeProtocolRoot(session))).toEqual(
      normalizeBrowserNode(browser.document.getElementById("root") as HappyElement),
    )

    browser.history.forward()
    await browser.happyDOM.waitUntilComplete()
    const forwarded = await visits.restoreTraversal(finalHistoryEntry)
    const forwardedBrowserTurboState = (
      browser.history.state as Readonly<{ turbo?: Readonly<{ restorationIndex?: unknown }> }> | null
    )?.turbo

    expect(forwarded).toMatchObject({
      direction: "forward",
      source: "snapshot",
    })
    expect(browser.location.href).toBe(finalHistoryEntry.url)
    expect(forwardedBrowserTurboState?.restorationIndex).toBe(finalHistoryEntry.restorationIndex)
    expect(browserRequests).toHaveLength(3)
    expect(normalizeProtocolNode(activeProtocolRoot(session))).toEqual(
      normalizeBrowserNode(browser.document.getElementById("root") as HappyElement),
    )

    browser.history.back()
    await browser.happyDOM.waitUntilComplete()
    const cachedBack = await visits.restoreTraversal(initialHistoryEntry)
    const cachedBackBrowserTurboState = (
      browser.history.state as Readonly<{ turbo?: Readonly<{ restorationIndex?: unknown }> }> | null
    )?.turbo

    expect(cachedBack).toMatchObject({
      direction: "back",
      source: "snapshot",
    })
    expect(browser.location.href).toBe(initialHistoryEntry.url)
    expect(cachedBackBrowserTurboState?.restorationIndex).toBe(initialHistoryEntry.restorationIndex)
    expect(browserRequests).toHaveLength(3)
    expect(normalizeProtocolNode(activeProtocolRoot(session))).toEqual(
      normalizeBrowserNode(browser.document.getElementById("root") as HappyElement),
    )
  } finally {
    browser.fetch = originalFetch
    turbo.session.stop()
  }
})

test.each([
  { body: "", status: 201 },
  { body: null, status: 204 },
])("matches upstream Turbo for an empty $status document response", async ({ body, status }) => {
  const initialDocument =
    '<main id="root"><a id="empty-link" href="/empty">Empty</a><p id="old">Old</p></main>'
  const session = new DocumentSession(
    parseExpoTurboDocument(initialDocument, { url: "https://example.test/demo" }),
  )
  const loader = new DocumentRequestLoader(
    session,
    {
      fetch: async () => ({
        headers: {},
        redirected: false,
        status,
        text: async () => "",
        url: "https://example.test/empty",
      }),
    },
    { next: () => "request-empty" },
  )
  const restorationIdentifiers = ["empty-initial", "empty-destination"]
  const history = new DocumentHistory(
    {
      next() {
        const identifier = restorationIdentifiers.shift()
        if (!identifier) throw new Error("Empty-response differential exhausted its identifiers")
        return identifier
      },
    },
    { write: () => undefined },
  )
  history.initialize({ kind: "unmanaged", url: "https://example.test/demo" })
  const visits = new DocumentVisitController(loader, realClock, { history })
  const expoResult = await visits.visit("/empty")
  const originalFetch = browser.fetch
  browser.fetch = async () => new browser.Response(body, { status })
  ;(turbo.session as typeof turbo.session & { clearCache(): void }).clearCache()
  browser.history.replaceState({}, "", "/demo")
  turbo.start()
  try {
    browser.document.body.innerHTML = initialDocument
    const responseHandled = new Promise<void>((resolve) => {
      browser.document.addEventListener("turbo:before-fetch-response", () => resolve(), {
        once: true,
      })
    })
    const link = browser.document.getElementById("empty-link")
    if (!(link instanceof browser.HTMLAnchorElement)) {
      throw new Error("Browser empty-response differential link is missing")
    }
    link.dispatchEvent(
      new browser.MouseEvent("click", {
        bubbles: true,
        button: 0,
        cancelable: true,
        composed: true,
      }),
    )
    await responseHandled
    await Promise.resolve()

    expect(expoResult.status).toBe("empty")
    expect(visits.state.status).toBe("completed")
    expect(history.current?.url).toBe(browser.location.href)
    expect(session.tree.document.url).toBe(browser.location.href)
    expect(normalizeProtocolNode(activeProtocolRoot(session))).toEqual(
      normalizeBrowserNode(browser.document.getElementById("root") as HappyElement),
    )
  } finally {
    browser.fetch = originalFetch
    turbo.session.stop()
    await browser.happyDOM.abort()
  }
})

test("matches upstream Turbo for an inadmissible document response MIME", async () => {
  const initialDocument =
    '<main id="root"><a id="wrong-mime-link" href="/wrong-mime">Wrong MIME</a><p id="old">Old</p></main>'
  const session = new DocumentSession(
    parseExpoTurboDocument(initialDocument, { url: "https://example.test/demo" }),
  )
  const loader = new DocumentRequestLoader(
    session,
    {
      fetch: async () => ({
        headers: { "Content-Type": "application/json" },
        redirected: false,
        status: 200,
        text: async () => '{"replacement":true}',
        url: "https://example.test/wrong-mime",
      }),
    },
    { next: () => "request-wrong-mime" },
  )
  const restorationIdentifiers = ["wrong-mime-initial", "wrong-mime-destination"]
  const history = new DocumentHistory(
    {
      next() {
        const identifier = restorationIdentifiers.shift()
        if (!identifier) throw new Error("Wrong-MIME differential exhausted its identifiers")
        return identifier
      },
    },
    { write: () => undefined },
  )
  history.initialize({ kind: "unmanaged", url: "https://example.test/demo" })
  const visits = new DocumentVisitController(loader, realClock, { history })
  const expoVisit = visits.visit("/wrong-mime")
  const originalFetch = browser.fetch
  const originalConsoleError = console.error
  browser.fetch = async () =>
    new browser.Response('{"replacement":true}', {
      headers: { "Content-Type": "application/json" },
      status: 200,
    })
  console.error = () => undefined
  ;(turbo.session as typeof turbo.session & { clearCache(): void }).clearCache()
  browser.history.replaceState({}, "", "/demo")
  turbo.start()
  try {
    browser.document.body.innerHTML = initialDocument
    const responseHandled = new Promise<void>((resolve) => {
      browser.document.addEventListener("turbo:before-fetch-response", () => resolve(), {
        once: true,
      })
    })
    const link = browser.document.getElementById("wrong-mime-link")
    if (!(link instanceof browser.HTMLAnchorElement)) {
      throw new Error("Browser wrong-MIME differential link is missing")
    }
    link.dispatchEvent(
      new browser.MouseEvent("click", {
        bubbles: true,
        button: 0,
        cancelable: true,
        composed: true,
      }),
    )
    await responseHandled
    await Promise.resolve()

    await expect(expoVisit).rejects.toBeInstanceOf(ContentTypeError)
    expect(visits.state.status).toBe("failed")
    expect(browser.location.href).toBe("https://example.test/wrong-mime")
    expect(history.current?.url).toBe(browser.location.href)
    expect(session.tree.document.url).toBe(browser.location.href)
    expect(normalizeProtocolNode(activeProtocolRoot(session))).toEqual(
      normalizeBrowserNode(browser.document.getElementById("root") as HappyElement),
    )
  } finally {
    browser.fetch = originalFetch
    console.error = originalConsoleError
    turbo.session.stop()
    await browser.happyDOM.abort()
  }
})

test("matches upstream Turbo for an authoritative 422 document response", async () => {
  const initialDocument =
    '<main id="root"><a id="invalid-link" href="/invalid">Invalid</a><p id="old">Old</p></main>'
  const invalidDocument =
    '<main id="root"><a id="retry-link" href="/demo">Retry</a><p id="invalid">Invalid document</p></main>'
  const session = new DocumentSession(
    parseExpoTurboDocument(initialDocument, { url: "https://example.test/demo" }),
  )
  const loader = new DocumentRequestLoader(
    session,
    {
      fetch: async () => ({
        headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
        redirected: false,
        status: 422,
        text: async () => invalidDocument,
        url: "https://example.test/invalid",
      }),
    },
    { next: () => "request-invalid" },
  )
  const visits = new DocumentVisitController(loader, realClock)
  const expoResult = await visits.visit("/invalid")
  const originalFetch = browser.fetch
  browser.fetch = async () =>
    new browser.Response(`<html><body>${invalidDocument}</body></html>`, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
      status: 422,
    })
  turbo.start()
  try {
    browser.document.body.innerHTML = initialDocument
    const link = browser.document.getElementById("invalid-link")
    if (!(link instanceof browser.HTMLAnchorElement)) {
      throw new Error("Browser error-document differential link is missing")
    }
    link.dispatchEvent(
      new browser.MouseEvent("click", {
        bubbles: true,
        button: 0,
        cancelable: true,
        composed: true,
      }),
    )
    await browser.happyDOM.waitUntilComplete()

    expect(expoResult.status).toBe("committed")
    expect(visits.state.status).toBe("failed")
    expect(normalizeProtocolNode(activeProtocolRoot(session))).toEqual(
      normalizeBrowserNode(browser.document.getElementById("root") as HappyElement),
    )
  } finally {
    browser.fetch = originalFetch
    turbo.session.stop()
  }
})

test("matches upstream Turbo for an authoritative 500 document response", async () => {
  const initialDocument =
    '<main id="root"><a id="error-link" href="/error">Error</a><p id="old">Old</p></main>'
  const errorDocument =
    '<main id="root"><a id="retry-link" href="/demo">Retry</a><p id="error">Server error</p></main>'
  const session = new DocumentSession(
    parseExpoTurboDocument(initialDocument, { url: "https://example.test/demo" }),
  )
  const loader = new DocumentRequestLoader(
    session,
    {
      fetch: async () => ({
        headers: { "Content-Type": EXPO_TURBO_MIME_TYPE },
        redirected: false,
        status: 500,
        text: async () => errorDocument,
        url: "https://example.test/error",
      }),
    },
    { next: () => "request-error" },
  )
  const visits = new DocumentVisitController(loader, realClock)
  const expoResult = await visits.visit("/error")
  const originalFetch = browser.fetch
  browser.fetch = async () =>
    new browser.Response(`<html><body>${errorDocument}</body></html>`, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
      status: 500,
    })
  turbo.start()
  try {
    browser.document.body.innerHTML = initialDocument
    const link = browser.document.getElementById("error-link")
    if (!(link instanceof browser.HTMLAnchorElement)) {
      throw new Error("Browser server-error differential link is missing")
    }
    link.dispatchEvent(
      new browser.MouseEvent("click", {
        bubbles: true,
        button: 0,
        cancelable: true,
        composed: true,
      }),
    )
    await browser.happyDOM.waitUntilComplete()

    expect(expoResult.status).toBe("committed")
    expect(visits.state.status).toBe("failed")
    expect(normalizeProtocolNode(activeProtocolRoot(session))).toEqual(
      normalizeBrowserNode(browser.document.getElementById("root") as HappyElement),
    )
  } finally {
    browser.fetch = originalFetch
    turbo.session.stop()
  }
})
