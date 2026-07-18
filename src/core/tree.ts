import { ParseError, TargetError } from "./errors"
import { assertDocumentTreeMutationAllowed } from "./tree-mutation-guard"

export interface SourceLocation {
  readonly column: number
  readonly line: number
}

interface ProtocolNodeBase {
  readonly key: string
  readonly location?: SourceLocation
  readonly parent: ProtocolParentNode | null
}

export interface ProtocolDocument extends ProtocolNodeBase {
  readonly children: readonly ProtocolNode[]
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
  readonly children: readonly ProtocolNode[]
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

const protectedProtocolNodes = new WeakSet<ProtocolNode>()
const protocolNodeParents = new WeakMap<ProtocolNode, ProtocolParentNode | null>()
const protocolNodeChildren = new WeakMap<ProtocolParentNode, readonly ProtocolNode[]>()
const protocolElementAttributes = new WeakMap<ProtocolElement, readonly ProtocolAttribute[]>()
const protocolDocumentUrls = new WeakMap<ProtocolDocument, string | undefined>()

function freezeAttributes(attributes: readonly ProtocolAttribute[]): readonly ProtocolAttribute[] {
  return Object.freeze(
    attributes.map((attribute) =>
      Object.isFrozen(attribute) ? attribute : Object.freeze(attribute),
    ),
  )
}

function protectProtocolNode(node: ProtocolNode): void {
  if (protectedProtocolNodes.has(node)) return
  protocolNodeParents.set(node, node.parent)
  Object.defineProperty(node, "parent", {
    configurable: false,
    enumerable: true,
    get: () => protocolNodeParents.get(node) ?? null,
  })
  if (node.kind === "document" || isElement(node)) {
    protocolNodeChildren.set(node, Object.freeze([...node.children]))
    Object.defineProperty(node, "children", {
      configurable: false,
      enumerable: true,
      get: () => protocolNodeChildren.get(node) ?? Object.freeze([]),
    })
  }
  if (isElement(node)) {
    protocolElementAttributes.set(node, freezeAttributes(node.attributes))
    Object.defineProperty(node, "attributes", {
      configurable: false,
      enumerable: true,
      get: () => protocolElementAttributes.get(node) ?? Object.freeze([]),
    })
  }
  if (node.kind === "document") {
    protocolDocumentUrls.set(node, node.url)
    Object.defineProperty(node, "url", {
      configurable: false,
      enumerable: true,
      get: () => protocolDocumentUrls.get(node),
    })
  }
  if (node.location) Object.freeze(node.location)
  protectedProtocolNodes.add(node)
  Object.freeze(node)
}

function setProtocolNodeParent(node: ProtocolNode, parent: ProtocolParentNode | null): void {
  if (protectedProtocolNodes.has(node)) protocolNodeParents.set(node, parent)
  else (node as { parent: ProtocolParentNode | null }).parent = parent
}

function setProtocolNodeChildren(
  node: ProtocolParentNode,
  children: readonly ProtocolNode[],
): void {
  const frozen = Object.freeze([...children])
  if (protectedProtocolNodes.has(node)) protocolNodeChildren.set(node, frozen)
  else (node as { children: readonly ProtocolNode[] }).children = frozen
}

function setProtocolElementAttributes(
  element: ProtocolElement,
  attributes: readonly ProtocolAttribute[],
): void {
  const frozen = freezeAttributes(attributes)
  if (protectedProtocolNodes.has(element)) protocolElementAttributes.set(element, frozen)
  else (element as { attributes: readonly ProtocolAttribute[] }).attributes = frozen
}

function setProtocolDocumentUrl(document: ProtocolDocument, url: string): void {
  if (protectedProtocolNodes.has(document)) protocolDocumentUrls.set(document, url)
  else (document as { url?: string }).url = url
}

export interface DocumentTreeOptions {
  readonly allowDuplicateIds?: boolean
}

export interface DocumentTreeCloneOptions {
  /** Retarget the cloned document location without mutating the source tree. */
  readonly documentUrl?: string
  /** Omit each element subtree marked by `data-turbo-temporary` presence. */
  readonly omitTemporaryElements?: boolean
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

function rendersTextBoundary(node: ProtocolNode): boolean {
  if (node.kind === "comment") return false
  if (node.kind !== "text") return true
  return node.cdata || /[^\t\n\r ]/.test(node.value)
}

export function renderedTextValue(node: ProtocolText): string {
  if (node.cdata) return node.value
  let ancestor = node.parent
  while (ancestor && ancestor.kind !== "document") {
    const xmlSpace = attributeValue(ancestor, "xml:space")
    if (xmlSpace === "preserve") return node.value
    if (xmlSpace === "default") break
    ancestor = ancestor.parent
  }
  if (!/[^\t\n\r ]/.test(node.value)) return ""

  let value = node.value.replace(/[\t\n\r ]+/g, " ")
  const siblings = node.parent?.children ?? []
  const index = siblings.indexOf(node)
  if (!siblings.slice(0, index).some(rendersTextBoundary)) value = value.replace(/^ +/, "")
  if (!siblings.slice(index + 1).some(rendersTextBoundary)) value = value.replace(/ +$/, "")
  return value
}

export function renderedNodeTextContent(node: ProtocolNode): string {
  if (node.kind === "text") return renderedTextValue(node)
  if (node.kind === "comment") return ""
  return node.children.map(renderedNodeTextContent).join("")
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
    Object.defineProperty(this, "document", {
      configurable: false,
      enumerable: true,
      value: document,
      writable: false,
    })
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
      protectProtocolNode(node)
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
    return Object.freeze([...this.frames])
  }

  getNodeByKey(key: string): ProtocolNode | undefined {
    return this.keyIndex.get(key)
  }

  getStreamSources(): readonly ProtocolElement[] {
    return Object.freeze([...this.streamSources])
  }

  contains(node: ProtocolNode): boolean {
    return this.nodes.has(node)
  }

  clone(options: DocumentTreeCloneOptions = {}): DocumentTree {
    if (!options || typeof options !== "object" || Array.isArray(options)) {
      throw new TargetError("Document tree clone options must be an object")
    }
    if (
      options.omitTemporaryElements !== undefined &&
      typeof options.omitTemporaryElements !== "boolean"
    ) {
      throw new TargetError("Document tree temporary-element policy must be boolean")
    }
    if (
      options.documentUrl !== undefined &&
      (typeof options.documentUrl !== "string" || options.documentUrl.trim() === "")
    ) {
      throw new TargetError("Document tree clone URL must be a nonblank string")
    }

    const document: ProtocolDocument = {
      children: [],
      key: this.document.key,
      kind: "document",
      parent: null,
      ...(this.document.location ? { location: { ...this.document.location } } : {}),
      ...(options.documentUrl !== undefined
        ? { url: options.documentUrl }
        : this.document.url !== undefined
          ? { url: this.document.url }
          : {}),
    }
    setProtocolNodeChildren(
      document,
      this.document.children.flatMap((child) => {
        const clone = this.cloneDocumentNode(child, document, options)
        return clone ? [clone] : []
      }),
    )

    const clone = new DocumentTree(document, { allowDuplicateIds: this.allowDuplicateIds })
    clone.mutationKey = this.mutationKey
    return clone
  }

  insertClones(
    parent: ProtocolParentNode,
    index: number,
    sources: readonly ProtocolNode[],
  ): readonly string[] {
    assertDocumentTreeMutationAllowed(this)
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
    assertDocumentTreeMutationAllowed(this)
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
    setProtocolNodeParent(node, null)
    return [parent.key, ...removedKeys]
  }

  replaceChildrenWithClones(
    parent: ProtocolParentNode,
    sources: readonly ProtocolNode[],
  ): readonly string[] {
    assertDocumentTreeMutationAllowed(this)
    this.assertActiveParent(parent)
    const previous = [...parent.children]
    const removed = previous.flatMap(subtreeKeys)
    const clones = sources.map((source) => this.cloneNode(source, parent))
    this.replaceChildren(parent, clones)
    for (const child of previous) setProtocolNodeParent(child, null)
    return [parent.key, ...removed, ...clones.flatMap(subtreeKeys)]
  }

  replaceNodeWithClones(node: ProtocolNode, sources: readonly ProtocolNode[]): readonly string[] {
    assertDocumentTreeMutationAllowed(this)
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
    setProtocolNodeParent(node, null)
    return [parent.key, ...removed, ...clones.flatMap(subtreeKeys)]
  }

  setAttribute(element: ProtocolElement, name: string, value: string): void {
    assertDocumentTreeMutationAllowed(this)
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
    const attributes = [...element.attributes]
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
    setProtocolElementAttributes(element, attributes)

    if (name === "id") {
      if (current !== undefined) this.idIndex.delete(current)
      this.idIndex.set(value, element)
    }
  }

  removeAttribute(element: ProtocolElement, name: string): void {
    assertDocumentTreeMutationAllowed(this)
    if (!this.nodes.has(element)) throw new TargetError("Element is outside the active document")
    if (name === "id")
      throw new TargetError("Element ids cannot be removed without replacing the element")
    if (name === "xmlns" || name.includes(":")) {
      throw new TargetError("Namespaced attributes require a declared codec")
    }

    const attributes = [...element.attributes]
    const index = attributes.findIndex((attribute) => attribute.name === name)
    if (index !== -1) {
      attributes.splice(index, 1)
      setProtocolElementAttributes(element, attributes)
    }
  }

  retargetDocumentUrl(url: string): void {
    assertDocumentTreeMutationAllowed(this)
    if (typeof url !== "string" || url.trim() === "") {
      throw new TargetError("Document URL must be a nonblank string")
    }
    setProtocolDocumentUrl(this.document, url)
  }

  private assertActiveParent(parent: ProtocolParentNode): void {
    if (!this.nodes.has(parent)) throw new TargetError("Parent is outside the active document")
  }

  private cloneDocumentNode(
    source: ProtocolNode,
    parent: ProtocolParentNode,
    options: DocumentTreeCloneOptions,
  ): ProtocolNode | undefined {
    if (
      options.omitTemporaryElements &&
      isElement(source) &&
      attributeValue(source, "data-turbo-temporary") !== undefined
    ) {
      return undefined
    }
    if (source.kind === "text") {
      return {
        cdata: source.cdata,
        key: source.key,
        kind: "text",
        parent,
        value: source.value,
        ...(source.location ? { location: { ...source.location } } : {}),
      }
    }
    if (source.kind === "comment") {
      return {
        key: source.key,
        kind: "comment",
        parent,
        value: source.value,
        ...(source.location ? { location: { ...source.location } } : {}),
      }
    }
    if (source.kind === "document") {
      throw new TargetError("A document cannot be nested inside another document")
    }

    const clone: ProtocolElement = {
      attributes: source.attributes.map((attribute) => ({ ...attribute })),
      children: [],
      key: source.key,
      kind: source.kind,
      localName: source.localName,
      namespaceUri: source.namespaceUri,
      parent,
      prefix: source.prefix,
      tagName: source.tagName,
      ...(source.location ? { location: { ...source.location } } : {}),
    }
    setProtocolNodeChildren(
      clone,
      source.children.flatMap((child) => {
        const childClone = this.cloneDocumentNode(child, clone, options)
        return childClone ? [childClone] : []
      }),
    )
    return clone
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
    setProtocolNodeChildren(
      clone,
      source.children.map((child) => this.cloneNode(child, clone)),
    )
    return clone
  }

  private replaceChildren(parent: ProtocolParentNode, children: ProtocolNode[]): void {
    const previous = parent.children
    setProtocolNodeChildren(parent, children)
    for (const child of children) setProtocolNodeParent(child, parent)
    try {
      this.rebuildIndexes()
    } catch (error) {
      setProtocolNodeChildren(parent, previous)
      for (const child of previous) setProtocolNodeParent(child, parent)
      this.rebuildIndexes()
      throw error
    }
  }
}
