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
  /** Omit `data-turbo-temporary` or exact legacy `data-turbo-cache="false"` subtrees. */
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

function isWithin(node: ProtocolNode, root: ProtocolNode): boolean {
  let current: ProtocolNode | null = node
  while (current) {
    if (current === root) return true
    current = current.parent
  }
  return false
}

function hasTurboPermanent(node: ProtocolNode): boolean {
  let permanent = false
  walk(node, (child) => {
    if (isElement(child) && attributeValue(child, "data-turbo-permanent") !== undefined) {
      permanent = true
    }
  })
  return permanent
}

function hasPermanentAncestor(node: ProtocolNode): boolean {
  let current: ProtocolNode | null = node
  while (current) {
    if (isElement(current) && attributeValue(current, "data-turbo-permanent") !== undefined) {
      return true
    }
    current = current.parent
  }
  return false
}

function isTurboPermanent(node: ProtocolNode): boolean {
  return isElement(node) && attributeValue(node, "data-turbo-permanent") !== undefined
}

function isCompatibleMorphElement(current: ProtocolElement, source: ProtocolElement): boolean {
  const currentId = attributeValue(current, "id")
  return (
    current.kind === "element" &&
    source.kind === "element" &&
    currentId !== undefined &&
    currentId === attributeValue(source, "id") &&
    current.tagName === source.tagName &&
    current.localName === source.localName &&
    current.namespaceUri === source.namespaceUri &&
    current.prefix === source.prefix
  )
}

function isCompatibleDocumentMorphRoot(current: ProtocolElement, source: ProtocolElement): boolean {
  const currentId = attributeValue(current, "id")
  return (
    current.kind === "element" &&
    source.kind === "element" &&
    currentId === attributeValue(source, "id") &&
    current.tagName === source.tagName &&
    current.localName === source.localName &&
    current.namespaceUri === source.namespaceUri &&
    current.prefix === source.prefix
  )
}

interface MorphClonePlan {
  readonly source: ProtocolNode
  readonly type: "clone"
}

interface MorphReusePlan {
  readonly children: readonly MorphPlan[]
  readonly current: ProtocolElement
  readonly source: ProtocolElement
  readonly type: "reuse"
}

interface MorphPermanentPlan {
  readonly current: ProtocolElement
  readonly type: "permanent"
}

type MorphPlan = MorphClonePlan | MorphPermanentPlan | MorphReusePlan

interface MorphTransaction {
  readonly attributes: Map<ProtocolElement, readonly ProtocolAttribute[]>
  readonly children: Map<ProtocolParentNode, readonly ProtocolNode[]>
  readonly parents: Map<ProtocolNode, ProtocolParentNode | null>
}

type StreamChildMorpher = (
  parent: ProtocolElement,
  sources: readonly ProtocolNode[],
) => readonly string[]

type FrameRefreshMorpher = (
  frame: ProtocolElement,
  responseFrame: ProtocolElement,
) => readonly string[]

type DocumentRefreshMorpher = (source: DocumentTree) => readonly string[]

const streamChildMorphers = new WeakMap<DocumentTree, StreamChildMorpher>()
const streamOuterMorphers = new WeakMap<DocumentTree, StreamChildMorpher>()
const frameRefreshMorphers = new WeakMap<DocumentTree, FrameRefreshMorpher>()
const documentRefreshMorphers = new WeakMap<DocumentTree, DocumentRefreshMorpher>()

/** @internal Stream dispatcher entrypoint; not re-exported from `expo-turbo/core`. */
export function morphStreamUpdateChildren(
  tree: DocumentTree,
  parent: ProtocolElement,
  sources: readonly ProtocolNode[],
): readonly string[] {
  const morph = streamChildMorphers.get(tree)
  if (!morph) throw new TargetError("Native Stream child morph requires an active document tree")
  return morph(parent, sources)
}

/** @internal Stream dispatcher entrypoint; not re-exported from `expo-turbo/core`. */
export function morphStreamReplaceElement(
  tree: DocumentTree,
  target: ProtocolElement,
  sources: readonly ProtocolNode[],
): readonly string[] {
  const morph = streamOuterMorphers.get(tree)
  if (!morph) throw new TargetError("Native Stream outer morph requires an active document tree")
  return morph(target, sources)
}

/** @internal Frame response entrypoint; not re-exported from `expo-turbo/core`. */
export function morphFrameRefreshChildren(
  tree: DocumentTree,
  frame: ProtocolElement,
  responseFrame: ProtocolElement,
): readonly string[] {
  const morph = frameRefreshMorphers.get(tree)
  if (!morph) throw new TargetError("Native Frame refresh morph requires an active document tree")
  return morph(frame, responseFrame)
}

/** @internal Current-document refresh entrypoint; not re-exported from `expo-turbo/core`. */
export function morphCurrentDocumentRoot(
  tree: DocumentTree,
  source: DocumentTree,
): readonly string[] {
  const morph = documentRefreshMorphers.get(tree)
  if (!morph)
    throw new TargetError("Native document refresh morph requires an active document tree")
  return morph(source)
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
    streamChildMorphers.set(this, (parent, sources) =>
      this.morphStreamUpdateChildren(parent, sources),
    )
    streamOuterMorphers.set(this, (target, sources) =>
      this.morphStreamReplaceElement(target, sources),
    )
    frameRefreshMorphers.set(this, (frame, responseFrame) =>
      this.morphFrameRefreshChildren(frame, responseFrame),
    )
    documentRefreshMorphers.set(this, (source) => this.morphCurrentDocumentRoot(source))
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

  /**
   * Reconciles children for the narrow native Stream `update method="morph"` contract.
   * Only same-parent, same-ID ordinary application elements retain their node identity.
   */
  private morphStreamUpdateChildren(
    parent: ProtocolElement,
    sources: readonly ProtocolNode[],
  ): readonly string[] {
    assertDocumentTreeMutationAllowed(this)
    this.assertActiveParent(parent)
    const target = attributeValue(parent, "id")
    if (parent.kind !== "element") {
      throw new TargetError("Native Stream child morph requires an application-element target", {
        ...(target ? { target } : {}),
      })
    }
    if (hasPermanentAncestor(parent)) {
      throw new TargetError("Native Stream child morph cannot run inside data-turbo-permanent", {
        ...(target ? { target } : {}),
      })
    }

    this.assertMorphSources(parent, sources)
    const plans = this.buildMorphPlans(parent, sources)
    return this.commitMorphPlans(parent, plans)
  }

  /**
   * Reconciles one exact Stream `replace method="morph"` application-element root.
   * The target retains identity only when its replacement root has the same exact shape.
   */
  private morphStreamReplaceElement(
    target: ProtocolElement,
    sources: readonly ProtocolNode[],
  ): readonly string[] {
    assertDocumentTreeMutationAllowed(this)
    this.assertActiveParent(target)
    const targetId = attributeValue(target, "id")
    const source = sources.length === 1 ? sources[0] : undefined
    if (
      target.kind !== "element" ||
      !targetId ||
      !source ||
      !isElement(source) ||
      source.kind !== "element" ||
      !isCompatibleMorphElement(target, source)
    ) {
      throw new TargetError(
        "Native Stream outer morph requires one compatible application-element root",
        { ...(targetId ? { target: targetId } : {}) },
      )
    }
    if (hasPermanentAncestor(target) || isTurboPermanent(source)) {
      throw new TargetError("Native Stream outer morph cannot run inside data-turbo-permanent", {
        target: targetId,
      })
    }

    this.assertMorphSources(target, source.children)
    return this.commitMorphPlans(target, this.buildMorphPlans(target, source.children), source)
  }

  /**
   * Reconciles children for the narrow native Frame `reload()` + `refresh="morph"` contract.
   * The mounted Frame wrapper always retains its identity and attributes.
   */
  private morphFrameRefreshChildren(
    frame: ProtocolElement,
    responseFrame: ProtocolElement,
  ): readonly string[] {
    assertDocumentTreeMutationAllowed(this)
    this.assertActiveParent(frame)
    const frameId = attributeValue(frame, "id")
    if (frame.kind !== "frame" || !frameId) {
      throw new TargetError("Native Frame refresh morph requires an active Frame target", {
        ...(frameId ? { target: frameId } : {}),
      })
    }
    if (hasPermanentAncestor(frame) || hasPermanentAncestor(responseFrame)) {
      throw new TargetError("Native Frame refresh morph cannot run inside data-turbo-permanent", {
        target: frameId,
      })
    }

    this.assertMorphSources(frame, responseFrame.children)
    return this.commitMorphPlans(frame, this.buildMorphPlans(frame, responseFrame.children))
  }

  /**
   * Reconciles the one ordinary application root admitted by a bounded native
   * current-document refresh morph. Protocol wrappers are deliberately excluded
   * because their browser refresh semantics need separate lifecycle contracts.
   */
  private morphCurrentDocumentRoot(sourceTree: DocumentTree): readonly string[] {
    assertDocumentTreeMutationAllowed(this)
    const sourceUrl = sourceTree.document.url
    if (sourceUrl !== undefined && (typeof sourceUrl !== "string" || sourceUrl.trim() === "")) {
      throw new TargetError("Document URL must be a nonblank string")
    }
    const currentRoot = this.documentMorphRoot(this.document)
    const sourceRoot = this.documentMorphRoot(sourceTree.document)
    if (
      !currentRoot ||
      !sourceRoot ||
      !isCompatibleDocumentMorphRoot(currentRoot, sourceRoot) ||
      isTurboPermanent(currentRoot) ||
      isTurboPermanent(sourceRoot)
    ) {
      throw new TargetError(
        "Native document refresh morph requires one compatible nonpermanent application root",
      )
    }
    this.assertDocumentMorphApplicationSubtree(currentRoot)
    this.assertDocumentMorphApplicationSubtree(sourceRoot)

    this.assertMorphSources(currentRoot, sourceRoot.children)
    const changed = [
      ...this.commitMorphPlans(
        currentRoot,
        this.buildMorphPlans(currentRoot, sourceRoot.children),
        sourceRoot,
      ),
    ]
    if (sourceUrl !== undefined && this.document.url !== sourceUrl) {
      this.retargetDocumentUrl(sourceUrl)
      changed.push(this.document.key)
    }
    return changed
  }

  private documentMorphRoot(document: ProtocolDocument): ProtocolElement | undefined {
    let root: ProtocolElement | undefined
    for (const child of document.children) {
      if (isElement(child) && child.kind === "element") {
        if (root) return undefined
        root = child
        continue
      }
      if (child.kind === "comment") continue
      if (child.kind === "text" && !child.cdata && !/[^\t\n\r ]/.test(child.value)) continue
      return undefined
    }
    return root
  }

  private assertDocumentMorphApplicationSubtree(root: ProtocolElement): void {
    let protocolNode: ProtocolElement | undefined
    walk(root, (node) => {
      if (!protocolNode && isElement(node) && node.kind !== "element") protocolNode = node
    })
    if (!protocolNode) return
    const target = attributeValue(protocolNode, "id")
    throw new TargetError("Native document refresh morph does not support protocol descendants", {
      ...(target ? { target } : {}),
    })
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

  private assertMorphSources(parent: ProtocolElement, sources: readonly ProtocolNode[]): void {
    const ids = new Set<string>()
    const visit = (source: ProtocolNode): void => {
      if (source.kind === "document") {
        throw new TargetError("A document cannot be used as a native morph child")
      }
      if (!isElement(source)) return
      const id = attributeValue(source, "id")
      if (id !== undefined) {
        if (!id.trim()) throw new TargetError("Element ids must not be blank")
        if (ids.has(id)) {
          throw new TargetError(
            `Native morph payload id ${JSON.stringify(id)} is declared more than once`,
            {
              target: id,
            },
          )
        }
        ids.add(id)
        const active = this.idIndex.get(id)
        if (active && (active === parent || !isWithin(active, parent))) {
          throw new TargetError(
            `Native morph payload id ${JSON.stringify(id)} is outside the target subtree`,
            { target: id },
          )
        }
      }
      for (const child of source.children) visit(child)
    }
    for (const source of sources) visit(source)
  }

  private buildMorphPlans(
    parent: ProtocolElement,
    sources: readonly ProtocolNode[],
  ): readonly MorphPlan[] {
    const currentById = new Map<string, ProtocolElement>()
    for (const child of parent.children) {
      if (!isElement(child)) continue
      const id = attributeValue(child, "id")
      if (id !== undefined) currentById.set(id, child)
    }
    this.assertMatchedPermanentChildren(parent, sources, currentById)

    return sources.map((source) => {
      const id = isElement(source) ? attributeValue(source, "id") : undefined
      const active = id === undefined ? undefined : this.idIndex.get(id)
      const current = id === undefined ? undefined : currentById.get(id)
      if (active && active !== current) {
        throw new TargetError(`Native morph cannot reparent id ${JSON.stringify(id)}`, {
          ...(id ? { target: id } : {}),
        })
      }
      if (isElement(source) && source.kind === "element" && current) {
        if (isTurboPermanent(current)) return { current, type: "permanent" } as const
        if (isCompatibleMorphElement(current, source)) {
          return {
            children: this.buildMorphPlans(current, source.children),
            current,
            source,
            type: "reuse",
          } as const
        }
      }

      if ((current && hasTurboPermanent(current)) || hasTurboPermanent(source)) {
        throw new TargetError("Native morph cannot clone a data-turbo-permanent subtree", {
          ...(id ? { target: id } : {}),
        })
      }
      this.assertMorphCloneIds(source, current)
      return { source, type: "clone" } as const
    })
  }

  private assertMatchedPermanentChildren(
    parent: ProtocolElement,
    sources: readonly ProtocolNode[],
    currentById: ReadonlyMap<string, ProtocolElement>,
  ): void {
    const sourceById = new Map<string, ProtocolElement>()
    for (const source of sources) {
      if (!isElement(source)) continue
      const id = attributeValue(source, "id")
      if (id !== undefined) sourceById.set(id, source)
    }

    for (const current of parent.children) {
      if (!isElement(current) || !hasTurboPermanent(current)) continue
      const id = attributeValue(current, "id")
      const source = id === undefined ? undefined : sourceById.get(id)
      if (
        !id?.trim() ||
        current.kind !== "element" ||
        !source ||
        source.kind !== "element" ||
        !isCompatibleMorphElement(current, source)
      ) {
        throw new TargetError(
          "Native morph permanent subtrees require a retained same-parent path",
          {
            ...(id ? { target: id } : {}),
          },
        )
      }
      if (isTurboPermanent(current)) {
        if (!isTurboPermanent(source)) {
          throw new TargetError("Native morph permanent nodes must be marked on both sides", {
            target: id,
          })
        }
        this.assertPermanentSubtree(current, source)
      }
    }

    for (const source of sources) {
      if (!isElement(source) || !hasTurboPermanent(source)) continue
      const id = attributeValue(source, "id")
      const current = id === undefined ? undefined : currentById.get(id)
      if (
        !id?.trim() ||
        source.kind !== "element" ||
        !current ||
        current.kind !== "element" ||
        !isCompatibleMorphElement(current, source)
      ) {
        throw new TargetError(
          "Native morph permanent subtrees require a retained same-parent path",
          {
            ...(id ? { target: id } : {}),
          },
        )
      }
      if (isTurboPermanent(source)) {
        if (!isTurboPermanent(current)) {
          throw new TargetError("Native morph permanent nodes must be marked on both sides", {
            target: id,
          })
        }
        this.assertPermanentSubtree(current, source)
      }
    }
  }

  private assertPermanentSubtree(current: ProtocolElement, source: ProtocolElement): void {
    if (current.children.some(hasTurboPermanent) || source.children.some(hasTurboPermanent)) {
      const id = attributeValue(current, "id")
      throw new TargetError("Native morph permanent nodes cannot contain another permanent node", {
        ...(id ? { target: id } : {}),
      })
    }
  }

  private assertMorphCloneIds(source: ProtocolNode, replacementRoot?: ProtocolElement): void {
    const visit = (node: ProtocolNode): void => {
      if (!isElement(node)) return
      const id = attributeValue(node, "id")
      const active = id === undefined ? undefined : this.idIndex.get(id)
      if (active && (!replacementRoot || !isWithin(active, replacementRoot))) {
        throw new TargetError(`Native morph cannot reparent id ${JSON.stringify(id)}`, {
          ...(id ? { target: id } : {}),
        })
      }
      for (const child of node.children) visit(child)
    }
    visit(source)
  }

  private applyMorphChildren(
    parent: ProtocolParentNode,
    plans: readonly MorphPlan[],
    transaction: MorphTransaction,
  ): void {
    const previous = parent.children
    if (!transaction.children.has(parent)) transaction.children.set(parent, previous)
    const children = plans.map((plan) => this.materializeMorphPlan(plan, parent, transaction))
    setProtocolNodeChildren(parent, children)

    for (const child of children) this.recordMorphParent(child, transaction)
    for (const child of children) setProtocolNodeParent(child, parent)

    const retained = new Set(children)
    for (const child of previous) {
      if (retained.has(child)) continue
      this.recordMorphParent(child, transaction)
      setProtocolNodeParent(child, null)
    }
  }

  private commitMorphPlans(
    parent: ProtocolElement,
    plans: readonly MorphPlan[],
    source?: ProtocolElement,
  ): readonly string[] {
    const previousKeys = parent.children.flatMap(subtreeKeys)
    const previousMutationKey = this.mutationKey
    const transaction: MorphTransaction = {
      attributes: new Map(),
      children: new Map(),
      parents: new Map(),
    }

    try {
      if (source) {
        transaction.attributes.set(parent, parent.attributes)
        setProtocolElementAttributes(parent, source.attributes)
      }
      this.applyMorphChildren(parent, plans, transaction)
      this.rebuildIndexes()
    } catch (error) {
      this.mutationKey = previousMutationKey
      this.restoreMorphTransaction(transaction)
      this.rebuildIndexes()
      throw error
    }

    return [parent.key, ...previousKeys, ...parent.children.flatMap(subtreeKeys)]
  }

  private materializeMorphPlan(
    plan: MorphPlan,
    parent: ProtocolParentNode,
    transaction: MorphTransaction,
  ): ProtocolNode {
    if (plan.type === "clone") return this.cloneNode(plan.source, parent)
    if (plan.type === "permanent") return plan.current

    const { current, source } = plan
    if (!transaction.attributes.has(current)) {
      transaction.attributes.set(current, current.attributes)
    }
    setProtocolElementAttributes(current, source.attributes)
    this.applyMorphChildren(current, plan.children, transaction)
    return current
  }

  private recordMorphParent(node: ProtocolNode, transaction: MorphTransaction): void {
    if (this.nodes.has(node) && !transaction.parents.has(node)) {
      transaction.parents.set(node, node.parent)
    }
  }

  private restoreMorphTransaction(transaction: MorphTransaction): void {
    for (const [element, attributes] of transaction.attributes) {
      setProtocolElementAttributes(element, attributes)
    }
    for (const [parent, children] of transaction.children) {
      setProtocolNodeChildren(parent, children)
    }
    for (const [node, parent] of transaction.parents) {
      setProtocolNodeParent(node, parent)
    }
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
      (attributeValue(source, "data-turbo-temporary") !== undefined ||
        attributeValue(source, "data-turbo-cache") === "false")
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
