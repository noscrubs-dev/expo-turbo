import { afterAll, beforeAll, expect, test } from "bun:test"
import { type Element as HappyElement, type Node as HappyNode, Window } from "happy-dom"

import {
  DocumentSession,
  dispatchTurboStreamFragment,
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
    Element: browser.Element,
    Event: browser.Event,
    EventTarget: browser.EventTarget,
    FormData: browser.FormData,
    HTMLAnchorElement: browser.HTMLAnchorElement,
    HTMLButtonElement: browser.HTMLButtonElement,
    HTMLElement: browser.HTMLElement,
    HTMLFormElement: browser.HTMLFormElement,
    HTMLIFrameElement: browser.HTMLIFrameElement,
    HTMLInputElement: browser.HTMLInputElement,
    HTMLTemplateElement: browser.HTMLTemplateElement,
    IntersectionObserver: browser.IntersectionObserver,
    MutationObserver: browser.MutationObserver,
    Node: browser.Node,
    NodeFilter: browser.NodeFilter,
    Request: browser.Request,
    Response: browser.Response,
    ShadowRoot: browser.ShadowRoot,
    URL: browser.URL,
    URLSearchParams: browser.URLSearchParams,
    Window: browser.Window,
    cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
    customElements: browser.customElements,
    document: browser.document,
    history: browser.history,
    location: browser.location,
    navigator: browser.navigator,
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
