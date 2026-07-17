import type { z } from "zod"

export interface AttributeCodec<Value> {
  readonly name: string
  decode(value: string): Value
}

function codec<Value>(name: string, decode: (value: string) => Value): AttributeCodec<Value> {
  return Object.freeze({ name, decode })
}

export const stringCodec = codec("string", (value) => value)

export const booleanCodec = codec("boolean", (value) => {
  if (value === "true") return true
  if (value === "false") return false
  throw new Error("expected true or false")
})

export const numberCodec = codec("number", (value) => {
  if (value.trim() === "") throw new Error("expected a number")
  const decoded = Number(value)
  if (!Number.isFinite(decoded)) throw new Error("expected a finite number")
  return decoded
})

export const integerCodec = codec("integer", (value) => {
  const decoded = numberCodec.decode(value)
  if (!Number.isInteger(decoded)) throw new Error("expected an integer")
  return decoded
})

export function enumCodec<const Values extends readonly [string, ...string[]]>(
  values: Values,
): AttributeCodec<Values[number]> {
  const admitted = new Set<string>(values)
  return codec(`enum:${values.join("|")}`, (value) => {
    if (!admitted.has(value)) throw new Error("expected an admitted enum value")
    return value as Values[number]
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
): AttributeCodec<z.output<Schema>> {
  if (!name.trim()) throw new Error("JSON codecs require a capability name")
  if (!Number.isInteger(options.maxBytes) || options.maxBytes <= 0) {
    throw new Error("JSON codecs require a positive integer byte limit")
  }

  return codec(`json:${name}`, (value) => {
    if (utf8ByteLength(value) > options.maxBytes)
      throw new Error("JSON attribute exceeds its limit")
    let parsed: unknown
    try {
      parsed = JSON.parse(value)
    } catch {
      throw new Error("expected valid JSON")
    }
    return schema.parse(parsed)
  })
}
