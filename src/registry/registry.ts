import type { ComponentType, ReactNode } from "react"
import type { z } from "zod"

import { PropsError, RegistryError } from "../core/errors"
import {
  attributeValue,
  isElement,
  type ProtocolElement,
  type ProtocolNode,
  renderedNodeTextContent,
  renderedTextValue,
} from "../core/tree"
import { EXPO_TURBO_PROTOCOL_VERSION } from "../core/versions"
import type { AttributeCodec } from "./codecs"

const RESERVED_TAGS = new Set([
  "expo-turbo-fragment",
  "template",
  "turbo-cable-stream-source",
  "turbo-frame",
  "turbo-stream",
])

type StringKey<Value> = Extract<keyof Value, string>

export type AttributeBinding<Props> = {
  [Key in StringKey<Props>]: Readonly<{
    codec: AttributeCodec<Props[Key]>
    deprecated?: string
    prop: Key
  }>
}[StringKey<Props>]

export type ComponentChildren = "nodes" | "none" | "text"
export type ComponentRenderer<Props> = ComponentType<Props & Readonly<{ children?: ReactNode }>>

export interface DefineComponentConfig<Tag extends string, Schema extends z.ZodObject> {
  readonly aliases?: readonly string[]
  readonly attributes: Readonly<Record<string, AttributeBinding<z.input<Schema>>>>
  readonly children: ComponentChildren
  readonly component: ComponentRenderer<z.output<Schema>>
  readonly schema: Schema
  readonly tag: Tag
}

interface ErasedAttributeBinding {
  readonly codec: AttributeCodec<unknown>
  readonly deprecated?: string
  readonly prop: string
}

export interface RegistryComponent {
  readonly aliases: readonly string[]
  readonly attributeBindings: Readonly<Record<string, ErasedAttributeBinding>>
  readonly children: ComponentChildren
  readonly component: unknown
  readonly tag: string
  decodeProps(attributes: Readonly<Record<string, unknown>>): unknown
}

export interface DefinedComponent<Tag extends string, Schema extends z.ZodObject>
  extends RegistryComponent {
  readonly component: ComponentRenderer<z.output<Schema>>
  readonly schema: Schema
  readonly tag: Tag
}

function validateTag(tag: string): void {
  if (!tag.trim()) throw new RegistryError("Component tags must not be blank")
  if (RESERVED_TAGS.has(tag)) {
    throw new RegistryError(`Component tag ${JSON.stringify(tag)} is reserved`, { target: tag })
  }
}

export function defineComponent<const Tag extends string, Schema extends z.ZodObject>(
  config: DefineComponentConfig<Tag, Schema>,
): DefinedComponent<Tag, Schema> {
  validateTag(config.tag)
  const aliases = [...new Set(config.aliases ?? [])]
  for (const alias of aliases) validateTag(alias)
  if (aliases.includes(config.tag)) {
    throw new RegistryError(`Component ${JSON.stringify(config.tag)} aliases itself`, {
      target: config.tag,
    })
  }

  const attributeBindings = Object.freeze(
    Object.fromEntries(
      Object.entries(config.attributes).map(([name, binding]) => {
        if (!binding.codec.name.trim()) {
          throw new RegistryError(`Attribute ${JSON.stringify(name)} requires a named codec`, {
            target: config.tag,
          })
        }
        return [name, Object.freeze({ ...binding })]
      }),
    ),
  ) as Readonly<Record<string, ErasedAttributeBinding>>

  return Object.freeze({
    aliases: Object.freeze(aliases),
    attributeBindings,
    children: config.children,
    component: config.component,
    decodeProps(attributes: Readonly<Record<string, unknown>>): unknown {
      return config.schema.parse(attributes)
    },
    schema: config.schema,
    tag: config.tag,
  })
}

export interface ComponentModule<
  Name extends string = string,
  Components extends readonly RegistryComponent[] = readonly RegistryComponent[],
> {
  readonly components: Components
  readonly name: Name
  readonly version: string
}

export function defineComponentModule<
  const Name extends string,
  const Components extends readonly RegistryComponent[],
>(config: ComponentModule<Name, Components>): ComponentModule<Name, Components> {
  if (!config.name.trim()) throw new RegistryError("Component modules require a name")
  if (!config.version.trim()) throw new RegistryError("Component modules require a version")
  return Object.freeze({
    components: Object.freeze([...config.components]) as unknown as Components,
    name: config.name,
    version: config.version,
  })
}

export interface ProtocolAttributes {
  readonly classNames: readonly string[]
  readonly data: Readonly<Record<string, string>>
  readonly direction?: "auto" | "ltr" | "rtl"
  readonly id?: string
  readonly xmlSpace?: "default" | "preserve"
}

export interface DecodedComponent<Component extends RegistryComponent = RegistryComponent> {
  readonly children: readonly ProtocolNode[]
  readonly definition: Component
  readonly props: unknown
  readonly protocol: ProtocolAttributes
  readonly text?: string
  readonly warnings: readonly string[]
}

export interface ComponentCapability {
  readonly aliases: readonly string[]
  readonly attributes: readonly Readonly<{
    codec: string
    deprecated?: string
    name: string
    prop: string
  }>[]
  readonly children: ComponentChildren
  readonly tag: string
}

export interface RegistryCapabilityManifest {
  readonly components: readonly ComponentCapability[]
  readonly hash: string
  readonly modules: readonly Readonly<{ name: string; version: string }>[]
  readonly protocolVersion: string
}

function capabilityHash(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, "0")}`
}

function protocolAttributes(element: ProtocolElement): ProtocolAttributes {
  const classes = (attributeValue(element, "class") ?? "").split(/\s+/).filter(Boolean)
  const data = Object.fromEntries(
    element.attributes
      .filter((attribute) => attribute.name.startsWith("data-"))
      .map((attribute) => [attribute.name.slice(5), attribute.value]),
  )
  const direction = attributeValue(element, "dir")
  if (direction && !["auto", "ltr", "rtl"].includes(direction)) {
    throw new PropsError(`Invalid shared dir attribute on ${JSON.stringify(element.tagName)}`, {
      target: element.tagName,
    })
  }
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
    classNames: Object.freeze(classes),
    data: Object.freeze(data),
    ...(direction === "auto" || direction === "ltr" || direction === "rtl" ? { direction } : {}),
    ...(id ? { id } : {}),
    ...(xmlSpace === "default" || xmlSpace === "preserve" ? { xmlSpace } : {}),
  })
}

function isSharedAttribute(name: string): boolean {
  return (
    name === "class" ||
    name === "dir" ||
    name === "id" ||
    name === "xml:space" ||
    name === "xmlns" ||
    name.startsWith("data-") ||
    name.startsWith("xmlns:")
  )
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

export interface ComponentRegistry<Component extends RegistryComponent = never> {
  readonly capabilities: RegistryCapabilityManifest
  decode(element: ProtocolElement): DecodedComponent<Component>
  get<Tag extends Component["tag"]>(tag: Tag): Extract<Component, { readonly tag: Tag }> | undefined
  resolve(tagOrAlias: string): Component | undefined
  use<Next extends readonly RegistryComponent[]>(
    module: ComponentModule<string, Next>,
  ): ComponentRegistry<Component | Next[number]>
}

class Registry<Component extends RegistryComponent> implements ComponentRegistry<Component> {
  readonly capabilities: RegistryCapabilityManifest
  private readonly components = new Map<string, RegistryComponent>()

  constructor(private readonly modules: readonly ComponentModule[]) {
    const moduleNames = new Set<string>()
    const owners = new Map<string, string>()
    for (const module of modules) {
      if (moduleNames.has(module.name)) {
        throw new RegistryError(`Duplicate component module ${JSON.stringify(module.name)}`)
      }
      moduleNames.add(module.name)
      for (const component of module.components) {
        for (const name of [component.tag, ...component.aliases]) {
          const owner = owners.get(name)
          if (owner) {
            throw new RegistryError(
              `Component name ${JSON.stringify(name)} is owned by both ${JSON.stringify(owner)} and ${JSON.stringify(module.name)}`,
              { target: name },
            )
          }
          owners.set(name, module.name)
          this.components.set(name, component)
        }
      }
    }

    const componentCapabilities = [...new Set(this.components.values())]
      .map((component): ComponentCapability => {
        const attributes = Object.entries(component.attributeBindings)
          .map(([name, binding]) =>
            Object.freeze({
              codec: binding.codec.name,
              ...(binding.deprecated ? { deprecated: binding.deprecated } : {}),
              name,
              prop: binding.prop,
            }),
          )
          .sort((left, right) => left.name.localeCompare(right.name))
        return Object.freeze({
          aliases: Object.freeze([...component.aliases].sort()),
          attributes: Object.freeze(attributes),
          children: component.children,
          tag: component.tag,
        })
      })
      .sort((left, right) => left.tag.localeCompare(right.tag))
    const moduleCapabilities = modules
      .map((module) => Object.freeze({ name: module.name, version: module.version }))
      .sort((left, right) => left.name.localeCompare(right.name))
    const serializable = {
      components: componentCapabilities,
      modules: moduleCapabilities,
      protocolVersion: EXPO_TURBO_PROTOCOL_VERSION,
    }
    this.capabilities = Object.freeze({
      ...serializable,
      components: Object.freeze(componentCapabilities),
      hash: capabilityHash(JSON.stringify(serializable)),
      modules: Object.freeze(moduleCapabilities),
    })
  }

  decode(element: ProtocolElement): DecodedComponent<Component> {
    const definition = this.resolve(element.tagName)
    if (!definition) {
      throw new RegistryError(`Unknown component ${JSON.stringify(element.tagName)}`, {
        target: element.tagName,
      })
    }

    const attributes: Record<string, unknown> = {}
    const warnings: string[] = []
    for (const attribute of element.attributes) {
      if (isSharedAttribute(attribute.name)) continue
      const binding = definition.attributeBindings[attribute.name]
      if (!binding) {
        throw new PropsError(
          `Unknown attribute ${JSON.stringify(attribute.name)} on ${JSON.stringify(element.tagName)}`,
          { target: element.tagName },
        )
      }
      try {
        attributes[binding.prop] = binding.codec.decode(attribute.value)
      } catch {
        throw new PropsError(
          `Invalid attribute ${JSON.stringify(attribute.name)} on ${JSON.stringify(element.tagName)}`,
          { target: element.tagName },
        )
      }
      if (binding.deprecated) warnings.push(binding.deprecated)
    }

    let props: unknown
    try {
      props = definition.decodeProps(attributes)
    } catch {
      throw new PropsError(`Props failed validation for ${JSON.stringify(element.tagName)}`, {
        target: element.tagName,
      })
    }
    const decodedChildren = decodeChildren(definition, element)
    return Object.freeze({
      ...decodedChildren,
      children: Object.freeze([...decodedChildren.children]),
      definition: definition as Component,
      props,
      protocol: protocolAttributes(element),
      warnings: Object.freeze(warnings),
    })
  }

  get<Tag extends Component["tag"]>(
    tag: Tag,
  ): Extract<Component, { readonly tag: Tag }> | undefined {
    const component = this.components.get(tag)
    return component?.tag === tag
      ? (component as Extract<Component, { readonly tag: Tag }>)
      : undefined
  }

  resolve(tagOrAlias: string): Component | undefined {
    return this.components.get(tagOrAlias) as Component | undefined
  }

  use<Next extends readonly RegistryComponent[]>(
    module: ComponentModule<string, Next>,
  ): ComponentRegistry<Component | Next[number]> {
    return new Registry<Component | Next[number]>([...this.modules, module])
  }
}

type ComponentsFromModules<Modules extends readonly ComponentModule[]> =
  Modules[number]["components"][number]

export function createRegistry<const Modules extends readonly ComponentModule[]>(
  ...modules: Modules
): ComponentRegistry<ComponentsFromModules<Modules>> {
  return new Registry<ComponentsFromModules<Modules>>(modules)
}
