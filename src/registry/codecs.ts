import { z } from "zod"

export interface AttributeCodec<Value> {
  readonly name: string
  decode(value: string): Value
}

export interface SchemaAttributeCodec<Schema extends z.ZodType = z.ZodType>
  extends AttributeCodec<z.output<Schema>> {
  readonly schema: Schema
  decodeInput(value: string): z.input<Schema>
}

function codec<Schema extends z.ZodType>(
  name: string,
  schema: Schema,
  decodeInput: (value: string) => z.input<Schema>,
): SchemaAttributeCodec<Schema> {
  return Object.freeze({
    decode(value: string) {
      return schema.parse(decodeInput(value))
    },
    decodeInput,
    name,
    schema,
  })
}

export const stringCodec = codec("string", z.string(), (value) => value)

export const presenceCodec = codec("presence", z.boolean(), () => true as const)

export const booleanCodec = codec("boolean", z.boolean(), (value) => {
  if (value === "true") return true
  if (value === "false") return false
  throw new Error("expected true or false")
})

export const numberCodec = codec("number", z.number(), (value) => {
  if (value.trim() === "") throw new Error("expected a number")
  const decoded = Number(value)
  if (!Number.isFinite(decoded)) throw new Error("expected a finite number")
  return decoded
})

export const integerCodec = codec("integer", z.number().int(), (value) => {
  const decoded = numberCodec.decodeInput(value)
  if (!Number.isInteger(decoded)) throw new Error("expected an integer")
  return decoded
})

export function enumCodec<const Values extends readonly [string, ...string[]]>(
  values: Values,
): SchemaAttributeCodec<z.ZodType<Values[number]>> {
  const admitted = new Set<string>(values)
  return codec(`enum:${values.join("|")}`, z.enum(values), (value) => {
    if (!admitted.has(value)) throw new Error("expected an admitted enum value")
    return value as Values[number]
  })
}

export function tokenListCodec<const Values extends readonly string[]>(
  name: string,
  values: Values,
  options: Readonly<{ maxTokens: number }>,
): SchemaAttributeCodec<z.ZodType<Values[number][]>> {
  if (!name.trim()) throw new Error("Token-list codecs require a capability name")
  if (!Number.isInteger(options.maxTokens) || options.maxTokens < 1) {
    throw new Error("Token-list codecs require a positive integer token limit")
  }
  const admitted = new Set<string>()
  for (const value of values) {
    if (value.length > 64 || !/^[a-z][a-z0-9-]*(?::[a-z][a-z0-9-]*)*$/.test(value)) {
      throw new Error("Token-list codec values must be bounded lowercase semantic tokens")
    }
    if (admitted.has(value)) throw new Error(`Duplicate token-list codec value ${value}`)
    admitted.add(value)
  }
  const capabilityValues = [...admitted].sort()

  const capability = JSON.stringify([name, options.maxTokens, capabilityValues])
  const schema = z
    .array(z.enum(values))
    .transform((tokens) => Object.freeze(tokens) as Values[number][])

  return codec(`tokens:${capability}`, schema, (value) => {
    const tokens = value.trim() ? value.trim().split(/\s+/) : []
    if (tokens.length > options.maxTokens) throw new Error("Token list exceeds its limit")
    const used = new Set<string>()
    for (const token of tokens) {
      if (!admitted.has(token)) throw new Error("Unknown token-list value")
      if (used.has(token)) throw new Error("Duplicate token-list value")
      used.add(token)
    }
    return Object.freeze(tokens as Values[number][]) as Values[number][]
  })
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

export function jsonCodec<Schema extends z.ZodType>(
  name: string,
  schema: Schema,
  options: Readonly<{ maxBytes: number }>,
): SchemaAttributeCodec<Schema> {
  if (!name.trim()) throw new Error("JSON codecs require a capability name")
  if (!Number.isInteger(options.maxBytes) || options.maxBytes <= 0) {
    throw new Error("JSON codecs require a positive integer byte limit")
  }

  return codec(`json:${name}`, schema, (value) => {
    if (utf8ByteLength(value) > options.maxBytes)
      throw new Error("JSON attribute exceeds its limit")
    let parsed: unknown
    try {
      parsed = JSON.parse(value)
    } catch {
      throw new Error("expected valid JSON")
    }
    return parsed as z.input<Schema>
  })
}
