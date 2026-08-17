import type { z } from "zod"

import { RegistryError } from "../core/errors.js"
import type { AttributeCodec, SchemaAttributeCodec } from "./codecs.js"
import { validateRegistryIdentifier } from "./registry-identifier-internal.js"

const ATTRIBUTE_DEFINITION = Symbol("expo-turbo.attribute-definition")

export interface AttributeDefinition<
  Schema extends z.ZodType = z.ZodType,
  Prop extends string | undefined = undefined,
> {
  readonly [ATTRIBUTE_DEFINITION]: true
  readonly codec: AttributeCodec<unknown>
  readonly deprecatedMessage: string | undefined
  readonly propName: Prop
  readonly schema: Schema
  default(
    value: Exclude<z.output<Schema>, undefined>,
  ): AttributeDefinition<z.ZodDefault<Schema>, Prop>
  deprecated(message: string): AttributeDefinition<Schema, Prop>
  optional(): AttributeDefinition<z.ZodOptional<Schema>, Prop>
  prop<const NextProp extends string>(name: NextProp): AttributeDefinition<Schema, NextProp>
}

interface AttributeDefinitionParts {
  readonly codec: AttributeCodec<unknown>
  readonly decode: (value: string) => unknown
  readonly deprecatedMessage: string | undefined
  readonly propName: string | undefined
  readonly schema: z.ZodType
}

type SchemaAcceptsCodec<Value, Schema extends z.ZodType> = [Value] extends [z.input<Schema>]
  ? unknown
  : never

function createAttributeDefinition<
  Schema extends z.ZodType,
  Prop extends string | undefined = undefined,
>(
  codec: AttributeCodec<unknown>,
  decode: (value: string) => unknown,
  schema: Schema,
  propName: Prop,
  deprecatedMessage: string | undefined,
): AttributeDefinition<Schema, Prop> {
  return Object.freeze({
    [ATTRIBUTE_DEFINITION]: true as const,
    codec,
    decode,
    default(value: Exclude<z.output<Schema>, undefined>) {
      return createAttributeDefinition(
        codec,
        decode,
        schema.default(value),
        propName,
        deprecatedMessage,
      )
    },
    deprecated(message: string) {
      validateRegistryIdentifier(message, "attribute.deprecated")
      if (!message.trim())
        throw new RegistryError("Attribute deprecation messages must not be blank")
      return createAttributeDefinition(codec, decode, schema, propName, message)
    },
    deprecatedMessage,
    optional() {
      return createAttributeDefinition(
        codec,
        decode,
        schema.optional(),
        propName,
        deprecatedMessage,
      )
    },
    prop<const NextProp extends string>(name: NextProp) {
      validateRegistryIdentifier(name, "attribute.prop")
      if (!name.trim()) throw new RegistryError("Attribute prop names must not be blank")
      return createAttributeDefinition(codec, decode, schema, name, deprecatedMessage)
    },
    propName,
    schema,
  })
}

export function attr<Schema extends z.ZodType>(
  codec: SchemaAttributeCodec<Schema>,
): AttributeDefinition<Schema>
export function attr<Codec extends AttributeCodec<unknown>, Schema extends z.ZodType>(
  codec: Codec,
  schema: Schema & SchemaAcceptsCodec<ReturnType<Codec["decode"]>, Schema>,
): AttributeDefinition<Schema>
export function attr<Value, Schema extends z.ZodType>(
  codec: AttributeCodec<Value>,
  schema?: Schema,
): AttributeDefinition<Schema> {
  const usesCodecSchema = schema === undefined
  const resolvedSchema = schema ?? ("schema" in codec ? codec.schema : undefined)
  if (resolvedSchema === undefined) {
    throw new RegistryError(
      `Attribute codec ${JSON.stringify(codec.name)} requires a schema passed to attr()`,
    )
  }
  const schemaCodec = codec as AttributeCodec<Value> & {
    readonly decodeInput?: (value: string) => unknown
  }
  const decodeInput = schemaCodec.decodeInput
  const decode =
    usesCodecSchema && typeof decodeInput === "function"
      ? (value: string) => decodeInput.call(codec, value)
      : (value: string) => codec.decode(value)
  return createAttributeDefinition(
    codec as AttributeCodec<unknown>,
    decode,
    resolvedSchema as Schema,
    undefined,
    undefined,
  )
}

export function attributeDefinitionParts(value: unknown): AttributeDefinitionParts | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    !(ATTRIBUTE_DEFINITION in value) ||
    value[ATTRIBUTE_DEFINITION] !== true
  ) {
    return undefined
  }
  return value as unknown as AttributeDefinitionParts
}
