import type { ComponentType, ReactNode } from "react"
import { z } from "zod"

import { RegistryError } from "../core/errors.js"
import type { FormContainerRole } from "../core/forms.js"
import { isExpoTurboModuleName, isExpoTurboModuleVersion } from "../core/protocol-request.js"
import type { ProtocolElement, ProtocolNode } from "../core/tree.js"
import { EXPO_TURBO_PROTOCOL_VERSION } from "../core/versions.js"
import { type AttributeDefinition, attributeDefinitionParts } from "./attributes.js"
import type { AttributeCodec } from "./codecs.js"
import {
  decodeRegistryElementForRender,
  decodeRegistryElementStrict,
} from "./registry-decode-internal.js"

const RESERVED_TAGS = new Set([
  "expo-turbo-fragment",
  "template",
  "turbo-cable-stream-source",
  "turbo-frame",
  "turbo-stream",
])

export const REGISTRY_CAPABILITY_MANIFEST_VERSION = 1 as const

type StringKey<Value> = Extract<keyof Value, string>

export type AttributeBinding<Props> = {
  [Key in StringKey<Props>]: Readonly<{
    codec: AttributeCodec<Props[Key]>
    deprecated?: string
    prop: Key
  }>
}[StringKey<Props>]

export type ComponentChildren = "nodes" | "none" | "text"
export type ComponentMorphState = "preserve" | "reset"
export type ComponentRenderer<Props> = ComponentType<Props & Readonly<{ children?: ReactNode }>>

export const nodes = "nodes" as const
export const none = "none" as const
export const text = "text" as const
export const formOwner = "form-owner" as const
export const datalist = "datalist" as const
export const fieldset = "fieldset" as const
export const legend = "legend" as const

export type ComponentRole = typeof datalist | typeof fieldset | typeof formOwner | typeof legend

type CamelCaseAttribute<Name extends string> = Name extends `${infer Head}-${infer Tail}`
  ? Tail extends `${infer Next}${infer Rest}`
    ? `${Head}${Uppercase<Next>}${CamelCaseAttribute<Rest>}`
    : `${Head}-`
  : Name

type AttributeDefinitionMap = Readonly<
  Record<string, AttributeDefinition<z.ZodType, string | undefined>>
>

type AttributeDefinitionSchema<Definition> = Definition extends {
  readonly schema: infer Schema extends z.ZodType
}
  ? Schema
  : never

type AttributeDefinitionProp<Name extends string, Definition> = Definition extends {
  readonly propName: infer Prop
}
  ? Prop extends string
    ? Prop
    : CamelCaseAttribute<Name>
  : never

type DerivedComponentShape<Attributes extends AttributeDefinitionMap> = {
  [Name in keyof Attributes & string as AttributeDefinitionProp<
    Name,
    Attributes[Name]
  >]: AttributeDefinitionSchema<Attributes[Name]>
}

export type DerivedComponentSchema<Attributes extends AttributeDefinitionMap> = z.ZodObject<
  DerivedComponentShape<Attributes>
>

export interface DefineComponentConfig<Tag extends string, Schema extends z.ZodObject> {
  readonly aliases?: readonly string[]
  readonly attributes: Readonly<Record<string, AttributeBinding<z.input<Schema>>>>
  readonly children: ComponentChildren
  readonly component: ComponentRenderer<z.output<Schema>>
  readonly formContainer?: FormContainerRole
  readonly formOwner?: boolean
  readonly morphState?: ComponentMorphState
  readonly schema: Schema
  readonly tag: Tag
}

export interface DefineDerivedComponentConfig<
  Tag extends string,
  Attributes extends AttributeDefinitionMap,
> {
  readonly aliases?: readonly string[]
  readonly attributes: Attributes
  readonly children: ComponentChildren
  readonly component: ComponentRenderer<z.output<DerivedComponentSchema<Attributes>>>
  readonly formContainer?: FormContainerRole
  readonly formOwner?: boolean
  readonly morphState?: ComponentMorphState
  readonly schema?: never
  readonly tag: Tag
}

export type DefineComponentDefinitionConfig<Tag extends string, Schema extends z.ZodObject> = Omit<
  DefineComponentConfig<Tag, Schema>,
  "component"
>

export type DefineDerivedComponentDefinitionConfig<
  Tag extends string,
  Attributes extends AttributeDefinitionMap,
> = Omit<DefineDerivedComponentConfig<Tag, Attributes>, "component">

type DeclaredChildrenProps<Children extends ComponentChildren> = Children extends "none"
  ? Readonly<Record<never, never>>
  : Children extends "text"
    ? Readonly<{ children?: string }>
    : Readonly<{ children?: ReactNode }>

const COMPONENT_DECLARATION = Symbol("expo-turbo.component-declaration")

export interface ComponentDeclaration<Schema extends z.ZodObject = z.ZodObject> {
  readonly [COMPONENT_DECLARATION]: true
  readonly aliases: readonly string[]
  readonly attributes: Readonly<Record<string, unknown>>
  readonly children: ComponentChildren
  readonly formContainer?: FormContainerRole
  readonly formOwner: boolean
  readonly morphState: ComponentMorphState
  readonly render: ComponentType<z.output<Schema> & Readonly<{ children?: ReactNode }>>
  readonly schema?: Schema
}

type StyleAttributeMap<Style extends AttributeDefinition | undefined> =
  Style extends AttributeDefinition<infer Schema>
    ? Readonly<{
        "style-tokens": AttributeDefinition<Schema, "styleTokens">
      }>
    : Readonly<Record<never, never>>

type DeclaredAttributeMap<
  Attributes extends AttributeDefinitionMap,
  Style extends AttributeDefinition | undefined,
> = Attributes & StyleAttributeMap<Style>

export interface DeclareComponentConfig<
  Attributes extends AttributeDefinitionMap,
  Children extends ComponentChildren,
  Style extends AttributeDefinition | undefined,
> {
  readonly aliases?: readonly string[]
  readonly attributes?: Attributes
  readonly children: Children
  readonly morphState?: ComponentMorphState
  readonly render: ComponentType<
    z.output<DerivedComponentSchema<DeclaredAttributeMap<Attributes, Style>>> &
      DeclaredChildrenProps<Children>
  >
  readonly role?: ComponentRole
  readonly styles?: Style
}

export interface DeclareExplicitComponentConfig<
  Schema extends z.ZodObject,
  Children extends ComponentChildren,
> {
  readonly aliases?: readonly string[]
  readonly attributes: Readonly<Record<string, AttributeBinding<z.input<Schema>>>>
  readonly children: Children
  readonly morphState?: ComponentMorphState
  readonly render: ComponentType<z.output<Schema> & DeclaredChildrenProps<Children>>
  readonly role?: ComponentRole
  readonly schema: Schema
  readonly styles?: never
}

export function component<
  const Attributes extends AttributeDefinitionMap = Record<never, never>,
  const Children extends ComponentChildren = ComponentChildren,
  const Style extends AttributeDefinition | undefined = undefined,
>(
  config: DeclareComponentConfig<Attributes, Children, Style>,
): ComponentDeclaration<DerivedComponentSchema<DeclaredAttributeMap<Attributes, Style>>>
export function component<Schema extends z.ZodObject, const Children extends ComponentChildren>(
  config: DeclareExplicitComponentConfig<Schema, Children>,
): ComponentDeclaration<Schema>
export function component(
  config:
    | DeclareComponentConfig<
        AttributeDefinitionMap,
        ComponentChildren,
        AttributeDefinition | undefined
      >
    | DeclareExplicitComponentConfig<z.ZodObject, ComponentChildren>,
): ComponentDeclaration {
  if ("schema" in config && config.styles !== undefined) {
    throw new RegistryError(
      'Components with an explicit schema must declare "style-tokens" in attributes',
    )
  }
  if (config.styles !== undefined && Object.hasOwn(config.attributes ?? {}, "style-tokens")) {
    throw new RegistryError('Component style acceptance must use only the "styles" field')
  }
  const attributes = {
    ...(config.attributes ?? {}),
    ...(config.styles !== undefined ? { "style-tokens": config.styles.prop("styleTokens") } : {}),
  }
  return Object.freeze({
    [COMPONENT_DECLARATION]: true as const,
    aliases: Object.freeze([...(config.aliases ?? [])]),
    attributes: Object.freeze(attributes),
    children: config.children,
    ...(config.role !== undefined && config.role !== formOwner
      ? { formContainer: config.role }
      : {}),
    formOwner: config.role === formOwner,
    morphState: config.morphState ?? "preserve",
    render: config.render as ComponentType<Readonly<Record<string, unknown>>>,
    ...("schema" in config ? { schema: config.schema } : {}),
  })
}

interface ErasedAttributeBinding {
  readonly codec: AttributeCodec<unknown>
  readonly decode?: (value: string) => unknown
  readonly deprecated?: string
  readonly prop: string
  readonly required?: boolean
}

export interface RegistryComponentDefinition {
  readonly aliases: readonly string[]
  readonly attributeBindings: Readonly<Record<string, ErasedAttributeBinding>>
  readonly children: ComponentChildren
  readonly formContainer?: FormContainerRole
  readonly formOwner: boolean
  readonly morphState: ComponentMorphState
  readonly tag: string
  decodeProps(attributes: Readonly<Record<string, unknown>>): unknown
}

export interface RegistryComponent extends RegistryComponentDefinition {
  readonly component: unknown
}

export interface DefinedComponentDefinition<Tag extends string, Schema extends z.ZodObject>
  extends RegistryComponentDefinition {
  readonly schema: Schema
  readonly tag: Tag
}

export interface DefinedComponent<Tag extends string, Schema extends z.ZodObject>
  extends DefinedComponentDefinition<Tag, Schema> {
  readonly component: ComponentRenderer<z.output<Schema>>
}

function validateTag(tag: string): void {
  if (!tag.trim()) throw new RegistryError("Component tags must not be blank")
  if (RESERVED_TAGS.has(tag)) {
    throw new RegistryError(`Component tag ${JSON.stringify(tag)} is reserved`, { target: tag })
  }
}

interface RuntimeDefineComponentDefinitionConfig {
  readonly aliases?: readonly string[]
  readonly attributes: Readonly<Record<string, unknown>>
  readonly children: ComponentChildren
  readonly formContainer?: FormContainerRole
  readonly formOwner?: boolean
  readonly morphState?: ComponentMorphState
  readonly schema?: z.ZodObject
  readonly tag: string
}

interface RuntimeDefineComponentConfig extends RuntimeDefineComponentDefinitionConfig {
  readonly component: unknown
}

function camelCaseAttributeName(name: string): string {
  return name.replace(/-(.)/g, (_match, character: string) => character.toUpperCase())
}

function attributeIsRequired(schema: z.ZodType, name: string, tag: string): boolean {
  try {
    return !schema.isOptional()
  } catch {
    throw new RegistryError(`Attribute ${JSON.stringify(name)} requiredness could not be derived`, {
      target: tag,
    })
  }
}

function preparedPropsDecoder(
  schema: z.ZodObject,
): (attributes: Readonly<Record<string, unknown>>) => unknown {
  const shapeEntries = Object.entries(schema.shape)
  const outputShape = Object.fromEntries(
    shapeEntries.map(([prop]) => [prop, z.unknown().optional()]),
  )
  const outputSchema = schema.safeExtend(outputShape)
  return (attributes) => {
    const prepared = Object.assign(Object.create(null), attributes) as Record<string, unknown>
    for (const [prop, propSchema] of shapeEntries) {
      if (Object.hasOwn(attributes, prop)) continue
      const value = propSchema.parse(undefined)
      if (value !== undefined) prepared[prop] = value
    }
    return outputSchema.parse(prepared)
  }
}

function deriveComponentSchemaAndBindings(
  config: RuntimeDefineComponentDefinitionConfig,
): Readonly<{
  attributeBindings: Readonly<Record<string, ErasedAttributeBinding>>
  decodeProps(attributes: Readonly<Record<string, unknown>>): unknown
  schema: z.ZodObject
}> {
  const bindingEntries: [string, ErasedAttributeBinding][] = []

  if (config.schema !== undefined) {
    for (const [name, value] of Object.entries(config.attributes)) {
      const binding = value as ErasedAttributeBinding
      if (!binding.codec.name.trim()) {
        throw new RegistryError(`Attribute ${JSON.stringify(name)} requires a named codec`, {
          target: config.tag,
        })
      }
      if (binding.prop === "__proto__") {
        throw new RegistryError(
          `Attribute ${JSON.stringify(name)} uses reserved prop "__proto__"`,
          {
            target: config.tag,
          },
        )
      }
      const propSchema = config.schema.shape[binding.prop]
      const decodeInput = (value: string) =>
        binding.decode ? binding.decode(value) : binding.codec.decode(value)
      bindingEntries.push([
        name,
        Object.freeze({
          ...binding,
          decode: propSchema
            ? (value: string) => propSchema.parse(decodeInput(value))
            : decodeInput,
          required: propSchema ? attributeIsRequired(propSchema, name, config.tag) : false,
        }),
      ])
    }
    return Object.freeze({
      attributeBindings: Object.freeze(Object.fromEntries(bindingEntries)),
      decodeProps: preparedPropsDecoder(config.schema),
      schema: config.schema,
    })
  }

  const shapeEntries: [string, z.ZodType][] = []
  const claimedProps = new Set<string>()
  for (const [name, value] of Object.entries(config.attributes)) {
    const definition = attributeDefinitionParts(value)
    if (!definition) {
      throw new RegistryError(
        `Attribute ${JSON.stringify(name)} must use attr() when the component schema is omitted`,
        { target: config.tag },
      )
    }
    if (!definition.codec.name.trim()) {
      throw new RegistryError(`Attribute ${JSON.stringify(name)} requires a named codec`, {
        target: config.tag,
      })
    }

    const prop = definition.propName ?? camelCaseAttributeName(name)
    if (!prop.trim()) {
      throw new RegistryError(`Attribute ${JSON.stringify(name)} resolves to a blank prop`, {
        target: config.tag,
      })
    }
    if (prop === "__proto__") {
      throw new RegistryError(`Attribute ${JSON.stringify(name)} uses reserved prop "__proto__"`, {
        target: config.tag,
      })
    }
    if (claimedProps.has(prop)) {
      throw new RegistryError(
        `Component ${JSON.stringify(config.tag)} maps multiple attributes to prop ${JSON.stringify(prop)}`,
        { target: config.tag },
      )
    }
    claimedProps.add(prop)
    shapeEntries.push([prop, definition.schema])
    bindingEntries.push([
      name,
      Object.freeze({
        codec: definition.codec,
        decode: (value: string) => definition.schema.parse(definition.decode(value)),
        ...(definition.deprecatedMessage !== undefined
          ? { deprecated: definition.deprecatedMessage }
          : {}),
        prop,
        required: attributeIsRequired(definition.schema, name, config.tag),
      }),
    ])
  }

  const schema = z.object(Object.fromEntries(shapeEntries))
  return Object.freeze({
    attributeBindings: Object.freeze(Object.fromEntries(bindingEntries)),
    decodeProps: preparedPropsDecoder(schema),
    schema,
  })
}

function createComponentDefinition(
  config: RuntimeDefineComponentDefinitionConfig,
): DefinedComponentDefinition<string, z.ZodObject> {
  validateTag(config.tag)
  if (
    config.formContainer !== undefined &&
    config.formContainer !== "datalist" &&
    config.formContainer !== "fieldset" &&
    config.formContainer !== "legend"
  ) {
    throw new RegistryError("Component form container must be datalist, fieldset, or legend", {
      target: config.tag,
    })
  }
  if (
    config.morphState !== undefined &&
    config.morphState !== "preserve" &&
    config.morphState !== "reset"
  ) {
    throw new RegistryError("Component morphState must be preserve or reset", {
      target: config.tag,
    })
  }
  const aliases = [...new Set(config.aliases ?? [])]
  for (const alias of aliases) validateTag(alias)
  if (aliases.includes(config.tag)) {
    throw new RegistryError(`Component ${JSON.stringify(config.tag)} aliases itself`, {
      target: config.tag,
    })
  }

  const { attributeBindings, decodeProps, schema } = deriveComponentSchemaAndBindings(config)

  return Object.freeze({
    aliases: Object.freeze(aliases),
    attributeBindings,
    children: config.children,
    decodeProps,
    ...(config.formContainer !== undefined ? { formContainer: config.formContainer } : {}),
    formOwner: config.formOwner === true,
    morphState: config.morphState ?? "preserve",
    schema,
    tag: config.tag,
  }) as DefinedComponentDefinition<string, z.ZodObject>
}

export function defineComponentDefinition<
  const Tag extends string,
  const Attributes extends AttributeDefinitionMap,
>(
  config: DefineDerivedComponentDefinitionConfig<Tag, Attributes>,
): DefinedComponentDefinition<Tag, DerivedComponentSchema<Attributes>>
export function defineComponentDefinition<const Tag extends string, Schema extends z.ZodObject>(
  config: DefineComponentDefinitionConfig<Tag, Schema>,
): DefinedComponentDefinition<Tag, Schema>
export function defineComponentDefinition(
  config: RuntimeDefineComponentDefinitionConfig,
): DefinedComponentDefinition<string, z.ZodObject> {
  return createComponentDefinition(config)
}

export function bindComponent<const Tag extends string, Schema extends z.ZodObject>(
  definition: DefinedComponentDefinition<Tag, Schema>,
  component: ComponentRenderer<z.output<Schema>>,
): DefinedComponent<Tag, Schema> {
  return Object.freeze({
    ...definition,
    component,
  })
}

export function defineComponent<
  const Tag extends string,
  const Attributes extends AttributeDefinitionMap,
>(
  config: DefineDerivedComponentConfig<Tag, Attributes>,
): DefinedComponent<Tag, DerivedComponentSchema<Attributes>>
export function defineComponent<const Tag extends string, Schema extends z.ZodObject>(
  config: DefineComponentConfig<Tag, Schema>,
): DefinedComponent<Tag, Schema>
export function defineComponent(
  config: RuntimeDefineComponentConfig,
): DefinedComponent<string, z.ZodObject> {
  const definition = createComponentDefinition(config)
  return Object.freeze({
    ...definition,
    component: config.component,
  }) as DefinedComponent<string, z.ZodObject>
}

export interface CapabilityModule<
  Name extends string = string,
  Definitions extends
    readonly RegistryComponentDefinition[] = readonly RegistryComponentDefinition[],
> {
  readonly components: Definitions
  readonly name: Name
  readonly version: string
}

export interface ComponentModule<
  Name extends string = string,
  Components extends readonly RegistryComponent[] = readonly RegistryComponent[],
> extends CapabilityModule<Name, Components> {}

const QUARANTINED_MODULE = Symbol("expo-turbo.quarantined-module")

type QuarantinedCapabilityModule = CapabilityModule & {
  readonly [QUARANTINED_MODULE]: true
}

function moduleIsQuarantined(module: CapabilityModule): module is QuarantinedCapabilityModule {
  return (
    (QUARANTINED_MODULE in module && module[QUARANTINED_MODULE] === true) ||
    !isExpoTurboModuleName(module.name) ||
    !isExpoTurboModuleVersion(module.version)
  )
}

function freezeCapabilityModule<
  const Name extends string,
  const Definitions extends readonly RegistryComponentDefinition[],
>(config: CapabilityModule<Name, Definitions>): CapabilityModule<Name, Definitions> {
  const quarantined =
    !isExpoTurboModuleName(config.name) || !isExpoTurboModuleVersion(config.version)
  return Object.freeze({
    ...(quarantined ? { [QUARANTINED_MODULE]: true as const } : {}),
    components: Object.freeze([...config.components]) as unknown as Definitions,
    name: config.name,
    version: config.version,
  })
}

export function defineCapabilityModule<
  const Name extends string,
  const Definitions extends readonly RegistryComponentDefinition[],
>(config: CapabilityModule<Name, Definitions>): CapabilityModule<Name, Definitions> {
  return freezeCapabilityModule(config)
}

export function defineComponentModule<
  const Name extends string,
  const Components extends readonly RegistryComponent[],
>(config: ComponentModule<Name, Components>): ComponentModule<Name, Components> {
  return freezeCapabilityModule(config)
}

export interface ProtocolAttributes {
  readonly autofocus: boolean
  readonly classNames: readonly string[]
  readonly data: Readonly<Record<string, string>>
  readonly direction?: "auto" | "ltr" | "rtl"
  readonly dirname?: string
  readonly form?: string
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

export type RegistryVocabularyIssue =
  | Readonly<{
      kind: "component"
      tag: string
    }>
  | Readonly<{
      attribute: string
      kind: "attribute" | "attribute-decode"
      tag: string
    }>

export type RegistryRenderDecodeResult<Component extends RegistryComponent> =
  | Readonly<{
      decoded: DecodedComponent<Component>
      issues: readonly RegistryVocabularyIssue[]
      status: "decoded"
    }>
  | Readonly<{
      children: readonly ProtocolNode[]
      definition?: Component
      issues: readonly RegistryVocabularyIssue[]
      protocol: ProtocolAttributes
      status: "transparent"
    }>

export interface ComponentCapability {
  readonly aliases: readonly string[]
  readonly attributes: readonly Readonly<{
    codec: string
    deprecated?: string
    name: string
    prop: string
    required?: boolean
  }>[]
  readonly children: ComponentChildren
  readonly formContainer?: FormContainerRole
  readonly formOwner: boolean
  readonly morphState: ComponentMorphState
  readonly tag: string
}

export interface RegistryCapabilityManifest {
  readonly components: readonly ComponentCapability[]
  readonly hash: string
  readonly modules: readonly Readonly<{ name: string; version: string }>[]
  readonly protocolVersion: string
}

export interface VersionedRegistryCapabilityManifest extends RegistryCapabilityManifest {
  readonly manifestVersion: typeof REGISTRY_CAPABILITY_MANIFEST_VERSION
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function capabilityHash(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, "0")}`
}

export function createCapabilityManifest(
  ...modules: readonly CapabilityModule[]
): VersionedRegistryCapabilityManifest {
  return createCapabilityManifestWithComponents(modules, [])
}

function createCapabilityManifestWithComponents(
  modules: readonly CapabilityModule[],
  declaredComponents: readonly RegistryComponentDefinition[],
): VersionedRegistryCapabilityManifest {
  const moduleNames = new Set<string>()
  const owners = new Map<string, string>()
  const definitions: RegistryComponentDefinition[] = [...declaredComponents]

  for (const definition of declaredComponents) {
    for (const name of [definition.tag, ...definition.aliases]) {
      const owner = owners.get(name)
      if (owner) {
        throw new RegistryError(
          `Component name ${JSON.stringify(name)} is declared more than once`,
          { target: name },
        )
      }
      owners.set(name, "registry")
    }
  }

  for (const module of modules) {
    if (moduleIsQuarantined(module)) continue
    if (moduleNames.has(module.name)) {
      throw new RegistryError(`Duplicate component module ${JSON.stringify(module.name)}`)
    }
    moduleNames.add(module.name)
    for (const definition of module.components) {
      for (const name of [definition.tag, ...definition.aliases]) {
        const owner = owners.get(name)
        if (owner) {
          throw new RegistryError(
            `Component name ${JSON.stringify(name)} is owned by both ${JSON.stringify(owner)} and ${JSON.stringify(module.name)}`,
            { target: name },
          )
        }
        owners.set(name, module.name)
      }
      definitions.push(definition)
    }
  }

  const componentCapabilities = definitions
    .map((definition): ComponentCapability => {
      const attributes = Object.entries(definition.attributeBindings)
        .map(([name, binding]) =>
          Object.freeze({
            codec: binding.codec.name,
            ...(binding.deprecated ? { deprecated: binding.deprecated } : {}),
            name,
            prop: binding.prop,
            required: binding.required === true,
          }),
        )
        .sort((left, right) => compareCodeUnits(left.name, right.name))
      return Object.freeze({
        aliases: Object.freeze([...definition.aliases].sort(compareCodeUnits)),
        attributes: Object.freeze(attributes),
        children: definition.children,
        ...(definition.formContainer !== undefined
          ? { formContainer: definition.formContainer }
          : {}),
        formOwner: definition.formOwner,
        morphState: definition.morphState,
        tag: definition.tag,
      })
    })
    .sort((left, right) => compareCodeUnits(left.tag, right.tag))
  const moduleCapabilities = modules
    .filter((module) => !moduleIsQuarantined(module))
    .map((module) => Object.freeze({ name: module.name, version: module.version }))
    .sort((left, right) => compareCodeUnits(left.name, right.name))
  const serializable = {
    components: componentCapabilities,
    modules: moduleCapabilities,
    protocolVersion: EXPO_TURBO_PROTOCOL_VERSION,
  }

  return Object.freeze({
    components: Object.freeze(componentCapabilities),
    hash: capabilityHash(JSON.stringify(serializable)),
    manifestVersion: REGISTRY_CAPABILITY_MANIFEST_VERSION,
    modules: Object.freeze(moduleCapabilities),
    protocolVersion: EXPO_TURBO_PROTOCOL_VERSION,
  })
}

function serializeCapabilityManifest(manifest: VersionedRegistryCapabilityManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`
}

function registryDevelopmentMode(): boolean {
  const globalDevelopment = (globalThis as Readonly<{ __DEV__?: unknown }>).__DEV__
  if (typeof globalDevelopment === "boolean") return globalDevelopment
  const nodeEnvironment = (
    globalThis as Readonly<{
      process?: Readonly<{ env?: Readonly<{ NODE_ENV?: string }> }>
    }>
  ).process?.env?.NODE_ENV
  return nodeEnvironment === "development"
}

export function capabilityManifestJSON(...modules: readonly CapabilityModule[]): string {
  return serializeCapabilityManifest(createCapabilityManifest(...modules))
}

export interface ComponentRegistry<Component extends RegistryComponent = never> {
  readonly capabilities: RegistryCapabilityManifest
  decode(element: ProtocolElement): DecodedComponent<Component>
  decodeForRender(element: ProtocolElement): RegistryRenderDecodeResult<Component>
  formContainerRole(element: ProtocolElement): FormContainerRole | undefined
  get<Tag extends Component["tag"]>(tag: Tag): Extract<Component, { readonly tag: Tag }> | undefined
  resolve(tagOrAlias: string): Component | undefined
  use<Next extends readonly RegistryComponent[]>(
    module: ComponentModule<string, Next>,
  ): ComponentRegistry<Component | Next[number]>
}

export interface ManifestComponentRegistry<Component extends RegistryComponent = never>
  extends ComponentRegistry<Component> {
  readonly capabilities: VersionedRegistryCapabilityManifest
  capabilityManifestJSON(): string
  decodeForRender(element: ProtocolElement): RegistryRenderDecodeResult<Component>
  use<Next extends readonly RegistryComponent[]>(
    module: ComponentModule<string, Next>,
  ): ManifestComponentRegistry<Component | Next[number]>
}

class Registry<Component extends RegistryComponent>
  implements ManifestComponentRegistry<Component>
{
  readonly capabilities: VersionedRegistryCapabilityManifest
  private readonly components = new Map<string, RegistryComponent>()
  private readonly reportedFallbacks = new Set<string>()

  constructor(
    private readonly modules: readonly ComponentModule[],
    private readonly declaredComponents: readonly RegistryComponent[] = [],
    private readonly invertedStrictness = false,
  ) {
    this.capabilities = createCapabilityManifestWithComponents(modules, declaredComponents)
    for (const component of declaredComponents) {
      for (const name of [component.tag, ...component.aliases]) {
        this.components.set(name, component)
      }
    }
    for (const module of modules) {
      if (moduleIsQuarantined(module)) continue
      for (const component of module.components) {
        for (const name of [component.tag, ...component.aliases]) {
          this.components.set(name, component)
        }
      }
    }
  }

  capabilityManifestJSON(): string {
    return serializeCapabilityManifest(this.capabilities)
  }

  decode(element: ProtocolElement): DecodedComponent<Component> {
    return decodeRegistryElementStrict((tagOrAlias) => this.resolve(tagOrAlias), element)
  }

  decodeForRender(element: ProtocolElement): RegistryRenderDecodeResult<Component> {
    const result = decodeRegistryElementForRender((tagOrAlias) => this.resolve(tagOrAlias), element)
    if (
      this.invertedStrictness &&
      result.status === "transparent" &&
      result.definition === undefined
    ) {
      const issue = result.issues.find(
        (candidate): candidate is Extract<RegistryVocabularyIssue, { kind: "component" }> =>
          candidate.kind === "component",
      )
      if (issue) {
        if (registryDevelopmentMode()) {
          throw new RegistryError(`Unknown component ${JSON.stringify(issue.tag)}`, {
            target: issue.tag,
          })
        }
        const fingerprint = `${issue.kind}:${issue.tag}`
        if (!this.reportedFallbacks.has(fingerprint)) {
          try {
            console.error("Expo Turbo registry contract fallback", issue)
            this.reportedFallbacks.add(fingerprint)
          } catch {
            // A diagnostic sink must not turn production skew into a render failure.
          }
        }
      }
    }
    return result
  }

  get<Tag extends Component["tag"]>(
    tag: Tag,
  ): Extract<Component, { readonly tag: Tag }> | undefined {
    const component = this.components.get(tag)
    return component?.tag === tag
      ? (component as Extract<Component, { readonly tag: Tag }>)
      : undefined
  }

  formContainerRole(element: ProtocolElement): FormContainerRole | undefined {
    return this.resolve(element.tagName)?.formContainer
  }

  resolve(tagOrAlias: string): Component | undefined {
    return this.components.get(tagOrAlias) as Component | undefined
  }

  use<Next extends readonly RegistryComponent[]>(
    module: ComponentModule<string, Next>,
  ): ManifestComponentRegistry<Component | Next[number]> {
    return new Registry<Component | Next[number]>(
      [...this.modules, module],
      this.declaredComponents,
      this.invertedStrictness,
    )
  }
}

type ComponentsFromModules<Modules extends readonly ComponentModule[]> =
  Modules[number]["components"][number]

export function createRegistry<const Modules extends readonly ComponentModule[]>(
  ...modules: Modules
): ManifestComponentRegistry<ComponentsFromModules<Modules>> {
  return new Registry<ComponentsFromModules<Modules>>(modules)
}

type ComponentsFromDeclarations<
  Declarations extends Readonly<Record<string, ComponentDeclaration>>,
> = {
  [Tag in keyof Declarations & string]: Declarations[Tag] extends ComponentDeclaration<infer Schema>
    ? DefinedComponent<Tag, Schema>
    : never
}[keyof Declarations & string]

export interface DefineRegistryConfig<
  Declarations extends Readonly<Record<string, ComponentDeclaration>>,
> {
  readonly components: Declarations
  readonly module: Readonly<{
    readonly name: string
    readonly version: string
  }>
}

export function defineRegistry<
  const Declarations extends Readonly<Record<string, ComponentDeclaration>>,
>(
  config: DefineRegistryConfig<Declarations>,
): ManifestComponentRegistry<ComponentsFromDeclarations<Declarations>> {
  const components = Object.entries(config.components).map(([tag, declaration]) => {
    if (
      typeof declaration !== "object" ||
      declaration === null ||
      !Object.hasOwn(declaration, COMPONENT_DECLARATION) ||
      declaration[COMPONENT_DECLARATION] !== true
    ) {
      throw new RegistryError(
        `Component ${JSON.stringify(tag)} must be declared with component()`,
        { target: tag },
      )
    }
    declaration.render.displayName = tag
    const definition = createComponentDefinition({
      aliases: declaration.aliases,
      attributes: declaration.attributes,
      children: declaration.children,
      ...(declaration.formContainer !== undefined
        ? { formContainer: declaration.formContainer }
        : {}),
      formOwner: declaration.formOwner,
      morphState: declaration.morphState,
      ...(declaration.schema !== undefined ? { schema: declaration.schema } : {}),
      tag,
    })
    return Object.freeze({ ...definition, component: declaration.render })
  })
  const module = defineComponentModule({
    components: components as ComponentsFromDeclarations<Declarations>[],
    name: config.module.name,
    version: config.module.version,
  })
  return new Registry<ComponentsFromDeclarations<Declarations>>([module], [], true)
}
