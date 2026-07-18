import {
  DOMParser,
  type Document as XmlDocument,
  type Element as XmlElement,
  type Node as XmlNode,
} from "@xmldom/xmldom"

import { ParseError } from "./errors"
import {
  DocumentTree,
  type ProtocolAttribute,
  type ProtocolDocument,
  type ProtocolElement,
  type ProtocolElementKind,
  type ProtocolNode,
  type ProtocolParentNode,
  type SourceLocation,
} from "./tree"

export interface ParseLimits {
  readonly maxAttributesPerElement: number
  readonly maxBytes: number
  readonly maxDepth: number
  readonly maxNodes: number
  readonly maxStreamActions: number
  readonly maxTextBytes: number
}

export const DEFAULT_PARSE_LIMITS: ParseLimits = Object.freeze({
  maxAttributesPerElement: 32,
  maxBytes: 1_048_576,
  maxDepth: 64,
  maxNodes: 10_000,
  maxStreamActions: 100,
  maxTextBytes: 524_288,
})

export interface ParseOptions {
  readonly limits?: Partial<ParseLimits>
  readonly url?: string
}

interface LocatedXmlNode extends XmlNode {
  readonly columnNumber?: number
  readonly lineNumber?: number
}

interface ConversionState {
  readonly allowDuplicateIds: boolean
  readonly ids: Map<string, SourceLocation | undefined>
  readonly limits: ParseLimits
  nodes: number
  streamActions: number
  textBytes: number
}

function utf8ByteLength(value: string): number {
  let bytes = 0
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0
    if (codePoint <= 0x7f) bytes += 1
    else if (codePoint <= 0x7ff) bytes += 2
    else if (codePoint <= 0xffff) bytes += 3
    else bytes += 4
  }
  return bytes
}

function sourceLocation(node: XmlNode): SourceLocation | undefined {
  const located = node as LocatedXmlNode
  if (!located.lineNumber || !located.columnNumber) return undefined
  return { column: located.columnNumber, line: located.lineNumber }
}

function parseLocation(message: string): SourceLocation | undefined {
  const match = message.match(/\[line:(\d+),col:(\d+)\]/)
  if (!match) return undefined
  return { column: Number(match[2]), line: Number(match[1]) }
}

function parseError(message: string, cause?: unknown): ParseError {
  const options = cause instanceof Error ? { cause } : undefined
  const location = parseLocation(message)
  return new ParseError(message, location ? { location } : {}, options)
}

function declarationBounds(xml: string): { end: number; start: number } | undefined {
  const start = xml.charCodeAt(0) === 0xfeff ? 1 : 0
  if (!/^<\?xml(?:\s|\?>)/.test(xml.slice(start))) return undefined
  const end = xml.indexOf("?>", start + 5)
  if (end === -1) throw parseError("Unterminated XML declaration")

  const declaration = xml.slice(start, end + 2)
  const version = declaration.match(/\bversion\s*=\s*(['"])(.*?)\1/i)?.[2]
  if (version !== "1.0") throw parseError("Expo Turbo XML requires an XML 1.0 declaration")
  const encoding = declaration.match(/\bencoding\s*=\s*(['"])(.*?)\1/i)?.[2]
  if (encoding && encoding.toLowerCase() !== "utf-8") {
    throw parseError("Expo Turbo XML must declare UTF-8 encoding")
  }
  return { end: end + 2, start }
}

function markupEnd(xml: string, start: number): number {
  let quote: '"' | "'" | undefined
  for (let index = start; index < xml.length; index += 1) {
    const character = xml[index]
    if (quote) {
      if (character === quote) quote = undefined
    } else if (character === '"' || character === "'") {
      quote = character
    } else if (character === ">") {
      return index
    }
  }
  throw parseError("Unterminated XML markup")
}

function preflight(xml: string, limits: ParseLimits, allowDeclaration: boolean): void {
  const bytes = utf8ByteLength(xml)
  if (bytes > limits.maxBytes) throw parseError(`XML exceeds the ${limits.maxBytes}-byte limit`)

  const declaration = declarationBounds(xml)
  if (declaration && !allowDeclaration)
    throw parseError("XML declarations are not allowed in fragments")

  let depth = 0
  let index = xml.charCodeAt(0) === 0xfeff ? 1 : 0
  while (index < xml.length) {
    const opening = xml.indexOf("<", index)
    if (opening === -1) break

    if (declaration && opening === declaration.start) {
      index = declaration.end
      continue
    }
    if (xml.startsWith("<!--", opening)) {
      const end = xml.indexOf("-->", opening + 4)
      if (end === -1) throw parseError("Unterminated XML comment")
      index = end + 3
      continue
    }
    if (xml.startsWith("<![CDATA[", opening)) {
      const end = xml.indexOf("]]>", opening + 9)
      if (end === -1) throw parseError("Unterminated CDATA section")
      index = end + 3
      continue
    }
    if (xml.startsWith("<?", opening)) throw parseError("Processing instructions are not allowed")
    if (/^<!doctype\b/i.test(xml.slice(opening))) {
      throw parseError("DOCTYPE declarations are not allowed")
    }
    if (xml.startsWith("<!", opening)) throw parseError("XML declarations are not allowed")

    const end = markupEnd(xml, opening + 1)
    const markup = xml.slice(opening + 1, end).trim()
    if (markup.startsWith("/")) depth -= 1
    else if (!markup.endsWith("/")) depth += 1
    if (depth > limits.maxDepth)
      throw parseError(`XML exceeds the depth limit of ${limits.maxDepth}`)
    if (depth < 0) throw parseError("XML closes an element before it is opened")
    index = end + 1
  }
}

function strictDocument(xml: string): XmlDocument {
  try {
    return new DOMParser({
      locator: true,
      onError(level, message) {
        throw parseError(`${level}: ${message}`)
      },
    }).parseFromString(xml, "application/xml")
  } catch (error) {
    if (error instanceof ParseError) throw error
    throw parseError("Unable to parse Expo Turbo XML", error)
  }
}

function elementKind(tagName: string): ProtocolElementKind {
  if (tagName === "turbo-frame") return "frame"
  if (tagName === "turbo-stream") return "stream"
  if (tagName === "turbo-cable-stream-source") return "stream-source"
  if (tagName === "template") return "template"
  return "element"
}

function elementAttributes(element: XmlElement, state: ConversionState): ProtocolAttribute[] {
  if (element.attributes.length > state.limits.maxAttributesPerElement) {
    const location = sourceLocation(element)
    throw new ParseError(
      `Element ${JSON.stringify(element.tagName)} exceeds the attribute limit of ${state.limits.maxAttributesPerElement}`,
      location ? { location } : {},
    )
  }

  const attributes: ProtocolAttribute[] = []
  for (let index = 0; index < element.attributes.length; index += 1) {
    const attribute = element.attributes.item(index)
    if (!attribute) continue
    attributes.push({
      localName: attribute.localName ?? attribute.name,
      name: attribute.name,
      namespaceUri: attribute.namespaceURI,
      prefix: attribute.prefix,
      value: attribute.value,
    })
  }
  return attributes
}

function countNode(state: ConversionState, location?: SourceLocation): void {
  state.nodes += 1
  if (state.nodes > state.limits.maxNodes) {
    throw new ParseError(
      `XML exceeds the node limit of ${state.limits.maxNodes}`,
      location ? { location } : {},
    )
  }
}

function convertNode(
  node: XmlNode,
  parent: ProtocolParentNode,
  key: string,
  depth: number,
  state: ConversionState,
): ProtocolNode | undefined {
  const location = sourceLocation(node)
  if (depth > state.limits.maxDepth) {
    throw new ParseError(
      `XML exceeds the depth limit of ${state.limits.maxDepth}`,
      location ? { location } : {},
    )
  }

  if (node.nodeType === 1) {
    countNode(state, location)
    const xmlElement = node as XmlElement
    const attributes = elementAttributes(xmlElement, state)
    const xmlSpace = attributes.find((attribute) => attribute.name === "xml:space")?.value
    if (xmlSpace !== undefined && xmlSpace !== "default" && xmlSpace !== "preserve") {
      throw new ParseError(
        `Invalid xml:space value ${JSON.stringify(xmlSpace)}`,
        location ? { location } : {},
      )
    }
    const id = attributes.find((attribute) => attribute.name === "id")?.value
    if (id !== undefined && id.trim() === "") {
      throw new ParseError("Element ids must not be blank", location ? { location } : {})
    }
    const existingLocation = id !== undefined ? state.ids.get(id) : undefined
    if (id !== undefined && state.ids.has(id) && !state.allowDuplicateIds) {
      const duplicateLocation = location ?? existingLocation
      throw new ParseError(`Duplicate id ${JSON.stringify(id)}`, {
        target: id,
        ...(duplicateLocation ? { location: duplicateLocation } : {}),
      })
    }
    if (id !== undefined) state.ids.set(id, location)

    const kind = elementKind(xmlElement.tagName)
    if (kind === "stream") {
      state.streamActions += 1
      if (state.streamActions > state.limits.maxStreamActions) {
        throw new ParseError(
          `XML exceeds the stream action limit of ${state.limits.maxStreamActions}`,
          location ? { location } : {},
        )
      }
    }

    const element: ProtocolElement = {
      attributes,
      children: [],
      key: id !== undefined ? `id:${id}` : key,
      kind,
      localName: xmlElement.localName ?? xmlElement.tagName,
      namespaceUri: xmlElement.namespaceURI,
      parent,
      prefix: xmlElement.prefix,
      tagName: xmlElement.tagName,
      ...(location ? { location } : {}),
    }
    ;(element as { children: readonly ProtocolNode[] }).children = convertChildren(
      node,
      element,
      key,
      depth + 1,
      state,
    )
    return element
  }

  if (node.nodeType === 3 || node.nodeType === 4) {
    countNode(state, location)
    const value = node.nodeValue ?? ""
    state.textBytes += utf8ByteLength(value)
    if (state.textBytes > state.limits.maxTextBytes) {
      throw new ParseError(`XML exceeds the text limit of ${state.limits.maxTextBytes} bytes`, {
        ...(location ? { location } : {}),
      })
    }
    return {
      cdata: node.nodeType === 4,
      key,
      kind: "text",
      parent,
      value,
      ...(location ? { location } : {}),
    }
  }

  if (node.nodeType === 8) {
    countNode(state, location)
    return {
      key,
      kind: "comment",
      parent,
      value: node.nodeValue ?? "",
      ...(location ? { location } : {}),
    }
  }

  return undefined
}

function convertChildren(
  node: XmlNode,
  parent: ProtocolParentNode,
  parentKey: string,
  depth: number,
  state: ConversionState,
): ProtocolNode[] {
  const children: ProtocolNode[] = []
  for (let index = 0; index < node.childNodes.length; index += 1) {
    const child = node.childNodes.item(index)
    if (!child) continue
    const converted = convertNode(child, parent, `${parentKey}.${index}`, depth, state)
    if (converted) children.push(converted)
  }
  return children
}

function parse(xml: string, options: ParseOptions, fragment: boolean): DocumentTree {
  const limits: ParseLimits = { ...DEFAULT_PARSE_LIMITS, ...options.limits }
  preflight(xml, limits, !fragment)

  const source = fragment ? `<expo-turbo-fragment>${xml}</expo-turbo-fragment>` : xml
  const parsed = strictDocument(source)
  const state: ConversionState = {
    allowDuplicateIds: fragment,
    ids: new Map(),
    limits,
    nodes: 1,
    streamActions: 0,
    textBytes: 0,
  }
  const document: ProtocolDocument = {
    children: [],
    key: "document",
    kind: "document",
    parent: null,
    ...(options.url ? { url: options.url } : {}),
  }

  const sourceNode = fragment ? parsed.documentElement : parsed
  if (!sourceNode) throw parseError("Expo Turbo XML requires a document element")
  ;(document as { children: readonly ProtocolNode[] }).children = convertChildren(
    sourceNode,
    document,
    "path",
    1,
    state,
  )
  const roots = document.children.filter((node) => isProtocolElement(node))
  if (!fragment && roots.length !== 1)
    throw parseError("Expo Turbo documents require one root element")
  if (fragment && roots.some((node) => node.kind !== "stream")) {
    throw parseError("Turbo Stream fragments may contain only turbo-stream root elements")
  }
  return new DocumentTree(document, { allowDuplicateIds: fragment })
}

function isProtocolElement(node: ProtocolNode): node is ProtocolElement {
  return !["comment", "document", "text"].includes(node.kind)
}

export function parseExpoTurboDocument(xml: string, options: ParseOptions = {}): DocumentTree {
  return parse(xml, options, false)
}

export function parseTurboStreamFragment(xml: string, options: ParseOptions = {}): DocumentTree {
  return parse(xml, options, true)
}
