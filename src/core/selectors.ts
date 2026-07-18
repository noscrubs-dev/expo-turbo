import { type Options, selectAll } from "css-select"

import { TargetError } from "./errors"
import {
  attributeValue,
  type DocumentTree,
  isElement,
  nodeTextContent,
  type ProtocolElement,
  type ProtocolNode,
} from "./tree"

type SelectorAdapter = NonNullable<Options<ProtocolNode, ProtocolElement>["adapter"]>

function children(node: ProtocolNode): ProtocolNode[] {
  return node.kind === "document" || isElement(node) ? [...node.children] : []
}

const adapter: SelectorAdapter = {
  getAttributeValue(element, name) {
    return attributeValue(element, name)
  },
  getChildren: children,
  getName(element) {
    return element.tagName
  },
  getParent(node) {
    return node.parent
  },
  getSiblings(node) {
    return node.parent ? [...node.parent.children] : [node]
  },
  getText: nodeTextContent,
  hasAttrib(element, name) {
    return attributeValue(element, name) !== undefined
  },
  isTag: isElement,
  prevElementSibling(node) {
    if (!node.parent) return null
    const siblings = node.parent.children
    for (let index = siblings.indexOf(node) - 1; index >= 0; index -= 1) {
      const sibling = siblings[index]
      if (sibling && isElement(sibling)) return sibling
    }
    return null
  },
  removeSubsets(nodes) {
    const unique = [...new Set(nodes)]
    const set = new Set<ProtocolNode>(unique)
    return unique.filter((node) => {
      let ancestor = node.parent
      while (ancestor) {
        if (set.has(ancestor)) return false
        ancestor = ancestor.parent
      }
      return true
    })
  },
}

const options: Options<ProtocolNode, ProtocolElement> = {
  adapter,
  cacheResults: false,
  lowerCaseAttributeNames: false,
  lowerCaseTags: false,
  xmlMode: true,
}

export function querySelectorAll(tree: DocumentTree, selector: string): readonly ProtocolElement[] {
  try {
    return selectAll(selector, [...tree.document.children], options)
  } catch (cause) {
    throw new TargetError(
      `Invalid or unsupported selector ${JSON.stringify(selector)}`,
      {
        target: selector,
      },
      { cause },
    )
  }
}
