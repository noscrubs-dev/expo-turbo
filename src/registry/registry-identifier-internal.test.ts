import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"

import { RegistryError } from "../core/errors"
import { registryIdentifierIssue, validateRegistryIdentifier } from "./registry-identifier-internal"

const grammar = JSON.parse(
  await readFile(
    new URL("../../protocol/registry-identifier-grammar.json", import.meta.url),
    "utf8",
  ),
) as Readonly<{
  invalidScalarHex: readonly string[]
  javascriptMalformedUtf16Hex: readonly Readonly<{
    codeUnits: readonly string[]
    description: string
  }>[]
  validScalarHex: readonly string[]
  validSequenceScalarHex: readonly Readonly<{
    description: string
    scalars: readonly string[]
  }>[]
}>

const scalar = (hex: string) => String.fromCodePoint(Number.parseInt(hex, 16))

describe("registry identifier scalar grammar", () => {
  test("consumes the shared valid scalar and sequence cases without normalization", () => {
    for (const hex of grammar.validScalarHex)
      expect(registryIdentifierIssue(scalar(hex))).toBeUndefined()
    for (const fixture of grammar.validSequenceScalarHex) {
      const value = fixture.scalars.map(scalar).join("")
      expect(registryIdentifierIssue(value)).toBeUndefined()
    }
    const [composed, decomposed] = grammar.validSequenceScalarHex
    expect(composed?.scalars.map(scalar).join("")).not.toBe(
      decomposed?.scalars.map(scalar).join(""),
    )
  })

  test("rejects every shared noncharacter at scalar start, middle, end, and first of many", () => {
    for (const hex of grammar.invalidScalarHex) {
      const invalid = scalar(hex)
      for (const [value, index] of [
        [`${invalid}ab`, 0],
        [`a${invalid}b`, 1],
        [`ab${invalid}`, 2],
      ] as const) {
        expect(() => validateRegistryIdentifier(value, "field.path")).toThrow(
          `Expo Turbo registry identifier field.path contains Unicode noncharacter U+${hex} at scalar index ${index}`,
        )
      }
    }
    expect(registryIdentifierIssue(`a${scalar("FDD0")}${scalar("10FFFF")}`)).toEqual({
      codePoint: 0xfdd0,
      kind: "Unicode noncharacter",
      scalarIndex: 1,
    })
    expect(() =>
      validateRegistryIdentifier(`${scalar("1F600")}${scalar("1FFFE")}`, "field.path"),
    ).toThrow(
      "Expo Turbo registry identifier field.path contains Unicode noncharacter U+1FFFE at scalar index 1",
    )
  })

  test("rejects lone UTF-16 surrogates without replacement and reports scalar indexes", () => {
    for (const fixture of grammar.javascriptMalformedUtf16Hex) {
      const value = String.fromCharCode(...fixture.codeUnits.map((hex) => Number.parseInt(hex, 16)))
      const codeUnit = fixture.codeUnits[1]
      expect(() => validateRegistryIdentifier(value, "module.name")).toThrow(
        `Expo Turbo registry identifier module.name contains lone surrogate U+${codeUnit} at scalar index 1`,
      )
    }
  })

  test("uses RegistryError with the registry code", () => {
    try {
      validateRegistryIdentifier(scalar("1FFFE"), "component.tag")
      throw new Error("expected identifier rejection")
    } catch (error) {
      expect(error).toBeInstanceOf(RegistryError)
      expect(error).toMatchObject({ code: "registry" })
    }
  })

  test("rejects non-string values before UTF-16 inspection", () => {
    for (const [value, type] of [
      [1, "number"],
      [Symbol("tag"), "symbol"],
      [null, "null"],
    ] as const) {
      expect(() => validateRegistryIdentifier(value, "component.tag")).toThrow(
        `Expo Turbo registry identifier component.tag must be a string, got ${type}`,
      )
      try {
        validateRegistryIdentifier(value, "component.tag")
      } catch (error) {
        expect(error).toBeInstanceOf(RegistryError)
        expect(error).toMatchObject({ code: "registry" })
      }
    }
  })
})
