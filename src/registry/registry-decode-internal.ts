import { PropsError, RegistryError } from "../core/errors.js"
import { protocolDirection } from "../core/protocol-direction.js"
import {
  attributeValue,
  isElement,
  type ProtocolElement,
  type ProtocolNode,
  renderedNodeTextContent,
  renderedTextValue,
} from "../core/tree.js"
import type {
  DecodedComponent,
  ProtocolAttributes,
  RegistryComponent,
  RegistryRenderDecodeResult,
  RegistryVocabularyIssue,
} from "./registry.js"

const FORM_OWNER_ATTRIBUTE_NAMES = new Set(["action", "enctype", "method", "novalidate", "target"])

type ResolveComponent<Component extends RegistryComponent> = (
  tagOrAlias: string,
) => Component | undefined

function protocolAttributes(element: ProtocolElement): ProtocolAttributes {
  const classes = (attributeValue(element, "class") ?? "").split(/\s+/).filter(Boolean)
  const data = Object.fromEntries(
    element.attributes
      .filter((attribute) => attribute.name.startsWith("data-"))
      .map((attribute) => [attribute.name.slice(5), attribute.value]),
  )
  const direction = protocolDirection(element)
  const dirname = attributeValue(element, "dirname")
  const form = attributeValue(element, "form")
  const xmlSpace = attributeValue(element, "xml:space")
  if (xmlSpace && !["default", "preserve"].includes(xmlSpace)) {
    throw new PropsError(
      `Invalid shared xml:space attribute on ${JSON.stringify(element.tagName)}`,
      {
        target: element.tagName,
      },
    )
  }
  const id = attributeValue(element, "id")

  return Object.freeze({
    autofocus: attributeValue(element, "autofocus") !== undefined,
    classNames: Object.freeze(classes),
    data: Object.freeze(data),
    ...(direction ? { direction } : {}),
    ...(dirname !== undefined ? { dirname } : {}),
    ...(form !== undefined ? { form } : {}),
    ...(id ? { id } : {}),
    ...(xmlSpace === "default" || xmlSpace === "preserve" ? { xmlSpace } : {}),
  })
}

function isSharedAttribute(name: string): boolean {
  return (
    name === "class" ||
    name === "autofocus" ||
    name === "dir" ||
    name === "dirname" ||
    name === "form" ||
    name === "id" ||
    name === "xml:space" ||
    name === "xmlns" ||
    name.startsWith("data-") ||
    name.startsWith("xmlns:")
  )
}

function isPackageOwnedAttribute(definition: RegistryComponent, name: string): boolean {
  return isSharedAttribute(name) || (definition.formOwner && FORM_OWNER_ATTRIBUTE_NAMES.has(name))
}

function decodeChildren(
  definition: RegistryComponent,
  element: ProtocolElement,
): Readonly<{ children: readonly ProtocolNode[]; text?: string }> {
  if (definition.children === "nodes") return { children: element.children }

  const meaningful = element.children.filter(
    (node) => node.kind !== "comment" && (node.kind !== "text" || renderedTextValue(node) !== ""),
  )
  if (definition.children === "none") {
    if (meaningful.length > 0) {
      throw new PropsError(
        `Component ${JSON.stringify(element.tagName)} does not accept children`,
        {
          target: element.tagName,
        },
      )
    }
    return { children: Object.freeze([]) }
  }

  if (meaningful.some(isElement)) {
    throw new PropsError(
      `Component ${JSON.stringify(element.tagName)} accepts text children only`,
      {
        target: element.tagName,
      },
    )
  }
  return { children: element.children, text: renderedNodeTextContent(element) }
}

function ownAttributeBinding(definition: RegistryComponent, name: string) {
  return Object.hasOwn(definition.attributeBindings, name)
    ? definition.attributeBindings[name]
    : undefined
}

function validatedProps(
  definition: RegistryComponent,
  element: ProtocolElement,
  attributes: Readonly<Record<string, unknown>>,
): unknown {
  try {
    return definition.decodeProps(attributes)
  } catch {
    throw new PropsError(`Props failed validation for ${JSON.stringify(element.tagName)}`, {
      target: element.tagName,
    })
  }
}

function decodedComponent<Component extends RegistryComponent>(
  definition: Component,
  element: ProtocolElement,
  attributes: Readonly<Record<string, unknown>>,
  warnings: readonly string[],
): DecodedComponent<Component> {
  const props = validatedProps(definition, element, attributes)
  const decodedChildren = decodeChildren(definition, element)
  return Object.freeze({
    ...decodedChildren,
    children: Object.freeze([...decodedChildren.children]),
    definition,
    props,
    protocol: protocolAttributes(element),
    warnings: Object.freeze([...warnings]),
  })
}

function vocabularyIssue(issue: RegistryVocabularyIssue): RegistryVocabularyIssue {
  return Object.freeze(issue)
}

export function decodeRegistryElementStrict<Component extends RegistryComponent>(
  resolve: ResolveComponent<Component>,
  element: ProtocolElement,
): DecodedComponent<Component> {
  const definition = resolve(element.tagName)
  if (!definition) {
    throw new RegistryError(`Unknown component ${JSON.stringify(element.tagName)}`, {
      target: element.tagName,
    })
  }

  const attributes: Record<string, unknown> = Object.create(null)
  const warnings: string[] = []
  for (const attribute of element.attributes) {
    const binding = ownAttributeBinding(definition, attribute.name)
    if (!binding && isPackageOwnedAttribute(definition, attribute.name)) continue
    if (!binding) {
      throw new PropsError(
        `Unknown attribute ${JSON.stringify(attribute.name)} on ${JSON.stringify(element.tagName)}`,
        { target: element.tagName },
      )
    }
    try {
      attributes[binding.prop] = binding.decode
        ? binding.decode(attribute.value)
        : binding.codec.decode(attribute.value)
    } catch {
      throw new PropsError(
        `Invalid attribute ${JSON.stringify(attribute.name)} on ${JSON.stringify(element.tagName)}`,
        { target: element.tagName },
      )
    }
    if (binding.deprecated) warnings.push(binding.deprecated)
  }

  return decodedComponent(definition, element, attributes, warnings)
}

export function decodeRegistryElementForRender<Component extends RegistryComponent>(
  resolve: ResolveComponent<Component>,
  element: ProtocolElement,
): RegistryRenderDecodeResult<Component> {
  const definition = resolve(element.tagName)
  if (!definition) {
    return Object.freeze({
      children: Object.freeze([...element.children]),
      issues: Object.freeze([vocabularyIssue({ kind: "component", tag: element.tagName })]),
      protocol: protocolAttributes(element),
      status: "transparent",
    })
  }

  const attributes: Record<string, unknown> = Object.create(null)
  const issues: RegistryVocabularyIssue[] = []
  const warnings: string[] = []
  let transparent = false
  for (const attribute of element.attributes) {
    const binding = ownAttributeBinding(definition, attribute.name)
    if (!binding) {
      if (isPackageOwnedAttribute(definition, attribute.name)) continue
      issues.push(
        vocabularyIssue({
          attribute: attribute.name,
          kind: "attribute",
          tag: element.tagName,
        }),
      )
      continue
    }

    try {
      attributes[binding.prop] = binding.decode
        ? binding.decode(attribute.value)
        : binding.codec.decode(attribute.value)
    } catch {
      issues.push(
        vocabularyIssue({
          attribute: attribute.name,
          kind: "attribute-decode",
          tag: element.tagName,
        }),
      )
      if (binding.required === true) transparent = true
      continue
    }
    if (binding.deprecated) warnings.push(binding.deprecated)
  }

  if (!transparent) {
    try {
      return Object.freeze({
        decoded: decodedComponent(definition, element, attributes, warnings),
        issues: Object.freeze(issues),
        status: "decoded",
      })
    } catch (error) {
      // A component whose props or child slots no longer match the served
      // markup is deployment skew, not a fatal document error. Treat the node
      // as unknown so its children remain the author's fallback channel.
      if (!(error instanceof PropsError)) throw error
      issues.push(vocabularyIssue({ kind: "component", tag: element.tagName }))
    }
  }

  return Object.freeze({
    children: Object.freeze([...element.children]),
    definition,
    issues: Object.freeze(issues),
    // Invalid shared protocol values stay fatal; they are malformed input
    // rather than an installed-client vocabulary gap.
    protocol: protocolAttributes(element),
    status: "transparent",
  })
}
