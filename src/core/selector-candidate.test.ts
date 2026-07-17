import { describe, expect, test } from "bun:test"
import { DOMParser, type Element, type Node } from "@xmldom/xmldom"
import { type Options, selectAll } from "css-select"

type SelectorAdapter = NonNullable<Options<Node, Element>["adapter"]>

function childNodes(node: Node): Node[] {
  const children: Node[] = []
  for (let index = 0; index < node.childNodes.length; index += 1) {
    const child = node.childNodes.item(index)
    if (child) children.push(child)
  }
  return children
}

const adapter: SelectorAdapter = {
  getAttributeValue(element, name) {
    return element.hasAttribute(name) ? (element.getAttribute(name) ?? undefined) : undefined
  },
  getChildren: childNodes,
  getName(element) {
    return element.tagName
  },
  getParent(node) {
    return node.parentNode
  },
  getSiblings(node) {
    return node.parentNode ? childNodes(node.parentNode) : [node]
  },
  getText(node) {
    return node.textContent ?? ""
  },
  hasAttrib(element, name) {
    return element.hasAttribute(name)
  },
  isTag(node): node is Element {
    return node.nodeType === 1
  },
  prevElementSibling(node) {
    let sibling = node.previousSibling
    while (sibling) {
      if (adapter.isTag(sibling)) return sibling
      sibling = sibling.previousSibling
    }
    return null
  },
  removeSubsets(nodes) {
    const unique = [...new Set(nodes)]
    const nodeSet = new Set<Node>(unique)
    return unique.filter((node) => {
      let ancestor = node.parentNode
      while (ancestor) {
        if (nodeSet.has(ancestor)) return false
        ancestor = ancestor.parentNode
      }
      return true
    })
  },
}

const options: Options<Node, Element> = {
  adapter,
  cacheResults: false,
  lowerCaseAttributeNames: false,
  lowerCaseTags: false,
  xmlMode: true,
}

function parseFixture() {
  return new DOMParser({
    onError(level, message) {
      throw new Error(`${level}: ${message}`)
    },
  }).parseFromString(
    `<Gallery>
      <DemoCard id="alpha" class="featured primary" data-state="ready">
        <DemoText data-kind="heading">Alpha</DemoText>
        <DemoButton data-action="open">Open</DemoButton>
      </DemoCard>
      <DemoCard id="beta" class="secondary">
        <DemoText data-kind="heading">Beta</DemoText>
      </DemoCard>
    </Gallery>`,
    "application/xml",
  )
}

function ids(selector: string, root: Node) {
  return selectAll(selector, root, options).map((element) => element.getAttribute("id"))
}

describe("css-select xmldom adapter candidate", () => {
  test("matches the required XML selector surface in document order", () => {
    const document = parseFixture()

    expect(ids("DemoCard", document)).toEqual(["alpha", "beta"])
    expect(ids("DemoCard.featured, DemoCard#beta", document)).toEqual(["alpha", "beta"])
    expect(ids('DemoCard[data-state="ready"]', document)).toEqual(["alpha"])
    expect(selectAll("DemoCard > DemoText:first-child", document, options)).toHaveLength(2)
    expect(selectAll("DemoText + DemoButton", document, options)).toHaveLength(1)
    expect(selectAll("DemoCard:nth-child(2)", document, options)).toHaveLength(1)
    expect(selectAll("democard", document, options)).toHaveLength(0)
  })

  test("queries the current mutable tree instead of a stale cached result", () => {
    const document = parseFixture()
    const beta = document.getElementById("beta")
    if (!beta) throw new Error("selector fixture lost beta")

    expect(ids(".featured", document)).toEqual(["alpha"])
    beta.setAttribute("class", "featured")
    expect(ids(".featured", document)).toEqual(["alpha", "beta"])
  })

  test("fails loudly for invalid and unsupported namespaced selectors", () => {
    const document = parseFixture()
    expect(() => selectAll("DemoCard[", document, options)).toThrow()
    expect(() => selectAll("demo|DemoCard", document, options)).toThrow(/namespace/i)
  })
})
