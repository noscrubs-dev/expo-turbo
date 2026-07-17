import { ParseError, TargetError } from "./errors"

export interface SourceLocation {
  readonly column: number
  readonly line: number
}

interface ProtocolNodeBase {
  readonly key: string
  readonly location?: SourceLocation
  parent: ProtocolParentNode | null
}

export interface ProtocolDocument extends ProtocolNodeBase {
  children: ProtocolNode[]
  readonly kind: "document"
  readonly url?: string
}

export interface ProtocolAttribute {
  readonly localName: string
  readonly name: string
  readonly namespaceUri: string | null
  readonly prefix: string | null
  readonly value: string
}

export type ProtocolElementKind = "element" | "frame" | "stream" | "stream-source" | "template"

export interface ProtocolElement extends ProtocolNodeBase {
  readonly attributes: readonly ProtocolAttribute[]
  children: ProtocolNode[]
  readonly kind: ProtocolElementKind
  readonly localName: string
  readonly namespaceUri: string | null
  readonly prefix: string | null
  readonly tagName: string
}

export interface ProtocolText extends ProtocolNodeBase {
  readonly cdata: boolean
  readonly kind: "text"
  readonly value: string
}

export interface ProtocolComment extends ProtocolNodeBase {
  readonly kind: "comment"
  readonly value: string
}

export type ProtocolNode = ProtocolComment | ProtocolDocument | ProtocolElement | ProtocolText
export type ProtocolParentNode = ProtocolDocument | ProtocolElement

export function isElement(node: ProtocolNode): node is ProtocolElement {
  return !["comment", "document", "text"].includes(node.kind)
}

export function attributeValue(element: ProtocolElement, name: string): string | undefined {
  return element.attributes.find((attribute) => attribute.name === name)?.value
}

export function nodeTextContent(node: ProtocolNode): string {
  if (node.kind === "text") return node.value
  if (node.kind === "comment") return ""
  return node.children.map(nodeTextContent).join("")
}

function walk(node: ProtocolNode, visit: (node: ProtocolNode) => void): void {
  visit(node)
  if (node.kind === "document" || isElement(node)) {
    for (const child of node.children) walk(child, visit)
  }
}

export class DocumentTree {
  readonly document: ProtocolDocument
  private readonly frames: ProtocolElement[] = []
  private readonly idIndex = new Map<string, ProtocolElement>()
  private readonly keyIndex = new Map<string, ProtocolNode>()
  private readonly nodes = new Set<ProtocolNode>()
  private readonly streamSources: ProtocolElement[] = []

  constructor(document: ProtocolDocument) {
    this.document = document
    walk(document, (node) => {
      this.nodes.add(node)
      if (this.keyIndex.has(node.key)) {
        throw new ParseError(`Duplicate internal key ${JSON.stringify(node.key)}`)
      }
      this.keyIndex.set(node.key, node)
      if (!isElement(node)) return

      const id = attributeValue(node, "id")
      if (id !== undefined && id.trim() === "") {
        throw new ParseError(
          "Element ids must not be blank",
          node.location ? { location: node.location } : {},
        )
      }
      const existing = id !== undefined ? this.idIndex.get(id) : undefined
      if (id !== undefined && existing) {
        throw new ParseError(`Duplicate id ${JSON.stringify(id)}`, {
          target: id,
          ...(node.location ? { location: node.location } : {}),
        })
      }
      if (id !== undefined) this.idIndex.set(id, node)
      if (node.kind === "frame") this.frames.push(node)
      if (node.kind === "stream-source") this.streamSources.push(node)
    })
  }

  getElementById(id: string): ProtocolElement | undefined {
    return this.idIndex.get(id)
  }

  getFrames(): readonly ProtocolElement[] {
    return this.frames
  }

  getNodeByKey(key: string): ProtocolNode | undefined {
    return this.keyIndex.get(key)
  }

  getStreamSources(): readonly ProtocolElement[] {
    return this.streamSources
  }

  setAttribute(element: ProtocolElement, name: string, value: string): void {
    if (!this.nodes.has(element)) throw new TargetError("Element is outside the active document")
    if (name === "xmlns" || name.includes(":")) {
      throw new TargetError("Namespaced attributes require a declared codec")
    }
    if (name === "id" && value.trim() === "") throw new TargetError("Element ids must not be blank")

    const current = attributeValue(element, name)
    if (name === "id" && current !== value) {
      throw new TargetError("Element ids cannot change without replacing the element", {
        ...(current ? { target: current } : {}),
      })
    }
    const attributes = element.attributes as ProtocolAttribute[]
    const index = attributes.findIndex((attribute) => attribute.name === name)
    const attribute: ProtocolAttribute = {
      localName: name,
      name,
      namespaceUri: null,
      prefix: null,
      value,
    }
    if (index === -1) attributes.push(attribute)
    else attributes[index] = attribute

    if (name === "id") {
      if (current !== undefined) this.idIndex.delete(current)
      this.idIndex.set(value, element)
    }
  }
}
