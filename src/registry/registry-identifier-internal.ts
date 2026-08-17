import { RegistryError } from "../core/errors.js"

export interface RegistryIdentifierIssue {
  readonly codePoint: number
  readonly kind: "lone surrogate" | "Unicode noncharacter"
  readonly scalarIndex: number
}

function isUnicodeNoncharacter(codePoint: number): boolean {
  return (
    (codePoint >= 0xfdd0 && codePoint <= 0xfdef) ||
    (codePoint <= 0x10ffff && (codePoint & 0xffff) >= 0xfffe)
  )
}

export function registryIdentifierIssue(value: string): RegistryIdentifierIssue | undefined {
  let scalarIndex = 0
  for (let offset = 0; offset < value.length; scalarIndex += 1) {
    const first = value.charCodeAt(offset)
    if (first >= 0xd800 && first <= 0xdbff) {
      const second = value.charCodeAt(offset + 1)
      if (!(second >= 0xdc00 && second <= 0xdfff)) {
        return { codePoint: first, kind: "lone surrogate", scalarIndex }
      }
      const codePoint = 0x10000 + ((first - 0xd800) << 10) + (second - 0xdc00)
      if (isUnicodeNoncharacter(codePoint)) {
        return { codePoint, kind: "Unicode noncharacter", scalarIndex }
      }
      offset += 2
      continue
    }
    if (first >= 0xdc00 && first <= 0xdfff) {
      return { codePoint: first, kind: "lone surrogate", scalarIndex }
    }
    if (isUnicodeNoncharacter(first)) {
      return { codePoint: first, kind: "Unicode noncharacter", scalarIndex }
    }
    offset += 1
  }
  return undefined
}

function formatCodePoint(codePoint: number): string {
  return codePoint.toString(16).toUpperCase().padStart(4, "0")
}

export function validateRegistryIdentifier(
  value: unknown,
  fieldPath: string,
): asserts value is string {
  if (typeof value !== "string") {
    const type = value === null ? "null" : typeof value
    throw new RegistryError(
      `Expo Turbo registry identifier ${fieldPath} must be a string, got ${type}`,
    )
  }
  const issue = registryIdentifierIssue(value)
  if (!issue) return
  throw new RegistryError(
    `Expo Turbo registry identifier ${fieldPath} contains ${issue.kind} U+${formatCodePoint(issue.codePoint)} at scalar index ${issue.scalarIndex}`,
  )
}
