import { afterAll, beforeAll, expect, test } from "bun:test"
import { type Element as HappyElement, type Node as HappyNode, Window } from "happy-dom"
import type { ClockAdapter, TurboRequest } from "../adapters"
import {
  applyFrameResponse,
  buildFormRequest,
  DocumentHistory,
  DocumentRequestLoader,
  DocumentSession,
  DocumentVisitController,
  dispatchTurboStreamFragment,
  EXPO_TURBO_MIME_TYPE,
  isElement,
  type ProtocolElement,
  type ProtocolNode,
  parseExpoTurboDocument,
} from "."

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

test("matches upstream Turbo advance, replace, and back restoration history", async () => {
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
  const visits = new DocumentVisitController(loader, realClock, { history })
  await visits.visit("/next", { action: "advance" })
  await visits.visit("/final", { action: "replace" })

  const originalFetch = browser.fetch
  ;(turbo.session as typeof turbo.session & { clearCache(): void }).clearCache()
  browser.history.replaceState({}, "", "/demo")
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
  } finally {
    browser.fetch = originalFetch
    turbo.session.stop()
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
