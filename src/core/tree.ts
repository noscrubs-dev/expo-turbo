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

export interface DocumentTreeOptions {
  readonly allowDuplicateIds?: boolean
}

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

function subtreeKeys(node: ProtocolNode): string[] {
  const keys: string[] = []
  walk(node, (child) => keys.push(child.key))
  return keys
}

export class DocumentTree {
  readonly document: ProtocolDocument
  private readonly allowDuplicateIds: boolean
  private readonly frames: ProtocolElement[] = []
  private readonly idIndex = new Map<string, ProtocolElement>()
  private readonly keyIndex = new Map<string, ProtocolNode>()
  private readonly nodes = new Set<ProtocolNode>()
  private readonly streamSources: ProtocolElement[] = []
  private mutationKey = 0

  constructor(document: ProtocolDocument, options: DocumentTreeOptions = {}) {
    this.document = document
    this.allowDuplicateIds = options.allowDuplicateIds ?? false
    this.rebuildIndexes()
  }

  private rebuildIndexes(): void {
    this.frames.length = 0
    this.idIndex.clear()
    this.keyIndex.clear()
    this.nodes.clear()
    this.streamSources.length = 0
    walk(this.document, (node) => {
      this.nodes.add(node)
      if (this.keyIndex.has(node.key) && !this.allowDuplicateIds) {
        throw new ParseError(`Duplicate internal key ${JSON.stringify(node.key)}`)
      }
      if (!this.keyIndex.has(node.key)) this.keyIndex.set(node.key, node)
      if (!isElement(node)) return

      const id = attributeValue(node, "id")
      if (id !== undefined && id.trim() === "") {
        throw new ParseError(
          "Element ids must not be blank",
          node.location ? { location: node.location } : {},
        )
      }
      const existing = id !== undefined ? this.idIndex.get(id) : undefined
      if (id !== undefined && existing && !this.allowDuplicateIds) {
        throw new ParseError(`Duplicate id ${JSON.stringify(id)}`, {
          target: id,
          ...(node.location ? { location: node.location } : {}),
        })
      }
      if (id !== undefined && !existing) this.idIndex.set(id, node)
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

  contains(node: ProtocolNode): boolean {
    return this.nodes.has(node)
  }

  insertClones(
    parent: ProtocolParentNode,
    index: number,
    sources: readonly ProtocolNode[],
  ): readonly string[] {
    this.assertActiveParent(parent)
    if (!Number.isInteger(index) || index < 0 || index > parent.children.length) {
      throw new TargetError("Insertion index is outside the active parent")
    }
    const clones = sources.map((source) => this.cloneNode(source, parent))
    this.replaceChildren(parent, [
      ...parent.children.slice(0, index),
      ...clones,
      ...parent.children.slice(index),
    ])
    return [parent.key, ...clones.flatMap(subtreeKeys)]
  }

  removeNode(node: ProtocolNode): readonly string[] {
    if (!this.nodes.has(node) || node.kind === "document" || !node.parent) {
      throw new TargetError("Node is outside the active document")
    }
    const parent = node.parent
    const index = parent.children.indexOf(node)
    if (index === -1) throw new TargetError("Node is detached from its indexed parent")
    const removedKeys = subtreeKeys(node)
    this.replaceChildren(parent, [
      ...parent.children.slice(0, index),
      ...parent.children.slice(index + 1),
    ])
    node.parent = null
    return [parent.key, ...removedKeys]
  }

  replaceChildrenWithClones(
    parent: ProtocolParentNode,
    sources: readonly ProtocolNode[],
  ): readonly string[] {
    this.assertActiveParent(parent)
    const previous = [...parent.children]
    const removed = previous.flatMap(subtreeKeys)
    const clones = sources.map((source) => this.cloneNode(source, parent))
    this.replaceChildren(parent, clones)
    for (const child of previous) child.parent = null
    return [parent.key, ...removed, ...clones.flatMap(subtreeKeys)]
  }

  replaceNodeWithClones(node: ProtocolNode, sources: readonly ProtocolNode[]): readonly string[] {
    if (!this.nodes.has(node) || node.kind === "document" || !node.parent) {
      throw new TargetError("Node is outside the active document")
    }
    const parent = node.parent
    const index = parent.children.indexOf(node)
    if (index === -1) throw new TargetError("Node is detached from its indexed parent")
    const removed = subtreeKeys(node)
    const clones = sources.map((source) => this.cloneNode(source, parent))
    this.replaceChildren(parent, [
      ...parent.children.slice(0, index),
      ...clones,
      ...parent.children.slice(index + 1),
    ])
    node.parent = null
    return [parent.key, ...removed, ...clones.flatMap(subtreeKeys)]
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

  private assertActiveParent(parent: ProtocolParentNode): void {
    if (!this.nodes.has(parent)) throw new TargetError("Parent is outside the active document")
  }

  private cloneNode(source: ProtocolNode, parent: ProtocolParentNode): ProtocolNode {
    const nextKey = () => `mutation:${this.mutationKey++}`
    if (source.kind === "text") {
      return {
        cdata: source.cdata,
        key: nextKey(),
        kind: "text",
        parent,
        value: source.value,
        ...(source.location ? { location: source.location } : {}),
      }
    }
    if (source.kind === "comment") {
      return {
        key: nextKey(),
        kind: "comment",
        parent,
        value: source.value,
        ...(source.location ? { location: source.location } : {}),
      }
    }
    if (source.kind === "document") {
      throw new TargetError("A document cannot be cloned into another document")
    }

    const id = attributeValue(source, "id")
    const clone: ProtocolElement = {
      attributes: source.attributes.map((attribute) => ({ ...attribute })),
      children: [],
      key: id ? `id:${id}` : nextKey(),
      kind: source.kind,
      localName: source.localName,
      namespaceUri: source.namespaceUri,
      parent,
      prefix: source.prefix,
      tagName: source.tagName,
      ...(source.location ? { location: source.location } : {}),
    }
    clone.children = source.children.map((child) => this.cloneNode(child, clone))
    return clone
  }

  private replaceChildren(parent: ProtocolParentNode, children: ProtocolNode[]): void {
    const previous = parent.children
    parent.children = children
    for (const child of children) child.parent = parent
    try {
      this.rebuildIndexes()
    } catch (error) {
      parent.children = previous
      for (const child of previous) child.parent = parent
      this.rebuildIndexes()
      throw error
    }
  }
}
