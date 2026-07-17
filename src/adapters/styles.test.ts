import { describe, expect, test } from "bun:test"

import { PropsError, RegistryError } from "../core/errors"
import { defineStyleAdapter, resolveComponentStyle } from "./styles"

type TestStyle = Readonly<Record<string, number | string>>

const TOKEN_STYLES = Object.freeze({
  "layout:row": Object.freeze({ direction: "row" }),
  "space:roomy": Object.freeze({ padding: 16 }),
  "tone:critical": Object.freeze({ color: "red" }),
  "tone:positive": Object.freeze({ color: "green" }),
}) satisfies Readonly<Record<string, TestStyle>>

function adapter() {
  return defineStyleAdapter({
    compose: (styles: readonly TestStyle[]) => Object.freeze(Object.assign({}, ...styles)),
    maxTokens: 3,
    tokens: {
      "layout:row": {
        components: ["DemoCard"],
        group: "layout",
        style: TOKEN_STYLES["layout:row"],
      },
      "space:roomy": { group: "space", style: TOKEN_STYLES["space:roomy"] },
      "tone:critical": { group: "tone", style: TOKEN_STYLES["tone:critical"] },
      "tone:positive": { group: "tone", style: TOKEN_STYLES["tone:positive"] },
    },
  })
}

describe("semantic style adapters", () => {
  test("merges component, admitted token, and prop layers in deterministic order", () => {
    const styles = resolveComponentStyle(
      adapter(),
      {
        component: { color: "black", padding: 4 },
        props: { color: "blue" },
        tokens: ["tone:positive", "space:roomy"],
      },
      { component: "DemoCard" },
    )

    expect(styles).toEqual({ color: "blue", padding: 16 })
    expect(Object.isFrozen(styles)).toBe(true)
  })

  test("rejects unknown, duplicate, conflicting, excessive, and inapplicable tokens", () => {
    const styles = adapter()
    expect(() => styles.resolve(["missing"], { component: "DemoCard" })).toThrow(PropsError)
    expect(() =>
      styles.resolve(["tone:positive", "tone:positive"], { component: "DemoCard" }),
    ).toThrow(PropsError)
    expect(() =>
      styles.resolve(["tone:positive", "tone:critical"], { component: "DemoCard" }),
    ).toThrow(PropsError)
    expect(() =>
      styles.resolve(["tone:positive", "space:roomy", "layout:row", "missing"], {
        component: "DemoCard",
      }),
    ).toThrow(PropsError)
    expect(() => styles.resolve(["layout:row"], { component: "DemoText" })).toThrow(PropsError)
  })

  test("validates and exposes a frozen deterministic capability manifest", () => {
    const styles = adapter()
    expect(styles.tokens).toEqual(["layout:row", "space:roomy", "tone:critical", "tone:positive"])
    expect(Object.isFrozen(styles.tokens)).toBe(true)
    expect(() => defineStyleAdapter({ compose: () => ({}), maxTokens: 0, tokens: {} })).toThrow(
      RegistryError,
    )
    expect(() =>
      defineStyleAdapter({
        compose: () => ({}),
        maxTokens: 1,
        tokens: { "Invalid token": { style: {} } },
      }),
    ).toThrow(RegistryError)
    expect(() =>
      defineStyleAdapter({
        compose: () => ({}),
        maxTokens: 1,
        tokens: { valid: { components: [""], style: {} } },
      }),
    ).toThrow(RegistryError)
    expect(() =>
      defineStyleAdapter({
        compose: () => ({}),
        maxTokens: 1,
        tokens: { valid: { components: ["Demo", "Demo"], style: {} } },
      }),
    ).toThrow(RegistryError)
  })
})
